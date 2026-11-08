import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { TicketLog } from './store/log'
import type { TicketBackend } from './store/backend'
import type {
  EntryKind,
  TicketBroadcast,
  TicketEntry,
  TicketSnapshot,
  TicketStatus,
} from './store/events'

// 后端在这一层之后：门面只认 TicketBackend 那四个原语（load / changed / append /
// location），jsonl 的文件细节（O_APPEND、补换行、坏行跳过）全在
// `store/jsonl.ts`。换 redis/sqlite 时这个文件一行不用改。
//
// 2026-11-04 拆成三层：事件类型在 `store/events.ts`，纯 fold 在
// `store/reducer.ts`，读写与投影在 `store/log.ts`。这个文件只剩「门面 + 与票
// 无关的小工具」（brief 宽度、时间换算、待投递过滤）。TicketStore 的方法一个
// 没少——删 `update({status})` 是第三期的事。
export { createTicketBackend, resolveDbFile } from './store/backend'
export { JsonlTicketStore } from './store/jsonl'
export { SqliteTicketStore } from './store/sqlite'
export type { TicketBackend, TicketBackendConfig, TicketBackendName } from './store/backend'
export type {
  Actor,
  Blocked,
  Closed,
  Delivered,
  Ended,
  Idled,
  LegacyStatus,
  LegacyTicketEvent,
  LegacyTicketSnapshot,
  Published,
  PresetSource,
  Queued,
  Reported,
  Resumed,
  Spawned,
  SpawnFailed,
  TicketBroadcast,
  TicketEntry,
  TicketEvent,
  TicketEventKind,
  TicketSnapshot,
  TicketStatus,
} from './store/events'
export type { EntryKind } from './store/events'
export { fold, foldEvents } from './store/reducer'

/**
 * Longest brief, measured in character columns: a CJK character is 2 columns, a
 * half-width one is 1. 34 columns = 17 汉字, which is what fits on the little
 * screen's second line.
 *
 * 依据 2026-11-02 小屏实测：第二行 10px 字号、可用宽 172px，能放 17 个汉字
 * 或 28 个 ASCII 字符。汉字更宽，所以上限按汉字钉死在 17×2=34 列；纯 ASCII 的
 * brief 会在 28 列左右就自然结束，不会顶到 34。
 *
 * Adjust it here only — or set `briefMaxColumns` in cordis.yml, whose schema
 * default points at this constant, so the two can never drift apart.
 */
export const BRIEF_MAX_COLUMNS = 34

/** The ellipsis is wide (U+2026), so it costs 2 columns of the budget. */
const ELLIPSIS = '…'
const ELLIPSIS_COLUMNS = 2

/** Wide (East Asian) characters take two columns: CJK, kana, hangul, full-width punctuation. */
function charColumns(char: string): number {
  const code = char.codePointAt(0) ?? 0
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  // The ellipsis is what the cap reserves for it (see ELLIPSIS_COLUMNS); counting
  // it as one column here would make the two disagree by half a glyph.
  if (char === ELLIPSIS) return ELLIPSIS_COLUMNS
  return wide ? 2 : 1
}

/** Display width of a string, in columns. */
export function textColumns(text: string): number {
  let total = 0
  for (const char of text) total += charColumns(char)
  return total
}

/** Cut to `maxColumns` character columns, adding an ellipsis when anything was dropped. */
export function truncateColumns(text: string, maxColumns: number = BRIEF_MAX_COLUMNS): string {
  if (textColumns(text) <= maxColumns) return text
  // The ellipsis has to fit inside the cap too, otherwise a "10 汉字" brief
  // renders 11 and the panel clips the last glyph.
  const budget = Math.max(0, maxColumns - ELLIPSIS_COLUMNS)
  let out = ''
  let width = 0
  for (const char of text) {
    const next = charColumns(char)
    if (width + next > budget) break
    out += char
    width += next
  }
  return `${out}${ELLIPSIS}`
}

/** Sentence ends for "take the first sentence"; the separator itself is dropped. */
const SENTENCE_END = /[。！？!?；;…\n\r]/
/** Punctuation and spaces trimmed off both ends of the brief. */
const EDGE_PUNCTUATION = /^[\s，,、：:·\-—–]+|[\s，,、：:·\-—–]+$/g

/** Only whitespace, punctuation or symbols: nothing a person can read. */
const NO_WORDS = /^[\s\p{P}\p{S}]*$/u

/**
 * Whether a brief says nothing: not a string, empty, whitespace-only, or made
 * only of punctuation and symbols. `dispatch_open` rejects all of these — since
 * 2026-11-03 the field is required, and a "。" line is as blank as "".
 */
