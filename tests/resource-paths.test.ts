/**
 * 声明的路径基准：declare 与 touch 都按票的 dir 归一化，落盘是绝对路径。
 *
 * 今天那张票的死结之一：declare 只校验不归一化，touch 审计按宿主 cwd 归一化，
 * 同一份声明和同一次写入变成两套写法，关票就误报「动了没声明的资源」。这里从工
 * 具层一路走到关票对账，钉死三件事：
 *
 * 1. declare 的相对路径按票的 dir 解析成绝对路径落盘，回执回显「相对 → 绝对」；
 * 2. touch 先取票再按同一把尺子归一化，绝对/相对两种写法都能跟 declared 对上账；
 * 3. 票上没有 dir 时不猜宿主 cwd：相对路径原样保留，回执明说没解析。
 *
 * 另外两条接线：declare 成功后当场重判排队票（不再白等下一次收工），任务书要求
 * 写绝对路径并打出票的 dir。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore } from '../src/store'
import { buildPrompt } from '../src/tickets/publish'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'
import type { FakePluginHost } from './helpers/plugin-harness'
import { flush, makeDesk } from './helpers/desk-harness'
import type { Harness } from './helpers/desk-harness'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  cleanTempDirs()
})

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 16, 12, 0, seconds)).toISOString()

function tempDir(prefix = 'dispatcher-paths-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function logFile(lines: Array<Record<string, unknown>>, dir: string): string {
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

function rows(file: string): Array<Record<string, unknown>> {
  const text = readFileSync(file, 'utf8').trim()
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : []
}

/** 一张带 dir 的探路票：published 里落 dir，workerId 是 `worker-path-1`。 */
function probeTicket(dir: string | undefined, extra: Record<string, unknown> = {}): string {
  const home = tempDir()
  return logFile(
    [
      {
        kind: 'published',
        id: 't-path',
        at: T(0),
        goal: '声明按票的 dir 归一化',
        brief: '路径基准',
        publisher: 'session-main',
        preset: 't2',
        presetSource: 'fallback',
        requestId: 'req-path-1',
        ...(dir ? { dir } : {}),
        ...extra,
      },
      { kind: 'spawned', id: 't-path', at: T(1), cause: 'tool', workerId: 'worker-path-1', preset: 't2' },
    ],
    home,
  )
}

type Call = (name: string, args: Record<string, unknown>, options?: { agent?: unknown }) => Promise<unknown>

function mount(file: string): { host: FakePluginHost; call: Call } {
  const host = mountPlugin({ config: { stateFile: file } })
  return { host, call: (name, args, options) => host.call(name, args, options as never) }
}

function worker(host: FakePluginHost, id: string): unknown {
  return host.makeAgent('subagent', id)
}

/** 跑工具的 output.render：模型看到的就是这一段文本。 */
function render(host: FakePluginHost, name: string, args: Record<string, unknown>, value: unknown): string {
  const output = host.definition(name).output as {
    render?: (args: Record<string, unknown>, value: unknown) => Array<{ type: string; text: string }>
  }
  return (output.render?.(args, value) ?? []).map((block) => block.text).join('\n')
}

