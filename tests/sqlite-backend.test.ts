import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore, foldEvents } from '../src/store'
import { JsonlTicketStore } from '../src/store/jsonl'
import { SqliteTicketStore } from '../src/store/sqlite'
import type { TicketEvent } from '../src/store'

const dirs: string[] = []
const stores: { close(): void }[] = []

afterEach(() => {
  while (stores.length) stores.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-sqlite-'))
  dirs.push(dir)
  return dir
}

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 4, 0, 0, seconds)).toISOString()

/**
 * 一串把门面所有写路径都走一遍的事件：开票、派活、排队投递（send）、报告、
 * 挂起（block）、重开、结束（close）、老格式状态行。
 */
function script(): TicketEvent[] {
  const id = 't-sqlite-1'
  return [
    {
      kind: 'published',
      id,
      at: T(0),
      goal: '把票日志搬进 sqlite',
      brief: '搬进 sqlite',
      publisher: 'session-main',
      preset: 't2',
      presetSource: 'fallback',
      requestId: 'req-1',
      dir: '/tmp/one',
    },
    { kind: 'spawned', id, at: T(1), workerId: 'worker-1', provider: 'deepseek', preset: 't2' },
    { kind: 'queued', id, at: T(2), input: { id: 'e-1', text: '顺手把测试跑了' } },
    { kind: 'delivered', id, at: T(3), entry: { kind: 'input', id: 'e-1' } },
    { kind: 'reported', id, at: T(4), report: { id: 'e-2', text: '搬完了' }, source: 'worker' },
    { kind: 'blocked', id, at: T(5), reason: '等主人点头' },
    { kind: 'resumed', id, at: T(6), workerId: 'worker-1', epoch: 1 },
    { kind: 'ended', id, at: T(7), workerId: 'worker-1', stopReason: 'done', epochReports: 1 },
    { kind: 'closed', id, at: T(8), outcome: 'done', note: '交付', voidedInputs: 0 },
    // 老格式的一行：没有 kind，回放路径必须一字不差。
    { id: 't-sqlite-2', at: T(9), goal: '老票也要能迁', status: 'open' },
    { id: 't-sqlite-2', at: T(10), owner: 'worker-old', status: 'running' },
    { id: 't-sqlite-2', at: T(11), status: 'done', note: '老票收工' },
  ]
}

/** 把同一串事件同时打进 jsonl 与 sqlite 两个后端。 */
function twoStores(): {
  jsonl: JsonlTicketStore
  sqlite: SqliteTicketStore
  a: TicketStore
  b: TicketStore
} {
  const dir = tempDir()
  const jsonl = new JsonlTicketStore(join(dir, 'tickets.jsonl'))
  const sqlite = new SqliteTicketStore(join(dir, 'tickets.db'))
  stores.push(sqlite)
  const a = new TicketStore(jsonl)
  const b = new TicketStore(sqlite)
  return { jsonl, sqlite, a, b }
}

describe('sqlite 后端与 jsonl 后端方法级等价', () => {
  it('同一串操作：事件序列逐字节一致，最终投影完全相等', () => {
    const { jsonl, sqlite, a, b } = twoStores()
    const events = script()
    for (const event of events) {
      a.log.commit(event)
      b.log.commit(event)
    }

    // 1) 事件序列完全等价（含顺序、字段、老行）。
    expect(sqlite.load()).toEqual(jsonl.load())
    expect(JSON.stringify(sqlite.load())).toBe(JSON.stringify(events))

    // 2) 两边门面折出来的票逐字段相等（含 close/send/block/report 的结果）。
    expect(b.list()).toEqual(a.list())
    const closed = b.get('t-sqlite-1')!
    expect(closed.status).toBe('done')
    expect(closed.note).toBe('交付')
    expect(closed.closedAt).toBe(T(8))
    expect(closed.inputs[0]!.delivered).toBe(true)
    expect(closed.reports[0]!.delivered).toBe(false)
    expect(b.get('t-sqlite-2')!.status).toBe('done')

    // 3) 投影表和「整份重放再 fold」一致：投影只是缓存，不是事实来源。
    const folded = foldEvents(sqlite.load()).sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    expect(b.list()).toEqual(folded)
  })

  it('每次 append 只 INSERT 事件、投影同一事务更新；事件表只增不改', () => {
    const dir = tempDir()
    const file = join(dir, 'tickets.db')
    const sqlite = new SqliteTicketStore(file)
    stores.push(sqlite)
    const store = new TicketStore(sqlite)
    for (const event of script()) store.log.commit(event)

    const db = new DatabaseSync(file)
    try {
      const count = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }
      expect(count.c).toBe(script().length)
      // 投影行只按票存在：两张票两行，seq 是这张票最后一条事件。
      const rows = db.prepare('SELECT id, state, seq FROM tickets ORDER BY id').all() as {
        id: string
        state: string
        seq: number
      }[]
      expect(rows).toEqual([
        { id: 't-sqlite-1', state: 'done', seq: 9 },
        { id: 't-sqlite-2', state: 'done', seq: 12 },
      ])
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'lastSeq'").get() as { value: string }
      expect(meta.value).toBe('12')
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string
      }
      expect(version.value).toBe('1')
      // 索引与 WAL 都在。
      const indexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as {
          name: string
        }[]
      ).map((row) => row.name)
      expect(indexes).toEqual(['idx_events_ticket', 'idx_tickets_state_updated'])
      const wal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(wal.journal_mode).toBe('wal')
    } finally {
      db.close()
    }
  })

  it('changed() 只在新事件落库后为真，自己的写会让它归零', () => {
    const { sqlite, b } = twoStores()
    b.log.commit(script()[0]!)
    expect(sqlite.changed()).toBe(false)
    // 另一个写者（直接开第二条连接）追加一条，本连接必须看得出来。
    const other = new SqliteTicketStore(sqlite.location)
    stores.push(other)
    other.append(script()[1]!)
    expect(sqlite.changed()).toBe(true)
    sqlite.load()
    expect(sqlite.changed()).toBe(false)
  })
})
