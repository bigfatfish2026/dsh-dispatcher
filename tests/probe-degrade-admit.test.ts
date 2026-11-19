/**
 * 探路超时不再等 idle：降级当拍派执行轮、巡检兜底、超时按毫秒算。
 *
 * 修的是这条卡死链：`degradeProbe` 只把票写成 phase=planned（屏上「待放行」），
 * 派活要等探路子会话自己回合结束发 `agent/status idle`。它要是在降级之前已经 idle
 * 过一次，那之后不会再有 idle 事件，票就永久停在 running+planned。这里五条用例
 * 把新口径钉住：降级是「拿不到声明」的终点，不是等 idle 的起点。
 *
 * 全部走内存后端和假子会话，一分钱不花；`sweepMs: 0` 只靠用例手动 `maintain()`。
 */
import { describe, expect, it } from 'vitest'
import type { ProbePort, ProbeRegistry } from '../src/tickets/probe'
import { flush, makeDesk } from './helpers/desk-harness'
import type { Harness } from './helpers/desk-harness'

const GOAL = '修 admit 卡死'
const INTENT = { goal: GOAL, brief: GOAL }
const DIR = 'dir:/tmp/probe-degrade-ws'
const TIMEOUT_MS = 120_000

/** 探路窗口假件：desk 只拆不建，这里记账都省了。 */
function fakeProbe(): ProbePort & ProbeRegistry {
  return {
    expect: () => undefined,
    drop: () => undefined,
    release: () => true,
    releaseTicket: () => true,
  }
}

function desk(): Harness {
  const h = makeDesk({
    config: { defaultPreset: 't1', sweepMs: 0, probeTimeoutMinutes: 2 },
    probe: fakeProbe(),
  })
  h.desk.attach()
  return h
}

/** 让某只探路子会话 idle 下来：宿主信号 → desk 串行链。 */
async function idle(h: Harness, worker: string): Promise<void> {
  h.host.emit('agent/status', { status: 'idle', agent: { id: worker } })
  await flush()
}

/** 最后一次派活的 prompt：看派的是第几轮、哪套任务书。 */
function lastPrompt(h: Harness): string {
  return h.subagents.spawned.at(-1)!.prompt.map((block) => block.text).join('\n')
}