describe('declare 按票的 dir 归一化并回显', () => {
  it('相对路径落盘成绝对路径，回执列出「相对 → 绝对」', async () => {
    const dir = tempDir()
    const file = probeTicket(dir)
    const { host, call } = mount(file)

    const output = (await call(
      'dispatch_declare',
      {
        plan: { summary: '加通知', files: [{ path: 'src/tickets/notify.ts' }] },
        intent: {
          writes: ['file:src/tickets/notify.ts', 'dir:src/tickets'],
          reads: ['file:src/tickets/arbiter.ts'],
          reversibility: 'auto',
        },
      },
      { agent: worker(host, 'worker-path-1') },
    )) as { id: string; resolved: Array<{ from: string; to: string }>; unresolved: string[] }

    expect(output.resolved).toEqual([
      { from: 'file:src/tickets/notify.ts', to: `file:${dir}/src/tickets/notify.ts` },
      { from: 'dir:src/tickets', to: `dir:${dir}/src/tickets` },
      { from: 'file:src/tickets/arbiter.ts', to: `file:${dir}/src/tickets/arbiter.ts` },
    ])
    expect(output.unresolved).toEqual([])

    // 落盘的那份是绝对路径，票面折出来也是。
    const written = rows(file).at(-1)!
    expect(written.kind).toBe('declared')
    expect((written.intent as { writes: string[] }).writes).toEqual([
      `file:${dir}/src/tickets/notify.ts`,
      `dir:${dir}/src/tickets`,
    ])
    const snapshot = new TicketStore(file).get('t-path')!
    expect(snapshot.intent?.writes).toEqual([
      `file:${dir}/src/tickets/notify.ts`,
      `dir:${dir}/src/tickets`,
    ])

    // 回显：模型当场看见解析结果。
    const text = render(host, 'dispatch_declare', {}, output)
    expect(text).toContain(`file:src/tickets/notify.ts → file:${dir}/src/tickets/notify.ts`)
    expect(text).toContain(`dir:src/tickets → dir:${dir}/src/tickets`)
  })

  it('票上没有 dir：相对路径原样落盘，回执明说没解析（不按宿主 cwd 猜）', async () => {
    const file = probeTicket(undefined)
    const { host, call } = mount(file)

    const output = (await call(
      'dispatch_declare',
      {
        plan: { summary: '改一处' },
        intent: { writes: ['file:src/tickets/notify.ts'], reversibility: 'auto' },
      },
      { agent: worker(host, 'worker-path-1') },
    )) as { resolved: unknown[]; unresolved: string[] }

    expect(output.resolved).toEqual([])
    expect(output.unresolved).toEqual(['file:src/tickets/notify.ts'])
    expect(new TicketStore(file).get('t-path')!.intent?.writes).toEqual(['file:src/tickets/notify.ts'])

    const text = render(host, 'dispatch_declare', {}, output)
    expect(text).toContain('票上没有 dir')
    expect(text).toContain('路径一律写绝对路径')
  })

  it('绝对路径不动：没有可回显的解析，resolved 为空', async () => {
    const dir = tempDir()
    const file = probeTicket(dir)
    const { host, call } = mount(file)

    const output = (await call(
      'dispatch_declare',
      {
        plan: { summary: '改一处' },
        intent: { writes: [`file:${dir}/a.ts`], reads: ['svc:dsh-example'], reversibility: 'auto' },
      },
      { agent: worker(host, 'worker-path-1') },
    )) as { resolved: unknown[]; unresolved: unknown[] }
    expect(output.resolved).toEqual([])
    expect(output.unresolved).toEqual([])
    expect(new TicketStore(file).get('t-path')!.intent?.writes).toEqual([`file:${dir}/a.ts`])
  })
})

describe('declare 与 touch 同基准对账', () => {
  async function declareThenClose(
    touchPaths: (ticketDir: string) => string[],
  ): Promise<{ file: string; dir: string; closed: Record<string, unknown> }> {
    const dir = tempDir()
    const file = probeTicket(dir)
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-path-1')
    await call(
      'dispatch_declare',
      {
        plan: { summary: '加通知', files: [{ path: 'src/tickets/notify.ts' }] },
        intent: { writes: ['file:src/tickets/notify.ts'], reversibility: 'auto' },
      },
      { agent },
    )
    await call('dispatch_touch', { paths: touchPaths(dir) }, { agent })
    await call('dispatch_report', { id: 't-path', text: '干完了' }, { agent })
    await host.call('dispatch_close', { id: 't-path' })
    return { file, dir, closed: rows(file).at(-1)! }
  }

  it('touch 报绝对路径：与 declared 对上账，关票不带 outOfScope', async () => {
    const { closed } = await declareThenClose((dir) => [`${dir}/src/tickets/notify.ts`])
    expect(closed.kind).toBe('closed')
    expect(closed).not.toHaveProperty('outOfScope')
  })

  it('touch 报相对路径：按票的 dir 归一化后照样对上账', async () => {
    const dir = tempDir()
    const file = probeTicket(dir)
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-path-1')
    await call(
      'dispatch_declare',
      {
        plan: { summary: '加通知' },
        intent: { writes: ['file:src/tickets/notify.ts'], reversibility: 'auto' },
      },
      { agent },
    )
    await call('dispatch_touch', { paths: ['src/tickets/notify.ts'] }, { agent })
    await call('dispatch_report', { id: 't-path', text: '干完了' }, { agent })
    await host.call('dispatch_close', { id: 't-path' })

    const snapshot = new TicketStore(file).get('t-path')!
    expect(snapshot.touched).toEqual([`file:${dir}/src/tickets/notify.ts`])
    expect(snapshot.outOfScope).toBeUndefined()
    expect(rows(file).at(-1)!).not.toHaveProperty('outOfScope')
  })

  it('验收对齐：票 dir 是仓库根，declare 相对路径落盘绝对路径，touch 同一文件对得上账', async () => {
    const { realpathSync } = await import('node:fs')
    const repo = realpathSync(process.cwd())
    const file = probeTicket(repo)
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-path-1')
    const target = `${repo}/src/tickets/notify.ts`

    const output = (await call(
      'dispatch_declare',
      {
        plan: { summary: '改通知', files: [{ path: 'src/tickets/notify.ts' }] },
        intent: { writes: ['file:src/tickets/notify.ts'], reversibility: 'auto' },
      },
      { agent },
    )) as { resolved: Array<{ from: string; to: string }> }
    expect(output.resolved).toEqual([{ from: 'file:src/tickets/notify.ts', to: `file:${target}` }])
    expect(new TicketStore(file).get('t-path')!.intent?.writes).toEqual([`file:${target}`])

    await call('dispatch_touch', { paths: [target] }, { agent })
    await call('dispatch_report', { id: 't-path', text: '干完了' }, { agent })
    await host.call('dispatch_close', { id: 't-path' })

    const snapshot = new TicketStore(file).get('t-path')!
    expect(snapshot.touched).toEqual([`file:${target}`])
    expect(snapshot.outOfScope).toBeUndefined()
    expect(rows(file).at(-1)!).not.toHaveProperty('outOfScope')
  })

  it('真越界照旧标出来：改了没声明的文件不会因为归一化被放过', async () => {
    const { dir, closed } = await declareThenClose((ticketDir) => [`${ticketDir}/src/tickets/other.ts`])
    expect(closed.outOfScope).toEqual([`file:${dir}/src/tickets/other.ts`])
  })
})

