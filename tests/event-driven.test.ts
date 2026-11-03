import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { apply, ticketEventQueue } from '../src/index'
import { TicketStore, pending } from '../src/store'
import type { TicketBroadcast, TicketSnapshot } from '../src/store'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const OWNER = 'session-owner-0001'
const WORKER = 'session-worker-0001'
const DEAD = 'session-dead-0001'

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 3, 0, 0, seconds)).toISOString()
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-events-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

interface Agent {
  status?: string
  followup?: (message: unknown) => Promise<unknown>
  steer?: (message: unknown) => Promise<unknown>
}

interface Agents {
  list(): Agent[]
  get(id: string): Agent | undefined
}

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
    quietSweep: true,
    ownerSessionId: '',
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
    workerPromptPrune: true,
    notifyScript: '',
    notifyTimeoutMs: 5000,
    ...overrides,
  }
}

interface RegisteredTool {
  execute(args: Record<string, unknown>): Promise<unknown>
}

interface Mount {
  tools: Map<string, RegisteredTool>
  inbox: unknown[]
  events: TicketBroadcast[]
  steer: unknown[]
  mutateAgent(id: string, patch: Partial<Agent>): void
  emit(name: string, payload: unknown): void
  settle(): Promise<void>
}

/**
 * Mount with a real (tiny) event bus: `emit` reaches listeners synchronously,
 * which is what the plugin's store does after an append. The owner session and
 * whichever workers a test registers live in the same agent table.
 */
function mount(stateFile: string, overrides: Partial<Config> = {}): Mount {
  const tools = new Map<string, RegisteredTool>()
  const inbox: unknown[] = []
  const events: TicketBroadcast[] = []
  const steer: unknown[] = []
  const listeners = new Map<string, Array<(payload: never) => unknown>>()

  const owner: Agent = {
    status: 'idle',
    followup: async (message) => {
      inbox.push(message)
      return undefined
    },
    steer: async (message) => {
      steer.push(message)
      return undefined
    },
  }
  const table = new Map<string, Agent>([[OWNER, owner]])
  const agents: Agents = {
    // 顶部安装白名单/剪枝钩子会遍历活表，假 agent 没有 session.header；这几条
    // 测试只走 get，扮活表用 get 就够了。agentAlive 的 list 兜底不在这几条路径上。
    list: () => [],
    get: (id: string) => table.get(id),
  }

  const ctx = {
    agents,
    effect: (callback: () => () => void) => callback(),
    on(name: string, listener: (payload: never) => unknown) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {}
    },
    emit(name: string, payload: unknown) {
      if (name === 'dispatcher/ticket') events.push(payload as TicketBroadcast)
      for (const listener of listeners.get(name) ?? []) listener(payload as never)
    },
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

  return {
    tools,
    inbox,
    events,
    steer,
    mutateAgent(id: string, patch: Partial<Agent>) {
      const agent = table.get(id) ?? {}
      table.set(id, { ...agent, ...patch })
    },
    emit(name: string, payload: unknown) {
      ctx.emit(name, payload)
    },
    async settle() {
      await (ticketEventQueue.get(ctx)?.() ?? Promise.resolve())
    },
  }
}

function snapshot(file: string, id: string): TicketSnapshot {
  const ticket = new TicketStore(file).get(id)
  expect(ticket).toBeTruthy()
  return ticket!
}

function injectedText(inbox: unknown[]): string {
  return inbox
    .flatMap((message) => {
      const content = (message as { content?: Array<{ text?: string }> }).content ?? []
      return content.map((part) => part.text ?? '')
    })
    .join('')
}

describe('票事件广播', () => {
  it('append 成功后广播 { id, at, kind }，外部写入能听见', async () => {
    const file = logFile([{ id: 't-1', at: T(0), goal: 'a', status: 'open' }])
    const host = mount(file)

    await host.tools.get('dispatch_send')!.execute({ id: 't-1', text: '继续' })
    await host.settle()

    expect(host.events.map((event) => event.kind)).toEqual(['input'])
    expect(host.events[0]).toMatchObject({ id: 't-1' })
    expect(typeof host.events[0]!.at).toBe('string')
  })

  it('内部写入不广播，也不自激', async () => {
    // 两张票正好踩中 sweep 自己会写的两处：重开（store.update）和清报告账
    // （markDelivered）。quiet 挂了的话，这两笔会各自再叫醒一轮处理器。
    const file = logFile([
      { id: 't-reopen', at: T(0), goal: '结束后又来信', status: 'open' },
      { id: 't-reopen', at: T(9), status: 'done' },
      { id: 't-reopen', at: T(10), input: { id: 'e-late', text: '晚了但还要做' } },
      { id: 't-clear', at: T(0), goal: '已关票的报告', status: 'open' },
      { id: 't-clear', at: T(1), report: { id: 'e-r', text: '交活' } },
      { id: 't-clear', at: T(2), status: 'done' },
    ])
    const host = mount(file, { quietSweep: true })

    await host.tools.get('dispatch_sweep')!.execute({})
    await host.settle()

    expect(host.events).toHaveLength(0)
    expect(snapshot(file, 't-reopen').status).toBe('open')
    expect(pending(snapshot(file, 't-clear').reports)).toHaveLength(0)

    // quiet 是计数器：sweep 的写入结束后，下一次真要广播的写入照常发。
    // 这张票是 done，输入落在 closedAt 之后，所以是 input + 重开的 status 两条。
    await host.tools.get('dispatch_send')!.execute({ id: 't-clear', text: '再补一句' })
    await host.settle()
    expect(host.events.map((event) => event.kind)).toEqual(['input', 'status'])
  })
})

