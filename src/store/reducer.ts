/**
 * 纯 fold：事件进去，票出来。
 *
 * 这一层不碰时间（`at` 全从事件里读）、不碰 IO、不碰 ctx，所以可以回放老日志、
 * 可以在测试里直接喂数组。`applyEvent` 是唯一的折叠规则，全量重放和增量投影
 * 共用它——一条代码路径，两者就不可能对不上。
 *
 * 两条折叠路径，边界清楚：
 *
 * - 2026-11-04 之前的老行（没有 `kind`）走 `applyLegacy`，逐字保留拆分前的
 *   语义；`tests/fixture-equivalence.test.ts` 拿 448 张线上票逐字段钉着它。
 * - 带 `kind` 的新事件按设计文档 §3.1 / §4 折叠，进了终态就只进不出。
 */
import { isKindedEvent, isTicketEvent } from './events'
import type {
  TicketEntry,
  TicketEvent,
  TicketSnapshot,
  TicketStatus,
  LegacyTicketEvent,
  KindedTicketEvent,
} from './events'

/** The two statuses that end a ticket: a dropped one is a person's stop. */
const ENDED: ReadonlySet<TicketStatus> = new Set(['done', 'dropped'])

function isTerminal(status: TicketStatus): boolean {
  return ENDED.has(status)
}

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

/** 一张刚出现的票：老行和新事件的公共底座。 */
function blank(event: { id: string; at: string }): TicketSnapshot {
  return {
    id: event.id,
    goal: '',
    brief: undefined,
    status: 'open',
    dir: undefined,
    note: undefined,
    owner: undefined,
    ownerId: undefined,
    createdAt: event.at,
    updatedAt: event.at,
    closedAt: undefined,
    inputs: [],
    reports: [],
    statusSince: event.at,
    workerId: undefined,
    device: undefined,
    workerAlive: undefined,
    preset: undefined,
    presetSource: undefined,
    presetWhy: undefined,
    requestId: undefined,
    publisher: undefined,
    epoch: 0,
    epochReports: 0,
    epochStartedAt: undefined,
  }
}

/**
 * 2026-11-04 之前那套折叠，逐字保留（含键的写法）。新字段只补默认值：
 * statusSince 跟着状态行走，epoch 恒 0，epochReports 数本「老 epoch」里的报告。
 */
