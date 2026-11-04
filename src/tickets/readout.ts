/**
 * 统一只读出口：CLI、进程内 cordis service、桌面快照文件共用这一层。
 *
 * 唯一的输入是 store 的折叠结果（`list()` / `get()`），这里不再读 jsonl、也不
 * 解析任何一行事件。后端换成 redis/sqlite 时，只要它还实现 `TicketSource`，
 * CLI、service、快照文件的形状一个字节都不变。
 *
 * 对外只给两种形状：
 * - `TicketView`：进程内用的完整读数（带 goal，可选字段缺省时整个键不出现）；
 * - `TicketsPayload` / `TicketJsonView`：跨进程用的固定形状，可选字段一律写
 *   `null`，键顺序固定，带 schema 版本号 `v`。
 *
 * 时间字段一律 ISO 8601（UTC，带 Z），与票日志里的 `at` 同一口径；没有 epoch ms
 * 混用。`generatedAt` 是这份读数的参考时刻，`ageMinutes` 按它算。
 */
import { isOpen } from '../store'
import { ticketView } from './view'
import type { TicketSnapshot, TicketStatus } from '../store'
import type { TicketView, ViewOptions } from './view'

/** 跨进程 JSON 的 schema 版本。字段增删都要 +1，消费者按它选解析器。 */
export const TICKETS_SCHEMA_VERSION = 1 as const

/** cordis service 名：`/tickets` 指令用 `ctx.get('dispatcher/tickets')` 直接拿。 */
export const TICKETS_SERVICE = 'dispatcher/tickets'

/** 只读出口真正依赖的东西：store 折好的快照，别的都不要。 */
export interface TicketSource {
  list(): TicketSnapshot[]
  get(id: string): TicketSnapshot | undefined
  /** 日志在哪儿（jsonl 是路径，redis 是地址），只给诊断用。 */
  readonly location: string
}

/**
 * 跨进程 JSON 的单票形状：所有键都在，缺省值写 null，键顺序固定。
 *
 * 前十四项是消费者点名的必给字段（`/tickets` 详情页要打「最后动静」和「关闭于」，
 * 所以 createdAt / updatedAt / closedAt 必须有）；后面几项是工具读数里本来就有、
 * 顺手给的诊断栏，缺省写 null。
 */
export interface TicketJsonView {
  id: string
  brief: string
  goal: string
  status: TicketStatus
  /** 小屏/工具用的 owner 标签；没有就是 null。 */
  owner: string | null
  createdAt: string
  updatedAt: string
  /** 关票时刻；开着就是 null。 */
  closedAt: string | null
  /** 进入当前状态的时刻。 */
  statusSince: string
  workerAlive: boolean | null
  pendingInputs: number
  pendingReports: number
  /** 这张票全部报告条数（含已读）。 */
  reportsCount: number
  ageMinutes: number
  stale: boolean
  epoch: number
  epochReports: number
  preset: string | null
  presetSource: string | null
  dir: string | null
  note: string | null
  device: string | null
}

/** 全量状态计数：屏上的「N 未结」直接取 `openTotal`，别自己数。 */
export interface TicketCounts {
  open: number
  running: number
  waiting: number
  blocked: number
  /** open + running + waiting + blocked。 */
  openTotal: number
}

/** CLI --json 与快照文件的完整形状；两处逐字段一致。 */
export interface TicketsPayload {
  v: typeof TICKETS_SCHEMA_VERSION
  /** 生成这份读数的时间，ISO 8601（UTC）。 */
  generatedAt: string
  /** 按全量日志算，不受 `tickets` 过滤影响。 */
  counts: TicketCounts
  tickets: TicketJsonView[]
}

/** 选哪些票。过滤条件只影响 `tickets`，不影响 `counts`。 */
export interface ReadSelection {
  /** 只看未结票（open/running/waiting/blocked）。 */
  open?: boolean
  /** 只看这一张（关了也看得到）。 */
  id?: string
  /**
   * 未结票之外，再带最近这么多张已结票；`0` 表示一张都不带。
   * 省略 = 全带（CLI 默认口径）。
   */
  recentClosed?: number
}

/** 换算与取数配置；默认值就是 cordis.yml 那几栏的默认值。 */
export interface ReadoutOptions extends Partial<Omit<ViewOptions, 'now'>> {
  /** 算 ageMinutes 的钟；测试钉死它，生产用真实时间。 */
  now?: () => Date
}

