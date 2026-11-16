/**
 * 巡检提醒：票台有动静时告诉主会话，但**不再冒充使用方说话**。
 *
 * 三条路：
 *
 * - 有未读报告、一轮干完没交报告、票干完/跑太久没收工 —— 记成巡检事实，走
 *   `ctx.systemPrompt.context()` 的动态上下文。宿主把它渲染成 runtime-context
 *   快照，模型看见的是环境状态，不会当成使用方发的指令回话。
 * - 冲突排队（`blocked` 带上 `wake`）—— 记事实之外再推开票方一句；主会话不在
 *   活表里就只剩事实，下一轮 runtime context 照样看得见。人工挂起不 wake。
 * - 票停在那儿没人接（`waiting` 满阈值）、或者挂起超过阈值（等使用方决定）——
 *   才真的 `followup` 一条，开头 `[sweep] `，第二句明说这是巡检、不是使用方在
 *   说话。这种「叫醒」只能走 user 消息，所以话得自己说清，还要带上怎么收场。
 * - 宿主没有动态上下文这一口 —— 退回唤醒，同样带 `[sweep] ` 前缀，至少不让
 *   模型把提醒当成使用方的命令。
 *
 * 所有方法都不抛：提醒失败不该让交报告、巡检这些正经事跟着失败。
 */
import type { Clock } from './clock'
import { realClock } from './clock'
import type { SweepFact, SweepFacts } from './sweep-facts'

/**
 * 把话送到主会话。第二个参数是「指名送给谁」（被挡/放行那张票的开票方
 * sessionId）：宿主认得出就只送那一个，认不出（会话已经不在了）再回落
 * 「第一个能 followup 的主会话」。
 */
export type OwnerWake = (text: string, to?: string) => boolean | Promise<boolean>

/** 打断主会话时文本的第一个词。只有真正需要人的那一条用得上。 */
export const SWEEP_PREFIX = '[sweep] '

