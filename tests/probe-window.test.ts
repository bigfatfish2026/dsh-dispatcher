/**
 * 探路窗口：只读钳子怎么装、怎么拆、什么时候降级。
 *
 * 三块：单元（ProbeWindows 自己）、票据层（desk 的两条拆窗口路径）、接线层
 * （agent/created 那一刀真装上了 deny 单）。一个真子会话都不开，restrict 全是假的。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fold } from '../src/store/reducer'
import type { TicketEvent, TicketSnapshot } from '../src/store'
import { WRITE_TOOLS } from '../src/protocol'
import { ProbeWindows } from '../src/tickets/probe'
import type { ProbeAgent, ProbePort, ProbeRegistry } from '../src/tickets/probe'
import { cleanTempDirs, mountPlugin, tempDir } from './helpers/plugin-harness'
import type { FakeAgent, FakePluginHost } from './helpers/plugin-harness'
import { flush, INTENT, makeDesk } from './helpers/desk-harness'

afterEach(() => {
  cleanTempDirs()
})

const minutes = (count: number): number => count * 60_000

function rows(file: string): Array<Record<string, unknown>> {
  const text = readFileSync(file, 'utf8').trim()
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : []
}

function kinds(file: string): string[] {
  return rows(file).map((line) => String(line.kind))
}

function ticketOf(file: string): TicketSnapshot {
  const events = rows(file) as unknown as TicketEvent[]
  return fold(events).get(String(events[0]?.id))!
}

/** 一个会记账的假 agent：restrict 被调了几次、拆了几次都看得见。 */
interface SpyAgent {
  agent: FakeAgent
  denies: string[][]
  allows: string[][]
  released: number
}

function spyAgent(agent: FakeAgent): SpyAgent {
  const spy: SpyAgent = { agent, denies: [], allows: [], released: 0 }
  const tools = agent.ctx.tools
  const real = tools.restrict.bind(tools)
  tools.restrict = (filter) => {
    if (filter.deny !== undefined) spy.denies.push([...filter.deny])
    if (filter.allow !== undefined) spy.allows.push([...filter.allow])
    const dispose = real(filter)
    return () => {
      spy.released += 1
      dispose()
    }
  }
  return spy
}

/** 这一次 restrict 是不是探路那一刀：write / edit / bash 三件全在 deny 里。 */
function isProbeDeny(deny: string[]): boolean {
  return WRITE_TOOLS.every((name) => deny.includes(name))
}

/**
 * 插件层台子：派活过程中宿主会发 `agent/created`，这里补一发（id 用 childId），
 * 顺手把每只新 worker 的 `restrict` 包成记账的——探路窗口装了什么、拆没拆，
 * 全靠它。
 */
function mountProbing(): { host: ReturnType<typeof mountPlugin>; file: string; spies: SpyAgent[] } {
  const file = join(tempDir(), 'tickets.jsonl')
  const host = mountPlugin({ config: { stateFile: file } })
  const seam = host.subagents.seam
  const original = seam.startActivation.bind(seam)
  const spies: SpyAgent[] = []
  seam.startActivation = async (spec) => {
    const activation = await original(spec)
    const agent = spyAgent(host.makeAgent('subagent', activation.childId))
    spies.push(agent)
    host.emit('agent/created', { agent: agent.agent })
    return activation
  }
  return { host, file, spies }
}

/**
 * 派活**不**自动补 `agent/created` 的台子：顺序由用例自己排（谁先冒出来）。
 * `spies` 按派活顺序记下带记账的 worker agent，发不发事件是用例的事。
 */
function mountProbingQuiet(): { host: ReturnType<typeof mountPlugin>; file: string; spies: SpyAgent[] } {
  const file = join(tempDir(), 'tickets.jsonl')
  const host = mountPlugin({ config: { stateFile: file } })
  const seam = host.subagents.seam
  const original = seam.startActivation.bind(seam)
  const spies: SpyAgent[] = []
  seam.startActivation = async (spec) => {
    const activation = await original(spec)
    spies.push(spyAgent(host.makeAgent('subagent', activation.childId)))
    return activation
  }
  return { host, file, spies }
}