/** TicketView → 固定形状 JSON：可选键补 null，键顺序按声明走。 */
export function toJsonView(view: TicketView, ticket: TicketSnapshot): TicketJsonView {
  return {
    id: view.id,
    brief: view.brief,
    goal: view.goal,
    status: view.status,
    owner: ticket.owner ?? null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    closedAt: ticket.closedAt ?? null,
    statusSince: view.statusSince,
    workerAlive: view.workerAlive ?? null,
    pendingInputs: view.pendingInputs,
    pendingReports: view.pendingReports,
    reportsCount: ticket.reports.length,
    ageMinutes: view.ageMinutes,
    stale: view.stale,
    epoch: view.epoch,
    epochReports: view.epochReports,
    preset: view.preset ?? null,
    presetSource: view.presetSource ?? null,
    dir: view.dir ?? null,
    note: view.note ?? null,
    device: view.device ?? null,
  }
}

/** 全量状态计数。 */
export function countTickets(tickets: readonly TicketSnapshot[]): TicketCounts {
  const counts: TicketCounts = { open: 0, running: 0, waiting: 0, blocked: 0, openTotal: 0 }
  for (const ticket of tickets) {
    switch (ticket.status) {
      case 'open':
        counts.open += 1
        break
      case 'running':
        counts.running += 1
        break
      case 'waiting':
        counts.waiting += 1
        break
      case 'blocked':
        counts.blocked += 1
        break
      default:
        continue
    }
    counts.openTotal += 1
  }
  return counts
}

/**
 * 只读出口本体。既是 CLI 的实现，也是 `dispatcher/tickets` 这个 cordis service
 * 的实现：`payload()` 给跨进程消费者，`views()` / `get()` 给同进程的指令和工具。
 */
export class TicketReadout {
  readonly v = TICKETS_SCHEMA_VERSION

  constructor(
    private readonly source: TicketSource,
    private readonly options: ReadoutOptions = {},
  ) {}

  /** 票日志位置，诊断用。 */
  get location(): string {
    return this.source.location
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  /** 单票读数；没有这张票就是 undefined。 */
  get(id: string): TicketView | undefined {
    const ticket = this.source.get(id)
    return ticket ? this.view(ticket, this.now()) : undefined
  }

  /** 按 `selection` 选票，保持 store 的顺序（createdAt 升序，老的在前）。 */
  select(selection: ReadSelection = {}): TicketView[] {
    return this.pairs(selection, this.now()).map((pair) => pair.view)
  }

  /** 选票并把快照一起带出来：JSON 形状要用快照上的 owner/createdAt 等栏。 */
  private pairs(
    selection: ReadSelection,
    now: Date,
  ): Array<{ view: TicketView; ticket: TicketSnapshot }> {
    if (selection.id) {
      const ticket = this.source.get(selection.id)
      return ticket ? [{ view: this.view(ticket, now), ticket }] : []
    }
    const all = this.source.list()
    const wanted = new Set<string>()
    for (const ticket of all) if (isOpen(ticket.status)) wanted.add(ticket.id)
    if (selection.open !== true) {
      const closed = all.filter((ticket) => !isOpen(ticket.status))
      // 已结票按 updatedAt 取最近的 N 张：先排序再截，不假设日志里的顺序。
      const kept =
        selection.recentClosed === undefined
          ? closed
          : [...closed]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, Math.max(0, selection.recentClosed))
      for (const ticket of kept) wanted.add(ticket.id)
    }
    return all
      .filter((ticket) => wanted.has(ticket.id))
      .map((ticket) => ({ view: this.view(ticket, now), ticket }))
  }

  /** 固定形状的读数；CLI 和快照文件都从这里出。 */
  payload(selection: ReadSelection = {}): TicketsPayload {
    // 一次算好参考时刻：generatedAt 和 ageMinutes 必须用同一个 now，别让两次
    // 取钟把刚开十秒的票算成 eleven。
    const now = this.now()
    const all = this.source.list()
    const pairs = this.pairs(selection, now)
    return {
      v: TICKETS_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      counts: countTickets(all),
      tickets: pairs.map((pair) => toJsonView(pair.view, pair.ticket)),
    }
  }

  private view(ticket: TicketSnapshot, now: Date): TicketView {
    return ticketView(ticket, {
      briefMaxColumns: this.options.briefMaxColumns ?? 34,
      waitingMinutes: this.options.waitingMinutes ?? 20,
      blockedMinutes: this.options.blockedMinutes ?? 60,
      now,
    })
  }
}

/** 进程内 service 的形状；`dispatcher/tickets` 提供的就是这个。 */
export type TicketsService = TicketReadout
