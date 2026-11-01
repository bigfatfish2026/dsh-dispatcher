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
  status?: TicketStatus
  dir?: string
  note?: string
  owner?: string
  input?: { id: string; text: string }
  report?: { id: string; text: string }
  delivered?: { kind: EntryKind; id: string }
}

export type EntryKind = 'input' | 'report'

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

  open(goal: string, dir?: string): TicketSnapshot {
    const now = new Date()
    const id = newTicketId(now)
    this.append({ id, at: now.toISOString(), goal, status: 'open', dir })
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