describe('dispatch_send 当场重开', () => {
  it('done 票在 closedAt 之后收到 input，立刻重开，不等 tick', async () => {
    const file = logFile([
      { id: 't-done', at: T(0), goal: '收尾的活', status: 'open' },
      { id: 't-done', at: T(9), status: 'done', note: '交付' },
    ])
    const host = mount(file, { notifyOwner: false })

    const result = (await host.tools.get('dispatch_send')!.execute({
      id: 't-done',
      text: '还有个尾巴',
    })) as { delivered: boolean; pendingInputs: number }

    expect(result.delivered).toBe(false)
    expect(result.pendingInputs).toBe(1)
    const ticket = snapshot(file, 't-done')
    expect(ticket.status).toBe('open')
    expect(ticket.closedAt).toBeUndefined()
  })

  it('dropped 的票不重开：那是人按下的停止', async () => {
    const file = logFile([
      { id: 't-dropped', at: T(0), goal: '别做了', status: 'open' },
      { id: 't-dropped', at: T(9), status: 'dropped', note: '主人叫停' },
    ])
    const host = mount(file, { notifyOwner: false })

    await host.tools.get('dispatch_send')!.execute({ id: 't-dropped', text: '再想想' })

    expect(snapshot(file, 't-dropped').status).toBe('dropped')
  })
})

describe('宿主事件', () => {
  it('agent/disposed 立刻按 ownerId 判 worker-gone，只推提醒不改 status', async () => {
    // 新建不到 2 分钟：sweep 的 freshMinutes 宽限本该压住，但 disposed 的 id
    // 是从活表里摘掉的，不存在「注册还没落地」这回事，应当立刻判。
    const file = logFile([
      { id: 't-gone', at: minutesAgo(1), goal: '小鱼没了', status: 'open' },
      { id: 't-gone', at: minutesAgo(1), owner: 't4 查qqbot PR', ownerId: DEAD, status: 'running' },
    ])
    const host = mount(file, { notifyOwner: true, quietSweep: false, ownerSessionId: OWNER })

    host.emit('agent/disposed', { agent: { session: { id: DEAD } } })
    await host.settle()

    expect(host.inbox).toHaveLength(1)
    const text = injectedText(host.inbox)
    expect(text).toContain('t-gone')
    expect(text).toContain('worker-gone')
    // 巡检只推提醒：status 还是 running，收票/关票只归主会话。
    expect(snapshot(file, 't-gone').status).toBe('running')
  })

  it('agent/status 变 idle 立刻投递名下的排队 input', async () => {
    const file = logFile([
      { id: 't-waiting-input', at: minutesAgo(3), goal: '排队等小鱼', status: 'open' },
      {
        id: 't-waiting-input',
        at: minutesAgo(3),
        owner: 'worker',
        ownerId: WORKER,
        status: 'running',
        input: { id: 'e-q1', text: '这条该马上到' },
      },
      // 对照：排在同一条日志里的另一张票，worker 不是这个 id，不该被投。
      { id: 't-other', at: minutesAgo(3), goal: '别人的活', status: 'open', ownerId: DEAD },
    ])
    const host = mount(file, { notifyOwner: false })
    host.mutateAgent(WORKER, { status: 'running', steer: async (message) => {
      host.steer.push(message)
      return undefined
    } })

    // tick 关掉了（sweepMinutes: 0），这条投递只能是 idle 事件触发的。
    host.mutateAgent(WORKER, { status: 'idle' })
    host.emit('agent/status', { agent: { session: { id: WORKER } }, status: 'idle' })
    await host.settle()

    expect(host.steer).toHaveLength(1)
    const text = injectedText(host.steer)
    expect(text).toContain('这条该马上到')
    expect(pending(snapshot(file, 't-waiting-input').inputs)).toHaveLength(0)
    expect(pending(snapshot(file, 't-other').inputs)).toHaveLength(0)
  })

  it('agent/status 不是 idle 时不动票', async () => {
    const file = logFile([
      { id: 't-busy', at: minutesAgo(3), goal: '还在跑', status: 'open' },
      {
        id: 't-busy',
        at: minutesAgo(3),
        ownerId: WORKER,
        status: 'running',
        input: { id: 'e-q2', text: '排队' },
      },
    ])
    const host = mount(file, { notifyOwner: false })
    host.mutateAgent(WORKER, { status: 'running' })

    host.emit('agent/status', { agent: { session: { id: WORKER } }, status: 'running' })
    await host.settle()

    expect(host.steer).toHaveLength(0)
    expect(pending(snapshot(file, 't-busy').inputs)).toHaveLength(1)
  })
})
