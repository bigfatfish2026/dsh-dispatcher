/**
 * 票快照 → 对外读数（TicketView）的唯一一份换算。
 *
 * 这里只做换算，不读日志、不写日志：入参是 store 折好的 `TicketSnapshot`，
 * 出参是工具、CLI、进程内 service 和桌面快照文件共用的形状。放在独立文件里是
 * 为了不让 desk（有队列、有 spawn）成为所有只读消费者的依赖——桌宠和 `/tickets`
 * 只需要这一个纯函数，不用把整个票台拖起来。
 */
import { briefOf, isOpen, minutesSince, pending } from '../store'
import type {
  ConflictWait,
  IntentSpec,
  PresetSource,
  TicketPhase,
  TicketPlan,
  TicketSnapshot,
  TicketStatus,
} from '../store'

/** 工具面看到的票：只有该看的，没有内部字段。 */
export interface TicketView {
  id: string
  goal: string
  brief: string
  status: TicketStatus
  /**
   * 探路/排队阶段位：`planning` 探路中、`planned` 待放行、`blocked` 冲突排队、
   * `running` 真在跑。快路径与老票没有这一栏，票面就别多写。
   */
  phase?: TicketPhase
  statusSince: string
  ageMinutes: number
  stale: boolean
  dir?: string
  note?: string
  workerAlive?: boolean
  device?: string
  preset?: string
  presetSource?: PresetSource
  epoch: number
  epochReports: number
  pendingInputs: number
  pendingReports: number
  /**
   * 票上的意图：影响面、可撤性、预演、撤回指南。来自 `declared`；老票没有这一栏，整个键不出现。
   * 只给主会话的 dispatch_list / dispatch_read 读回，不进跨进程 JSON（那一层的
   * 形状由 `readout.ts` 的 schema 版本管，加字段要单独升版）。
   */
  intent?: IntentSpec
  /** 探路子会话交的方案；快路径或老票没有这一栏。 */
  plan?: TicketPlan
  /**
   * 冲突排队：phase 是 `queued` 时撞的是谁、撞了什么。dispatch_list 的 render
   * 把它铺成 `waiting on t-xxxx (dir:/a/b)` 一行，主会话看得见为什么没派活。
   */
  waitOn?: ConflictWait[]
  /** 弱冲突的票号：判定是提示放行，不阻塞，但票面上要看得到撞过谁。 */
  weakWith?: string[]
  /**
   * 关票时对出来的越界项（归一化资源串）。dispatch_list / dispatch_read 各铺一行
   * 「越界：…」；没有越界时整个键不出现，render 一个字都不多写。
   */
  outOfScope?: string[]
}

/** 换算需要的配置：全是 desk 与 CLI 共用的几个数，没有别的东西。 */
export interface ViewOptions {
  /** brief 的列宽上限（汉字按两列算）。 */
  briefMaxColumns: number
  /** waiting 票多久算「凉了」。 */
  waitingMinutes: number
  /** blocked 票多久算「凉了」。 */
  blockedMinutes: number
  /** 算 ageMinutes 用的钟；测试可以钉死。 */
  now?: Date
}

/**
 * 一张票的对外读数。状态、epoch、待投递/待读计数全按快照里的值，不重新解析
 * 日志；`brief` 仍是 `briefOf()`（老票从 goal 推），与 dispatch_list 完全同源。
 */
export function ticketView(ticket: TicketSnapshot, options: ViewOptions): TicketView {
  const ageMinutes = minutesSince(ticket.statusSince, options.now ?? new Date())
  const stale =
    (ticket.status === 'waiting' && ageMinutes >= options.waitingMinutes) ||
    (ticket.status === 'blocked' && ageMinutes >= options.blockedMinutes)
  return {
    id: ticket.id,
    goal: ticket.goal,
    brief: briefOf(ticket, options.briefMaxColumns),
    status: ticket.status,
    ...(ticket.phase ? { phase: ticket.phase } : {}),
    statusSince: ticket.statusSince,
    ageMinutes,
    stale,
    ...(ticket.dir ? { dir: ticket.dir } : {}),
    ...(ticket.note ? { note: ticket.note } : {}),
    ...(ticket.workerAlive !== undefined ? { workerAlive: ticket.workerAlive } : {}),
    ...(ticket.device ? { device: ticket.device } : {}),
    ...(ticket.preset ? { preset: ticket.preset } : {}),
    ...(ticket.presetSource ? { presetSource: ticket.presetSource } : {}),
    epoch: ticket.epoch,
    epochReports: ticket.epochReports,
    pendingInputs: pending(ticket.inputs).length,
    pendingReports: pending(ticket.reports).length,
    ...(ticket.intent ? { intent: ticket.intent } : {}),
    ...(ticket.plan ? { plan: ticket.plan } : {}),
    ...(ticket.waitOn?.length ? { waitOn: ticket.waitOn } : {}),
    ...(ticket.weakWith?.length ? { weakWith: ticket.weakWith } : {}),
    ...(ticket.outOfScope?.length ? { outOfScope: ticket.outOfScope } : {}),
  }
}

/** 未结票计数：和 `dispatch_list` 的 openCount 同一口径（open/running/waiting/blocked）。 */
export function openTicketCount(tickets: readonly TicketSnapshot[]): number {
  return tickets.filter((ticket) => isOpen(ticket.status)).length
}
