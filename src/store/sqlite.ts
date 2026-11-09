import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyEvent } from './reducer'
import { isTicketEvent } from './events'
import type { TicketBackend } from './backend'
import type { TicketEvent, TicketSnapshot } from './events'

/**
 * 第二个实现：SQLite。`node:sqlite` 是 Node 内置模块，不装包。
 *
 * 表有三张，分工和 jsonl 一一对应：
 *
 * - `events` 是日志本体（seq 单调、只 INSERT，和 jsonl 的行序等价）；
 * - `tickets` 是投影缓存，每次 append 与对应事件同一事务重写那一行——它坏了
 *   也能由 `rebuildProjection()` 从 `events` 全量重放恢复，所以不是事实来源；
 * - `meta` 放 `schema_version` 与 `lastSeq`。
 *
 * 契约（`backend.ts` 顶上五条）逐条对得上：一次 append 在 BEGIN IMMEDIATE …
 * COMMIT 之间，事件与投影同生共死；不 UPDATE/DELETE `events`；`load()` 按 seq
 * 原样吐出事件，不在读的时候顺手更正；崩溃后 WAL + 事务保证已提交的就是已
 * 提交的，`load()` 重放即得；`changed()` 只比 `(lastSeq, 事件数)`，答不上来
 * 也算 true。
 *
 * 默认仍是 jsonl：只有 `store.backend: sqlite` 才会走到这里（见 backend.ts）。
 */

/** 当前 schema 版本；改表结构就 +1，并在 `ensureSchema` 里写迁移。 */
export const SCHEMA_VERSION = 1

/** `tickets` 表的列。事件本体不在这里，这里只是折好的投影。 */
const TICKET_COLUMNS = [
  'id',
  'title',
  'brief',
  'state',
  'owner',
  'ownerId',
  'preset',
  'presetSource',
  'presetWhy',
  'createdAt',
  'updatedAt',
  'closedAt',
  'statusSince',
  'dir',
  'note',
  'workerId',
  'device',
  'workerAlive',
  'requestId',
  'publisher',
  'epoch',
  'epochReports',
  'epochStartedAt',
  'inputs',
  'reports',
  'seq',
] as const

