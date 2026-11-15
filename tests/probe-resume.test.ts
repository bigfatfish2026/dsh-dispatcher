/**
 * 巡检兜底续派：投下一句之前先把探路窗口拆掉。
 *
 * 漏的就是这条路：声明已经交了、票落到 planned，探路子会话还在活表里，但 idle
 * 事件丢了（重启把事件吞了、或者它降级前就 idle 过一次）。巡检兜底不看 idle，
 * 直接走 `startTask` 的续派分支把执行轮投回同一个会话——探路窗口却还挂着，
 * 执行子会话手里少了 write / edit / bash 三件，活干不下去。
 *
 * 这里用真的 `ProbeWindows` + 记账的假 agent 钉住：兜底那一拍窗口必须已经拆了，
 * 而且是在投下一句之前。
 */
import { describe, expect, it } from 'vitest'
import { WRITE_TOOLS } from '../src/protocol'
import { ProbeWindows } from '../src/tickets/probe'
import type { ProbeAgent } from '../src/tickets/probe'
import { INTENT, makeDesk } from './helpers/desk-harness'

/** 记账的探路 agent：restrict 装了什么、回收函数被调了几次都看得见。 */
interface SpyWindow {
  agent: ProbeAgent
  denies: string[][]
  released: number
}

function spyWindow(workerId: string): SpyWindow {
  const spy: SpyWindow = { agent: { id: workerId }, denies: [], released: 0 }
  spy.agent.ctx = {
    tools: {
      restrict(filter: { deny: readonly string[] }) {
        spy.denies.push([...filter.deny])
        return () => {
          spy.released += 1
        }
      },
    },
  }
  return spy
}

describe('巡检兜底续派：先拆探路窗口', () => {
  it('worker 还活着、窗口还挂着：兜底投执行轮前拆掉 restrict', async () => {
    const probe = new ProbeWindows()
    const spy = spyWindow('worker-1')
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe })
    const { id } = await h.desk.open({ ...INTENT }, h.main)

    // 探路子会话冒出来：窗口装上，写 / 改 / 跑命三件被 deny。
    expect(probe.adopt(spy.agent, (ticketId) => h.log.get(ticketId))).toBe('worker-1')
    expect(spy.denies).toEqual([[...WRITE_TOOLS]])
    expect(probe.has('worker-1')).toBe(true)

    // 声明交了，idle 事件却没来：票已经 planned，窗口还挂在这只身上。
    await h.desk.declare(
      'worker-1',
      { summary: '改 desk 的续派分支', files: [{ path: 'src/tickets/desk.ts' }] },
      { writes: ['file:src/tickets/desk.ts'], reads: [], reversibility: 'auto' },
    )
    const planned = h.log.get(id)!
    expect(planned.phase).toBe('planned')
    expect(planned.status).toBe('running')
    expect(probe.has('worker-1')).toBe(true)
    // 会话还在活表里：这一轮走的就是续派那条分支。
    h.agents.markAlive('worker-1')

    await h.desk.maintain()

    // 窗口拆了：restrict 的回收函数被调了一次，票面不再只读。
    expect(probe.has('worker-1')).toBe(false)
    expect(spy.released).toBe(1)
    // 这一轮真投回同一只，不是重起；执行轮的任务书也发出去了。
    expect(h.subagents.spawned).toHaveLength(1)
    expect(h.subagents.sent).toHaveLength(1)
    expect(h.subagents.sent[0]!.target).toBe('worker-1')
    // 任务书得自己说一句钳子已经松了：上一轮那句「这轮用不了」还在同一个上下文里，
    // 不说清楚，子会话会照旧判「没有 bash」，手里有工具也不用。
    const text = h.subagents.sent[0]!.text
    expect(text).toContain('探路轮已结束')
    expect(text).toContain('bash / write / edit')
    expect(text).toContain('已失效')
    expect(text).not.toContain('这一轮是只读轮')
    expect(h.log.get(id)!.epoch).toBe(2)
    expect(h.log.get(id)!.phase).toBe('running')
    expect(h.warnings.join('\n')).toContain(`巡检兜底放行票 ${id}`)
  })

  it('早退路径（发布会话不在活表）不碰窗口，也不抛出来', async () => {
    const probe = new ProbeWindows()
    const spy = spyWindow('worker-1')
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    probe.adopt(spy.agent, (ticketId) => h.log.get(ticketId))
    await h.desk.declare(
      'worker-1',
      { summary: '改一处', files: [{ path: 'src/tickets/desk.ts' }] },
      { writes: ['file:src/tickets/desk.ts'], reads: [], reversibility: 'auto' },
    )
    h.agents.markAlive('worker-1')
    h.agents.markGone('session-main')

    await h.desk.maintain()

    // 派不出去：票退回 planned，窗口原样留着等下一拍或探路超时降级。
    expect(h.warnings.join('\n')).toContain('发布会话不在活表')
    expect(h.log.get(id)!.phase).toBe('planned')
    expect(probe.has('worker-1')).toBe(true)
    expect(spy.released).toBe(0)
    expect(h.subagents.sent).toHaveLength(0)
  })

  it('planning 里 send：投递前窗口已经拆了', async () => {
    const probe = new ProbeWindows()
    const spy = spyWindow('worker-1')
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe })
    const { id } = await h.desk.open({ ...INTENT }, h.main)

    probe.adopt(spy.agent, (ticketId) => h.log.get(ticketId))
    expect(probe.has('worker-1')).toBe(true)
    // 票还在探路轮：主会话这时候补一句，队列投递也得先把只读钳子松掉，
    // 否则这句投进去等于让子会话在只会 readonly 的手上接着干。
    expect(h.log.get(id)!.phase).toBe('planning')

    const receipt = await h.desk.send(id, '补一句：目录在 tests 下', h.main)

    expect(receipt.delivered).toBe(true)
    expect(h.log.get(id)!.phase).toBe('planning')
    expect(probe.has('worker-1')).toBe(false)
    expect(spy.released).toBe(1)
    expect(h.subagents.sent).toHaveLength(1)
    expect(h.subagents.sent[0]!.target).toBe('worker-1')
    expect(h.warnings.join('\n')).not.toContain('[probe] 窗口没拆到')
  })
})
