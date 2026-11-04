import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { briefOf, isOpen, minutesSince } from '../src/store'
import { TicketLog } from '../src/store/log'
import { TICKETS_SCHEMA_VERSION, TicketReadout, toJsonView } from '../src/tickets/readout'
import type { TicketsPayload } from '../src/tickets/readout'
import { TicketSnapshotFile } from '../src/tickets/snapshot'
import { runTicketsCli } from '../src/cli'
import { apply } from '../src/index'
import { fakePluginHost, mountPlugin, testConfig } from './helpers/plugin-harness'

/**
 * 统一只读出口的验收：CLI、`dispatcher/tickets` service、桌面快照文件三处
 * 必须和 store 的折叠结果逐字段一致，而且老行（没有 kind / kind 是
 * `legacy/status`）也要折得出来。
 *
 * 对照物固定是 `new TicketLog(...).list()`：它是 store 唯一的折叠口径。测试
 * 自己按快照的字段解释一遍（briefOf / minutesSince / filter(!delivered)），
 * 不调用 readout 的内部换算，免得变成自己比自己。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'tickets-20261104.jsonl')
/** fixture 的行数 / 票数锚点，和 fixture-equivalence 一致。 */
const FIXTURE_TICKETS = 448
const LIB_CLI = join(HERE, '..', 'lib', 'tickets-cli.js')

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-readout-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

interface CliRun {
  code: number
  out: string
  err: string
}

function run(argv: readonly string[]): CliRun {
  let out = ''
  let err = ''
  const code = runTicketsCli(argv, {
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
  })
  return { code, out, err }
}

/** 固定键序：跨进程消费者按它解析，多一个少一个都算改动。 */
const JSON_KEYS = [
  'id',
  'brief',
  'goal',
  'status',
  'owner',
  'createdAt',
  'updatedAt',
  'closedAt',
  'statusSince',
  'workerAlive',
  'pendingInputs',
  'pendingReports',
  'reportsCount',
  'ageMinutes',
  'stale',
  'epoch',
  'epochReports',
  'preset',
  'presetSource',
  'dir',
  'note',
  'device',
]

function parsed(runResult: CliRun): TicketsPayload {
  expect(runResult.err).toBe('')
  expect(runResult.code).toBe(0)
  return JSON.parse(runResult.out) as TicketsPayload
}

