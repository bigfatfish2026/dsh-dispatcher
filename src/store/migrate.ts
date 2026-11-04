import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { textColumns } from '../store'
import { fold } from './reducer'
import { isTicketEvent } from './events'
import {
  ensureSchema,
  eventType,
  foldTicket,
  metaValue,
  openDatabase,
  rebuildProjection,
  setMeta,
  writeProjection,
} from './sqlite'
import type { DatabaseSync } from 'node:sqlite'
import type { TicketEvent, TicketSnapshot } from './events'

/**
 * jsonl → sqlite 迁移。只读输入，写一个新库，最后双向校验。
 *
 * 三条硬规矩：
 *
 * 1. 输入 jsonl 只 `readFileSync`，绝不以任何方式打开写。
 * 2. 输出库不许落在真实 `~/.dsh` 下（`assertSafeOut`），默认写 /tmp。迁移是
 *    离线动作，线上那份日志和库这轮一行都不该动。
 * 3. seq 就是 jsonl 的行号（从 1 起，坏行/空行不占号），所以重跑幂等：同一个
 *    seq 上载荷一样就跳过，载荷不一样就报冲突、整次回滚、rc=1。
 */

/** 一条 jsonl 读出来的东西。 */
export interface JsonlScan {
  file: string
  /** 非空行数；每条事件占一行。 */
  lines: number
  /** 哪几行（1 起）解析不出来或不长成事件。 */
  badLines: number[]
  /** 能折的事件，顺序即行序。 */
  events: TicketEvent[]
}

/** 只读扫一份 jsonl：不 mkdir、不 touch、不改 mtime。 */
export function scanJsonl(file: string): JsonlScan {
  if (!existsSync(file)) throw new Error(`输入日志不存在：${file}`)
  const text = readFileSync(file, 'utf8')
  const events: TicketEvent[] = []
  const badLines: number[] = []
  let lines = 0
  let index = 0
  for (const raw of text.split('\n')) {
    index += 1
    const trimmed = raw.trim()
    if (!trimmed) continue
    lines += 1
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      badLines.push(index)
      continue
    }
    if (!isTicketEvent(parsed)) {
      badLines.push(index)
      continue
    }
    events.push(parsed)
  }
  return { file, lines, badLines, events }
}

/** 真实 DSH 目录：迁移脚本绝对不许往里写测试库。 */
function realDshRoots(): string[] {
  const roots = [join(homedir(), '.dsh')]
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  return roots.map((root) => resolve(root))
}

/** 输出路径的护栏；碰到真实 ~/.dsh 直接抛，没有放行开关。 */
export function assertSafeOut(file: string): string {
  const out = resolve(file)
  for (const root of realDshRoots()) {
    if (out === root || out.startsWith(root + sep)) {
      throw new Error(
        `拒绝写入 ${out}：迁移脚本绝不写真实 DSH 目录（${root}）。用 --out 指到 /tmp 下的测试库。`,
      )
    }
  }
  return out
}

/** 默认输出：/tmp 下的测试库，按时间戳区分，不会撞上真实目录。 */
export function defaultOutPath(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15)
  return join('/tmp', `dsh-tickets-${stamp}.db`)
}

/** 一张核对表的行。 */
export interface CheckRow {
  item: string
  jsonl: string
  sqlite: string
  ok: boolean
  detail?: string
}

/** 一次迁移的结果：给 CLI 打印，也给测试断言。 */
export interface MigrateResult {
  jsonl: string
  db: string
  dryRun: boolean
  tickets: number
  events: number
  lines: number
  badLines: number[]
  inserted: number
  skipped: number
  checks: CheckRow[]
  /** 全部核对通过；dry-run 时恒 true（没写就没得核）。 */
  ok: boolean
}

export interface MigrateOptions {
  jsonl: string
  db: string
  dryRun?: boolean
  log?: (message: string) => void
}

