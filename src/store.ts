import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

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
   * `BRIEF_MAX_COLUMNS` display columns. Optional because tickets written before
   * 2026-11-02 have no such field — readers fall back to `briefOf()`, which
   * derives the same thing from `goal`.
   */
  brief?: string
  status: TicketStatus
  dir?: string
  note?: string
  owner?: string
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
interface TicketEvent {
  id: string
  at: string
  goal?: string
  brief?: string
  status?: TicketStatus
  dir?: string
  note?: string
  owner?: string
  input?: { id: string; text: string }
  report?: { id: string; text: string }
  delivered?: { kind: EntryKind; id: string }
}

export type EntryKind = 'input' | 'report'

/**
 * Longest brief, measured in display columns: a CJK character is 2 columns, a
 * half-width one is 1. 34 columns = 17 汉字, which is what fits on the little
 * screen's second line.
 *
 * 依据 2026-11-02 display 侧实测：第二行 10px 字号、可用宽 172px，能放 17 个汉字
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

/** Cut to `maxColumns` display columns, adding an ellipsis when anything was dropped. */
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

/** Fold events into the current snapshot of every ticket, newest event last. */
export function foldEvents(events: readonly TicketEvent[]): TicketSnapshot[] {
  const state = new Map<string, TicketSnapshot>()
  for (const event of events) {
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
        createdAt: event.at,
        updatedAt: event.at,
        closedAt: event.status && ENDED.has(event.status) ? event.at : undefined,
        inputs: event.input ? queue([], event.at, event.input) : [],
        reports: event.report ? queue([], event.at, event.report) : [],
      })
      continue
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
  return [...state.values()]
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
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  get path(): string {
    return this.file
  }

  private readEvents(): TicketEvent[] {
    if (!existsSync(this.file)) return []
    const text = readFileSync(this.file, 'utf8')
    const events: TicketEvent[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed) as TicketEvent)
      } catch {
        // A torn last line after a crash is skipped rather than failing the tool.
      }
    }
    return events
  }

  list(): TicketSnapshot[] {
    return foldEvents(this.readEvents()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  get(id: string): TicketSnapshot | undefined {
    return this.list().find((ticket) => ticket.id === id)
  }

  private append(event: TicketEvent): void {
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8')
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

  update(id: string, patch: { status?: TicketStatus; note?: string; owner?: string; dir?: string }): TicketSnapshot {
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