/** 建表 + 索引 + meta 初值。幂等，打开已有库时也跑一遍。 */
export function ensureSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id             TEXT PRIMARY KEY,
      title          TEXT NOT NULL DEFAULT '',
      brief          TEXT,
      state          TEXT NOT NULL,
      owner          TEXT,
      ownerId        TEXT,
      preset         TEXT,
      presetSource   TEXT,
      presetWhy      TEXT,
      createdAt      TEXT NOT NULL,
      updatedAt      TEXT NOT NULL,
      closedAt       TEXT,
      statusSince    TEXT,
      dir            TEXT,
      note           TEXT,
      workerId       TEXT,
      device         TEXT,
      workerAlive    INTEGER,
      requestId      TEXT,
      publisher      TEXT,
      epoch          INTEGER NOT NULL DEFAULT 0,
      epochReports   INTEGER NOT NULL DEFAULT 0,
      epochStartedAt TEXT,
      inputs         TEXT NOT NULL DEFAULT '[]',
      reports        TEXT NOT NULL DEFAULT '[]',
      seq            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_state_updated ON tickets(state, updatedAt);

    CREATE TABLE IF NOT EXISTS events (
      seq      INTEGER PRIMARY KEY,
      ticketId TEXT NOT NULL,
      type     TEXT NOT NULL,
      payload  TEXT NOT NULL,
      ts       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticketId, seq);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
    INSERT OR IGNORE INTO meta(key, value) VALUES ('lastSeq', '0');
  `)
  const version = Number(metaValue(db, 'schema_version') ?? SCHEMA_VERSION)
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `票库的 schema_version=${version} 比这版代码认识的 ${SCHEMA_VERSION} 新，别拿旧代码往上写。`,
    )
  }
}

/** 读一条 meta；没有就是 undefined。 */
export function metaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value?: unknown }
    | undefined
  return typeof row?.value === 'string' ? row.value : undefined
}

/** 写一条 meta，值统一存字符串。 */
export function setMeta(db: DatabaseSync, key: string, value: string | number): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  )
}

/** 事件落进 `events` 那一行的 type 栏：带 kind 的写 kind，老行写 legacy。 */
export function eventType(event: TicketEvent): string {
  const kind = (event as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : 'legacy'
}

/** 一张折好的票 → `tickets` 表的一行（列顺序见 TICKET_COLUMNS）。 */
export function projectionRow(snapshot: TicketSnapshot, seq: number): (string | number | null)[] {
  return [
    snapshot.id,
    snapshot.goal,
    snapshot.brief ?? null,
    snapshot.status,
    snapshot.owner ?? null,
    snapshot.ownerId ?? null,
    snapshot.preset ?? null,
    snapshot.presetSource ?? null,
    snapshot.presetWhy ?? null,
    snapshot.createdAt,
    snapshot.updatedAt,
    snapshot.closedAt ?? null,
    snapshot.statusSince,
    snapshot.dir ?? null,
    snapshot.note ?? null,
    snapshot.workerId ?? null,
    snapshot.device ?? null,
    snapshot.workerAlive === undefined ? null : snapshot.workerAlive ? 1 : 0,
    snapshot.requestId ?? null,
    snapshot.publisher ?? null,
    snapshot.epoch,
    snapshot.epochReports,
    snapshot.epochStartedAt ?? null,
    JSON.stringify(snapshot.inputs),
    JSON.stringify(snapshot.reports),
    seq,
  ]
}

/** 这张票当前折到第几条事件：投影的 seq 栏，没有这张票就是 0。 */
function ticketSeq(db: DatabaseSync, id: string): number {
  const row = db.prepare('SELECT seq FROM tickets WHERE id = ?').get(id) as
    | { seq?: unknown }
    | undefined
  return typeof row?.seq === 'number' ? row.seq : 0
}

/**
 * 只折一张票的全部事件；fold 是按票独立的，结果和整份重放一致。
 *
 * dsh-events 的 `publish` 现在不往 `events.ticketId` 里带票号（它只认事件名和
 * payload），新行的 ticketId 是空串。所以这里除了按列查，还按 payload 里的
 * `id` 兜一层：publisher 路径写下的行、以及「切回直写」后同一张票的后续行，
 * 都能折到一起。老行 ticketId 非空，走前半句，不碰 JSON。
 */
export function foldTicket(db: DatabaseSync, id: string): TicketSnapshot | undefined {
  const rows = db
    .prepare(
      "SELECT payload FROM events WHERE ticketId = ? OR (ticketId = '' AND json_extract(payload, '$.id') = ?) ORDER BY seq",
    )
    .all(id, id) as {
    payload: string
  }[]
  const state = new Map<string, TicketSnapshot>()
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (!isTicketEvent(parsed)) continue
    applyEvent(state, parsed)
  }
  return state.get(id)
}

/** 把一行投影 upsert 进 `tickets`。调用方负责事务。 */
export function writeProjection(db: DatabaseSync, snapshot: TicketSnapshot, seq: number): void {
  const columns = TICKET_COLUMNS.join(', ')
  const placeholders = TICKET_COLUMNS.map(() => '?').join(', ')
  const updates = TICKET_COLUMNS.filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ')
  db.prepare(`INSERT INTO tickets (${columns}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`).run(
    ...projectionRow(snapshot, seq),
  )
}

/**
 * 从 `events` 全量重放重建 `tickets`。投影被手改、迁移后补建、或者哪天表结构
 * 变了要回填，都走这一条——投影永远不是事实来源。调用方负责事务。
 */
export function rebuildProjection(db: DatabaseSync): number {
  const rows = db.prepare('SELECT seq, payload FROM events ORDER BY seq').all() as {
    seq: number
    payload: string
  }[]
  const state = new Map<string, TicketSnapshot>()
  const lastSeqOf = new Map<string, number>()
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (!isTicketEvent(parsed)) continue
    applyEvent(state, parsed)
    lastSeqOf.set(parsed.id, row.seq)
  }
  db.exec('DELETE FROM tickets')
  for (const [id, snapshot] of state) writeProjection(db, snapshot, lastSeqOf.get(id) ?? 0)
  return state.size
}

/** 一次 didn't-set-up-yet 的库：测试与迁移脚本建空库用。 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  ensureSchema(db)
  return db
}

/** SQLite 后端。方法面与 `JsonlTicketStore` 一致，业务代码一行不用改。 */
export class SqliteTicketStore implements TicketBackend {
  private readonly file: string
  private readonly log?: (message: string) => void
  private readonly db: DatabaseSync
  /** 上次 load()/append() 时的 `lastSeq:事件数`；变了说明别人写过。 */
  private signature = ''
  private observed = false
  /** 上一次 load 报过的坏行数，别每轮都刷同一条日志。 */
  private reportedBad = 0

  constructor(file: string, log?: (message: string) => void) {
    this.file = file
    this.log = log
    this.db = openDatabase(file)
    this.signature = this.currentSignature()
    this.observed = true
  }

  /** 库里在哪儿：文件路径，和 jsonl 的 location 同义。 */
  get location(): string {
    return this.file
  }

  /** 给测试和 CLI 用：显式关库（WAL 会落盘）。 */
  close(): void {
    this.db.close()
  }

  private statSignature(): string {
    const last = Number(metaValue(this.db, 'lastSeq') ?? 0)
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c?: unknown }
    const count = typeof row?.c === 'number' ? row.c : 0
    return `${last}:${count}`
  }

  private currentSignature(): string {
    try {
      return this.statSignature()
    } catch {
      return ''
    }
  }

  changed(): boolean {
    if (!this.observed) return true
    return this.currentSignature() !== this.signature
  }

  load(): TicketEvent[] {
    const signature = this.currentSignature()
    const rows = this.db.prepare('SELECT seq, payload FROM events ORDER BY seq').all() as {
      seq: number
      payload: string
    }[]
    const events: TicketEvent[] = []
    const bad: number[] = []
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.payload)
      } catch {
        bad.push(row.seq)
        continue
      }
      if (!isTicketEvent(parsed)) {
        bad.push(row.seq)
        continue
      }
      events.push(parsed)
    }
    // 和 jsonl 的坏行一样：跳过、报一声、绝不抛。
    if (bad.length > 0 && bad.length !== this.reportedBad) {
      this.log?.(
        `[dispatcher] ticket db ${this.file}: skipped ${bad.length} event(s) that are not events (seq ${bad.join(', ')})`,
      )
    }
    this.reportedBad = bad.length
    this.signature = signature
    this.observed = true
    return events
  }

  /** 在一个事务里跑 work，出错回滚。 */
  private transact<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = work()
      this.db.exec('COMMIT')
      return out
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务已经不在（比如 SQLITE_FULL 触发的自动回滚）：保留原始错误。
      }
      throw error
    }
  }

  /**
   * 唯一写入口。事件 INSERT 与投影 UPDATE 同事务：崩在两者之间要么都没落，
   * 要么一起落；即使投影被写成半截，`rebuildProjection()` 也能从事件重放回来。
   */
  append(event: TicketEvent): void {
    this.transact(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM events').get() as {
        last?: unknown
      }
      const seq = (typeof row?.last === 'number' ? row.last : 0) + 1
      this.db
        .prepare('INSERT INTO events(seq, ticketId, type, payload, ts) VALUES(?, ?, ?, ?, ?)')
        .run(seq, event.id, eventType(event), JSON.stringify(event), event.at)
      setMeta(this.db, 'lastSeq', seq)
      const snapshot = foldTicket(this.db, event.id)
      if (snapshot) writeProjection(this.db, snapshot, seq)
    })
    this.signature = this.currentSignature()
    this.observed = true
  }

  /**
   * 事件已经由 dsh-events publish 进同一张 `events` 表，这里只补投影。
   *
   * 投影的输入是门面内存里刚折好的快照，不是再查一遍 `events`：publish 已经
   * 返回 seq，事务边界在 dsh-events 那边，这边只做一次 upsert。补投影失败
   * 不抛给调用方——事件已经落库了，`rebuildProjection()` 随时能把它补回来，
   * 不能因为展示用的投影让 `dispatch_open` 看起来失败。
   */
  adoptPublished(snapshot: TicketSnapshot, seq: number): void {
    try {
      this.transact(() => {
        writeProjection(this.db, snapshot, seq)
      })
    } catch (error) {
      this.log?.(
        `[dispatcher] ticket db ${this.file}: 事件已 publish 但投影没写成（票 ${snapshot.id}，seq ${seq}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    this.signature = this.currentSignature()
    this.observed = true
  }

  /** 这张票的投影行（诊断/校验用），没有就是 undefined。 */
  projection(id: string): TicketSnapshot | undefined {
    return foldTicket(this.db, id)
  }

  /** 投影列投到第几条事件：迁移校验拿它和 `meta.lastSeq` 对。 */
  projectionSeq(id: string): number {
    return ticketSeq(this.db, id)
  }

  /** 暴露给迁移脚本的事务入口。 */
  transaction<T>(work: (db: DatabaseSync) => T): T {
    return this.transact(() => work(this.db))
  }
}