describe('declare 成功后放行排队票', () => {
  const DIR = 'dir:/tmp/resource-paths-ws'

  function fakeProbe() {
    return {
      expect: () => undefined,
      drop: () => undefined,
      release: () => true,
      releaseTicket: () => true,
    }
  }

  function desk(): Harness {
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe: fakeProbe() })
    h.desk.attach()
    return h
  }

  async function idle(h: Harness, workerId: string): Promise<void> {
    h.host.emit('agent/status', { status: 'idle', agent: { id: workerId } })
    await flush()
  }

  async function openProbe(h: Harness, goal: string, writes: string[]): Promise<string> {
    const receipt = await h.desk.open({ goal, brief: goal }, h.main)
    await h.desk.declare(h.log.get(receipt.id)!.workerId!, { summary: goal }, { writes })
    return receipt.id
  }

  it('挡路票补了不撞的新声明：排队票当场重判放行，不用等收工', async () => {
    const h = desk()
    const blocker = await openProbe(h, '占住目录', [DIR])
    // 用票上真实的 workerId idle：A 的执行轮可能重起成另一只，别硬编码。
    await idle(h, h.log.get(blocker)!.workerId!)
    expect(h.log.get(blocker)!.phase).toBe('running')

    const waiter = await openProbe(h, '抢目录', [DIR])
    await idle(h, h.log.get(waiter)!.workerId!)
    expect(h.log.get(waiter)!.phase).toBe('queued')

    // 挡路票重新声明：不再写那片目录。声明一落盘就该重判排队票。
    await h.desk.declare(
      h.log.get(blocker)!.workerId!,
      { summary: '改别处' },
      { writes: ['dir:/tmp/resource-paths-elsewhere'] },
    )

    const released = h.log.get(waiter)!
    expect(released.phase).not.toBe('queued')
    expect(released.waitOn).toBeUndefined()
  })
})

describe('任务书要求绝对路径并打出票的 dir', () => {
  const base = { ticketId: 't-path', goal: '改一处', brief: '路径基准' }

  it('探路轮打出票的 dir，并说清相对路径按它解析', () => {
    const prompt = buildPrompt({ ...base, epoch: 1, round: 'probe', dir: '/home/julia/fatfish/plugins/dsh-dispatcher' })
    expect(prompt).toContain('票的 dir：/home/julia/fatfish/plugins/dsh-dispatcher')
    expect(prompt).toContain('路径一律写绝对路径')
  })

  it('探路轮没有 dir 时明说：相对路径没有基准', () => {
    const prompt = buildPrompt({ ...base, epoch: 1, round: 'probe' })
    expect(prompt).toContain('票上没有 dir')
    expect(prompt).toContain('路径一律写绝对路径')
  })

  it('执行轮与降级轮也要求绝对路径', () => {
    expect(buildPrompt({ ...base, epoch: 2, round: 'task' })).toContain('路径一律写绝对路径')
    expect(buildPrompt({ ...base, epoch: 2, round: 'degraded' })).toContain('路径一律写绝对路径')
  })
})
