import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore } from '../src/store'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'
import type { FakePluginHost } from './helpers/plugin-harness'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  cleanTempDirs()
})

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 12, 8, 0, seconds)).toISOString()

function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-declare-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

function rows(file: string): Array<Record<string, unknown>> {
  const text = readFileSync(file, 'utf8').trim()
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : []
}

/** 一张已派出子会话的票：published + spawned，workerId 是 `worker-probe-1`。 */
function probeTicket(status?: 'done' | 'dropped'): string {
  return logFile([
    {
      kind: 'published',
      id: 't-probe',
      at: T(0),
      goal: '先看档再交声明',
      brief: '探路交声明',
      publisher: 'session-main',
      preset: 't2',
      presetSource: 'fallback',
      requestId: 'req-probe-1',
    },
    { kind: 'spawned', id: 't-probe', at: T(1), cause: 'tool', workerId: 'worker-probe-1', preset: 't2' },
    ...(status ? [{ kind: 'closed', id: 't-probe', at: T(2), cause: 'tool', outcome: status }] : []),
  ])
}

type Call = (name: string, args: Record<string, unknown>, options?: { agent?: unknown }) => Promise<unknown>

function mount(file: string): { host: FakePluginHost; call: Call } {
  const host = mountPlugin({ config: { stateFile: file } })
  return { host, call: (name, args, options) => host.call(name, args, options as never) }
}

function worker(host: FakePluginHost, id: string): unknown {
  return host.makeAgent('subagent', id)
}

const plan = {
  summary: '加 resources.ts 并补测试',
  files: [
    { path: 'src/tickets/resources.ts', what: '归一化函数' },
    { path: 'tests/resources.test.ts', what: '测试' },
  ],
}

const intent = {
  impact: { paths: ['src/tickets/resources.ts'], services: ['dsh-example'] },
  reversibility: 'auto',
  undo: { kind: 'file', ref: '/tmp/resources.ts.bak', howto: 'cp /tmp/resources.ts.bak src/tickets/resources.ts' },
}

