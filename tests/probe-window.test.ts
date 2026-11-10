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
import { PROBE_DENY, ProbeWindows } from '../src/tickets/probe'
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

/**
 * 插件层台子：派活过程中宿主会发 `agent/created`，这里补一发（id 用 childId），
 * 顺手把每只新 worker 的 `restrict` 包成记账的——探路窗口装了什么、拆没拆，
 * 全靠它。
 */
function mountProbing(): { host: FakePluginHost; file: string; spies: SpyAgent[] } {
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

/** 假的窗口管理器：desk 只调 expect / drop / release / releaseTicket，这里记账。 */
function fakeProbe(): ProbePort &
  ProbeRegistry & { expected: string[]; dropped: string[]; released: string[]; releasedTickets: string[] } {
  const expected: string[] = []
  const dropped: string[] = []
  const released: string[] = []
  const releasedTickets: string[] = []
  return {
    expected,
    dropped,
    released,
    releasedTickets,
    expect(ticketId) {
      expected.push(ticketId)
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
    expect(windows.adopt(agent, () => ({ phase: 'planning' }))).toBe('worker-1')
    expect(seen).toEqual([[...PROBE_DENY]])
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
    expect(windows.adopt(agent, () => ({ phase: 'planned' }))).toBeUndefined()
    // 登记被消费掉了：下一只 worker 不会被误装。
    expect(windows.adopt(agent, () => ({ phase: 'planning' }))).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('宿主没给 restrict / 抛错都不炸，只记一句', () => {
    const warnings: string[] = []
    const windows = new ProbeWindows({ warn: (message) => warnings.push(message) })
    windows.expect('t-1')
    expect(windows.adopt({ id: 'worker-1' }, () => ({ phase: 'planning' }))).toBeUndefined()

    windows.expect('t-2')
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
    windows.adopt(build('worker-1'), () => ({ phase: 'planning' }))
    windows.expect('t-2')
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
    windows.adopt(build('worker-3'), () => ({ phase: 'planning' }))
    windows.releaseAll()
    expect(windows.size).toBe(0)
    expect(made).toHaveLength(3)
  })
})

describe('接线：probe 开关与 agent/created', () => {
  it('probe 不开：事件一个都不多，票上没有阶段位，deny 单里没有只读那三件', async () => {
    const { host, file, spies } = mountProbing()
    await host.call('dispatch_open', { goal: '改个配置', brief: '改配置' })
    await host.settled()

    expect(kinds(file)).toEqual(['published', 'spawned'])
    const ticket = ticketOf(file)
    expect(ticket.phase).toBeUndefined()
    expect(ticket.degraded).toBeUndefined()
    // worker 反向名单那一刀还在（老行为），但探路窗口没装。
    expect(spies).toHaveLength(1)
    expect(spies[0]!.denies).not.toContainEqual([...PROBE_DENY])
  })

  it('probe 打开：先落 planning，探路子会话装只读窗口，事件顺序是 published → planning → spawned', async () => {
    const { host, file, spies } = mountProbing()
    const receipt = (await host.call('dispatch_open', {
      goal: '先出方案再动手',
      brief: '先探路',
      probe: true,
    })) as { id: string }
    await host.settled()

    expect(kinds(file)).toEqual(['published', 'planning', 'spawned'])
    const ticket = ticketOf(file)
    expect(ticket.phase).toBe('planning')
    expect(ticket.status).toBe('running')
    expect(spies).toHaveLength(1)
    expect(spies[0]!.denies).toContainEqual([...PROBE_DENY])
    expect(spies[0]!.released).toBe(0)

    // 登记是一次性的：再来一只闲逛的 worker 不会被装窗口。
    const stranger = host.makeAgent('subagent', 'worker-9')
    host.emit('agent/created', { agent: stranger })
    expect(spies).toHaveLength(1)

    // idle 下来：窗口拆掉，补一条空声明；探路票收工那一刻当场判冲突（这张票
    // 孤零零一张，判 none），判定落票之后派执行轮——所以最后又冒出一只新子会话。
    host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await host.settled()
    expect(kinds(file)).toEqual([
      'published',
      'planning',
      'spawned',
      'declared',
      'conflict-checked',
      'spawned',
    ])
    expect(spies[0]!.released).toBe(1)

    const after = ticketOf(file)
    expect(after.id).toBe(receipt.id)
    expect(after.phase).toBe('running')
    expect(after.degraded).toBe(false)
    expect(after.plan).toEqual({})
    expect(after.intent).toEqual({})
    expect(after.waitOn).toBeUndefined()
    expect(spies[1]!.agent.id).not.toBe(spies[0]!.agent.id)
  })

  it('子会话自己交过声明再 idle：只拆窗口，不重复写 declared', async () => {
    const { host, file, spies } = mountProbing()
    await host.call('dispatch_open', { goal: '先出方案再动手', brief: '先探路', probe: true })
    await host.settled()
    const worker = spies[0]!.agent
    await host.call('dispatch_declare', { plan: { summary: '先读源码再改' }, intent: {} }, { agent: worker })
    await host.settled()
    expect(kinds(file)).toEqual(['published', 'planning', 'spawned', 'declared'])

    host.emit('agent/status', { status: 'idle', agent: { id: worker.id } })
    await host.settled()
    // 声明已经有了（不再补 declared），idle 直接进判定 → 派执行轮。
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
    const { id } = await h.desk.open({ ...INTENT, probe: true }, h.main)

    expect(h.backend.kinds()).toEqual(['published', 'planning', 'spawned'])
    expect(probe.expected).toEqual([id])
    expect(probe.dropped).toEqual([id])
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
    expect(ticket.phase).toBe('planned')
    expect(ticket.degraded).toBe(true)
    // 探路降级不写状态：status 仍是执行子会话派出去之后的 running。
    expect(ticket.status).toBe('running')
    expect(ticket.plan).toEqual({})
    expect(probe.releasedTickets).toEqual([id])
    expect(h.backend.kinds().at(-1)).toBe('declared')

    // 再扫一遍不重复写：票已经不是 planning 了。
    const before = h.lines()
    await h.desk.maintain()
    expect(h.lines()).toBe(before)
  })

  it('probe 不开的票永远不降级', async () => {
    const probe = fakeProbe()
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe })
    const { id } = await h.desk.open(INTENT, h.main)
    h.clock.advance(minutes(30))
    await h.desk.maintain()
    const ticket = h.log.get(id)!
    expect(ticket.phase).toBeUndefined()
    expect(ticket.degraded).toBeUndefined()
    expect(probe.releasedTickets).toEqual([])
    expect(h.backend.kinds()).toEqual(['published', 'spawned'])
  })

  it('探路子会话 idle 是判定时刻：窗口拆掉、判 none，就地派执行轮', async () => {
    const probe = fakeProbe()
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe })
    const { id } = await h.desk.open({ ...INTENT, probe: true }, h.main)
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