export function briefIsBlank(brief: unknown): boolean {
  if (typeof brief !== 'string') return true
  const trimmed = brief.trim()
  return trimmed.length === 0 || NO_WORDS.test(trimmed)
}

/**
 * Derive a short summary from a goal: first sentence, no edge punctuation,
 * whitespace collapsed, truncated to the column cap.
 *
 * Since 2026-11-03 `dispatch_open` requires an explicit brief, so this has one
 * caller left: readers of tickets written before the field existed (`briefOf`).
 * A goal that starts with punctuation ("！… ") would split to an empty first
 * sentence, so the cleaned whole goal is the fallback — an empty string would
 * blank the panel's second line.
 */
export function deriveBrief(goal: string, maxColumns: number = BRIEF_MAX_COLUMNS): string {
  const first = goal.trim().split(SENTENCE_END)[0] ?? ''
  const cleaned = (first || goal).replace(/\s+/g, ' ').replace(EDGE_PUNCTUATION, '').trim()
  return truncateColumns(cleaned, maxColumns)
}

/**
 * The brief to show for a ticket: what the log stored, or — for a ticket opened
 * before the field existed — one derived from its goal. An empty stored string
 * counts as absent.
 */
export function briefOf(
  ticket: { goal: string; brief?: string },
  maxColumns: number = BRIEF_MAX_COLUMNS,
): string {
  const own = ticket.brief?.trim()
  // 调用方给的 brief 也按当前上限再截一次：上限调小以后，老日志里存的那句
  // 不该把第二行撑破。
  return own ? truncateColumns(own, maxColumns) : deriveBrief(ticket.goal, maxColumns)
}

const OPEN: ReadonlySet<TicketStatus> = new Set(['open', 'running', 'waiting', 'blocked'])

export function isOpen(status: TicketStatus): boolean {
  return OPEN.has(status)
}

/** Resolve a configured path: absolute as-is, relative against the DSH home. */
export function resolveStateFile(configured: string): string {
  if (isAbsolute(configured)) return configured
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, configured)
}

export function minutesSince(iso: string, now: Date = new Date()): number {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 0
  return Math.max(0, Math.round((now.getTime() - then) / 60_000))
}

/** Entries still waiting for delivery. */
export function pending(entries: readonly TicketEntry[]): TicketEntry[] {
  return entries.filter((entry) => !entry.delivered)
}

/**
 * 薄门面：调用点还用 `new TicketStore(...)` 和那几个方法，实现全搬到
 * `TicketLog`。这一期一个方法都不删——`update({status})` 留给第三期。
 */
export class TicketStore {
  private readonly inner: TicketLog

  constructor(
    source: string | TicketBackend,
    log?: (message: string) => void,
    emit?: (event: TicketBroadcast) => void,
  ) {
    this.inner = new TicketLog(source, log, emit)
  }

  /** 这份日志在哪儿：jsonl 就是文件路径，别的后端是它自己的地址。 */
  get path(): string {
    return this.inner.location
  }

  /**
   * 同一个 TicketLog 给票台用：desk 只碰 `commit` / `get` / `list`，串行化仍归
   * 调用方那一条队列。门面自己那几个写方法（P3 删）与 desk 共用这一个实例，
   * 所以投影只有一份，不会各折各的。
   */
  get log(): TicketLog {
    return this.inner
  }

  list(): TicketSnapshot[] {
    return this.inner.list()
  }

  get(id: string): TicketSnapshot | undefined {
    return this.inner.get(id)
  }

  quietly<T>(work: () => T): T {
    return this.inner.quietly(work)
  }

  open(goal: string, dir?: string, brief?: string): TicketSnapshot {
    return this.inner.open(goal, dir, brief)
  }

  update(
    id: string,
    patch: { status?: TicketStatus; note?: string; owner?: string; ownerId?: string; dir?: string },
  ): TicketSnapshot {
    return this.inner.update(id, patch)
  }

  /** Queue one more message for the worker; it is delivered later, not now. */
  appendInput(id: string, text: string): { ticket: TicketSnapshot; entry: TicketEntry } {
    return this.inner.appendInput(id, text)
  }

  /** Record one report from a worker; the main session reads it later. */
  appendReport(id: string, text: string): { ticket: TicketSnapshot; entry: TicketEntry } {
    return this.inner.appendReport(id, text)
  }

  /** Record that one queued entry reached its reader. */
  markDelivered(id: string, kind: EntryKind, entryId: string): TicketSnapshot {
    return this.inner.markDelivered(id, kind, entryId)
  }
}
