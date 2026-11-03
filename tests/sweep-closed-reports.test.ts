import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { apply } from '../src/index'
import { TicketStore, pending } from '../src/store'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A log with fixed timestamps: the order under test is not the clock's. */
function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-closed-reports-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

const OWNER = 'session-owner'

function testConfig(stateFile: string, overrides: Partial<Config> = {}): Config {
  return {
    stateFile,
    staleMinutes: 30,
    maxOpen: 8,
    briefMaxColumns: 20,
    handoffPolicy: false,
    handoffPolicyText: '',
    sweepMinutes: 0,
    zombieMinutes: 20,
    noReportMinutes: 5,
    notifyOwner: false,
    quietSweep: false,
    ownerSessionId: OWNER,
    qqPrefsPath: join(stateFile, '..', 'prefs.json'),
    ownerOpenId: '',
    noWaitGuard: false,
    maxCommandMs: 30000,
    maxWaitMs: 5000,
    routerRestrict: false,
    routerEscapeFile: join(stateFile, '..', 'no-restrict'),
    routerTools: [],
    extraRouterTools: [],
    workerToolDeny: false,
    workerDenyTools: [],
    notifyScript: '',
    notifyTimeoutMs: 5000,
    ...overrides,
  }
}

interface RegisteredTool {
  execute(args: Record<string, unknown>): Promise<unknown>
}

interface Injected {
  text: string
}

/**
 * Mount the plugin the way the host does, with an idle owner session that
 * records every followup the sweep sends it.
 */
function mount(
  stateFile: string,
  overrides: Partial<Config> = {},
): { tools: Map<string, RegisteredTool>; inbox: Injected[] } {
  const tools = new Map<string, RegisteredTool>()
  const inbox: Injected[] = []
  const owner = {
    status: 'idle',
    followup: async (message: unknown) => {
      inbox.push(message as Injected)
      return undefined
    },
    steer: async () => undefined,
  }
  const ctx = {
    agents: {
      list: () => [],
      get: (id: string) => (id === OWNER ? owner : undefined),
    },
    effect: (callback: () => () => void) => callback(),
    on: () => () => {},
    tools: {
      register(definition: { name: string } & RegisteredTool) {
        tools.set(definition.name, definition)
        return () => {}
      },
      get: () => undefined,
    },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx as never, testConfig(stateFile, overrides))
  return { tools, inbox }
}

/** The text the sweep injected, as the owner session would read it. */
function injectedText(inbox: Injected[]): string {
  return inbox
    .flatMap((message) => {
      const content = (message as unknown as { content?: Array<{ text?: string }> }).content ?? []
      return content.map((part) => part.text ?? '')
    })
    .join('')
}

interface SweepOutput {
  stale: number
  delivered: number
  cleared: number
  woke: boolean
  reason: string
}

async function sweep(tools: Map<string, RegisteredTool>): Promise<SweepOutput> {
  return (await tools.get('dispatch_sweep')!.execute({})) as SweepOutput
}

/** A moment on 2026-11-01, far enough in the past to be judged idle. */
const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 1, 0, 0, seconds)).toISOString()

