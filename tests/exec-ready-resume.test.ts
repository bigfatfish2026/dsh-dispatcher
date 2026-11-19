/**
 * 「探路轮之后执行轮不自动续派」的回归用例（方案 B，t-mwn2jdda-tgcz 实证）。
 *
 * 根因：推进下一轮的入口拿 status 做前置，而 status 由会话生命周期写、phase
 * 才是该不该派的维度。四种组合各钉一条：
 * A declare 后 end（waiting+planned）→ 下一拍派出执行轮
 * B 没 declare 就 end（waiting+planning）→ 探路超时降级并派活
 * C spawn 失败（open/planned）→ 节流窗口过后巡检重试成功
 * D gated（waiting+gated）→ 连扫 5 拍不重派、不刷日志
 *
 * 外加 `execReady` 的原因表：每一种不派都要说得出为什么。
 */
import { describe, expect, it } from 'vitest'
import { EXEC_RETRY_WINDOW_MS, execReady } from '../src/tickets/admission'
import type { TicketSnapshot } from '../src/store'
import { flush, INTENT, TEST_PRESETS, fakePresets, makeDesk } from './helpers/desk-harness'

const MANUAL = { config: { defaultPreset: 't1', sweepMs: 0 } }

function ticketOf(over: Partial<TicketSnapshot>): TicketSnapshot {
  return {
    id: 't-admission-1',
    status: 'waiting',
    phase: 'planned',
    declaredAt: '2026-01-01T00:00:00.000Z',
    actions: [],
    reports: [],
    inputs: [],
    ...over,
  } as unknown as TicketSnapshot
}

describe('execReady：该不该派执行轮的唯一定义', () => {
  it('白名单：waiting+planned+已声明 才算 ready（running 状态也照派）', () => {
    expect(execReady(ticketOf({ status: 'waiting' }))).toEqual({ ready: true, reason: 'ready' })
    expect(execReady(ticketOf({ status: 'running' }))).toEqual({ ready: true, reason: 'ready' })
    expect(execReady(ticketOf({ status: 'open' }))).toEqual({ ready: true, reason: 'ready' })
  })

  it('每一种不派都给出自己的原因', () => {
    expect(execReady(ticketOf({ status: 'done' })).reason).toBe('closed')
    expect(execReady(ticketOf({ status: 'dropped' })).reason).toBe('closed')
    expect(execReady(ticketOf({ status: 'blocked' })).reason).toBe('manual-blocked')
    expect(execReady(ticketOf({ phase: 'planning' })).reason).toBe('phase:planning')
    expect(execReady(ticketOf({ phase: 'queued' })).reason).toBe('phase:queued')
    expect(execReady(ticketOf({ phase: 'gated' })).reason).toBe('phase:gated')
    expect(execReady(ticketOf({ phase: 'running' })).reason).toBe('phase:running')
    expect(execReady(ticketOf({ phase: undefined })).reason).toBe('phase:unknown')
    expect(execReady(ticketOf({ declaredAt: undefined })).reason).toBe('no-declare')
  })

  it('重试节流：窗口内 retry-wait，过了窗口恢复 ready', () => {
    const now = Date.parse('2026-01-01T00:01:00.000Z')
    expect(
      execReady(ticketOf({}), { nowMs: now, lastAttemptMs: now - EXEC_RETRY_WINDOW_MS + 1 }),
    ).toEqual({ ready: false, reason: 'retry-wait' })
    expect(
      execReady(ticketOf({}), { nowMs: now, lastAttemptMs: now - EXEC_RETRY_WINDOW_MS }),
    ).toEqual({ ready: true, reason: 'ready' })
  })
})