/** 两张票的终态是否一致：状态、关闭时刻、更新时刻、排队/报告条数。 */
function sameShape(a: TicketSnapshot, b: TicketSnapshot): boolean {
  return (
    a.status === b.status &&
    (a.closedAt ?? '') === (b.closedAt ?? '') &&
    a.updatedAt === b.updatedAt &&
    a.inputs.length === b.inputs.length &&
    a.reports.length === b.reports.length &&
    a.brief === b.brief &&
    a.goal === b.goal
  )
}

/** 逐票比对；返回不符的票号。 */
function compareTickets(expected: Map<string, TicketSnapshot>, actual: Map<string, TicketSnapshot>): string[] {
  const bad: string[] = []
  for (const [id, want] of expected) {
    const got = actual.get(id)
    if (!got || !sameShape(want, got)) bad.push(id)
  }
  for (const id of actual.keys()) {
    if (!expected.has(id)) bad.push(id)
  }
  return bad.sort()
}

/** 读库里全部事件（按 seq），供校验用。 */
function loadDbEvents(db: DatabaseSync): TicketEvent[] {
  const rows = db.prepare('SELECT seq, payload FROM events ORDER BY seq').all() as {
    seq: number
    payload: string
  }[]
  const events: TicketEvent[] = []
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.payload)
      if (isTicketEvent(parsed)) events.push(parsed)
    } catch {
      // 库里坏行不该出现；出现了就少一条，校验的「事件条数」会把账对上。
    }
  }
  return events
}

/** 跑一次迁移。dryRun=true 时只读 jsonl、不建库、不写盘。 */
export function migrateToSqlite(options: MigrateOptions): MigrateResult {
  const scan = scanJsonl(options.jsonl)
  const dbPath = assertSafeOut(options.db)
  const expected = fold(scan.events)
  const base: MigrateResult = {
    jsonl: options.jsonl,
    db: dbPath,
    dryRun: options.dryRun === true,
    tickets: expected.size,
    events: scan.events.length,
    lines: scan.lines,
    badLines: scan.badLines,
    inserted: 0,
    skipped: 0,
    checks: [],
    ok: true,
  }
  if (options.dryRun) return base

  const db = openDatabase(dbPath)
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = new Map<number, string>()
      for (const row of db.prepare('SELECT seq, payload FROM events').all() as {
        seq: number
        payload: string
      }[]) {
        existing.set(row.seq, row.payload)
      }
      if (existing.size > scan.events.length) {
        throw new Error(
          `库 ${dbPath} 已有 ${existing.size} 条事件，比输入 ${scan.events.length} 条多；这不是同一个日志，拒绝合并。`,
        )
      }
      let inserted = 0
      let skipped = 0
      const conflicts: number[] = []
      scan.events.forEach((event, index) => {
        const seq = index + 1
        const stored = existing.get(seq)
        if (stored !== undefined) {
          let same = false
          try {
            same = JSON.stringify(JSON.parse(stored)) === JSON.stringify(event)
          } catch {
            same = false
          }
          if (same) skipped += 1
          else conflicts.push(seq)
          return
        }
        db.prepare('INSERT INTO events(seq, ticketId, type, payload, ts) VALUES(?, ?, ?, ?, ?)').run(
          seq,
          event.id,
          eventType(event),
          JSON.stringify(event),
          event.at,
        )
        inserted += 1
      })
      if (conflicts.length > 0) {
        const preview = conflicts.slice(0, 5).join(', ')
        throw new Error(
          `库 ${dbPath} 在 seq ${preview}${conflicts.length > 5 ? ` 等 ${conflicts.length} 处` : ''} 与输入载荷不同；不覆盖已有事件，整次回滚。换一个新的 --out 重跑。`,
        )
      }
      const lastSeq = Math.max(existing.size, scan.events.length)
      setMeta(db, 'lastSeq', lastSeq)
      rebuildProjection(db)
      db.exec('COMMIT')
      base.inserted = inserted
      base.skipped = skipped
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 已经自动回滚：保留原始错误。
      }
      throw error
    }

    // ── 双向校验：jsonl 折出来的 vs 库里折出来的 ──────────────────
    const dbEvents = loadDbEvents(db)
    const actual = fold(dbEvents)
    const ticketMismatch = compareTickets(expected, actual)
    const projectionRows = db.prepare('SELECT COUNT(*) AS c FROM tickets').get() as { c?: unknown }
    const projectionCount = typeof projectionRows?.c === 'number' ? projectionRows.c : 0
    const lastSeq = Number(metaValue(db, 'lastSeq') ?? 0)

    const checks: CheckRow[] = [
      {
        item: '票数',
        jsonl: String(expected.size),
        sqlite: String(actual.size),
        ok: expected.size === actual.size,
      },
      {
        item: '每票终态',
        jsonl: `${expected.size} 张一致`,
        sqlite: ticketMismatch.length === 0 ? `${actual.size} 张一致` : `${ticketMismatch.length} 张不符`,
        ok: ticketMismatch.length === 0,
        detail: ticketMismatch.length > 0 ? `不符票号：${ticketMismatch.slice(0, 10).join(', ')}` : undefined,
      },
      {
        item: '事件条数',
        jsonl: String(scan.events.length),
        sqlite: String(dbEvents.length),
        ok: scan.events.length === dbEvents.length,
      },
      {
        item: 'lastSeq / 行数',
        jsonl: String(scan.lines),
        sqlite: String(lastSeq),
        // 每个非空行都该是一条事件：行数 == lastSeq，且没有坏行，才算便携。
        ok: lastSeq === scan.lines && scan.badLines.length === 0,
        detail:
          scan.badLines.length > 0
            ? `坏行 ${scan.badLines.length} 条（行 ${scan.badLines.slice(0, 5).join(', ')}）没进库`
            : `非空行 ${scan.lines} = lastSeq ${lastSeq}`,
      },
      {
        item: '投影行数',
        jsonl: String(expected.size),
        sqlite: String(projectionCount),
        ok: projectionCount === expected.size,
      },
    ]
    base.checks = checks
    base.ok = checks.every((row) => row.ok)
  } finally {
    db.close()
  }
  return base
}