/** 事件一行一条，写进临时日志。 */
function writeLog(lines: readonly unknown[]): string {
  const file = join(tempDir(), 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return file
}

describe('dsh-dispatcher tickets --json', () => {
  it('和 store 折叠结果逐字段一致（线上 fixture，448 张老票）', () => {
    const payload = parsed(run(['tickets', '--json', '--state', FIXTURE]))
    const snapshots = new TicketLog(FIXTURE).list()

    expect(payload.v).toBe(TICKETS_SCHEMA_VERSION)
    expect(Date.parse(payload.generatedAt)).not.toBeNaN()
    expect(payload.tickets).toHaveLength(FIXTURE_TICKETS)
    expect(payload.counts.openTotal).toBe(snapshots.filter((ticket) => isOpen(ticket.status)).length)
    expect(payload.counts.openTotal).toBe(
      payload.counts.open + payload.counts.running + payload.counts.waiting + payload.counts.blocked,
    )

    const generatedAt = new Date(payload.generatedAt)
    for (const view of payload.tickets) {
      const snapshot = snapshots.find((ticket) => ticket.id === view.id)
      expect(snapshot, `票 ${view.id} 不在折叠结果里`).toBeDefined()
      if (!snapshot) continue
      expect(Object.keys(view)).toEqual(JSON_KEYS)
      expect(view.brief).toBe(briefOf(snapshot))
      expect(view.goal).toBe(snapshot.goal)
      expect(view.status).toBe(snapshot.status)
      expect(view.owner).toBe(snapshot.owner ?? null)
      expect(view.createdAt).toBe(snapshot.createdAt)
      expect(view.updatedAt).toBe(snapshot.updatedAt)
      expect(view.closedAt).toBe(snapshot.closedAt ?? null)
      expect(view.statusSince).toBe(snapshot.statusSince)
      expect(view.workerAlive).toBe(snapshot.workerAlive ?? null)
      expect(view.pendingInputs).toBe(snapshot.inputs.filter((entry) => !entry.delivered).length)
      expect(view.pendingReports).toBe(snapshot.reports.filter((entry) => !entry.delivered).length)
      expect(view.reportsCount).toBe(snapshot.reports.length)
      expect(view.epoch).toBe(snapshot.epoch)
      expect(view.epochReports).toBe(snapshot.epochReports)
      // ageMinutes 以 generatedAt 为参考时刻：同一份读数里只有一个 now。
      expect(view.ageMinutes).toBe(minutesSince(snapshot.statusSince, generatedAt))
    }
  })

  it('老行：没有 kind 的建票/状态行折得出来', () => {
    const file = writeLog([
      { id: 't-legacy-a', at: '2026-10-01T00:00:00.000Z', goal: '老票，没有 kind', status: 'open' },
      { id: 't-legacy-a', at: '2026-10-01T00:05:00.000Z', status: 'running', owner: 'worker-old' },
      { id: 't-legacy-a', at: '2026-10-01T00:09:00.000Z', status: 'waiting' },
      { id: 't-legacy-a', at: '2026-10-01T00:10:00.000Z', status: 'done', note: '收工' },
    ])
    const payload = parsed(run(['tickets', '--json', '--id', 't-legacy-a', '--state', file]))
    expect(payload.tickets).toHaveLength(1)
    const view = payload.tickets[0]
    expect(view.id).toBe('t-legacy-a')
    expect(view.status).toBe('done')
    expect(view.createdAt).toBe('2026-10-01T00:00:00.000Z')
    expect(view.updatedAt).toBe('2026-10-01T00:10:00.000Z')
    expect(view.statusSince).toBe('2026-10-01T00:10:00.000Z')
    expect(view.closedAt).toBe('2026-10-01T00:10:00.000Z')
    expect(view.owner).toBe('worker-old')
    expect(view.note).toBe('收工')
    expect(payload.counts.openTotal).toBe(0)
    // 和 store 折出来的逐字段对齐（含 size-0 的 pending 计数）。
    const snapshot = new TicketLog(file).get('t-legacy-a')!
    expect(view).toEqual(toJsonView(new TicketReadout(new TicketLog(file)).get('t-legacy-a')!, snapshot))
  })

  it('老行：带 kind 的 legacy/status 也折', () => {
    const file = writeLog([
      { id: 't-legacy-b', at: '2026-10-02T00:00:00.000Z', goal: 'legacy/status 行', status: 'open' },
      { kind: 'legacy/status', id: 't-legacy-b', at: '2026-10-02T00:03:00.000Z', status: 'blocked', note: '等人' },
      { kind: 'legacy/status', id: 't-legacy-b', at: '2026-10-02T00:04:00.000Z', status: 'open' },
    ])
    const payload = parsed(run(['tickets', '--json', '--id', 't-legacy-b', '--state', file]))
    const view = payload.tickets[0]
    expect(view.status).toBe('open')
    expect(view.note).toBe('等人')
    expect(view.statusSince).toBe('2026-10-02T00:04:00.000Z')
    expect(view.closedAt).toBeNull()
    expect(view.ageMinutes).toBeGreaterThanOrEqual(0)
  })

  it('--open-only 只输出未结票，counts 仍是全量', () => {
    const file = writeLog([
      { id: 't-a', at: '2026-10-01T00:00:00.000Z', goal: '开着', status: 'open' },
      { id: 't-b', at: '2026-10-01T00:00:01.000Z', goal: '干完', status: 'open' },
      { id: 't-b', at: '2026-10-01T00:10:00.000Z', status: 'running' },
      { id: 't-b', at: '2026-10-01T00:20:00.000Z', status: 'done' },
      { id: 't-c', at: '2026-10-01T00:00:02.000Z', goal: '挂着', status: 'open' },
      { id: 't-c', at: '2026-10-01T00:30:00.000Z', status: 'waiting' },
    ])
    const payload = parsed(run(['tickets', '--json', '--open-only', '--state', file]))
    expect(payload.tickets.map((view) => view.id)).toEqual(['t-a', 't-c'])
    expect(payload.counts).toEqual({ open: 1, running: 0, waiting: 1, blocked: 0, openTotal: 2 })
    // --open 是同一个开关的别名。
    expect(parsed(run(['tickets', '--json', '--open', '--state', file])).tickets.map((v) => v.id)).toEqual([
      't-a',
      't-c',
    ])
  })

  it('--recent 只带最近 n 张已结票，未结票一张不少', () => {
    const lines: unknown[] = []
    for (let index = 0; index < 5; index += 1) {
      const id = `t-done-${index}`
      lines.push({ id, at: `2026-10-01T00:0${index}:00.000Z`, goal: `做完 ${index}`, status: 'open' })
      lines.push({ id, at: `2026-10-01T01:0${index}:00.000Z`, status: 'done' })
    }
    lines.push({ id: 't-open', at: '2026-10-01T02:00:00.000Z', goal: '还开着', status: 'open' })
    const file = writeLog(lines)
    const payload = parsed(run(['tickets', '--json', '--recent', '2', '--state', file]))
    const ids = payload.tickets.map((view) => view.id)
    expect(ids).toContain('t-open')
    expect(ids.filter((id) => id.startsWith('t-done-'))).toEqual(['t-done-3', 't-done-4'])
    expect(payload.counts.openTotal).toBe(1)
  })

  it('--id 查不到：退出码 1，stdout 仍是合法 JSON', () => {
    const runResult = run(['tickets', '--json', '--id', 't-nope', '--state', FIXTURE])
    expect(runResult.code).toBe(1)
    expect(runResult.err).toContain('t-nope')
    const payload = JSON.parse(runResult.out) as TicketsPayload
    expect(payload.v).toBe(1)
    expect(payload.tickets).toEqual([])
    expect(payload.counts.openTotal).toBeGreaterThan(0)
  })

  it('参数不对：退出码 2，stderr 带用法', () => {
    const runResult = run(['tickets', '--bogus'])
    expect(runResult.code).toBe(2)
    expect(runResult.err).toContain('不认识的参数')
    expect(runResult.err).toContain('用法：')
    expect(run(['tickets', '--id', 't-a', '--open-only']).code).toBe(2)
    expect(run(['tickets', '--recent', '-1']).code).toBe(2)
  })
})

describe('进程内 service（dispatcher/tickets）', () => {
  it('插件装载后能直接拿到 readout，读数和 CLI 同一份', () => {
    const host = fakePluginHost()
    apply(host.ctx as never, testConfig({ snapshotEnabled: false }))
    const service = (host.ctx as { get(name: string): unknown }).get('dispatcher/tickets') as
      | TicketReadout
      | undefined
    expect(service).toBeInstanceOf(TicketReadout)
    if (!service) return
    const payload = service.payload()
    expect(payload.v).toBe(1)
    expect(payload.tickets).toEqual([])
    expect(payload.counts.openTotal).toBe(0)

    // 同一份 fixture：service 与 CLI 的 JSON 逐字节一致（用 CLI 的 generatedAt
    // 当作 service 的钟，ageMinutes 也就能对上）。
    const cli = parsed(run(['tickets', '--json', '--state', FIXTURE]))
    const sameClock = new TicketReadout(new TicketLog(FIXTURE), {
      now: () => new Date(cli.generatedAt),
    })
    expect(sameClock.payload()).toEqual(cli)
  })

  it('没有 provide 的宿主也不炸（降级成 CLI + 快照文件）', () => {
    const host = fakePluginHost()
    delete (host.ctx as Record<string, unknown>).provide
    expect(() => apply(host.ctx as never, testConfig({ snapshotEnabled: false }))).not.toThrow()
    expect((host.ctx as { get(name: string): unknown }).get('dispatcher/tickets')).toBeUndefined()
  })
})

describe('桌面快照文件', () => {
  const sample = (): string =>
    writeLog([
      { id: 't-a', at: '2026-10-01T00:00:00.000Z', goal: '一', status: 'open' },
      { id: 't-a', at: '2026-10-01T00:01:00.000Z', status: 'running' },
      { id: 't-b', at: '2026-10-01T00:02:00.000Z', goal: '二', status: 'open' },
      { id: 't-b', at: '2026-10-01T00:03:00.000Z', status: 'done' },
    ])

  it('内容与 CLI 完全一致，原子替换且没变就不写', () => {
    const logFile = sample()
    const log = new TicketLog(logFile)
    const fixed = new Date('2026-11-04T12:00:00.000Z')
    const readout = new TicketReadout(log, { now: () => fixed })
    const file = join(tempDir(), 'tickets.snapshot.json')
    const snapshot = new TicketSnapshotFile(readout, { file, recentClosed: 20 })

    expect(snapshot.write()).toBe(true)
    const written = JSON.parse(readFileSync(file, 'utf8')) as TicketsPayload
    const expected = readout.payload({ recentClosed: 20 })
    expect(written).toEqual(expected)
    expect(Object.keys(written)).toEqual(['v', 'generatedAt', 'counts', 'tickets'])
    expect(existsSync(`${file}.tmp`)).toBe(false)

    const stamp = statSync(file).mtimeMs
    expect(snapshot.write()).toBe(false)
    expect(statSync(file).mtimeMs).toBe(stamp)

    // 新事件进来：内容变了才重写。
    log.commit({ kind: 'closed', id: 't-a', at: '2026-11-04T12:01:00.000Z', outcome: 'done' })
    expect(snapshot.write()).toBe(true)
    const next = JSON.parse(readFileSync(file, 'utf8')) as TicketsPayload
    expect(next.counts.openTotal).toBe(0)
    expect(next.tickets.map((view) => view.status)).toEqual(['done', 'done'])
  })

  it('只带未结票 + 最近 N 张结票，counts 按全量算', () => {
    const lines: unknown[] = []
    for (let index = 0; index < 30; index += 1) {
      const id = `t-done-${index}`
      lines.push({ id, at: `2026-10-01T00:00:${String(index).padStart(2, '0')}.000Z`, goal: `旧 ${index}`, status: 'open' })
      lines.push({ id, at: `2026-10-01T00:01:${String(index).padStart(2, '0')}.000Z`, status: 'done' })
    }
    lines.push({ id: 't-open', at: '2026-10-02T00:00:00.000Z', goal: '新的', status: 'open' })
    const log = new TicketLog(writeLog(lines))
    const readout = new TicketReadout(log, { now: () => new Date('2026-11-04T12:00:00.000Z') })
    const file = join(tempDir(), 'snap.json')
    new TicketSnapshotFile(readout, { file, recentClosed: 20 }).write()
    const payload = JSON.parse(readFileSync(file, 'utf8')) as TicketsPayload
    expect(payload.tickets).toHaveLength(21)
    expect(payload.tickets.filter((view) => view.status === 'open')).toHaveLength(1)
    expect(payload.counts.openTotal).toBe(1)
    expect(payload.counts).toEqual({ open: 1, running: 0, waiting: 0, blocked: 0, openTotal: 1 })
  })

  it('插件在每次 commit 之后自动重写快照', async () => {
    const host = mountPlugin()
    const file = join(dirname(host.config.stateFile), 'tickets.snapshot.json')
    // 装载时就落一份：桌宠不用等第一条票。
    expect(existsSync(file)).toBe(true)
    expect((JSON.parse(readFileSync(file, 'utf8')) as TicketsPayload).counts.openTotal).toBe(0)

    const receipt = (await host.call('dispatch_open', { goal: '装机', brief: '装机' })) as { id: string }
    const before = JSON.parse(readFileSync(file, 'utf8')) as TicketsPayload
    expect(before.counts.openTotal).toBe(1)
    expect(before.tickets.map((view) => view.id)).toEqual([receipt.id])

    await host.call('dispatch_close', { id: receipt.id, outcome: 'done', note: '收工' })
    const after = JSON.parse(readFileSync(file, 'utf8')) as TicketsPayload
    expect(after.counts.openTotal).toBe(0)
    expect(after.tickets[0].status).toBe('done')
    expect(after.tickets[0].note).toBe('收工')
    expect(after.tickets[0].closedAt).not.toBeNull()
  })
})

describe('bin 入口', () => {
  it('package.json 的 bin 指向可执行文件', () => {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
    }
    expect(pkg.bin?.['dsh-dispatcher']).toBe('bin/tickets.mjs')
    const bin = join(HERE, '..', 'bin', 'tickets.mjs')
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
    expect(statSync(bin).mode & 0o111).not.toBe(0)
  })

  it.skipIf(!existsSync(LIB_CLI))('构建后子进程输出与进程内一致', () => {
    const out = execFileSync(
      process.execPath,
      [join(HERE, '..', 'bin', 'tickets.mjs'), 'tickets', '--json', '--id', 't-mvxeoo0z-i5ab', '--state', FIXTURE],
      { encoding: 'utf8' },
    )
    const payload = JSON.parse(out) as TicketsPayload
    expect(payload.v).toBe(1)
    expect(payload.tickets).toHaveLength(1)
    expect(payload.tickets[0].id).toBe('t-mvxeoo0z-i5ab')
  })
})
