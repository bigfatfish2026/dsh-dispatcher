import { describe, expect, it } from 'vitest'
import { kindOf } from '../src/store/events'
import { ticketEventName } from '../src/store/bus'
import { fold } from '../src/store/reducer'
import type { Declared, TicketEvent, TicketSnapshot, TouchReported } from '../src/store'

const T0 = '2026-11-12T08:00:00.000Z'
const T1 = '2026-11-12T08:01:00.000Z'
const T2 = '2026-11-12T08:02:00.000Z'
const T3 = '2026-11-12T08:03:00.000Z'
const T4 = '2026-11-12T08:04:00.000Z'

const ID = 't-20261112-plan'

function one(events: TicketEvent[]): TicketSnapshot {
  return fold(events).get(ID)!
}

const published: TicketEvent = {
  kind: 'published',
  id: ID,
  at: T0,
  goal: '给资源串做归一化',
  brief: '资源串归一化',
  publisher: 'session-main',
  preset: 't1',
  presetSource: 'fallback',
  requestId: 'req-plan-1',
  intent: { reversibility: 'auto' },
}

const declared: Declared = {
  kind: 'declared',
  id: ID,
  at: T2,
  cause: 'tool',
  plan: {
    summary: '新增 resources.ts 并补测试',
    files: [
      { path: 'src/tickets/resources.ts', what: '归一化函数' },
      { path: 'tests/resources.test.ts', what: '测试' },
    ],
  },
  intent: {
    impact: { paths: ['file:/home/user/dev/dsh-dispatcher/src/tickets/resources.ts'] },
    reversibility: 'auto',
  },
}

