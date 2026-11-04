/**
 * 报告提醒：告诉主人「某张票有动静了」。
 *
 * 只发摘要，不带正文。正文在日志里，谁要看谁 `dispatch_read`——把正文塞进
 * 提醒里等于让同一段话在两条路上各存一份，读数、截断、去重全得做两遍。
 *
 * 所有方法都不抛：提醒失败不该让交报告、巡检这些正经事跟着失败。
 */
export type OwnerWake = (text: string) => boolean | Promise<boolean>

export interface NotifierDeps {
  /** 把话送到主人那儿（活着的会话 / 推送通道）。没配就是「不提醒」。 */
  wake?: OwnerWake
  /** 巡检提醒总开关。报告到达不受它管——那是人的事，不是定时器的噪音。 */
  quiet?: boolean
  warn?: (message: string) => void
}

export interface ReportArrivedInput {
  ticketId: string
  brief: string
  epoch: number
  pendingReports: number
}

export type IdleReason = 'waiting-20m' | 'blocked-60m' | 'running-90m'

export interface IdleInput {
  ticketId: string
  brief: string
  reason: IdleReason
  sinceMinutes: number
}

export interface NoReportInput {
  ticketId: string
  brief: string
  epoch: number
  stopReason: string
}

export interface OwnerNotifier {
  reportArrived(input: ReportArrivedInput): Promise<boolean>
  idle(input: IdleInput): Promise<boolean>
  noReport(input: NoReportInput): Promise<boolean>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 一句话，别带正文：提醒是钩子，不是内容。 */
export function reportArrivedText(input: ReportArrivedInput): string {
  const more = input.pendingReports > 1 ? `等 ${input.pendingReports} 条` : '1 条'
  return `票 ${input.ticketId}「${input.brief}」交了报告（第 ${input.epoch} 轮 ${more}），要看看就用 dispatch_read。`
}

export function idleText(input: IdleInput): string {
  switch (input.reason) {
    case 'waiting-20m':
      return `票 ${input.ticketId}「${input.brief}」干完 ${input.sinceMinutes} 分钟了还没收工：dispatch_close 收掉，还是再派点？`
    case 'blocked-60m':
      return `票 ${input.ticketId}「${input.brief}」挂了 ${input.sinceMinutes} 分钟，还在等什么？`
    case 'running-90m':
      return `票 ${input.ticketId}「${input.brief}」跑了 ${input.sinceMinutes} 分钟还没停，看一眼要不要它继续。`
    default:
      return `票 ${input.ticketId}「${input.brief}」该看一眼了。`
  }
}

export function noReportText(input: NoReportInput): string {
  return `票 ${input.ticketId}「${input.brief}」这一轮（第 ${input.epoch} 轮，${input.stopReason}）干完了，一份报告也没交。`
}

export function createNotifier(deps: NotifierDeps = {}): OwnerNotifier {
  const warn = deps.warn ?? (() => {})

  async function send(text: string, gated: boolean): Promise<boolean> {
    if (gated && deps.quiet) return false
    if (!deps.wake) return false
    try {
      return await deps.wake(text)
    } catch (error) {
      warn(`提醒没送出去：${messageOf(error)}`)
      return false
    }
  }

  return {
    reportArrived: (input) => send(reportArrivedText(input), false),
    idle: (input) => send(idleText(input), true),
    noReport: (input) => send(noReportText(input), false),
  }
}
