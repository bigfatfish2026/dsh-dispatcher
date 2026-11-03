import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { createTicketBackend } from './store/backend'
import { JsonlTicketStore } from './store/jsonl'
import type { TicketBackend } from './store/backend'

// 后端在这一层之后：门面只认 TicketBackend 那四个原语（load / changed / append /
// location），jsonl 的文件细节（O_APPEND、补换行、坏行跳过）全在
// `store/jsonl.ts`。换 redis/sqlite 时这个文件一行不用改。
export { createTicketBackend } from './store/backend'
export { JsonlTicketStore } from './store/jsonl'
export type { TicketBackend, TicketBackendConfig, TicketBackendName } from './store/backend'

export type TicketStatus = 'open' | 'running' | 'waiting' | 'blocked' | 'done' | 'dropped'

/**
 * One message waiting for a worker, or one report a worker handed back. Both
 * are durable: the queue survives a restart, which is the point of keeping it
 * in the log instead of in the session that happened to be alive.
 */
export interface TicketEntry {
  id: string
  at: string
  text: string
  delivered: boolean
  deliveredAt?: string
}

/** One ticket as the tools and the model see it: a fold of its events. */
export interface TicketSnapshot {
  id: string
  goal: string
  /**
   * One-line summary of the goal, for the little screen's second line: at most
   * `BRIEF_MAX_COLUMNS` character columns. Optional because tickets written before
   * 2026-11-02 have no such field — readers fall back to `briefOf()`, which
   * derives the same thing from `goal`.
   */
  brief?: string
  status: TicketStatus
  dir?: string
  note?: string
  /**
   * Human label for the worker (what the little screen shows): `t4 查qqbot PR`
   * rather than a session id. Kept as free text so a person can read it.
   */
  owner?: string
  /**
   * The worker's session id as `spawn` returned it (uuid, optionally with a
   * `session-` prefix). Optional: tickets written before 2026-11-03 have none,
   * and readers must treat it as absent rather than guessing — the zombie sweep
   * uses it for an exact liveness check and otherwise falls back to the old
   * hex-fragment scan over `owner`.
   */
  ownerId?: string
  createdAt: string
  updatedAt: string
  /**
   * When the ticket last ended (done or dropped), in the log's own time; unset
   * while it is open again. A sweep needs this to tell "mail that arrived after
   * the close" from "mail a dead worker never picked up" — only the first is a
   * reason to reopen, and the log cannot answer that without keeping the close.
   */
  closedAt?: string
  /** Messages queued for the worker, oldest first. */
  inputs: TicketEntry[]
  /** Reports the worker handed back, oldest first. */
  reports: TicketEntry[]
}

/** One line of the append-only log. Every field except id/at is optional. */
export interface TicketEvent {
  id: string
  at: string
  goal?: string
  brief?: string
  status?: TicketStatus
  dir?: string
  note?: string
  owner?: string
  ownerId?: string
  input?: { id: string; text: string }
  report?: { id: string; text: string }
  delivered?: { kind: EntryKind; id: string }
}

export type EntryKind = 'input' | 'report'

/** What one appended log line did, as the event bus announces it. */
export type TicketEventKind = 'open' | 'status' | 'input' | 'report' | 'delivered'

/**
 * What goes on the bus after a successful append: which ticket moved and in
 * what way. Deliberately not the whole line — a listener that needs the ticket
 * reads it from the projection (one shared fold, not one per listener).
 */
export interface TicketBroadcast {
  id: string
  at: string
  kind: TicketEventKind
}

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

/** The two statuses that end a ticket: a dropped one is a person's stop. */
const ENDED: ReadonlySet<TicketStatus> = new Set(['done', 'dropped'])

export function isOpen(status: TicketStatus): boolean {
  return OPEN.has(status)
}

/** Resolve a configured path: absolute as-is, relative against the DSH home. */
export function resolveStateFile(configured: string): string {
  if (isAbsolute(configured)) return configured
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, configured)
}

export function newTicketId(now: Date = new Date()): string {
  const stamp = now.getTime().toString(36)
  const salt = Math.random().toString(36).slice(2, 6)
  return `t-${stamp}-${salt}`
}

