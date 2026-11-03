import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { hasIdFragment, matchesId } from '../src/ids'
import { apply } from '../src/index'
import { foldEvents } from '../src/store'
import type { TicketStatus } from '../src/store'
import { evaluateZombies } from '../src/zombie'

/**
 * 2026-11-03：短标签 owner 也得走 worker-gone 快路。
 *
 * 原来 zombie.ts 先拿 looksLikeSessionId 卡一道：owner 不像 uuid 就连活表都不查，
 * 只能等 20 分钟静默。现在改成「owner 带 id 片段就扫活表，扫不到就判死」，同时
 * 把「扫不到」和「没法比」分开——「小丙」这种纯文字标签抽不出片段，对不上活表
 * 只说明没法比，刚派出去的活不能被当场判死。
 */

const now = new Date('2026-11-03T09:00:00Z')
const ago = (min: number): string => new Date(now.getTime() - min * 60_000).toISOString()

const FULL = '34b183b9-5d77-4c3e-9f00-112233445566'
const DEAD = 'aff73fb2-0000-4111-8222-333344445555'
const SHORT = 'subagent 34b183b9'
const SHORT_DEAD = 'subagent deadbeef'

interface Event {
  id: string
  at: string
  goal?: string
  status?: TicketStatus
  owner?: string
  note?: string
}

const events: Event[] = [
  // 短标签对上活会话：不许判僵尸，也不许因为「对不上」就当成死了。
  { id: 't-short-live', at: ago(10), goal: '短标签 owner，会话还在', status: 'running', owner: SHORT },
  // 短标签扫不到活会话：才 3 分钟就该判 worker-gone，不用等 20 分钟。
  { id: 't-short-gone', at: ago(3), goal: '短标签 owner，会话没了', status: 'running', owner: SHORT_DEAD },
  // 纯中文标签：抽不出 id 片段，对不上不等于会话没了。
  { id: 't-cn-new', at: ago(3), goal: '刚派出去的中文标签活', status: 'running', owner: '小丙' },
  // 纯中文标签挂久了：还是按慢路 silent 报出来。
  { id: 't-cn-old', at: ago(25), goal: '中文标签挂了一整天', status: 'running', owner: '小丙' },
  // 原来的 full uuid 行为不许变：活着就不挑，没了一样的快路。
  { id: 't-uuid-live', at: ago(10), goal: 'uuid owner，会话还在', status: 'running', owner: FULL },
  { id: 't-uuid-gone', at: ago(3), goal: 'uuid owner，会话没了', status: 'running', owner: DEAD },
  // 刚建的票还在宽限里，来不及注册也不该判死。
  { id: 't-fresh-gone', at: ago(1), goal: '刚建一分钟', status: 'running', owner: SHORT_DEAD },
]

const tickets = foldEvents(events.map((event) => ({ ...event })))

/** 模拟真实的 agentAlive：活表非空，owner 有片段才给结论。 */
const aliveLookup = (liveIds: readonly string[]) => (owner: string): boolean | undefined => {
  if (!hasIdFragment(owner)) return undefined
  return liveIds.some((id) => matchesId(owner, id))
}

const opts = { now, zombieMinutes: 20, noReportMinutes: 5, freshMinutes: 2 }

describe('短标签 owner 的僵尸判定', () => {
  const isAlive = aliveLookup([FULL])

  it('短标签扫到活会话就不判', () => {
    const ids = evaluateZombies(tickets, { ...opts, isAlive }).map((hit) => hit.ticket.id)
    expect(ids).not.toContain('t-short-live')
  })

  it('短标签扫不到就立刻 worker-gone，不用等静默阈值', () => {
    const hit = evaluateZombies(tickets, { ...opts, isAlive }).find((one) => one.ticket.id === 't-short-gone')
    expect(hit?.reason).toBe('worker-gone')
    expect(hit?.idleMinutes).toBe(3)
  })

  it('纯中文标签对不上不当成会话不存在', () => {
    const ids = evaluateZombies(tickets, { ...opts, isAlive }).map((hit) => hit.ticket.id)
    expect(ids).not.toContain('t-cn-new')
  })

  it('纯中文标签挂久了仍然走 silent 慢路', () => {
    const hit = evaluateZombies(tickets, { ...opts, isAlive }).find((one) => one.ticket.id === 't-cn-old')
    expect(hit?.reason).toBe('silent')
  })

  it('full uuid 行为不变：活着不挑，没了快路判死', () => {
    const alive = evaluateZombies(tickets, { ...opts, isAlive }).map((hit) => hit.ticket.id)
    expect(alive).not.toContain('t-uuid-live')
    const gone = evaluateZombies(tickets, { ...opts, isAlive })
    expect(gone.find((hit) => hit.ticket.id === 't-uuid-gone')?.reason).toBe('worker-gone')
  })

  it('新建宽限挡住了刚派出去的票', () => {
    const ids = evaluateZombies(tickets, { ...opts, isAlive }).map((hit) => hit.ticket.id)
    expect(ids).not.toContain('t-fresh-gone')
  })

  it('活表空着（服务没就绪）不判死', () => {
    // agentAlive 在 list 为空时返回 undefined，这里直接模拟那个结果。
    const ids = evaluateZombies(tickets, { ...opts, isAlive: () => undefined }).map((hit) => hit.ticket.id)
    expect(ids).toEqual(['t-cn-old'])
  })
})