/** 核对表拍成文本；CLI 打这个，测试也能直接比。中文按两列宽对齐。 */
export function formatChecks(checks: readonly CheckRow[]): string {
  const head = ['项目', 'jsonl', 'sqlite', '结果']
  const rows = checks.map((row) => [row.item, row.jsonl, row.sqlite, row.ok ? 'OK' : 'FAIL'])
  const widths = head.map((_, column) =>
    Math.max(...[head, ...rows].map((row) => textColumns(row[column]!))),
  )
  const pad = (cell: string, width: number, right: boolean): string => {
    const fill = ' '.repeat(Math.max(0, width - textColumns(cell)))
    return right ? `${fill}${cell}` : `${cell}${fill}`
  }
  const line = (cells: string[]): string =>
    cells.map((cell, index) => pad(cell, widths[index]!, index > 0)).join('  ')
  const out = [line(head), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)]
  for (const row of checks) if (row.detail) out.push(`  ${row.item}: ${row.detail}`)
  return out.join('\n')
}

/** CLI 的注入点：测试抓输出，bin 用 process。 */
export interface MigrateIo {
  out(text: string): void
  err(text: string): void
}

export const MIGRATE_USAGE = `用法：node scripts/migrate-to-sqlite.ts <jsonl 路径> [选项]

把 append-only 的 jsonl 票日志迁进 SQLite。输入只读，输出默认写到 /tmp；绝不写真实 ~/.dsh。

选项：
  --dry-run          只读：输出将写入多少票、多少事件，不建库
  --out <路径>       输出库；默认 /tmp/dsh-tickets-<时间戳>.db
  --json             输出 JSON 结果（给脚本用）
  --help, -h         打印这段

退出码：0 成功且核对全过；1 核对不符 / 冲突 / 输入有问题；2 参数不对。`