describe('探路与对账事件', () => {
  it('planning / declared / touch-reported 都不写 status：状态仍只由主会话的四个动作动', () => {
    const ticket = one([
      published,
      { kind: 'planning', id: ID, at: T1, cause: 'tool', preset: 't2', workerId: 'probe-1' },
      declared,
      { kind: 'touch-reported', id: ID, at: T3, cause: 'tool', actor: 'worker', paths: ['src/tickets/resources.ts'] },
    ])
    expect(ticket.status).toBe('open')
    // statusSince 也不许被这几个事件顶掉：提醒计时按状态边界算。
    expect(ticket.statusSince).toBe(T0)
    expect(ticket.updatedAt).toBe(T3)
  })

  describe('阶段位', () => {
    it('planning 折出 planning、declared 折出 planned，status 与 statusSince 一动不动', () => {
      const planned = one([
        published,
        { kind: 'planning', id: ID, at: T1, cause: 'tool', preset: 't2' },
      ])
      expect(planned.phase).toBe('planning')
      expect(planned.degraded).toBe(false)
      expect(planned.status).toBe('open')
      expect(planned.statusSince).toBe(T0)

      const declaredOnce = one([
        published,
        { kind: 'planning', id: ID, at: T1, cause: 'tool', preset: 't2' },
        declared,
      ])
      expect(declaredOnce.phase).toBe('planned')
      // 交活这条也不许动状态：转 planned 是主会话的动作，不是探路子会话写的。
      expect(declaredOnce.status).toBe('open')
      expect(declaredOnce.statusSince).toBe(T0)
    })

    it('探路票 spawn 之后阶段位还在：status 转 running 不覆盖 phase', () => {
      const ticket = one([
        published,
        { kind: 'planning', id: ID, at: T1, cause: 'tool', preset: 't2' },
        { kind: 'spawned', id: ID, at: T2, cause: 'lifecycle', workerId: 'probe-1', preset: 't2' },
      ])
      expect(ticket.status).toBe('running')
      expect(ticket.phase).toBe('planning')
      expect(ticket.statusSince).toBe(T2)
    })

    it('降级的 declared 带 degraded，收工时清 phase 留 degraded', () => {
      const degraded = one([
        published,
        { kind: 'planning', id: ID, at: T1, cause: 'tool', preset: 't2' },
        { kind: 'declared', id: ID, at: T3, cause: 'timer', plan: {}, intent: {}, degraded: true },
      ])
      expect(degraded.phase).toBe('planned')
      expect(degraded.degraded).toBe(true)

      const closed = one([
        published,
        { kind: 'planning', id: ID, at: T1, cause: 'tool', preset: 't2' },
        { kind: 'declared', id: ID, at: T3, cause: 'timer', plan: {}, intent: {}, degraded: true },
        { kind: 'closed', id: ID, at: T4, cause: 'tool', outcome: 'done' },
      ])
      expect(closed.phase).toBeUndefined()
      expect(closed.degraded).toBe(true)
      expect(closed.status).toBe('done')
      expect(closed.closedAt).toBe(T4)
    })

    it('不探路的票没有阶段位：published + spawned 之后仍是 undefined', () => {
      const ticket = one([
        published,
        { kind: 'spawned', id: ID, at: T2, cause: 'lifecycle', workerId: 'worker-1', preset: 't1' },
      ])
      expect(ticket.phase).toBeUndefined()
      expect(ticket.degraded).toBeUndefined()
    })
  })

  it('declared 把 plan 与 intent 一起折进快照，后一次覆盖前一次', () => {
    const ticket = one([published, declared])
    expect(ticket.plan).toEqual(declared.plan)
    expect(ticket.intent).toEqual(declared.intent)

    const again = one([
      published,
      declared,
      {
        kind: 'declared',
        id: ID,
        at: T4,
        plan: { summary: '改主意了' },
        intent: { reversibility: 'manual' },
      },
    ])
    expect(again.plan?.summary).toBe('改主意了')
    expect(again.plan?.files).toBeUndefined()
    expect(again.intent?.reversibility).toBe('manual')
    // 旧的 published 意图不残留：declared 是整栏覆盖。
    expect(again.intent?.impact).toBeUndefined()
  })

  it('touch-reported 合并去重，收工的票也能补记，且不把状态拉回来', () => {
    const closed: TicketEvent = { kind: 'closed', id: ID, at: T3, outcome: 'done' }
    const ticket = one([
      published,
      declared,
      closed,
      { kind: 'touch-reported', id: ID, at: T4, actor: 'worker', paths: ['a.ts', 'b.ts'] },
    ])
    expect(ticket.status).toBe('done')
    expect(ticket.closedAt).toBe(T3)
    expect(ticket.touched).toEqual(['a.ts', 'b.ts'])

    const second = one([
      published,
      declared,
      { kind: 'touch-reported', id: ID, at: T3, actor: 'worker', paths: ['a.ts'] },
      { kind: 'touch-reported', id: ID, at: T4, actor: 'worker', paths: ['c.ts'] },
    ])
    // 后报的按首次出现顺序合并：一轮里分几次报不会只剩最后一批。
    expect(second.touched).toEqual(['a.ts', 'c.ts'])
  })

  it('探路事件折的是自己那份数组，事件对象被后面改也不污染快照', () => {
    const paths = ['a.ts']
    const event: TouchReported = { kind: 'touch-reported', id: ID, at: T3, actor: 'worker', paths }
    const ticket = one([published, event])
    paths.push('b.ts')
    expect(ticket.touched).toEqual(['a.ts'])
  })

  it('广播归并：declared / touch-reported 归 report，planning 归 status', () => {
    expect(kindOf(declared)).toBe('report')
    expect(kindOf({ kind: 'planning', id: ID, at: T1 } as TicketEvent)).toBe('status')
    expect(
      kindOf({ kind: 'touch-reported', id: ID, at: T3, actor: 'worker', paths: [] } as TicketEvent),
    ).toBe('report')
  })

  it('dsh-events 里三个新 kind 各自有事件名，不再落到 .legacy', () => {
    expect(ticketEventName({ kind: 'planning', id: ID, at: T1 } as TicketEvent)).toBe(
      'dispatcher.ticket.planning',
    )
    expect(ticketEventName(declared)).toBe('dispatcher.ticket.declared')
    expect(
      ticketEventName({ kind: 'touch-reported', id: ID, at: T3, actor: 'worker', paths: [] } as TicketEvent),
    ).toBe('dispatcher.ticket.touch-reported')
  })
})
