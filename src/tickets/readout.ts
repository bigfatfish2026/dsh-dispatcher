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
import { BLOCKED_MINUTES, BRIEF_MAX_COLUMNS, WAITING_MINUTES } from '../defaults'
import { ticketView } from './view'
import type { TicketPhase, TicketSnapshot, TicketStatus } from '../store'
import type { TicketView, ViewOptions } from './view'

/**
 * 跨进程 JSON 的 schema 版本。
 *
 * 只做**加法**（多一个键）不升版本：现有消费者按名字取键、认不出来的键直接
 * 忽略，升到 2 反而会让只认 v1 的一方（桌宠 `ticket_snap.rs` 里 `ver != 1`
 * 就整份丢帧）当场读不出票。删键、改名、改语义才升版本，那时要两边一起换。
 */
export const TICKETS_SCHEMA_VERSION = 1 as const

/** cordis service 名：`/tickets` 指令用 `ctx.get('dispatcher/tickets')` 直接拿。 */
export const TICKETS_SERVICE = 'dispatcher/tickets'

/**
 * 查票服务的 cordis service 名：dsh-backlog 用 `ctx.inject(['dispatcher'])` 拿它，
 * 挂工单之前先确认票号真在票台上。和 `dispatcher/tickets` 是两个口子：那个给
 * `/tickets` 和桌宠吃整份读数，这个只留查票的两个方法。
 */
export const DISPATCHER_SERVICE = 'dispatcher'

/** 只读出口真正依赖的东西：store 折好的快照，别的都不要。 */
export interface TicketSource {
  list(): TicketSnapshot[]
  get(id: string): TicketSnapshot | undefined
  /** 日志在哪儿（jsonl 是路径，redis 是地址），只给诊断用。 */
  readonly location: string
}

/**
 * 查票口子返回的单票读数：只够调用方判断「这张票在不在、什么状态」，不给
 * 报告、账本、意图这些内部栏。可选栏缺省时整个键不出现（与 `TicketView` 同一
 * 口径），不吃 null。
 */
export interface TicketLookup {
  id: string
  status: TicketStatus
  /** 一句话摘要；老票由 goal 推出来，和 dispatch_list 同一份。 */
  brief: string
  goal: string
  preset?: string
  owner?: string
  createdAt: string
}

/**
 * `dispatcher` service 的唯一形状：两个只读方法，不暴露 readout、log、desk
 * 或任何能改状态的句柄。
 *
 * 两个方法都只读 store 折好的快照，不追加事件、不开写事务、不触发广播；
 * 查不到的票返回 `null`（`hasTicket` 返回 `false`），不抛错。
 */
export interface DispatcherService {
  lookupTicket(id: string): TicketLookup | null
  hasTicket(id: string): boolean
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
  /**
   * 相位（planning / planned / queued / gated / running），没有就是 null。
   *
   * 消费者光看 status 分不出「派活被驳回」和普通 waiting：gated 那张票
   * status 也是 waiting。小屏要画「×」这类标记只能靠这一栏，所以它跟着
   * 快照一起出去，别让桌宠自己猜。
   */
  phase: TicketPhase | null
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
    phase: view.phase ?? null,
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

  /**
   * 查票：有就返回收窄后的读数，没有返回 `null`。
   *
   * 只走 `source.get()` 这条现成的折叠读路径，不碰后端、不开事务、不广播。
   */
  lookupTicket(id: string): TicketLookup | null {
    const ticket = this.source.get(id)
    if (!ticket) return null
    const view = this.view(ticket, this.now())
    return {
      id: view.id,
      status: view.status,
      brief: view.brief,
      goal: view.goal,
      ...(view.preset ? { preset: view.preset } : {}),
      ...(ticket.owner ? { owner: ticket.owner } : {}),
      createdAt: ticket.createdAt,
    }
  }

  /** 票在不在；内部直接调 `lookupTicket`，两个口子结论永远一致。 */
  hasTicket(id: string): boolean {
    return this.lookupTicket(id) !== null
  }

  /** 按 `selection` 选票，保持 store 的顺序（排队序号 seq 升序；老票按 createdAt，老的在前）。 */
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
      briefMaxColumns: this.options.briefMaxColumns ?? BRIEF_MAX_COLUMNS,
      waitingMinutes: this.options.waitingMinutes ?? WAITING_MINUTES,
      blockedMinutes: this.options.blockedMinutes ?? BLOCKED_MINUTES,
      now,
    })
  }
}

/** 进程内 service 的形状；`dispatcher/tickets` 提供的就是这个。 */
export type TicketsService = TicketReadout