function newEntryId(now: Date = new Date()): string {
  return `e-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** Append one queued entry, undelivered. */
function queue(entries: readonly TicketEntry[], at: string, entry: { id: string; text: string }): TicketEntry[] {
  return [...entries, { id: entry.id, at, text: entry.text, delivered: false }]
}

/** Mark one entry of a list delivered; other entries are untouched. */
function deliver(entries: readonly TicketEntry[], at: string, id: string): TicketEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, delivered: true, deliveredAt: at } : entry))
}

/**
 * Fold one event into `state`. Shared by the full fold (`foldEvents`) and the
 * store's projection: one code path means an incremental update after `append`
 * and a rebuild from the file can never disagree.
 */
function applyEvent(state: Map<string, TicketSnapshot>, event: TicketEvent): void {
  // 一行能 parse 不等于它是一条事件：崩溃留下的 null、数字、数组都在这里被挡下。
  // 放过去的话 `event.id` 会抛 TypeError，而 `store.list()` 是每个 dispatch_* 的
  // 第一步——一处脏行就能把整套工具打死。没有 id/at 的行也不构成事件。
  if (event === null || typeof event !== 'object') return
  if (typeof event.id !== 'string' || typeof event.at !== 'string') return
  const previous = state.get(event.id)
  if (!previous) {
    state.set(event.id, {
      id: event.id,
      goal: event.goal ?? '',
      brief: event.brief,
      status: event.status ?? 'open',
      dir: event.dir,
      note: event.note,
      owner: event.owner,
      ownerId: event.ownerId,
      createdAt: event.at,
      updatedAt: event.at,
      closedAt: event.status && ENDED.has(event.status) ? event.at : undefined,
      inputs: event.input ? queue([], event.at, event.input) : [],
      reports: event.report ? queue([], event.at, event.report) : [],
    })
    return
  }
  state.set(event.id, {
    ...previous,
    goal: event.goal ?? previous.goal,
    // Old lines have no brief at all: `??` keeps whatever the ticket already
    // had, so a fold never turns a present brief into undefined.
    brief: event.brief ?? previous.brief,
    status: event.status ?? previous.status,
    dir: event.dir ?? previous.dir,
    note: event.note ?? previous.note,
    owner: event.owner ?? previous.owner,
    ownerId: event.ownerId ?? previous.ownerId,
    updatedAt: event.at,
    // A status line is the only thing that moves the close: done/dropped set
    // it, reopening clears it, and every other event leaves it alone.
    closedAt: event.status ? (ENDED.has(event.status) ? event.at : undefined) : previous.closedAt,
    inputs: event.input
      ? queue(previous.inputs, event.at, event.input)
      : event.delivered?.kind === 'input'
        ? deliver(previous.inputs, event.at, event.delivered.id)
        : previous.inputs,
    reports: event.report
      ? queue(previous.reports, event.at, event.report)
      : event.delivered?.kind === 'report'
        ? deliver(previous.reports, event.at, event.delivered.id)
        : previous.reports,
  })
}

/** Fold events into the current snapshot of every ticket, newest event last. */
export function foldEvents(events: readonly TicketEvent[]): TicketSnapshot[] {
  const state = new Map<string, TicketSnapshot>()
  for (const event of events) applyEvent(state, event)
  return [...state.values()]
}

/** What one log line did, for the event bus. */
export function kindOf(event: TicketEvent): TicketEventKind {
  if (event.delivered) return 'delivered'
  if (event.input) return 'input'
  if (event.report) return 'report'
  // A creation line is the only one that carries a goal together with status
  // open; every later status line is a change, including a reopen to open.
  if (event.goal !== undefined && event.status === 'open') return 'open'
  return 'status'
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

export class TicketStore {
  /** 事件从哪儿来、往哪儿写；所有读写都走它，这个文件里没有一行 fs。 */
  private readonly backend: TicketBackend
  /** Called after every append that is not internal; see `quietly`. */
  private readonly emit?: (event: TicketBroadcast) => void

  /**
   * 内存投影：ticketId → 折好的快照。list()/get() 从这儿读，不再每次整份重读
   * 日志、重新 fold。启动时（第一次 refresh）全量 fold 一次，之后 append 只折叠
   * 刚写进去的那一行。
   */
  private state = new Map<string, TicketSnapshot>()
  private loaded = false
  /** 内部写入（巡检自己的重开、投递记账）不许再广播，否则事件自激。 */
  private quiet = 0

  /**
   * `source` 给路径就按 jsonl 打开（测试和工具都这么用），给一个 TicketBackend
   * 实例就用它。传后端时 `log` 这一栏没用：坏行由后端自己报。
   */
  constructor(
    source: string | TicketBackend,
    log?: (message: string) => void,
    emit?: (event: TicketBroadcast) => void,
  ) {
    this.backend = typeof source === 'string' ? new JsonlTicketStore(source, log) : source
    this.emit = emit
  }

  /** 这份日志在哪儿：jsonl 就是文件路径，别的后端是它自己的地址。 */
  get path(): string {
    return this.backend.location
  }

  /**
   * 读之前的兜底：只问后端一次「变了吗」，没变就直接用投影。变了（别的进程
   * 追加、有人手改了文件、日志被截断）才整份重放一次——不是每次都重新折叠。
   */
  private refresh(): void {
    if (this.loaded && !this.backend.changed()) return
    const state = new Map<string, TicketSnapshot>()
    for (const event of this.backend.load()) applyEvent(state, event)
    this.state = state
    this.loaded = true
  }

  list(): TicketSnapshot[] {
    this.refresh()
    return [...this.state.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  get(id: string): TicketSnapshot | undefined {
    this.refresh()
    return this.state.get(id)
  }

  /**
   * Run `work` without broadcasting what it appends. Sweep and the ticket
   * handlers write to the log themselves (reopen, markDelivered); announcing
   * those would wake the very listener that asked for the write. Nested calls
   * are fine: the counter only reaches zero once, on the outermost return.
   */
  quietly<T>(work: () => T): T {
    this.quiet += 1
    try {
      return work()
    } finally {
      this.quiet -= 1
    }
  }

  private append(event: TicketEvent): void {
    // 先对齐一次投影：日志要是被外部改过，这一条必须折在最新状态上。
    this.refresh()
    // 原子追加归后端管（jsonl 是一次 O_APPEND 的 writeSync），这里只折刚写的
    // 这一行，不重读整份日志。
    this.backend.append(event)
    applyEvent(this.state, event)
    this.loaded = true
    if (this.emit && this.quiet === 0) {
      this.emit({ id: event.id, at: event.at, kind: kindOf(event) })
    }
  }

  open(goal: string, dir?: string, brief?: string): TicketSnapshot {
    const now = new Date()
    const id = newTicketId(now)
    // An empty brief is not written at all: absent and empty should read the
    // same, and leaving it out keeps the log line as short as it used to be.
    const trimmed = brief?.trim()
    this.append({ id, at: now.toISOString(), goal, status: 'open', dir, ...(trimmed ? { brief: trimmed } : {}) })
    return this.get(id)!
  }

  update(
    id: string,
    patch: { status?: TicketStatus; note?: string; owner?: string; ownerId?: string; dir?: string },
  ): TicketSnapshot {
    const existing = this.get(id)
    if (!existing) throw new Error(`unknown ticket: ${id}`)
    this.append({ id, at: new Date().toISOString(), ...patch })
    return this.get(id)!
  }

  /** Queue one more message for the worker; it is delivered later, not now. */
  appendInput(id: string, text: string): { ticket: TicketSnapshot; entry: TicketEntry } {
    if (!this.get(id)) throw new Error(`unknown ticket: ${id}`)
    const now = new Date()
    const entry = newEntryId(now)
    this.append({ id, at: now.toISOString(), input: { id: entry, text } })
    return { ticket: this.get(id)!, entry: { id: entry, at: now.toISOString(), text, delivered: false } }
  }

  /** Record one report from a worker; the main session reads it later. */
  appendReport(id: string, text: string): { ticket: TicketSnapshot; entry: TicketEntry } {
    if (!this.get(id)) throw new Error(`unknown ticket: ${id}`)
    const now = new Date()
    const entry = newEntryId(now)
    this.append({ id, at: now.toISOString(), report: { id: entry, text } })
    return { ticket: this.get(id)!, entry: { id: entry, at: now.toISOString(), text, delivered: false } }
  }

  /** Record that one queued entry reached its reader. */
  markDelivered(id: string, kind: EntryKind, entryId: string): TicketSnapshot {
    if (!this.get(id)) throw new Error(`unknown ticket: ${id}`)
    this.append({ id, at: new Date().toISOString(), delivered: { kind, id: entryId } })
    return this.get(id)!
  }
}
