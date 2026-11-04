import { describe, expect, it } from 'vitest'
import { fold } from '../src/store/reducer'
import { isKindedEvent, isTicketEvent, kindOf, legacyKindOf } from '../src/store/events'
import type { TicketEvent, TicketSnapshot } from '../src/store'

const T0 = '2026-11-04T08:00:00.000Z'
const T1 = '2026-11-04T08:10:00.000Z'
const T2 = '2026-11-04T08:20:00.000Z'
const T3 = '2026-11-04T08:30:00.000Z'
const T4 = '2026-11-04T08:40:00.000Z'

const ID = 't-20261104-1'

function one(events: TicketEvent[]): TicketSnapshot {
  return fold(events).get(ID)!
}

const published: TicketEvent = {
  kind: 'published',
  id: ID,
  at: T0,
  goal: '拆票台',
  brief: '拆票台',
  publisher: 'session-main',
  preset: 't1',
  presetSource: 'fallback',
  requestId: 'req-1',
  device: 'board-test',
}

const spawned: TicketEvent = {
  kind: 'spawned',
  id: ID,
  at: T0,
  workerId: 'worker-1',
  provider: 'spawn',
  preset: 't1',
  device: 'board-test',
  label: '票 t-1「拆票台」',
  messageId: 'msg-1',
}

describe('事件归类', () => {
  it('老行按老规矩归类：建票/状态/排队/报告/已读', () => {
    expect(legacyKindOf({ id: ID, at: T0, goal: '拆', status: 'open' })).toBe('open')
    expect(legacyKindOf({ id: ID, at: T0, status: 'running' })).toBe('status')
    expect(legacyKindOf({ id: ID, at: T0, input: { id: 'i-1', text: '话' } })).toBe('input')
    expect(legacyKindOf({ id: ID, at: T0, report: { id: 'r-1', text: '报' } })).toBe('report')
    expect(legacyKindOf({ id: ID, at: T0, delivered: { kind: 'report', id: 'r-1' } })).toBe(
      'delivered',
    )
  })

  it('新事件折回老的五个广播类别，监听方不用加分支', () => {
    expect(kindOf(published)).toBe('open')
    expect(kindOf({ kind: 'queued', id: ID, at: T0, input: { id: 'i', text: '' } })).toBe('input')
    expect(kindOf({ kind: 'reported', id: ID, at: T0, report: { id: 'r', text: '' }, source: 'worker' })).toBe('report')
    expect(kindOf({ kind: 'delivered', id: ID, at: T0, entry: { kind: 'input', id: 'i' } })).toBe('delivered')
    for (const kind of ['spawned', 'spawn-failed', 'ended', 'idled', 'resumed', 'blocked', 'closed'] as const) {
      expect(kindOf({ kind, id: ID, at: T0 } as TicketEvent)).toBe('status')
    }
  })

  it('脏行不算事件；kind 不是字符串的也算脏行', () => {
    expect(isTicketEvent(null)).toBe(false)
    expect(isTicketEvent(42)).toBe(false)
    expect(isTicketEvent({ id: ID })).toBe(false)
    expect(isTicketEvent({ id: ID, at: T0, kind: 7 })).toBe(false)
    expect(isTicketEvent({ id: ID, at: T0, kind: 'published' })).toBe(true)
    expect(isKindedEvent({ id: ID, at: T0 })).toBe(false)
  })
})

