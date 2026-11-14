import { describe, expect, it } from 'vitest'
import type { TicketSnapshot } from '../src/store'
import { TicketLog } from '../src/store/log'
import { WorkerRegistry } from '../src/tickets/registry'
import type { WorkerPool } from '../src/tickets/workers'
import { MemoryBackend } from './helpers/desk-harness'

const T = (second: number): string => `2026-11-14T12:00:${String(second).padStart(2, '0')}.000Z`

function logWith(events: Array<Record<string, unknown>>): TicketLog {
  const backend = new MemoryBackend()
  for (const event of events) backend.append(event as never)
  return new TicketLog(backend)
}

function fakePool(alive: (id: string) => boolean | undefined = () => undefined): WorkerPool & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    async start() {
      throw new Error('not used')
    },
    async send(workerId, _sender, text) {
      calls.push(`send:${workerId}:${text}`)
      return 'msg-1'
    },
    alive,
    async abort(workerId, reason) {
      calls.push(`abort:${workerId}:${reason ?? ''}`)
    },
    async abortAll(reason) {
      calls.push(`abortAll:${reason ?? ''}`)
    },
    registrations: () => [],
  }
}

function ticket(id: string, workerId?: string, extra: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return { id, status: 'running', createdAt: T(0), updatedAt: T(0), ...(workerId ? { workerId } : {}), ...extra } as TicketSnapshot
}

describe('WorkerRegistry：查询与 idle 记账', () => {
  it('alive / send / abort / abortAll 直接转发池子', async () => {
    const pool = fakePool((id) => id === 'worker-1')
    const registry = new WorkerRegistry({ pool, log: logWith([]) })
    expect(registry.alive('worker-1')).toBe(true)
    expect(registry.alive('worker-2')).toBe(false)
    expect(await registry.send('worker-1', {}, '接着干')).toBe('msg-1')
    await registry.abort('worker-1', '收工')
    await registry.abortAll('关台')
    expect(pool.calls).toEqual(['send:worker-1:接着干', 'abort:worker-1:收工', 'abortAll:关台'])
    expect(registry.pool).toBe(pool)
  })

  it('按 worker 查票，含已结的', () => {
    const log = logWith([
      { kind: 'published', id: 't-a', at: T(0), goal: 'a', brief: 'a', publisher: 'session-main', preset: 't1', presetSource: 'fallback' },
      { kind: 'spawned', id: 't-a', at: T(1), cause: 'tool', workerId: 'worker-1', preset: 't1' },
      { kind: 'closed', id: 't-a', at: T(2), cause: 'tool', outcome: 'done' },
      { kind: 'published', id: 't-b', at: T(3), goal: 'b', brief: 'b', publisher: 'session-main', preset: 't1', presetSource: 'fallback' },
      { kind: 'spawned', id: 't-b', at: T(4), cause: 'tool', workerId: 'worker-1', preset: 't1' },
    ])
    const registry = new WorkerRegistry({ pool: fakePool(), log })
    expect(registry.ticketsOf('worker-1').map((row) => row.id)).toEqual(['t-a', 't-b'])
    expect(registry.ticketsOf('worker-none')).toEqual([])
  })

  it('idle 标记：markIdle 收起，clearIdle 划掉', () => {
    const registry = new WorkerRegistry({ pool: fakePool(), log: logWith([]) })
    expect(registry.isIdle('worker-1')).toBe(false)
    registry.markIdle('worker-1')
    expect(registry.isIdle('worker-1')).toBe(true)
    registry.clearIdle('worker-1')
    expect(registry.isIdle('worker-1')).toBe(false)
  })

  it('describe：没 workerId、活表查不到/比不了、空闲、正忙四种文案', () => {
    const noWorker = new WorkerRegistry({ pool: fakePool(), log: logWith([]) })
    expect(noWorker.describe(ticket('t-1'))).toBe('没有 workerId，重起一只')

    const unknown = new WorkerRegistry({ pool: fakePool(() => undefined), log: logWith([]) })
    expect(unknown.describe(ticket('t-2', 'worker-2'))).toBe('worker-2 已死（活表 alive=undefined），重起一只')

    const dead = new WorkerRegistry({ pool: fakePool(() => false), log: logWith([]) })
    expect(dead.describe(ticket('t-3', 'worker-3'))).toBe('worker-3 已死（活表 alive=false），重起一只')

    const busy = new WorkerRegistry({ pool: fakePool(() => true), log: logWith([]) })
    expect(busy.describe(ticket('t-4', 'worker-4'))).toBe('worker-4 正忙，steer 到下一个 step 边界')
    busy.markIdle('worker-4')
    expect(busy.describe(ticket('t-4', 'worker-4'))).toBe('worker-4 空闲，steer 回原会话')
  })
})