describe('探路收工后的续派', () => {
  it('A：declare 后 end，下一拍巡检就把执行轮派出去', async () => {
    const h = makeDesk(MANUAL)
    h.desk.attach()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.declare(
      'worker-1',
      { summary: '改 desk', files: [{ path: 'src/tickets/desk.ts' }] },
      { writes: ['file:src/tickets/desk.ts'], reads: [], reversibility: 'auto' },
    )
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()

    const waiting = h.log.get(id)!
    expect(waiting.status).toBe('waiting')
    expect(waiting.phase).toBe('planned')
    expect(waiting.declaredAt).toBeTruthy()

    await h.desk.maintain()

    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('running')
    expect(ticket.phase).toBe('running')
    expect(ticket.epoch).toBe(2)
    expect(h.subagents.spawned).toHaveLength(2)
  })

  it('B：没 declare 就 end，探路超时当拍降级并派活', async () => {
    const h = makeDesk(MANUAL)
    h.desk.attach()
    const { id } = await h.desk.open(INTENT, h.main)
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()
    expect(h.log.get(id)!.status).toBe('waiting')
    expect(h.log.get(id)!.phase).toBe('planning')

    h.clock.advance(2 * 60_000)
    await h.desk.maintain()

    const ticket = h.log.get(id)!
    expect(ticket.degraded).toBe(true)
    expect(ticket.status).toBe('running')
    expect(ticket.phase).toBe('running')
    expect(h.subagents.spawned).toHaveLength(2)
    expect(h.backend.kinds()).toContain('declared')
  })

  it('C：spawn 失败退回 planned，节流窗口过后巡检重试成功', async () => {
    const h = makeDesk(MANUAL)
    h.desk.attach()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.declare(
      'worker-1',
      { summary: '改 desk', files: [{ path: 'src/tickets/desk.ts' }] },
      { writes: ['file:src/tickets/desk.ts'], reads: [], reversibility: 'auto' },
    )
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()

    h.subagents.failNext(new Error('subagents 服务不可用'))
    await h.desk.maintain()
    expect(h.log.get(id)!.phase).toBe('planned')
    expect(h.subagents.spawned).toHaveLength(1)

    // 节流窗口内再扫也不重试，票面不再写第二条 declared。
    const quiet = h.lines()
    await h.desk.maintain()
    expect(h.lines()).toBe(quiet)
    expect(h.subagents.spawned).toHaveLength(1)

    h.clock.advance(EXEC_RETRY_WINDOW_MS)
    await h.desk.maintain()

    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('running')
    expect(ticket.phase).toBe('running')
    expect(h.subagents.spawned).toHaveLength(2)
  })

  it('D：gated 之后连扫 5 拍不重派、不刷日志', async () => {
    // t2 的工具面里没有 bash：分类器说「要跑命令」时守卫必须驳回。
    const toolsets = {
      t1: {
        mode: 'allow' as const,
        names: new Set(['read', 'write', 'edit', 'bash', 'dispatch_report', 'dispatch_declare']),
      },
      t2: {
        mode: 'allow' as const,
        names: new Set(['read', 'glob', 'grep', 'dispatch_report', 'dispatch_declare']),
      },
    }
    const answers: unknown[] = ['t1', { preset: 't2', needsCommand: true }]
    const classify = {
      calls: 0,
      async classify() {
        const answer = answers[Math.min(classify.calls, answers.length - 1)]
        classify.calls += 1
        return answer as { preset: string; needsCommand?: boolean }
      },
    }
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      presets: fakePresets(TEST_PRESETS, 't1', toolsets),
      classify,
    })
    h.desk.attach()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.declare(
      'worker-1',
      { summary: '改 desk', files: [{ path: 'src/tickets/desk.ts' }] },
      { writes: ['file:src/tickets/desk.ts'], reads: [], reversibility: 'auto' },
    )
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()

    await h.desk.maintain()
    const gated = h.log.get(id)!
    expect(gated.status).toBe('waiting')
    expect(gated.phase).toBe('gated')
    expect(h.backend.kinds().filter((kind) => kind === 'gated')).toHaveLength(1)

    const lines = h.lines()
    for (let i = 0; i < 5; i += 1) await h.desk.maintain()

    expect(h.backend.kinds().filter((kind) => kind === 'gated')).toHaveLength(1)
    expect(h.lines()).toBe(lines)
    expect(h.subagents.spawned).toHaveLength(1)
    expect(h.log.get(id)!.phase).toBe('gated')
  })
})
