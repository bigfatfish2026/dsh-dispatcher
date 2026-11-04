/**
 * 票快照 → 对外读数（TicketView）的唯一一份换算。
 *
 * 这里只做换算，不读日志、不写日志：入参是 store 折好的 `TicketSnapshot`，
 * 出参是工具、CLI、进程内 service 和桌面快照文件共用的形状。放在独立文件里是
 * 为了不让 desk（有队列、有 spawn）成为所有只读消费者的依赖——桌宠和 `/tickets`
 * 只需要这一个纯函数，不用把整个票台拖起来。
 */
import { briefOf, isOpen, minutesSince, pending } from '../store'
import type { PresetSource, TicketSnapshot, TicketStatus } from '../store'

/** 工具面看到的票：只有该看的，没有内部字段。 */
export interface TicketView {
  id: string
  goal: string
  brief: string
  status: TicketStatus
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
  }
}

/** 未结票计数：和 `dispatch_list` 的 openCount 同一口径（open/running/waiting/blocked）。 */
export function openTicketCount(tickets: readonly TicketSnapshot[]): number {
  return tickets.filter((ticket) => isOpen(ticket.status)).length
}