describe('dispatch_declare', () => {
  it('正常写入：commit 一条 declared，快照折进 plan 与 intent，状态不动', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)

    const output = (await call('dispatch_declare', { plan, intent }, { agent: worker(host, 'worker-probe-1') })) as {
      id: string
      status: string
      files: number
      resources: number
    }
    expect(output).toMatchObject({ id: 't-probe', status: 'running', files: 2, resources: 2 })

    // 事件：最后一行是 declared，plan / intent / workerId 都落下了。
    const written = rows(file).at(-1)!
    expect(written.kind).toBe('declared')
    expect(written.id).toBe('t-probe')
    expect(written.workerId).toBe('worker-probe-1')
    expect(written.plan).toEqual(plan)
    expect(written.intent).toEqual(intent)

    // 快照：plan / intent 折进去，status 还是 running（declared 不写状态）。
    const snapshot = new TicketStore(file).get('t-probe')!
    expect(snapshot.status).toBe('running')
    expect(snapshot.plan).toEqual(plan)
    expect(snapshot.intent).toEqual(intent)
  })

  it('没有票时拒绝：worker 名下没票就报错，不写日志', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)
    const before = rows(file).length

    await expect(
      call('dispatch_declare', { plan, intent }, { agent: worker(host, 'worker-nobody') }),
    ).rejects.toThrow('没有挂在这个 worker 上的票')
    expect(rows(file)).toHaveLength(before)
  })

  it('票已结束时拒绝：done / dropped 都不许再声明', async () => {
    for (const status of ['done', 'dropped'] as const) {
      const file = probeTicket(status)
      const { host, call } = mount(file)
      const before = rows(file).length

      await expect(
        call('dispatch_declare', { plan, intent }, { agent: worker(host, 'worker-probe-1') }),
      ).rejects.toThrow(/票 t-probe 已结束/)
      expect(rows(file)).toHaveLength(before)
      expect(new TicketStore(file).get('t-probe')!.plan).toBeUndefined()
    }
  })

  it('别人的票拒绝：票挂在 worker-probe-1 上，worker-other 调也写不进去', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)
    const before = rows(file).length

    await expect(
      call('dispatch_declare', { plan, intent }, { agent: worker(host, 'worker-other-1') }),
    ).rejects.toThrow('没有挂在这个 worker 上的票')
    expect(rows(file)).toHaveLength(before)
    expect(new TicketStore(file).get('t-probe')!.plan).toBeUndefined()
  })

  it('只给 plan 时沿用票上已有的 intent，不把开票意图清空', async () => {
    const file = logFile([
      {
        kind: 'published',
        id: 't-keep',
        at: T(0),
        goal: '保留开票意图',
        brief: '保留开票意图',
        publisher: 'session-main',
        preset: 't2',
        presetSource: 'fallback',
        requestId: 'req-keep-1',
        intent: { reversibility: 'manual', impact: { services: ['dsh-example'] } },
      },
      { kind: 'spawned', id: 't-keep', at: T(1), cause: 'tool', workerId: 'worker-keep-1', preset: 't2' },
    ])
    const { host, call } = mount(file)

    const output = (await call(
      'dispatch_declare',
      { plan },
      { agent: worker(host, 'worker-keep-1') },
    )) as { id: string; status: string; files: number; resources: number }
    expect(output).toMatchObject({ id: 't-keep', status: 'running', files: 2, resources: 0 })

    const snapshot = new TicketStore(file).get('t-keep')!
    expect(snapshot.plan).toEqual(plan)
    expect(snapshot.intent).toEqual({ reversibility: 'manual', impact: { services: ['dsh-example'] } })
  })

  it('intent 的可选栏都收下：impact 三栏、reversibility、dryRun、undo', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)
    await call(
      'dispatch_declare',
      {
        plan,
        intent: {
          writes: ['file:/tmp/a.ts'],
          reads: ['dir:/tmp'],
          impact: { paths: ['/tmp/a.ts'], services: ['dsh-example'], remotes: ['origin'] },
          reversibility: 'manual',
          dryRun: { ok: false, detail: '预演没过' },
          undo: { kind: 'file', ref: '/tmp/a.ts.bak', howto: 'cp /tmp/a.ts.bak /tmp/a.ts' },
        },
      },
      { agent: worker(host, 'worker-probe-1') },
    )
    const snapshot = new TicketStore(file).get('t-probe')!
    expect(snapshot.intent).toEqual({
      writes: ['file:/tmp/a.ts'],
      reads: ['dir:/tmp'],
      impact: { paths: ['/tmp/a.ts'], services: ['dsh-example'], remotes: ['origin'] },
      reversibility: 'manual',
      dryRun: { ok: false, detail: '预演没过' },
      undo: { kind: 'file', ref: '/tmp/a.ts.bak', howto: 'cp /tmp/a.ts.bak /tmp/a.ts' },
    })
  })

  it('intent 只给 reads、dryRun 不带 detail、undo 不带 ref：可选项缺省不报错', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)
    await call(
      'dispatch_declare',
      {
        plan: { summary: '只读一份', files: [{ path: '/tmp/a.ts' }] },
        intent: { reads: ['dir:/tmp'], dryRun: { ok: true }, undo: { kind: 'git', howto: 'git revert abc1234' } },
      },
      { agent: worker(host, 'worker-probe-1') },
    )
    const snapshot = new TicketStore(file).get('t-probe')!
    expect(snapshot.intent).toEqual({
      reads: ['dir:/tmp'],
      dryRun: { ok: true },
      undo: { kind: 'git', howto: 'git revert abc1234' },
    })
    expect(snapshot.plan).toEqual({ summary: '只读一份', files: [{ path: '/tmp/a.ts' }] })
  })

  it('资源串不合法：拒收，回执说清怎么改，库里一行不多', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)
    const before = rows(file).length

    await expect(
      call(
        'dispatch_declare',
        {
          plan,
          intent: {
            writes: ['cmd:ls', 'http:docs.deepseek.com', 'port:192.0.2.10:8080 (gw)'],
            reads: [],
            reversibility: 'auto',
          },
        },
        { agent: worker(host, 'worker-probe-1') },
      ),
    ).rejects.toThrow(/资源串不合法.*cmd:ls.*http:docs\.deepseek\.com.*命令写进 plan\.summary/s)
    expect(rows(file)).toHaveLength(before)
    expect(new TicketStore(file).get('t-probe')!.plan).toBeUndefined()
  })

  it('plan 与 intent 都空：不写一条没内容的声明', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)
    const before = rows(file).length

    await expect(
      call('dispatch_declare', {}, { agent: worker(host, 'worker-probe-1') }),
    ).rejects.toThrow(/declare 必须给 plan/)
    expect(rows(file)).toHaveLength(before)
  })

  it('只给 plan 不给 intent，票上也没有旧 intent：拒绝，不进执行轮', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)
    const before = rows(file).length

    await expect(
      call('dispatch_declare', { plan }, { agent: worker(host, 'worker-probe-1') }),
    ).rejects.toThrow(/declare 必须给 intent/)
    expect(rows(file)).toHaveLength(before)
  })

  it('只给 intent 不给 plan：拒绝', async () => {
    const file = probeTicket()
    const { host, call } = mount(file)
    const before = rows(file).length

    await expect(
      call('dispatch_declare', { intent }, { agent: worker(host, 'worker-probe-1') }),
    ).rejects.toThrow(/declare 必须给 plan/)
    expect(rows(file)).toHaveLength(before)
  })
})
