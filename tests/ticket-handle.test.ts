import { describe, expect, it } from 'vitest'
import { TicketLog } from '../src/store/log'
import { TicketHandle, ticketsOfWork } from '../src/tickets/handle'
import { MemoryBackend } from './helpers/desk-harness'

const at = (second: number): string => `2026-11-14T12:00:${String(second).padStart(2, '0')}.000Z`

function logWith(events: Array<Record<string, unknown>>): TicketLog {
  const backend = new MemoryBackend()
  for (const event of events) backend.append(event as never)
  return new TicketLog(backend)
}

function published(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'published',
    id,
    at: at(0),
    goal: `活 ${id}`,
    brief: `活 ${id}`,
    publisher: 'session-main',
    preset: 't1',
    presetSource: 'fallback',
    ...extra,
  }
}

function spawned(id: string, workerId: string, when = 1): Record<string, unknown> {
  return { kind: 'spawned', id, at: at(when), cause: 'tool', workerId, preset: 't1' }
}

describe('TicketHandle：归属与状态前置', () => {
  it('票不存在：一句「没有票 X」', () => {
    const log = logWith([])
    expect(() => new TicketHandle(log, 't-missing').current()).toThrow('没有票 t-missing')
  })

  it('forWorker：没挂票、票已结束都拒，错误里带 verb 与票号', () => {
    const log = logWith([
      published('t-done'),
      spawned('t-done', 'worker-1'),
      { kind: 'closed', id: 't-done', at: at(9), cause: 'tool', outcome: 'done' },
    ])
    expect(() => TicketHandle.forWorker(log, 'worker-none', '声明')).toThrow('没有挂在这个 worker 上的票')
    expect(() => TicketHandle.forWorker(log, 'worker-1', '声明')).toThrow('票 t-done 已结束（done），不能再声明')
  })

  it('forWorker：名下多张活票时取最近动过的那张', () => {
    const log = logWith([published('t-a'), spawned('t-a', 'worker-1', 1), published('t-b'), spawned('t-b', 'worker-1', 5)])
    const handle = TicketHandle.forWorker(log, 'worker-1', '报路径')
    expect(handle.id).toBe('t-b')
    expect(ticketsOfWork(log, 'worker-1').map((ticket) => ticket.id)).toEqual(['t-a', 't-b'])
    expect(ticketsOfWork(log, 'worker-none')).toEqual([])
  })

  it('send / block 的状态前置各有各的文案', () => {
    const log = logWith([published('t-done'), spawned('t-done', 'worker-1'), { kind: 'closed', id: 't-done', at: at(9), cause: 'tool', outcome: 'dropped' }])
    expect(() => new TicketHandle(log, 't-done').openForSend()).toThrow('票 t-done 已收工，要接着干就开新票')
    expect(() => new TicketHandle(log, 't-done').openForBlock()).toThrow('票 t-done 已经 dropped 了')
  })

  it('收工与挂起只有主会话能做', () => {
    const log = logWith([published('t-1'), spawned('t-1', 'worker-1')])
    const handle = new TicketHandle(log, 't-1')
    expect(() => handle.assertRouterCanClose({ kind: 'worker', sessionId: 'worker-1' })).toThrow('worker 不能收工')
    expect(() => handle.assertRouterCanBlock({ kind: 'worker', sessionId: 'worker-1' })).toThrow('worker 不能改票的状态')
    expect(() => handle.assertRouterCanClose({ kind: 'main', sessionId: 'session-main' })).not.toThrow()
  })

  it('报告归属：worker 只写自己票；主会话只写自己开的票；老票无 publisher 放行主会话', () => {
    const log = logWith([published('t-1'), spawned('t-1', 'worker-1'), published('t-old', { publisher: undefined })])
    expect(() => new TicketHandle(log, 't-1').assertMayReport({ kind: 'worker', sessionId: 'worker-1' })).not.toThrow()
    expect(() => new TicketHandle(log, 't-1').assertMayReport({ kind: 'worker', sessionId: 'worker-2' })).toThrow(
      '不挂在当前 worker 名下',
    )
    expect(() => new TicketHandle(log, 't-1').assertMayReport({ kind: 'main', sessionId: 'session-main' })).not.toThrow()
    expect(() => new TicketHandle(log, 't-1').assertMayReport({ kind: 'main', sessionId: 'session-other' })).toThrow(
      '不是这个会话开的',
    )
    expect(() => new TicketHandle(log, 't-old').assertMayReport({ kind: 'main', sessionId: 'session-other' })).not.toThrow()
  })
})