describe('新事件的折叠', () => {
  it('published → spawned：running、epoch 1、workerAlive true', () => {
    const ticket = one([published, spawned])
    expect(ticket).toMatchObject({
      status: 'running',
      workerId: 'worker-1',
      workerAlive: true,
      epoch: 1,
      epochReports: 0,
      preset: 't1',
      presetSource: 'fallback',
      requestId: 'req-1',
      publisher: 'session-main',
      device: 'board-test',
      statusSince: T0,
      epochStartedAt: T0,
    })
  })

  it('spawn-failed：票留在 open，原因进 note', () => {
    const ticket = one([
      published,
      { kind: 'spawn-failed', id: ID, at: T1, requestId: 'req-1', code: 'boom', reason: 'provider 挂了' },
    ])
    expect(ticket.status).toBe('open')
    expect(ticket.note).toBe('spawn 失败：provider 挂了')
    // 没派成不算状态变化：票一直是 open，statusSince 也停在建票那一刻。
    expect(ticket.statusSince).toBe(T0)
  })

  it('ended 冻结报告数；resumed 开新 epoch 并归零', () => {
    const before = one([
      published,
      spawned,
      { kind: 'reported', id: ID, at: T1, report: { id: 'r-1', text: '一' }, source: 'worker' },
      { kind: 'ended', id: ID, at: T2, workerId: 'worker-1', stopReason: 'end', epochReports: 1 },
    ])
    expect(before).toMatchObject({ status: 'waiting', workerAlive: false, epoch: 1, epochReports: 1, statusSince: T2 })

    const after = one([
      published,
      spawned,
      { kind: 'reported', id: ID, at: T1, report: { id: 'r-1', text: '一' }, source: 'worker' },
      { kind: 'ended', id: ID, at: T2, workerId: 'worker-1', stopReason: 'end', epochReports: 1 },
      { kind: 'resumed', id: ID, at: T3, workerId: 'worker-1', messageId: 'msg-2', epoch: 2 },
    ])
    expect(after).toMatchObject({ status: 'running', workerAlive: true, epoch: 2, epochReports: 0, statusSince: T3, epochStartedAt: T3 })
    // 老报告还在，只是不算这一轮的。
    expect(after.reports).toHaveLength(1)
  })

  it('delivered（input）把 waiting 拉回 running；delivered（report）不动状态', () => {
    const waiting = one([
      published,
      spawned,
      { kind: 'ended', id: ID, at: T1, workerId: 'worker-1', stopReason: 'end', epochReports: 0 },
    ])
    expect(waiting.status).toBe('waiting')
    const resumed = fold([
      published,
      spawned,
      { kind: 'ended', id: ID, at: T1, workerId: 'worker-1', stopReason: 'end', epochReports: 0 },
      { kind: 'queued', id: ID, at: T2, input: { id: 'i-1', text: '再来' } },
      { kind: 'delivered', id: ID, at: T3, entry: { kind: 'input', id: 'i-1' } },
    ]).get(ID)!
    expect(resumed).toMatchObject({ status: 'running', workerAlive: true, statusSince: T3 })
    expect(resumed.inputs[0]!.delivered).toBe(true)
  })

  it('closed 作废没投出去的排队消息，已投递的留着当历史', () => {
    const ticket = one([
      published,
      spawned,
      { kind: 'queued', id: ID, at: T1, input: { id: 'i-1', text: '投过的' } },
      { kind: 'delivered', id: ID, at: T1, entry: { kind: 'input', id: 'i-1' } },
      { kind: 'queued', id: ID, at: T2, input: { id: 'i-2', text: '没投的' } },
      { kind: 'closed', id: ID, at: T3, outcome: 'done', note: '收工', voidedInputs: 1 },
    ])
    expect(ticket).toMatchObject({ status: 'done', closedAt: T3, note: '收工', workerAlive: false })
    expect(ticket.inputs.map((entry) => entry.text)).toEqual(['投过的'])
  })

  it('终态之后的事件一律忽略：票不会自己活过来', () => {
    const ticket = one([
      published,
      spawned,
      { kind: 'closed', id: ID, at: T1, outcome: 'done' },
      { kind: 'queued', id: ID, at: T2, input: { id: 'i-1', text: '迟到' } },
      { kind: 'spawned', id: ID, at: T3, workerId: 'worker-9', provider: 'spawn', preset: 't2' },
      { kind: 'blocked', id: ID, at: T3, reason: '想挂' },
      { kind: 'resumed', id: ID, at: T4, workerId: 'worker-1', epoch: 5 },
      { kind: 'ended', id: ID, at: T4, workerId: 'worker-1', stopReason: 'end', epochReports: 0 },
    ])
    expect(ticket).toMatchObject({ status: 'done', epoch: 1, workerId: 'worker-1', workerAlive: false })
    expect(ticket.inputs).toHaveLength(0)
  })

  it('dropped 和 done 一样是终态：之后什么都不改', () => {
    const ticket = one([
      published,
      spawned,
      { kind: 'closed', id: ID, at: T1, outcome: 'dropped' },
      { kind: 'idled', id: ID, at: T2, workerId: 'worker-1' },
      { kind: 'blocked', id: ID, at: T2, reason: '想挂' },
    ])
    expect(ticket).toMatchObject({ status: 'dropped', note: undefined })
  })

  it('idled 与 ended 只差 workerAlive；两者都落 waiting', () => {
    const idled = one([published, spawned, { kind: 'idled', id: ID, at: T1, workerId: 'worker-1' }])
    expect(idled).toMatchObject({ status: 'waiting', workerAlive: true })
    const ended = one([
      published,
      spawned,
      { kind: 'ended', id: ID, at: T1, workerId: 'worker-1', stopReason: 'end', epochReports: 0 },
    ])
    expect(ended).toMatchObject({ status: 'waiting', workerAlive: false })
  })

  it('没派过活的 open 票收到 ended：忽略，不写坏', () => {
    const ticket = one([
      published,
      { kind: 'ended', id: ID, at: T1, workerId: 'worker-x', stopReason: 'end', epochReports: 0 },
    ])
    expect(ticket.status).toBe('open')
    expect(ticket.workerAlive).toBeUndefined()
  })

  it('queued/reported 不会把 statusSince 推走，除非状态真的变了', () => {
    const ticket = one([
      published,
      spawned,
      { kind: 'queued', id: ID, at: T1, input: { id: 'i-1', text: '话' } },
      { kind: 'reported', id: ID, at: T2, report: { id: 'r-1', text: '报' }, source: 'worker' },
    ])
    expect(ticket.status).toBe('running')
    expect(ticket.statusSince).toBe(T0)
    expect(ticket.epochReports).toBe(1)
  })

  it('不认识的 kind 只跳过那一行，不把票折坏', () => {
    const events = [
      published,
      spawned,
      { kind: 'future-thing', id: ID, at: T1, payload: { anything: true } },
    ] as unknown as TicketEvent[]
    const ticket = fold(events).get(ID)!
    expect(ticket.status).toBe('running')
    expect(ticket.workerId).toBe('worker-1')
  })
})
