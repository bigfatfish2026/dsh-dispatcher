import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { apply } from '../src/index'
import { TicketStore, foldEvents } from '../src/store'

/**
 * 2026-11-03：票的 owner 拆成两栏——`owner` 是人话标签（屏幕上显示的就是它），
 * `ownerId` 是 spawn 返回的会话 id。
 *
 * 老规矩里 owner 是自由文本，巡检只能从里面抽 ≥6 位 hex 片段去活表比对。主会话
 * 写的是「t4 查qqbot PR」这种中文标签，抽不出片段，worker-gone 就永远不触发，
 * 只能等 20 分钟 silent。现在开票时带 ownerId，巡检直接精确比对；没带 ownerId 的
 * 老票照旧走老路，一条都不许变。
 */

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-owner-id-'))
  dirs.push(dir)
  return join(dir, 'tickets.jsonl')
}

function logFile(lines: Array<Record<string, unknown>>): string {
  const file = tempFile()
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

/** 时间要相对真实时钟：sweep 用的是 new Date()。 */
const minutesAgo = (min: number): string => new Date(Date.now() - min * 60_000).toISOString()

const OWNER = 'session-owner'
const FULL = '34b183b9-5d77-4c3e-9f00-112233445566'
const FULL_SESSION = `session-${FULL}`
const DEAD = 'aff73fb2-0000-4111-8222-333344445555'

function testConfig(stateFile: string): Config {
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
    notifyOwner: true,
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
    workerPromptPrune: true,
    notifyScript: '',
    notifyTimeoutMs: 5000,
  }
}

interface RegisteredTool {
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface Mounted {
  tools: Map<string, RegisteredTool>
  inbox: unknown[]
  warns: string[]
  /** Fire a host event at the plugins that subscribed to it. */
  emit(name: string, payload: unknown): void
}

/** 活表里的 agent 要够 install 用：有 session.header，也有 ctx 上那几个钩子。 */
function makeAgent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: { id, header: {} },
    ...extra,
    ctx: {
      effect: (callback: () => () => void) => callback(),
      on: () => () => {},
      tools: {
        restrict: () => () => {},
        guard: () => () => {},
        get: () => undefined,
      },
    },
  }
}

/**
 * 挂插件。`registered` 是活表里认得出的会话（会被 get 和 list 同时答上）。
 * `withGet: false` 模拟查活那条路还没就绪：ctx.agents 在，但没有 get。
 */
function mount(
  stateFile: string,
  options: { registered?: readonly string[]; withGet?: boolean } = {},
): Mounted {
  const registered = options.registered ?? []
  const tools = new Map<string, RegisteredTool>()
  const inbox: unknown[] = []
  const warns: string[] = []
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>()

  const owner = makeAgent(OWNER, {
    status: 'idle',
    followup: async (message: unknown) => {
      inbox.push(message)
      return undefined
    },
    steer: async () => undefined,
  })
  const workers = registered.filter((id) => id !== OWNER).map((id) => makeAgent(id))
  const live = [owner, ...workers]

  // 活表按 session id 建索引，裸 uuid 和 session- 前缀两种写法都答得上。
  const liveById = new Map<string, Record<string, unknown>>()
  for (const agent of live) {
    const id = String((agent.session as { id: string }).id)
    liveById.set(id, agent)
    liveById.set(id.replace(/^session-/, ''), agent)
    liveById.set(`session-${id.replace(/^session-/, '')}`, agent)
  }
  const agents =
    options.withGet === false
      ? { list: () => live }
      : { list: () => live, get: (id: string) => liveById.get(id) }

  const ctx = {
    agents,
    effect: (callback: () => () => void) => callback(),
    on(name: string, listener: (payload: unknown) => unknown) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    tools: {
      register(definition: { name: string } & RegisteredTool) {
        tools.set(definition.name, definition)
        return () => {}
      },
      get: () => undefined,
    },
    logger: { info: () => {}, warn: (line: string) => warns.push(line) },
  }
  apply(ctx as never, testConfig(stateFile))
  return {
    tools,
    inbox,
    warns,
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
  }
}

function injectedText(inbox: unknown[]): string {
  return inbox
    .flatMap((message) => {
      const content = (message as unknown as { content?: Array<{ text?: string }> }).content ?? []
      return content.map((part) => part.text ?? '')
    })
    .join('')
}

interface OpenOutput {
  id: string
  status: string
}

interface SweepOutput {
  stale: number
  woke: boolean
}

describe('store 认 ownerId', () => {
  it('folds ownerId 到快照上，老票读到就是 undefined', () => {
    const snapshots = foldEvents([
      { id: 't-new', at: '2026-11-03T00:00:00.000Z', goal: '新票', status: 'open' },
      {
        id: 't-new',
        at: '2026-11-03T00:01:00.000Z',
        status: 'running',
        owner: 't4 查qqbot PR',
        ownerId: FULL,
      },
      { id: 't-old', at: '2026-11-03T00:00:00.000Z', goal: '老票', status: 'running', owner: FULL },
    ])
    const fresh = snapshots.find((ticket) => ticket.id === 't-new')
    expect(fresh?.owner).toBe('t4 查qqbot PR')
    expect(fresh?.ownerId).toBe(FULL)
    expect(snapshots.find((ticket) => ticket.id === 't-old')?.ownerId).toBeUndefined()
  })
})