describe('探路超时当拍推进', () => {
  it('探路按时交声明：idle 那刻照旧放行，不走降级', async () => {
    const h = desk()
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    await h.desk.declare(
      'worker-1',
      { summary: '改 desk', files: [{ path: 'src/tickets/desk.ts' }] },
      { writes: ['file:src/tickets/desk.ts'], reads: [], reversibility: 'auto' },
    )

    await idle(h, 'worker-1')

    const ticket = h.log.get(id)!
    expect(ticket.degraded).toBe(false)
    expect(ticket.phase).toBe('running')
    expect(h.subagents.spawned).toHaveLength(2)
    // 走的是正常执行轮任务书，不是降级轮那套「探路超时、直接干」。
    expect(lastPrompt(h)).not.toContain('探路超时')
    expect(h.backend.kinds().slice(-2)).toEqual(['conflict-checked', 'spawned'])
  })

  it('探路超时：降级当拍判冲突并派执行轮，不等 idle', async () => {
    const h = desk()
    const { id } = await h.desk.open({ ...INTENT }, h.main)

    // 一发 idle 都不发，直接推到超时那一拍。
    h.clock.advance(TIMEOUT_MS)
    await h.desk.maintain()

    const ticket = h.log.get(id)!
    expect(ticket.degraded).toBe(true)
    expect(ticket.phase).toBe('running')
    // 执行轮真的起了：第二个子会话，任务书是降级那套。
    expect(h.subagents.spawned).toHaveLength(2)
    expect(ticket.workerId).toBe('worker-2')
    expect(lastPrompt(h)).toContain('探路超时')
    expect(h.backend.kinds().slice(-3)).toEqual(['declared', 'conflict-checked', 'spawned'])
  })

  it('探路超时且 worker 已经没了：这一拍派不出去，下一拍巡检兜底捞起', async () => {
    const h = desk()
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    // 活表里查不到它：进程重启、quota 回收都长这样。
    h.agents.markGone('worker-1')
    // 降级那一拍正好赶上派活失败：票退回 planned，活没落下去。
    h.subagents.failNext(new Error('subagents 服务不可用'))

    h.clock.advance(TIMEOUT_MS)
    await h.desk.maintain()
    expect(h.log.get(id)!.phase).toBe('planned')
    expect(h.subagents.spawned).toHaveLength(1)

    // 下一拍巡检不看 idle 事件：票面是 planned、活没在跑，就补一次 admit。
    await h.desk.maintain()

    const ticket = h.log.get(id)!
    expect(ticket.phase).toBe('running')
    expect(ticket.workerId).toBe('worker-2')
    expect(h.subagents.spawned).toHaveLength(2)
    // 兜底那一行把判定写出来：活表里没有它，按重起处理。
    expect(h.warnings.join('\n')).toContain(`巡检兜底放行票 ${id}`)
    expect(h.warnings.join('\n')).toContain('已死')
  })

  it('探路子会话在降级之前已经 idle 过一次：没有第二个 idle 事件也能放行', async () => {
    const h = desk()
    const { id } = await h.desk.open({ ...INTENT }, h.main)

    // 没交声明就 idle：票留在 planning，这正是旧实现里「idle 补空声明」被拆之后
    // 的样子——严格说来它这一轮已经说完了，之后不会再有 idle 事件。
    await idle(h, 'worker-1')
    expect(h.log.get(id)!.phase).toBe('planning')

    h.clock.advance(TIMEOUT_MS)
    await h.desk.maintain()

    const ticket = h.log.get(id)!
    expect(ticket.degraded).toBe(true)
    // 不等那个永远不会来的 idle：降级那一拍照常派执行轮。
    expect(ticket.phase).toBe('running')
    expect(h.subagents.spawned).toHaveLength(2)
  })

  it('降级时没交 plan：不假装占整片目录，不排队、照派执行轮', async () => {
    const h = desk()
    // 挡路的票先跑起来：声明过、探路收工、已经派了执行轮。
    const blocker = await h.desk.open({ goal: '占住目录', brief: '占住目录' }, h.main)
    await h.desk.declare(
      'worker-1',
      { summary: '占目录', files: [{ path: '/tmp/probe-degrade-ws/a.ts' }] },
      { writes: [DIR], reads: [], reversibility: 'manual' },
    )
    await idle(h, 'worker-1')
    expect(h.log.get(blocker.id)!.phase).toBe('running')
    // 挡路票的执行轮 worker 在活表里：否则巡检的 A2 死 worker 兜底会先把它收成 waiting。
    h.agents.markAlive(h.log.get(blocker.id)!.workerId!)

    const dealt = await h.desk.open({ goal: '降级票', brief: '降级票', dir: '/tmp/probe-degrade-ws' }, h.main)
    h.clock.advance(TIMEOUT_MS)
    await h.desk.maintain()

    const ticket = h.log.get(dealt.id)!
    expect(ticket.degraded).toBe(true)
    // plan 空着就什么写都不占：降级票不再拿票面 dir 整片兜底。
    expect(ticket.phase).toBe('running')
    expect(ticket.waitOn).toBeUndefined()
    // 两只探路 + 挡路那张的执行轮 + 降级票自己的执行轮。
    expect(h.subagents.spawned).toHaveLength(4)
  })

  it('2 分钟按毫秒算：119999ms 不降级，120000ms 降级，日志里打实际毫秒', async () => {
    const h = desk()
    const { id } = await h.desk.open({ ...INTENT }, h.main)

    // 探路开始那行：实际生效的毫秒数，不是「大约两分钟」。
    expect(h.warnings.join('\n')).toContain(`[probe] 探路开始 id=${id} timeoutMs=120000`)

    h.clock.advance(TIMEOUT_MS - 1)
    await h.desk.maintain()
    expect(h.log.get(id)!.phase).toBe('planning')
    expect(h.backend.kinds()).not.toContain('declared')

    h.clock.advance(1)
    await h.desk.maintain()
    const ticket = h.log.get(id)!
    expect(ticket.degraded).toBe(true)
    expect(ticket.phase).toBe('running')
  })
})
