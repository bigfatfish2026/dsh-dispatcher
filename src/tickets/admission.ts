/**
 * 「这张票现在该不该派执行轮」的唯一定义。
 *
 * status 是会话生命周期写的（open / running / waiting / blocked），phase 才是
 * 「该不该派」的维度。三处入口各写一遍判定时，(waiting, planned)、
 * (waiting, planning)、(open, planning) 这三种合法组合没人推进
 * （t-mwn2jdda-tgcz 实证）。这里用显式白名单把判定收敛成纯函数。
 *
 * 本文件不碰日志、不看活表：活没活着由 `startTask` 按 `pool.alive` 分，
 * 这里只回答票面本身够不够格。
 */
import { isOpen } from '../store'
import type { TicketSnapshot } from '../store'

/** 派不了时给出的原因：排查时直接看这一句。 */
export type ExecBlockReason =
  | 'closed'
  | 'manual-blocked'
  | 'phase:planning'
  | 'phase:queued'
  | 'phase:gated'
  | 'phase:running'
  | 'phase:unknown'
  | 'no-declare'
  | 'retry-wait'

/** `ready` 之外的所有值都是「不派」，且各自说明为什么。 */
export type ExecReadyReason = 'ready' | ExecBlockReason

export interface ExecReadiness {
  ready: boolean
  reason: ExecReadyReason
}

/**
 * 重试节流的上下文。
 *
 * `lastAttemptMs` 由调用方记账（desk 只在派活真失败时写）：不记在票面上，
 * 免得一次失败多写一条事件；也不参与 `updatedAt`，正常声明后下一拍就能派。
 */
export interface ExecRetryContext {
  /** 当前时刻，默认 `Date.now()`。 */
  nowMs?: number
  /** 上一次派活失败的时刻（毫秒时间戳）；没失败过就不传。 */
  lastAttemptMs?: number
  /** 节流窗口，默认 `EXEC_RETRY_WINDOW_MS`；0 = 不节流。 */
  retryWindowMs?: number
}

/**
 * 派活失败后的重试窗口，毫秒。
 *
 * 不节流的话，「派活持续失败」会每 `SWEEP_MS`（10 秒）写一条 `declared` +
 * 一条 `conflict-checked`，日志被刷满还看不出真实进度。1 分钟比巡检间隔大，
 * 又不至于让正常恢复等太久。
 */
export const EXEC_RETRY_WINDOW_MS = 60_000

/**
 * 判一张票该不该派执行轮。
 *
 * 显式白名单，顺序固定：状态 → 挂起 → phase → 声明 → 重试节流。任何一条
 * 不满足都返回 `ready: false` 和对应的 reason，不靠调用方再补条件。
 */
export function execReady(ticket: TicketSnapshot, retry: ExecRetryContext = {}): ExecReadiness {
  if (!isOpen(ticket.status)) return { ready: false, reason: 'closed' }
  if (ticket.status === 'blocked') return { ready: false, reason: 'manual-blocked' }
  if (ticket.phase !== 'planned') {
    const reason: ExecBlockReason =
      ticket.phase === 'planning'
        ? 'phase:planning'
        : ticket.phase === 'queued'
          ? 'phase:queued'
          : ticket.phase === 'gated'
            ? 'phase:gated'
            : ticket.phase === 'running'
              ? 'phase:running'
              : 'phase:unknown'
    return { ready: false, reason }
  }
  if (!ticket.declaredAt) return { ready: false, reason: 'no-declare' }
  const window = retry.retryWindowMs ?? EXEC_RETRY_WINDOW_MS
  if (window > 0 && retry.lastAttemptMs !== undefined) {
    const now = retry.nowMs ?? Date.now()
    if (now - retry.lastAttemptMs < window) return { ready: false, reason: 'retry-wait' }
  }
  return { ready: true, reason: 'ready' }
}