export interface NotifierDeps {
  /** 巡检事实表：有它就走动态上下文，没有就退回唤醒。 */
  facts?: SweepFacts
  clock?: Clock
  /** 把话送到使用方那儿（活着的会话）。没配就是「不提醒」。 */
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

export interface BlockedInput {
  ticketId: string
  brief: string
  /** 冲突挂起时撞的对手与资源；人工挂起时没有这一栏。 */
  waitOn?: readonly { ticketId: string; resources: readonly string[]; brief?: string }[]
  /** 人工挂起的理由（`dispatch_block`）。 */
  reason?: string
  /** 开票方 sessionId：通知指名送给它，别推给别的主会话。 */
  publisher?: string
  /**
   * 冲突挂起那一刻推一把开票方：主会话在活表里就 followup 一句话，不在就只剩
   * 巡检事实。人工挂起不传这一栏——挂起不是叫醒人的理由，冲突才是。
   */
  wake?: boolean
}

export interface ReleasedInput {
  ticketId: string
  brief: string
  /** 挡在前面的票；收工后才轮到这单。没有就不细说。 */
  releasedBy?: readonly string[]
  /** 开票方 sessionId：放行那句指名送给它。 */
  publisher?: string
}

export interface OwnerNotifier {
  reportArrived(input: ReportArrivedInput): Promise<boolean>
  idle(input: IdleInput): Promise<boolean>
  noReport(input: NoReportInput): Promise<boolean>
  /**
   * 票挂起那刻记一条巡检事实；`wake` 为 true（冲突排队）时再推开票方一句。
   * 人工挂起仍然只记事实。
   */
  blocked(input: BlockedInput): Promise<boolean>
  /** 票放行或收工：把挂起那条摘掉，别一直挂着。 */
  resumed(ticketId: string): Promise<boolean>
  /** 冲突排队放行：摘掉挂起事实，再推开票方一句「轮到它了」。 */
  released(input: ReleasedInput): Promise<boolean>
  /**
   * 收工时发现票动了没声明的资源：给开票方推一句。老宿主/假件可以不实现，
   * 票台的调用点会判 `typeof === 'function'`。
   */
  outOfScope?(input: OutOfScopeInput): Promise<boolean>
}

/** 收工越界：一句话说清票号、越界几处、前几处是什么；不回滚，只提醒。 */
export interface OutOfScopeInput {
  ticketId: string
  brief: string
  paths: readonly string[]
  /** 开票方 sessionId：越界通知指名送给它。 */
  publisher?: string
}

const OUT_OF_SCOPE_MAX = 3

export function outOfScopeText(input: OutOfScopeInput): string {
  const shown = input.paths.slice(0, OUT_OF_SCOPE_MAX).join('、')
  const more = input.paths.length > OUT_OF_SCOPE_MAX ? ` 等 ${input.paths.length} 处` : ''
  return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」收工时对不上账：动了没声明的资源 ${shown}${more}。不回滚，只提醒；下张票可能被它撞。`
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
      // waiting 是「子会话停了、没人接」，得把主会话叫起来：一句话说清谁、停了
      // 多久、怎么收场，别让它回头冲着提醒本身回话。
      return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」进 waiting 已满 ${input.sinceMinutes} 分钟没动作。这是 dsh-dispatcher 巡检，不是使用方在说话。要看就 dispatch_read ${input.ticketId}，要收就 dispatch_close ${input.ticketId}。`
    case 'blocked-60m':
      return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」挂了 ${input.sinceMinutes} 分钟，在等使用方决定。这是巡检提醒，不是使用方在说话，看情况处理，不用回我。`
    case 'running-90m':
      return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」跑了 ${input.sinceMinutes} 分钟还没停。`
    default:
      return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」该看一眼了。`
  }
}

export function noReportText(input: NoReportInput): string {
  return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」这一轮（第 ${input.epoch} 轮，${input.stopReason}）干完了，一份报告也没交。`
}

/** 对手的写法：有 brief 就带上一句，主会话不用再翻票。 */
function waiters(waits: readonly { ticketId: string; brief?: string }[]): string {
  return waits.map((wait) => (wait.brief ? `${wait.ticketId}「${wait.brief}」` : wait.ticketId)).join('、')
}

/** 冲突挂起推给开票方的那一句：谁被挡、被谁挡、撞在哪。 */
export function conflictText(input: BlockedInput): string {
  const waits = input.waitOn ?? []
  const resources = [...new Set(waits.flatMap((wait) => wait.resources))].join('、')
  const why = resources ? `，冲突在 ${resources}` : ''
  return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」被 ${waiters(waits)} 挡住${why}，已排队等它收工后自动放行。这是票台通知，不是使用方在说话。`
}

/** 放行推给开票方的那一句。 */
export function releasedText(input: ReleasedInput): string {
  const by = input.releasedBy?.length ? `（${input.releasedBy.join('、')} 已收工）` : ''
  return `${SWEEP_PREFIX}票 ${input.ticketId}「${input.brief}」已放行${by}，执行轮派出去了。这是票台通知，不是使用方在说话。`
}

export function createNotifier(deps: NotifierDeps = {}): OwnerNotifier {
  const warn = deps.warn ?? (() => {})
  const clock = deps.clock ?? realClock

  async function send(text: string, gated: boolean, to?: string): Promise<boolean> {
    if (gated && deps.quiet) return false
    if (!deps.wake) return false
    try {
      return await deps.wake(text, to)
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
      // 票停在 waiting 没人接、或者挂起等使用方决定——都值得叫起来看一眼，
      // 走同一条 followup 通道。其余都是主会话下一轮抬头就能看到的状态。
      if (input.reason === 'waiting-20m' || input.reason === 'blocked-60m') {
        return send(idleText(input), true)
      }
      return record(
        {
          ticketId: input.ticketId,
          brief: input.brief,
          kind: 'running',
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
    blocked(input) {
      // 冲突排队必须留一条事实：主会话每个回合自己会读到 runtime context；
      // 没有事实表就只剩 followup（下面 wake 那条）这一条路。
      const waitOn = input.waitOn?.length
        ? input.waitOn.map((wait) => ({
            ticketId: wait.ticketId,
            resources: [...wait.resources],
            ...(wait.brief ? { brief: wait.brief } : {}),
          }))
        : undefined
      deps.facts?.remember({
        ticketId: input.ticketId,
        brief: input.brief,
        kind: 'blocked',
        since: clock.now().toISOString(),
        ...(waitOn ? { waitOn } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      })
      // 人工挂起不 wake；冲突排队才推。没有 wake（宿主没给 followup 口）就
      // 只留事实，下一轮 runtime context 里照样看得见。
      if (input.wake !== true) return Promise.resolve(deps.facts !== undefined)
      return send(conflictText(input), false, input.publisher)
    },
    resumed(ticketId) {
      deps.facts?.forget(ticketId, ['blocked'])
      return Promise.resolve(true)
    },
    released(input) {
      deps.facts?.forget(input.ticketId, ['blocked'])
      return send(releasedText(input), false, input.publisher)
    },
    outOfScope(input) {
      return send(outOfScopeText(input), false, input.publisher)
    },
  }
}