class UsageError extends Error {}

interface CliOptions {
  jsonl?: string
  db: string
  dryRun: boolean
  json: boolean
  help: boolean
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { db: defaultOutPath(), dryRun: false, json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--json') options.json = true
    else if (arg === '--out') {
      const value = argv[index + 1]
      if (!value) throw new UsageError('--out 后面要跟路径')
      options.db = value
      index += 1
    } else if (arg.startsWith('--out=')) options.db = arg.slice('--out='.length)
    else if (arg.startsWith('-')) throw new UsageError(`不认识的选项：${arg}`)
    else if (options.jsonl === undefined) options.jsonl = arg
    else throw new UsageError(`多余的参数：${arg}`)
  }
  return options
}

/**
 * `scripts/migrate-to-sqlite.ts` 的全部逻辑。真脚本只把 argv 递进来——这样
 * 参数面、护栏、打印都能在 vitest 里跑，不用先 build。
 */
export function runMigrateCli(argv: readonly string[], io: MigrateIo): number {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${MIGRATE_USAGE}\n`)
    return 2
  }
  if (options.help) {
    io.out(`${MIGRATE_USAGE}\n`)
    return 0
  }
  if (!options.jsonl) {
    io.err(`缺输入 jsonl 路径\n\n${MIGRATE_USAGE}\n`)
    return 2
  }

  let result: MigrateResult
  try {
    result = migrateToSqlite({ jsonl: options.jsonl, db: options.db, dryRun: options.dryRun })
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  if (options.json) {
    io.out(`${JSON.stringify({ ...result, ok: result.ok }, null, 2)}\n`)
    return result.ok ? 0 : 1
  }

  if (result.dryRun) {
    io.out('迁移计划（--dry-run，只读，不建库）\n')
    io.out(`  输入    ${result.jsonl}\n`)
    io.out(`  输出    ${result.db}\n`)
    io.out(`  事件    ${result.events} 条（有效行 ${result.lines}，坏行 ${result.badLines.length}）\n`)
    io.out(`  票      ${result.tickets} 张\n`)
    io.out(`  lastSeq ${result.events}\n`)
    return 0
  }

  io.out(`已迁移到 ${result.db}\n`)
  io.out(`  新写入 ${result.inserted} 条，已存在跳过 ${result.skipped} 条，票 ${result.tickets} 张\n`)
  io.out(`${formatChecks(result.checks)}\n`)
  io.out(result.ok ? '核对全过\n' : '核对未过\n')
  return result.ok ? 0 : 1
}

/** 迁移后拿这张票的投影（只读诊断）。 */
export function readProjection(dbPath: string, id: string): TicketSnapshot | undefined {
  const db = openDatabase(dbPath)
  try {
    return foldTicket(db, id)
  } finally {
    db.close()
  }
}

/** 给测试用：确保 db 是三张表 + 索引的形态。 */
export function schemaOf(dbPath: string): { tables: string[]; indexes: string[] } {
  const db = openDatabase(dbPath)
  try {
    ensureSchema(db)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string
    }[]).map((row) => row.name)
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string
    }[]).map((row) => row.name)
    return { tables, indexes }
  } finally {
    db.close()
  }
}

/** 外部直接写投影（模拟「事件已写、投影未更新」）——只给测试和诊断用。 */
export function writeRawProjection(dbPath: string, snapshot: TicketSnapshot, seq: number): void {
  const db = openDatabase(dbPath)
  try {
    writeProjection(db, snapshot, seq)
  } finally {
    db.close()
  }
}

/** 未使用但保留：绝对路径判断，供未来 --state 之类的参数复用。 */
export const isAbsolutePath = isAbsolute