describe('a sweep never delivers reports', () => {
  // 2026-11-02 19:40：定时器一恢复，sweep 把 tickets.jsonl 里所有积压报告倒进主会话，
  // 158 条全在 done/dropped 票上。这一刀之后报告这条推送线整个撤掉：open 票的报告留在
  // pending 上等主会话自己扫，done/dropped 票的静默清账，一句话都不发。
  it('pushes nothing, keeps an open report pending and clears the done one', async () => {
    const file = logFile([
      { id: 't-done', at: T(0), goal: '早就交完的活', status: 'open', dir: '/tmp' },
      { id: 't-done', at: T(1), owner: 'dead-worker', status: 'running' },
      { id: 't-done', at: T(2), report: { id: 'e-done', text: 'DONE-REPORT 已收尾，别推' } },
      { id: 't-done', at: T(3), status: 'done', note: '主会话已收票' },
      { id: 't-open', at: T(4), goal: '还在跑的活', status: 'open' },
      { id: 't-open', at: T(5), owner: 'live-worker', status: 'running' },
      { id: 't-open', at: T(6), report: { id: 'e-open', text: 'OPEN-REPORT 进度 3/5' } },
    ])

    const { tools, inbox } = mount(file)
    const result = await sweep(tools)

    // 一条 followup 都没有：没有僵尸票，sweep 一个字都不发。
    expect(inbox).toHaveLength(0)
    expect(result.woke).toBe(false)
    expect(result.reason).toBe('')

    // 已关票那条被静默清账：不再 pending，deliveredAt 有值，原文还在日志里。
    const done = new TicketStore(file).get('t-done')!
    expect(pending(done.reports)).toHaveLength(0)
    expect(done.reports[0]!.deliveredAt).toBeTruthy()
    expect(done.reports[0]!.text).toBe('DONE-REPORT 已收尾，别推')

    // 未结票那条一个字都别动：还 pending，dispatch_list 的 «n 要看得见它。
    const open = new TicketStore(file).get('t-open')!
    expect(pending(open.reports)).toHaveLength(1)
    expect(open.reports[0]!.delivered).toBe(false)
    expect(open.reports[0]!.deliveredAt).toBeUndefined()

    // 计数分开：cleared 是「清掉几条已关票报告」，delivered 只数交给 worker 的排队消息。
    expect(result.cleared).toBe(1)
    expect(result.delivered).toBe(0)
  })

  it('clears a dropped ticket report and never wakes the owner', async () => {
    const file = logFile([
      { id: 't-dropped', at: T(0), goal: '主人喊停的活', status: 'open' },
      { id: 't-dropped', at: T(1), report: { id: 'e-dropped', text: 'DROP-REPORT 交了一半' } },
      { id: 't-dropped', at: T(2), status: 'dropped', note: '主人叫停' },
    ])

    const { tools, inbox } = mount(file)
    const result = await sweep(tools)

    expect(inbox).toHaveLength(0)
    expect(result.woke).toBe(false)
    expect(result.cleared).toBe(1)
    expect(pending(new TicketStore(file).get('t-dropped')!.reports)).toHaveLength(0)
  })

  // 重开（notices）也只改状态：票回到 open，报告留在 pending 上，但不叫醒主会话。
  it('reopens a done ticket without waking anyone, and keeps its report pending', async () => {
    const file = logFile([
      { id: 't-back', at: T(0), goal: '重开的活', status: 'open' },
      { id: 't-back', at: T(1), report: { id: 'e-back', text: 'BACK-REPORT 补完' } },
      { id: 't-back', at: T(5), status: 'done', note: '先交了' },
      { id: 't-back', at: T(9), input: { id: 'e-more', text: '主人补了一句' } },
    ])

    const { tools, inbox } = mount(file)
    const result = await sweep(tools)

    const ticket = new TicketStore(file).get('t-back')!
    expect(ticket.status).toBe('open')
    expect(ticket.closedAt).toBeUndefined()
    expect(inbox).toHaveLength(0)
    expect(result.woke).toBe(false)
    // 票已经是 open，那条报告不是「已关票积压」，一条都不清。
    expect(result.cleared).toBe(0)
    expect(pending(ticket.reports)).toHaveLength(1)
  })

  describe('only a zombie ticket wakes the owner', () => {
    it('sends one summary line, no report body, and leaves the report pending', async () => {
      const file = logFile([
        { id: 't-zombie', at: T(0), goal: '跑丢了的活', status: 'open' },
        { id: 't-zombie', at: T(1), owner: 'short-label', status: 'running' },
        { id: 't-zombie', at: T(2), report: { id: 'e-zombie', text: 'ZOMBIE-REPORT 正文不该出现' } },
      ])

      const { tools, inbox } = mount(file, { notifyOwner: true })
      const result = await sweep(tools)

      expect(result.woke).toBe(true)
      expect(inbox).toHaveLength(1)
      const text = injectedText(inbox)
      expect(text).toContain('t-zombie')
      expect(text).toContain('疑似没动静')
      expect(text).toContain('未读报告 1 条')
      // 摘要不带报告正文，报告也不因此被标已读。
      expect(text).not.toContain('ZOMBIE-REPORT')
      expect(pending(new TicketStore(file).get('t-zombie')!.reports)).toHaveLength(1)
    })

    it('says nothing on a second sweep with the same fingerprint', async () => {
      const file = logFile([{ id: 't-zombie', at: T(0), goal: '跑丢了的活', status: 'running' }])

      const { tools, inbox } = mount(file, { notifyOwner: true })
      expect((await sweep(tools)).woke).toBe(true)
      expect(inbox).toHaveLength(1)

      expect((await sweep(tools)).woke).toBe(false)
      expect(inbox).toHaveLength(1)
    })
  })

  it('does not clear twice, in this process or a fresh one', async () => {
    const file = logFile([
      { id: 't-done', at: T(0), goal: '老活', status: 'open' },
      { id: 't-done', at: T(1), report: { id: 'e-done', text: 'OLD-REPORT' } },
      { id: 't-done', at: T(2), status: 'done' },
    ])

    const first = mount(file)
    expect((await sweep(first.tools)).cleared).toBe(1)
    expect(first.inbox).toHaveLength(0)

    // 同一个进程再来一轮，以及一个全新进程（重读日志），都不该再清一遍。
    expect((await sweep(first.tools)).cleared).toBe(0)
    const second = mount(file)
    expect((await sweep(second.tools)).cleared).toBe(0)
    expect(second.inbox).toHaveLength(0)

    // 清账写在日志里，不是内存里的记忆：重读还是已投递，而且只有一条。
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.filter((line) => line.delivered?.kind === 'report')).toHaveLength(1)
  })
})
