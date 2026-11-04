/**
 * 冻结的折叠参考实现——不是产品代码，只服务等价性测试。
 *
 * 逐字抄自 HEAD 8fd5ea0 的 `src/store.ts`（`ENDED` / `queue` / `deliver` /
 * `applyEvent` / `foldEvents`），一行没改。P1 把 `applyEvent` 搬进
 * `src/store/reducer.ts` 之后，线上代码里就只剩「新」这一份 fold 了；拿
 * TicketStore 的投影和 reducer 互相比，等于自己比自己，护栏就空了。所以这份
 * 副本停在拆 store 之前那一刻：新 reducer 必须与它在这份 3015 行线上日志上
 * 逐字段相等（连键集合都不许多不许少）。
 *
 * 规矩：这里的实现和注释都不要动，包括那些「看起来能改进」的地方。要改
 * reducer，先看 `tests/fixture-equivalence.test.ts` 红不红；它红了说明行为变了，
 * 不是测试要跟着改。
 */
import type {
  LegacyTicketEvent,
  LegacyTicketSnapshot,
  TicketEntry,
  TicketStatus,
} from '../../src/store'

// 只改类型、不改实现：新事件和快照多了几个字段，这份冻结的参考实现停在拆
// store 之前那一刻，所以按老形状收窄。折叠逻辑一个字没动。
type TicketEvent = LegacyTicketEvent
type TicketSnapshot = LegacyTicketSnapshot

/** The two statuses that end a ticket: a dropped one is a person's stop. */
const ENDED: ReadonlySet<TicketStatus> = new Set(['done', 'dropped'])

/** Append one queued entry, undelivered. */
function queue(
  entries: readonly TicketEntry[],
  at: string,
  entry: { id: string; text: string },
): TicketEntry[] {
  return [...entries, { id: entry.id, at, text: entry.text, delivered: false }]
}

/** Mark one entry of a list delivered; other entries are untouched. */
function deliver(entries: readonly TicketEntry[], at: string, id: string): TicketEntry[] {
  return entries.map((entry) =>
    entry.id === id ? { ...entry, delivered: true, deliveredAt: at } : entry,
  )
}

/** 8fd5ea0 的 applyEvent：注意它是就地改 `state`，且自己挡脏行。 */
function applyEvent(state: Map<string, TicketSnapshot>, event: TicketEvent): void {
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
    brief: event.brief ?? previous.brief,
    status: event.status ?? previous.status,
    dir: event.dir ?? previous.dir,
    note: event.note ?? previous.note,
    owner: event.owner ?? previous.owner,
    ownerId: event.ownerId ?? previous.ownerId,
    updatedAt: event.at,
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

/** 8fd5ea0 的 foldEvents，改成返回 Map 好和新 reducer 按 id 对齐。 */
export function foldLegacy(events: readonly TicketEvent[]): Map<string, TicketSnapshot> {
  const state = new Map<string, TicketSnapshot>()
  for (const event of events) applyEvent(state, event)
  return state
}