describe('纯中文标签的防御层', () => {
  it('就算查活那边手滑返回 false，也不把中文标签判成会话没了', () => {
    // 这是最后一道闸：owner 抽不出 id 片段时，false 只能当「没法判断」。
    const hits = evaluateZombies(tickets, { ...opts, isAlive: () => false })
    expect(hits.find((hit) => hit.ticket.id === 't-cn-new')).toBeUndefined()
    expect(hits.find((hit) => hit.ticket.id === 't-cn-old')?.reason).toBe('silent')
    // 有片段的那几张照旧走快路。
    expect(hits.find((hit) => hit.ticket.id === 't-short-gone')?.reason).toBe('worker-gone')
  })
})

/* ------------------------------------------------------------------ */
/* 端到端：sweep 真的按快路推                                                                  */
/* ------------------------------------------------------------------ */

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-owner-match-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

const OWNER = 'session-owner'

/** 时间要相对真实时钟：sweep 用的是 new Date()。 */
const minutesAgo = (min: number): string => new Date(Date.now() - min * 60_000).toISOString()

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
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** 活表里的 agent 要够 install 用：有 session.header.origin，也有 ctx 上那几个钩子。 */
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

function mount(stateFile: string, liveIds: readonly string[]): { tools: Map<string, RegisteredTool>; inbox: unknown[] } {
  const tools = new Map<string, RegisteredTool>()
  const inbox: unknown[] = []
  const owner = makeAgent(OWNER, {
    status: 'idle',
    followup: async (message: unknown) => {
      inbox.push(message)
      return undefined
    },
    steer: async () => undefined,
  })
  const others = liveIds.filter((id) => id !== OWNER).map((id) => makeAgent(id))
  const ctx = {
    agents: {
      list: () => [owner, ...others],
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
  apply(ctx as never, testConfig(stateFile))
  return { tools, inbox }
}

function injectedText(inbox: unknown[]): string {
  return inbox
    .flatMap((message) => {
      const content = (message as unknown as { content?: Array<{ text?: string }> }).content ?? []
      return content.map((part) => part.text ?? '')
    })
    .join('')
}

interface SweepOutput {
  stale: number
  woke: boolean
}

const ticketLines = [
  { id: 't-short-live', at: minutesAgo(10), goal: '短标签 owner，会话还在', status: 'open' },
  { id: 't-short-live', at: minutesAgo(9), owner: SHORT, status: 'running' },
  { id: 't-short-gone', at: minutesAgo(3), goal: '短标签 owner，会话没了', status: 'open' },
  { id: 't-short-gone', at: minutesAgo(3), owner: SHORT_DEAD, status: 'running' },
  { id: 't-cn-new', at: minutesAgo(3), goal: '刚派出去的中文标签活', status: 'open' },
  { id: 't-cn-new', at: minutesAgo(3), owner: '小丙', status: 'running' },
]

describe('sweep 端到端', () => {
  it('短标签对上活会话的不推，扫不到的那张立刻推 worker-gone', async () => {
    const file = logFile(ticketLines)
    const { tools, inbox } = mount(file, [FULL, OWNER])
    const result = (await tools.get('dispatch_sweep')!.execute({})) as SweepOutput

    expect(result.stale).toBe(1)
    expect(result.woke).toBe(true)
    expect(inbox).toHaveLength(1)
    const text = injectedText(inbox)
    expect(text).toContain('t-short-gone')
    expect(text).toContain('worker-gone')
    expect(text).not.toContain('t-short-live')
    // 中文标签那张没到静默阈值，也不许出现在推送里。
    expect(text).not.toContain('t-cn-new')
  })

  it('活表里那张短标签会话还在，就一条都不推', async () => {
    const file = logFile(ticketLines)
    // 让 SHORT_DEAD 也对上一个活会话：两张短标签票都不该被当成僵尸。
    const { tools, inbox } = mount(file, [FULL, OWNER, 'deadbeef-1111-4222-8333-44445555666'])
    const result = (await tools.get('dispatch_sweep')!.execute({})) as SweepOutput

    expect(result.stale).toBe(0)
    expect(result.woke).toBe(false)
    expect(inbox).toHaveLength(0)
  })
})