/** 假的窗口管理器：desk 只调 expect / drop / release / releaseTicket，这里记账。 */
function fakeProbe(): ProbePort &
  ProbeRegistry & {
    expected: string[]
    bound: Array<{ ticketId: string; workerId: string }>
    dropped: string[]
    released: string[]
    releasedTickets: string[]
  } {
  const expected: string[] = []
  const bound: Array<{ ticketId: string; workerId: string }> = []
  const dropped: string[] = []
  const released: string[] = []
  const releasedTickets: string[] = []
  return {
    expected,
    bound,
    dropped,
    released,
    releasedTickets,
    expect(ticketId) {
      expected.push(ticketId)
    },
    bind(ticketId, workerId) {
      bound.push({ ticketId, workerId })
    },
    drop(ticketId) {
      dropped.push(ticketId)
    },
    release(workerId) {
      released.push(workerId)
      return true
    },
    releaseTicket(ticketId) {
      releasedTickets.push(ticketId)
      return true
    },
  }
}

describe('ProbeWindows：只读钳子本身', () => {
  it('planning 的票装 deny 单，返回 workerId', () => {
    const windows = new ProbeWindows()
    const seen: string[][] = []
    const agent: ProbeAgent = {
      id: 'worker-1',
      ctx: {
        tools: {
          restrict: (filter) => {
            seen.push([...filter.deny])
            return () => {}
          },
        },
      },
    }
    windows.expect('t-1')
    windows.bind('t-1', 'worker-1')
    expect(windows.adopt(agent, () => ({ phase: 'planning' }))).toBe('worker-1')
    expect(seen).toEqual([[...WRITE_TOOLS]])
    expect(windows.size).toBe(1)
    expect(windows.has('worker-1')).toBe(true)
    expect(windows.workerOf('t-1')).toBe('worker-1')
  })

  it('不在 planning 就不装，而且登记一次就作废', () => {
    const windows = new ProbeWindows()
    let calls = 0
    const agent = {
      id: 'worker-1',
      ctx: {
        tools: {
          restrict: () => {
            calls += 1
            return () => {}
          },
        },
      },
    }
    windows.expect('t-1')
    windows.bind('t-1', 'worker-1')
    expect(windows.adopt(agent, () => ({ phase: 'planned' }))).toBeUndefined()
    // 登记被消费掉了：下一只 worker 不会被误装。
    expect(windows.adopt(agent, () => ({ phase: 'planning' }))).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('宿主没给 restrict / 抛错都不炸，只记一句', () => {
    const warnings: string[] = []
    const windows = new ProbeWindows({ warn: (message) => warnings.push(message) })
    windows.expect('t-1')
    windows.bind('t-1', 'worker-1')
    expect(windows.adopt({ id: 'worker-1' }, () => ({ phase: 'planning' }))).toBeUndefined()

    windows.expect('t-2')
    windows.bind('t-2', 'worker-2')
    const thrower = {
      id: 'worker-2',
      ctx: {
        tools: {
          restrict: () => {
            throw new Error('unknown tool write')
          },
        },
      },
    }
    expect(windows.adopt(thrower, () => ({ phase: 'planning' }))).toBeUndefined()
    expect(warnings).toHaveLength(2)
    expect(windows.size).toBe(0)
  })

  it('release / releaseTicket / releaseAll 都能拆，认 id 变体', () => {
    const made: number[] = []
    const build = (id: string): { id: string; ctx: { tools: { restrict: () => () => void } } } => ({
      id,
      ctx: {
        tools: {
          restrict: () => () => {
            made.push(1)
          },
        },
      },
    })
    const windows = new ProbeWindows()
    windows.expect('t-1')
    windows.bind('t-1', 'worker-1')
    windows.adopt(build('worker-1'), () => ({ phase: 'planning' }))
    windows.expect('t-2')
    windows.bind('t-2', 'session-worker-2')
    windows.adopt(build('session-worker-2'), () => ({ phase: 'planning' }))
    expect(windows.size).toBe(2)

    // 宿主报的 id 少了 `session-` 前缀也要认。
    expect(windows.release('worker-2')).toBe(true)
    expect(made).toHaveLength(1)
    expect(windows.release('worker-9')).toBe(false)

    expect(windows.releaseTicket('t-1')).toBe(true)
    expect(made).toHaveLength(2)
    expect(windows.size).toBe(0)

    windows.expect('t-3')
    windows.bind('t-3', 'worker-3')
    windows.adopt(build('worker-3'), () => ({ phase: 'planning' }))
    windows.releaseAll()
    expect(windows.size).toBe(0)
    expect(made).toHaveLength(3)
  })

  it('身份对不上就忽略、不消耗登记：别的新会话吃不掉探路窗口', () => {
    const windows = new ProbeWindows()
    const seen: string[] = []
    const build = (id: string): ProbeAgent => ({
      id,
      ctx: {
        tools: {
          restrict: () => {
            seen.push(id)
            return () => {}
          },
        },
      },
    })
    windows.expect('t-1')
    windows.bind('t-1', 'worker-1')

    // 别的新会话先到：不装，也不把登记吃掉。
    expect(windows.adopt(build('worker-9'), () => ({ phase: 'planning' }))).toBeUndefined()
    expect(windows.size).toBe(0)
    expect(seen).toEqual([])

    // 真正的探路子会话到了才装（宿主 id 带不带 `session-` 前缀都认）。
    expect(windows.adopt(build('session-worker-1'), () => ({ phase: 'planning' }))).toBe('session-worker-1')
    expect(seen).toEqual(['session-worker-1'])
    expect(windows.size).toBe(1)
  })

  it('宿主时序：agent/created 先到、身份后补，bind 把挂起的那只领出来', () => {
    const windows = new ProbeWindows()
    const seen: string[] = []
    const agent: ProbeAgent = {
      id: 'worker-1',
      ctx: {
        tools: {
          restrict: () => {
            seen.push('worker-1')
            return () => {}
          },
        },
      },
    }
    windows.expect('t-1')
    // 身份还没回来：判不了人，先挂着，不装也不消耗。
    expect(windows.adopt(agent, () => ({ phase: 'planning' }))).toBeUndefined()
    expect(seen).toEqual([])
    windows.bind('t-1', 'worker-1')
    expect(seen).toEqual(['worker-1'])
    expect(windows.workerOf('t-1')).toBe('worker-1')
    // 登记已经被领走：再来一次不会装第二遍。
    expect(windows.adopt(agent, () => ({ phase: 'planning' }))).toBeUndefined()
    expect(seen).toEqual(['worker-1'])
  })

  it('超时还没被预期会话领取：expire 打固定文案、清登记', () => {
    const warnings: string[] = []
    const windows = new ProbeWindows({ warn: (message) => warnings.push(message) })
    windows.expect('t-1')
    windows.bind('t-1', 'worker-1')
    windows.adopt({ id: 'worker-9', ctx: { tools: { restrict: () => () => {} } } }, () => ({ phase: 'planning' }))
    expect(windows.size).toBe(0)
    expect(windows.expire('t-1')).toBe(true)
    expect(warnings).toContain('[probe] 窗口未被预期会话领取 id=t-1 超时降级')
    // 收过账了，不会打第二遍。
    expect(windows.expire('t-1')).toBe(false)
  })
})

describe('接线：一律探路与 agent/created', () => {
  it('不传任何开关也一律探路：先落 planning、装只读窗口、第一轮是探路任务书', async () => {
    const { host, file, spies } = mountProbing()
    const receipt = (await host.call('dispatch_open', { goal: '改个配置', brief: '改配置' })) as {
      id: string
    }
    await host.settled()

    expect(kinds(file)).toEqual(['published', 'planning', 'spawned'])
    const ticket = ticketOf(file)
    expect(ticket.phase).toBe('planning')
    expect(ticket.status).toBe('running')
    expect(spies).toHaveLength(1)
    // 工具面被 restrict：写文件、改文件、跑命令三件都摘掉。
    expect(spies[0]!.denies).toContainEqual([...WRITE_TOOLS])
    expect(spies[0]!.released).toBe(0)

    // 第一轮发出去的就是探路任务书，不是执行任务书。
    const prompt = host.subagents.spawned[0]!.request.prompt[0]!.text
    expect(prompt).toContain('这一轮是只读轮')
    expect(prompt).toContain('dispatch_declare')
    expect(prompt).toContain(receipt.id)

    // 登记是一次性的：再来一只闲逛的 worker 不会被装窗口。
    const stranger = host.makeAgent('subagent', 'worker-9')
    host.emit('agent/created', { agent: stranger })
    expect(spies).toHaveLength(1)
  })

  it('干扰：别的新会话先来 adopt 被忽略，真 worker 后到才装上 restrict', async () => {
    const { host, spies } = mountProbingQuiet()
    await host.call('dispatch_open', { goal: '改个配置', brief: '改配置' })
    await host.settled()
    expect(spies).toHaveLength(1)
    // 派活已经回来、身份已登记，但 worker 的 agent/created 还没来：窗口还没装。
    expect(spies[0]!.denies).toEqual([])

    // 干扰：别的新会话先冒出来。旧实现会把它当成探路子会话，把登记吃掉。
    const stranger = spyAgent(host.makeAgent('subagent', 'worker-9'))
    host.emit('agent/created', { agent: stranger.agent })
    // 别的守卫可能给它装自己的 deny 单，但探路那三件不该出现。
    expect(stranger.denies.some(isProbeDeny)).toBe(false)
    expect(spies[0]!.denies).toEqual([])

    // 真正的探路子会话到了：装 deny 单，而且只装一次。
    host.emit('agent/created', { agent: spies[0]!.agent })
    expect(spies[0]!.denies.filter(isProbeDeny)).toEqual([[...WRITE_TOOLS]])
    host.emit('agent/created', { agent: spies[0]!.agent })
    expect(spies[0]!.denies.filter(isProbeDeny)).toHaveLength(1)
  })

  it('探路轮 idle 却没交声明：不补声明、不进执行轮，票留在 planning', async () => {
    const { host, file, spies } = mountProbing()
    await host.call('dispatch_open', { goal: '先出方案再动手', brief: '先探路' })
    await host.settled()

    host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await host.settled()

    // 窗口拆了，但没有 declared、没有 conflict-checked、没有第二只子会话。
    expect(spies[0]!.released).toBe(1)
    expect(kinds(file)).toEqual(['published', 'planning', 'spawned'])
    const ticket = ticketOf(file)
    expect(ticket.phase).toBe('planning')
    expect(ticket.status).toBe('running')
    expect(ticket.declaredAt).toBeUndefined()
    expect(spies).toHaveLength(1)
  })

  it('交过声明再 idle：拆窗口 → 判冲突 → 派执行轮', async () => {
    const { host, file, spies } = mountProbing()
    await host.call('dispatch_open', { goal: '先出方案再动手', brief: '先探路' })
    await host.settled()
    const worker = spies[0]!.agent
    await host.call(
      'dispatch_declare',
      {
        plan: { summary: '先读源码再改' },
        intent: { writes: ['file:src/tickets/publish.ts'], reads: [], reversibility: 'auto' },
      },
      { agent: worker },
    )
    await host.settled()
    expect(kinds(file)).toEqual(['published', 'planning', 'spawned', 'declared'])

    host.emit('agent/status', { status: 'idle', agent: { id: worker.id } })
    await host.settled()
    expect(kinds(file)).toEqual([
      'published',
      'planning',
      'spawned',
      'declared',
      'conflict-checked',
      'spawned',
    ])
    expect(spies).toHaveLength(2)
    const ticket = ticketOf(file)
    expect(ticket.phase).toBe('running')
    expect(ticket.plan).toEqual({ summary: '先读源码再改' })
  })
})


describe('探路超时降级', () => {
  it('planning 满 2 分钟：标 degraded、转 planned、拆窗口，status 一动不动', async () => {
    const probe = fakeProbe()
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe })
    const { id } = await h.desk.open({ ...INTENT }, h.main)

    expect(h.backend.kinds()).toEqual(['published', 'planning', 'spawned'])
    expect(probe.expected).toEqual([id])
    // 派活成功：登记补上 worker 身份（不再 drop），窗口等 agent/created 认领。
    expect(probe.bound).toEqual([{ ticketId: id, workerId: 'worker-1' }])
    expect(probe.dropped).toEqual([])
    expect(h.log.get(id)!.phase).toBe('planning')

    // 差一分钟不降级。
    h.clock.advance(minutes(1))
    await h.desk.maintain()
    expect(h.log.get(id)!.phase).toBe('planning')
    expect(probe.releasedTickets).toEqual([])

    h.clock.advance(minutes(1) + 1_000)
    const report = await h.desk.maintain()
    // 降级不拦巡检：这一拍照常跑完。
    expect(report.signals).toBe(0)

    const ticket = h.log.get(id)!
    // 降级当拍就把这一轮推下去：判完冲突直接派执行轮，不等第二只子会话 idle。
    expect(ticket.phase).toBe('running')
    expect(ticket.degraded).toBe(true)
    // 探路降级不写状态：status 仍是执行子会话派出去之后的 running。
    expect(ticket.status).toBe('running')
    expect(ticket.plan).toEqual({})
    expect(probe.releasedTickets).toEqual([id])
    expect(h.backend.kinds().slice(-3)).toEqual(['declared', 'conflict-checked', 'spawned'])
    expect(h.subagents.spawned).toHaveLength(2)

    // 再扫一遍不重复写：票已经不是 planning，也不是 planned 了。
    const before = h.lines()
    await h.desk.maintain()
    expect(h.lines()).toBe(before)
  })

  it('窗口一直没被预期会话领走：降级照走、固定日志出现，没人拿到只读钳', async () => {
    const warnings: string[] = []
    const windows = new ProbeWindows({ warn: (message) => warnings.push(message) })
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe: windows })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    expect(windows.size).toBe(0)

    h.clock.advance(minutes(2) + 1_000)
    await h.desk.maintain()

    const ticket = h.log.get(id)!
    // 窗口没装上不影响放行：降级完当场判冲突、派执行轮。
    expect(ticket.phase).toBe('running')
    expect(ticket.degraded).toBe(true)
    expect(h.subagents.spawned).toHaveLength(2)
    expect(warnings).toContain(`[probe] 窗口未被预期会话领取 id=${id} 超时降级`)
    // 窗口从头到尾没装上：没有任何 worker 拿到 deny 单，票面是降级不是静默放行。
    expect(windows.size).toBe(0)
    expect(windows.workerOf(id)).toBeUndefined()
  })

  it('交过声明的票不会被降级：巡检兜底直接放行，不写 degraded', async () => {
    const probe = fakeProbe()
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe })
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.declare('worker-1', { summary: '探完了' }, { writes: ['dir:/tmp/probe-ws'], reads: [] })
    h.clock.advance(minutes(30))
    await h.desk.maintain()
    const ticket = h.log.get(id)!
    expect(ticket.degraded).toBe(false)
    expect(probe.releasedTickets).toEqual([])
    // 声明齐了就不是探路超时：兜底按「方案就绪」放行，declared 只有探路那一条。
    expect(ticket.phase).toBe('running')
    expect(h.backend.kinds()).toEqual([
      'published',
      'planning',
      'spawned',
      'declared',
      'conflict-checked',
      'spawned',
    ])
  })

  it('探路子会话交完声明 idle：窗口拆掉、判 none，就地派执行轮', async () => {
    const probe = fakeProbe()
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    await h.desk.declare('worker-1', { summary: '探完了' }, { writes: ['dir:/tmp/probe-ws'], reads: [] })
    h.desk.attach()
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()

    const ticket = h.log.get(id)!
    expect(ticket.phase).toBe('running')
    // 执行轮是一只新子会话：探路那只的只读工具面不能拿来干活。
    expect(ticket.workerId).toBe('worker-2')
    expect(ticket.status).toBe('running')
    expect(probe.released).toEqual(['worker-1'])
    expect(h.backend.kinds()).toEqual([
      'published',
      'planning',
      'spawned',
      'declared',
      'conflict-checked',
      'spawned',
    ])
  })
})
