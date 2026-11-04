/**
 * 巡检提醒：票台有动静时告诉主会话，但**不再冒充主人说话**。
 *
 * 三条路：
 *
 * - 有未读报告、一轮干完没交报告、票干完/跑太久没收工 —— 记成巡检事实，走
 *   `ctx.systemPrompt.context()` 的动态上下文。宿主把它渲染成 runtime-context
 *   快照，模型看见的是环境状态，不会当成主人发的指令回话。
 * - 票挂起超过阈值（等主人决定）—— 才真的 `followup` 一条，开头 `[sweep] `，
 *   第二句明说不是主人在说话。这种「叫醒」只能走 user 消息，所以话得自己说清。
 * - 宿主没有动态上下文这一口 —— 退回唤醒，同样带 `[sweep] ` 前缀，至少不让
 *   模型把提醒当成主人的命令。
 *
 * 所有方法都不抛：提醒失败不该让交报告、巡检这些正经事跟着失败。
 */
import type { Clock } from './clock'
import { realClock } from './clock'
import type { SweepFact, SweepFacts } from './sweep-facts'

export type OwnerWake = (text: string) => boolean | Promise<boolean>

/** 打断主会话时文本的第一个词。只有真正需要人的那一条用得上。 */
export const SWEEP_PREFIX = '[sweep] '

export interface NotifierDeps {
  /** 巡检事实表：有它就走动态上下文，没有就退回唤醒。 */
  facts?: SweepFacts
  clock?: Clock
  /** 把话送到主人那儿（活着的会话）。没配就是「不提醒」。 */
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

/** 一句话，别带正文：提醒是钩子，不是内容。陈述句，不点名工具。 */
export function reportArrivedText(input: ReportArrivedInput): string {
  return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」交了 ${input.pendingReports} 条报告，还没读。`
}

export function idleText(input: IdleInput): string {
  switch (input.reason) {
    case 'waiting-20m':
      return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」干完 ${input.sinceMinutes} 分钟了还没收工。`
    case 'blocked-60m':
      return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」挂了 ${input.sinceMinutes} 分钟，在等主人决定。这是巡检提醒，不是主人在说话，看情况处理，不用回我。`
    case 'running-90m':
      return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」跑了 ${input.sinceMinutes} 分钟还没停。`
    default:
      return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」该看一眼了。`
  }
}

export function noReportText(input: NoReportInput): string {
  return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」这一轮（第 ${input.epoch} 轮，${input.stopReason}）干完了，一份报告也没交。`
}

export function createNotifier(deps: NotifierDeps = {}): OwnerNotifier {
  const warn = deps.warn ?? (() => {})
  const clock = deps.clock ?? realClock

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

  /** 记一条巡检事实；没有事实表（老宿主）就退回带 `[sweep] ` 的唤醒。 */
  function record(fact: SweepFact, fallback: string): Promise<boolean> {
    if (deps.facts) {
      deps.facts.remember(fact)
      return Promise.resolve(true)
    }
    return send(fallback, true)
  }

  return {
    reportArrived(input) {
      return record(
        {
          ticketId: input.ticketId,
          brief: input.brief,
          kind: 'report',
          since: clock.now().toISOString(),
          unread: input.pendingReports,
        },
        reportArrivedText(input),
      )
    },
    idle(input) {
      // 只有「等主人决定」才值得打断：其余都是主会话下一轮抬头就能看到的状态。
      if (input.reason === 'blocked-60m') return send(idleText(input), true)
      return record(
        {
          ticketId: input.ticketId,
          brief: input.brief,
          kind: input.reason === 'running-90m' ? 'running' : 'waiting',
          since: new Date(clock.now().getTime() - input.sinceMinutes * 60_000).toISOString(),
        },
        idleText(input),
      )
    },
    noReport(input) {
      return record(
        {
          ticketId: input.ticketId,
          brief: input.brief,
          kind: 'no-report',
          since: clock.now().toISOString(),
        },
        noReportText(input),
      )
    },
  }
}
