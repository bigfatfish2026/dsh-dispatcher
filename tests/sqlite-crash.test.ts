import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore } from '../src/store'
import { SqliteTicketStore, rebuildProjection } from '../src/store/sqlite'
import type { TicketEvent } from '../src/store'

const dirs: string[] = []
const stores: SqliteTicketStore[] = []

afterEach(() => {
  while (stores.length) {
    try {
      stores.pop()!.close()
    } catch {
      // 测试里已经手动关过的库：重复 close 不算失败。
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-crash-'))
  dirs.push(dir)
  return join(dir, 'tickets.db')
}

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 4, 0, 0, seconds)).toISOString()

function events(): TicketEvent[] {
  const id = 't-crash-1'
  return [
    {
      kind: 'published',
      id,
      at: T(0),
      goal: '崩溃一致性',
      brief: '崩溃一致性',
      publisher: 'session-main',
      preset: 't2',
      presetSource: 'fallback',
      requestId: 'req-1',
    },
    { kind: 'spawned', id, at: T(1), workerId: 'worker-1', provider: 'deepseek', preset: 't2' },
    { kind: 'blocked', id, at: T(2), reason: '等外部条件' },
    { kind: 'resumed', id, at: T(3), workerId: 'worker-1', epoch: 1 },
    { kind: 'closed', id, at: T(4), outcome: 'done', note: '重放后应该还是 done' },
  ]
}

describe('sqlite 崩溃一致性', () => {
  it('事件已写、投影没更新：重新打开后重放，状态正确', () => {
    const file = tempDb()
    const first = new SqliteTicketStore(file)
    stores.push(first)
    const store = new TicketStore(first)
    for (const event of events()) store.log.commit(event)
    const before = store.list()
    first.close()

    // 模拟「事件写进去了、投影那一步崩了」：投影表被人为清空。
    const raw = new DatabaseSync(file)
    try {
      raw.exec('DELETE FROM tickets')
      expect((raw.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(5)
    } finally {
      raw.close()
    }

    // 重开：load() 折事件，不依赖投影表。
    const second = new SqliteTicketStore(file)
    stores.push(second)
    const reopened = new TicketStore(second)
    expect(reopened.list()).toEqual(before)
    expect(reopened.get('t-crash-1')!.status).toBe('done')
    expect(reopened.get('t-crash-1')!.note).toBe('重放后应该还是 done')

    // 投影可以随时从事件重建，重建后与门面读数一致。
    const db = new DatabaseSync(file)
    try {
      const rebuilt = rebuildProjection(db)
      expect(rebuilt).toBe(1)
      const row = db.prepare('SELECT state, seq FROM tickets WHERE id = ?').get('t-crash-1') as {
        state: string
        seq: number
      }
      expect(row).toEqual({ state: 'done', seq: 5 })
    } finally {
      db.close()
    }
  })

  it('事务中途抛错：事件、meta、投影一起回滚，一条都不留', () => {
    const file = tempDb()
    const backend = new SqliteTicketStore(file)
    stores.push(backend)
    const store = new TicketStore(backend)
    store.log.commit(events()[0]!)

    const before = backend.load().length
    expect(() =>
      backend.transaction((db) => {
        db.prepare('INSERT INTO events(seq, ticketId, type, payload, ts) VALUES(?, ?, ?, ?, ?)').run(
          99,
          't-crash-1',
          'closed',
          '{"kind":"closed","id":"t-crash-1"}',
          T(50),
        )
        db.prepare("UPDATE meta SET value = '99' WHERE key = 'lastSeq'").run()
        db.exec("UPDATE tickets SET state = 'done' WHERE id = 't-crash-1'")
        throw new Error('boom')
      }),
    ).toThrow('boom')

    const db = new DatabaseSync(file)
    try {
      expect((db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(before)
      expect((db.prepare("SELECT value FROM meta WHERE key = 'lastSeq'").get() as { value: string }).value).toBe(
        String(before),
      )
      expect((db.prepare("SELECT state FROM tickets WHERE id = 't-crash-1'").get() as { state: string }).state).toBe(
        'open',
      )
    } finally {
      db.close()
    }
    // 回滚后门面照旧能读、能写。
    const read = new TicketStore(backend)
    expect(read.get('t-crash-1')!.status).toBe('open')
  })

  it('append 在序列化阶段抛错也不留半条事件', () => {
    const file = tempDb()
    const backend = new SqliteTicketStore(file)
    stores.push(backend)
    backend.append(events()[0]!)
    const before = backend.load().length
    const poisoned = { ...events()[1]!, at: T(2) } as unknown as TicketEvent
    ;(poisoned as unknown as { bonus: bigint }).bonus = 1n
    expect(() => backend.append(poisoned)).toThrow()
    expect(backend.load().length).toBe(before)
  })

  it('关库再开：WAL 已落盘，事件与投影都在', () => {
    const file = tempDb()
    const first = new SqliteTicketStore(file)
    stores.push(first)
    const store = new TicketStore(first)
    for (const event of events()) store.log.commit(event)
    first.close()

    const second = new SqliteTicketStore(file)
    stores.push(second)
    expect(second.load()).toHaveLength(5)
    expect(new TicketStore(second).get('t-crash-1')!.status).toBe('done')
  })
})