function applyLegacy(state: Map<string, TicketSnapshot>, event: LegacyTicketEvent): void {
  const previous = state.get(event.id)
  if (!previous) {
    state.set(event.id, {
      ...blank(event),
      goal: event.goal ?? '',
      brief: event.brief,
      status: event.status ?? 'open',
      dir: event.dir,
      note: event.note,
      owner: event.owner,
      ownerId: event.ownerId,
      closedAt: event.status && ENDED.has(event.status) ? event.at : undefined,
      inputs: event.input ? queue([], event.at, event.input) : [],
      reports: event.report ? queue([], event.at, event.report) : [],
      epochReports: event.report ? 1 : 0,
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
    closedAt: event.status
      ? ENDED.has(event.status)
        ? event.at
        : undefined
      : previous.closedAt,
    // 老日志推不出「进入当前状态的准确时刻」以外的东西：状态行就是状态边界。
    statusSince: event.status ? event.at : previous.statusSince,
    epochReports: event.report ? previous.epochReports + 1 : previous.epochReports,
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

/** 状态变了才动 statusSince；同状态的事件不许把提醒计时清零。 */
function advance(
  previous: TicketSnapshot,
  at: string,
  patch: Partial<TicketSnapshot> & { status: TicketStatus },
): TicketSnapshot {
  return {
    ...previous,
    ...patch,
    updatedAt: at,
    statusSince: patch.status === previous.status ? previous.statusSince : at,
  }
}

function applyKinded(state: Map<string, TicketSnapshot>, event: KindedTicketEvent): void {
  const previous = state.get(event.id)
  switch (event.kind) {
    case 'published': {
      // 同一张票只建一次：重放或重复发布不许把已有状态推回 open。
      if (previous) return
      state.set(event.id, {
        ...blank(event),
        goal: event.goal,
        brief: event.brief,
        dir: event.dir,
        status: 'open',
        publisher: event.publisher,
        device: event.device,
        preset: event.preset,
        presetSource: event.presetSource,
        presetWhy: event.presetWhy,
        requestId: event.requestId,
      })
      return
    }
    case 'spawned': {
      if (!previous || isTerminal(previous.status)) return
      const epoch = previous.epoch + 1
      state.set(
        event.id,
        advance(previous, event.at, {
          status: 'running',
          workerId: event.workerId,
          device: event.device ?? previous.device,
          workerAlive: true,
          preset: event.preset,
          epoch,
          epochReports: 0,
          epochStartedAt: event.at,
          owner: event.label ?? previous.owner,
          note: previous.note,
        }),
      )
      return
    }
    case 'spawn-failed': {
      if (!previous || isTerminal(previous.status)) return
      state.set(event.id, {
        ...previous,
        updatedAt: event.at,
        note: `spawn 失败：${event.reason}`,
      })
      return
    }
    case 'ended': {
      // 第 8 行：没 spawned 过的 open 票对不上任何 worker，忽略。
      if (!previous || isTerminal(previous.status)) return
      if (previous.status === 'open' && previous.epoch === 0 && !previous.workerId) return
      state.set(
        event.id,
        advance(previous, event.at, {
          status: 'waiting',
          workerAlive: false,
          epochReports: event.epochReports ?? previous.epochReports,
        }),
      )
      return
    }
    case 'idled': {
      if (!previous || isTerminal(previous.status)) return
      // 只有 running / waiting 上有意义：open 还没派出去，别的状态不是这个边。
      if (previous.status !== 'running' && previous.status !== 'waiting') return
      state.set(
        event.id,
        advance(previous, event.at, { status: 'waiting', workerAlive: true }),
      )
      return
    }
    case 'resumed': {
      if (!previous || isTerminal(previous.status)) return
      state.set(
        event.id,
        advance(previous, event.at, {
          status: 'running',
          workerId: event.workerId,
          device: event.device ?? previous.device,
          workerAlive: true,
          epoch: event.epoch ?? previous.epoch + 1,
          epochReports: 0,
          epochStartedAt: event.at,
        }),
      )
      return
    }
    case 'queued': {
      if (!previous || isTerminal(previous.status)) return
      state.set(event.id, {
        ...previous,
        updatedAt: event.at,
        inputs: queue(previous.inputs, event.at, event.input),
      })
      return
    }
    case 'delivered': {
      if (!previous) return
      const inputs =
        event.entry.kind === 'input'
          ? deliver(previous.inputs, event.at, event.entry.id)
          : previous.inputs
      const reports =
        event.entry.kind === 'report'
          ? deliver(previous.reports, event.at, event.entry.id)
          : previous.reports
      // 投递成功本身就说明「人活着」；只有 input 才是「又有一轮活在跑」。
      if (event.entry.kind === 'input' && !isTerminal(previous.status)) {
        state.set(
          event.id,
          advance(previous, event.at, {
            status: 'running',
            workerAlive: true,
            inputs,
            reports,
          }),
        )
        return
      }
      state.set(event.id, { ...previous, updatedAt: event.at, inputs, reports })
      return
    }
    case 'reported': {
      if (!previous) return
      state.set(event.id, {
        ...previous,
        updatedAt: event.at,
        reports: queue(previous.reports, event.at, event.report),
        epochReports: previous.epochReports + 1,
      })
      return
    }
    case 'blocked': {
      if (!previous || isTerminal(previous.status)) return
      state.set(
        event.id,
        advance(previous, event.at, {
          status: 'blocked',
          note: event.reason,
        }),
      )
      return
    }
    case 'closed': {
      if (!previous || isTerminal(previous.status)) return
      state.set(
        event.id,
        advance(previous, event.at, {
          status: event.outcome,
          // 票都收了就没有「人还在」这回事：终态上 workerAlive 一律 false。
          workerAlive: false,
          closedAt: event.at,
          note: event.note ?? previous.note,
          // 作废：未投递的排队 input 不再投、也不留复活借口。已投递的留着当历史。
          inputs: previous.inputs.filter((entry) => entry.delivered),
        }),
      )
      return
    }
    case 'legacy/status': {
      if (!previous) {
        state.set(event.id, {
          ...blank(event),
          status: event.status,
          note: event.note,
          closedAt: ENDED.has(event.status) ? event.at : undefined,
        })
        return
      }
      state.set(event.id, {
        ...previous,
        updatedAt: event.at,
        status: event.status,
        note: event.note ?? previous.note,
        statusSince: event.status === previous.status ? previous.statusSince : event.at,
        closedAt: ENDED.has(event.status)
          ? event.at
          : previous.closedAt && event.status !== previous.status
            ? undefined
            : previous.closedAt,
      })
      return
    }
    default:
      // 未知 kind（含将来删掉的事件名）：跳过，不许把票折坏。
      return
  }
}

/**
 * Fold one event into `state`. Shared by the full fold (`fold`) and the store's
 * projection (`store/log.ts`): one code path means an incremental update after
 * `commit` and a rebuild from the file can never disagree.
 */
export function applyEvent(state: Map<string, TicketSnapshot>, event: TicketEvent): void {
  // 一行能 parse 不等于它是一条事件：崩溃留下的 null、数字、数组都在这里被挡下。
  // 放过去的话 `event.id` 会抛 TypeError，而 `list()` 是每个 dispatch_* 的第一步
  // ——一处脏行就能把整套工具打死。没有 id/at 的行也不构成事件。
  if (!isTicketEvent(event)) return
  if (isKindedEvent(event)) applyKinded(state, event)
  else applyLegacy(state, event)
}

/**
 * Fold events into the current snapshot of every ticket, newest event last.
 *
 * 返回 Map 而不是数组：投影要按 id 查，等价性测试也要两边按 id 对齐。
 * 顺序：Map 的插入顺序就是票第一次出现的顺序。
 */
export function fold(events: readonly TicketEvent[]): Map<string, TicketSnapshot> {
  const state = new Map<string, TicketSnapshot>()
  for (const event of events) applyEvent(state, event)
  return state
}

/** Same fold, as a plain array — kept because callers imported it this way. */
export function foldEvents(events: readonly TicketEvent[]): TicketSnapshot[] {
  return [...fold(events).values()]
}