describe('dispatch_open 校验 ownerId', () => {
  it('ownerId 命中活表就开票，两栏都落盘', async () => {
    const file = tempFile()
    const { tools } = mount(file, { registered: [FULL] })
    const opened = (await tools.get('dispatch_open')!.execute({
      goal: '查一下 qqbot 的 PR',
      brief: '查qqbot PR',
      owner: 't4 查qqbot PR',
      ownerId: FULL,
    })) as unknown as OpenOutput

    expect(opened.status).toBe('running')
    const ticket = new TicketStore(file).get(opened.id)
    expect(ticket?.owner).toBe('t4 查qqbot PR')
    expect(ticket?.ownerId).toBe(FULL)
  })

  it('带 session- 前缀的 ownerId 也认', async () => {
    const file = tempFile()
    const { tools } = mount(file, { registered: [FULL] })
    await expect(
      tools.get('dispatch_open')!.execute({
        goal: 'g',
        brief: '前缀写法',
        owner: '小鱼',
        ownerId: FULL_SESSION,
      }),
    ).resolves.toMatchObject({ status: 'running' })
  })

  it('ownerId 不在活表就拒开票，一个事件都不写', async () => {
    const file = tempFile()
    const { tools } = mount(file, { registered: [FULL] })
    await expect(
      tools.get('dispatch_open')!.execute({
        goal: 'g',
        brief: '填错 id',
        owner: '小鱼',
        ownerId: DEAD,
      }),
    ).rejects.toThrow(/ownerId 不在活表，可能是填错了或小鱼已经结束/)
    expect(existsSync(file) ? readFileSync(file, 'utf8').trim() : '').toBe('')
  })

  it('查不到 agents 服务时放行，但记一条日志', async () => {
    const file = tempFile()
    const { tools, warns } = mount(file, { withGet: false })
    const opened = (await tools.get('dispatch_open')!.execute({
      goal: 'g',
      brief: '服务没起来',
      owner: '小鱼',
      ownerId: FULL,
    })) as unknown as OpenOutput

    expect(opened.status).toBe('running')
    expect(new TicketStore(file).get(opened.id)?.ownerId).toBe(FULL)
    expect(warns.join('\n')).toMatch(/ownerId 没校验/)
  })
})

describe('巡检按 ownerId 精确判活', () => {
  it('ownerId 不在活表：3 分钟就 worker-gone，不用等 20 分钟', async () => {
    const file = logFile([
      { id: 't-gone', at: minutesAgo(3), goal: '中文标签 + 真 id', status: 'open' },
      {
        id: 't-gone',
        at: minutesAgo(3),
        owner: 't4 查qqbot PR',
        ownerId: DEAD,
        status: 'running',
      },
    ])
    const { tools, inbox } = mount(file, { registered: [FULL] })
    const result = (await tools.get('dispatch_sweep')!.execute({})) as unknown as SweepOutput

    expect(result.stale).toBe(1)
    expect(result.woke).toBe(true)
    const text = injectedText(inbox)
    expect(text).toContain('t-gone')
    expect(text).toContain('worker-gone')
  })

  it('ownerId 命中的不推；中文标签也不再靠猜', async () => {
    const file = logFile([
      { id: 't-live', at: minutesAgo(3), goal: '活得好好的', status: 'open' },
      {
        id: 't-live',
        at: minutesAgo(3),
        owner: 't4 查qqbot PR',
        ownerId: FULL,
        status: 'running',
      },
    ])
    const { tools, inbox } = mount(file, { registered: [FULL] })
    const result = (await tools.get('dispatch_sweep')!.execute({})) as unknown as SweepOutput

    expect(result.stale).toBe(0)
    expect(inbox).toHaveLength(0)
  })

  it('老票没有 ownerId 仍走老规则：中文标签不到 20 分钟不报，到了报 silent', async () => {
    const file = logFile([
      { id: 't-cn-new', at: minutesAgo(3), goal: '刚派的中文标签活', status: 'open' },
      { id: 't-cn-new', at: minutesAgo(3), owner: '小丙', status: 'running' },
      { id: 't-cn-old', at: minutesAgo(25), goal: '挂久了的中文标签活', status: 'open' },
      { id: 't-cn-old', at: minutesAgo(25), owner: '小丙', status: 'running' },
    ])
    const { tools, inbox } = mount(file, { registered: [FULL] })
    const result = (await tools.get('dispatch_sweep')!.execute({})) as unknown as SweepOutput

    expect(result.stale).toBe(1)
    const text = injectedText(inbox)
    expect(text).toContain('t-cn-old')
    expect(text).toContain('silent')
    expect(text).not.toContain('t-cn-new')
  })

  it('老票的短标签短 hex 片段照旧走 worker-gone', async () => {
    const file = logFile([
      { id: 't-short-gone', at: minutesAgo(3), goal: '没 ownerId 的老票', status: 'open' },
      { id: 't-short-gone', at: minutesAgo(3), owner: 'subagent deadbeef', status: 'running' },
    ])
    const { tools, inbox } = mount(file, { registered: [FULL] })
    const result = (await tools.get('dispatch_sweep')!.execute({})) as unknown as SweepOutput

    expect(result.stale).toBe(1)
    expect(injectedText(inbox)).toContain('worker-gone')
  })
})

describe('subagent/end 也对 ownerId', () => {
  it('人话 owner 对不上事件 id，但 ownerId 对得上，票照样落 waiting', () => {
    const file = logFile([
      { id: 't-1', at: minutesAgo(5), goal: '标签 + 真 id', status: 'open' },
      { id: 't-1', at: minutesAgo(5), owner: 't4 查qqbot PR', ownerId: FULL, status: 'running' },
    ])
    const { emit } = mount(file, { registered: [FULL] })
    emit('subagent/end', { id: FULL, stopReason: 'completed' })

    const ticket = new TicketStore(file).get('t-1')
    expect(ticket?.status).toBe('waiting')
    expect(ticket?.note).toContain('completed')
  })
})
