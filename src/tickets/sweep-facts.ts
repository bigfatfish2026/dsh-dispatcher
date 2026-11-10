/**
 * 巡检事实：主会话该知道的票台近况，写成一段动态上下文，不走「人话消息」。
 *
 * 为什么不是 `followup`：注进主会话的 user 消息在模型眼里和维护者打的话一模一样，
 * 原来那几句「要看看就用 dispatch_read」读起来就是维护者下的命令，主会话回头冲着
 * 它自己回话。这里改成陈述句、带来源，交给宿主渲染成 runtime-context 快照——
 * 模型看见的是环境状态，不是谁在说话。
 *
 * 两条硬规矩：
 *
 * - **不在文本里放秒级时间。** 这段文字一变，KV 前缀缓存就从这里断，所以时间
 *   只给五分钟粒度（「约 20 分钟」），同一个五分钟窗口里渲染几次都一字不差。
 * - **读过就撤。** `dispatch_list` / `dispatch_read` / `dispatch_close` 见过这张
 *   票之后，对应条目摘掉；下一轮快照自然变短。没读的继续挂着。
 */
import type { Clock } from './clock'
import { realClock } from './clock'

export type SweepFactKind = 'report' | 'blocked' | 'no-report' | 'waiting' | 'running'

/** 一条判断：哪张票、什么状态、从什么时候开始。 */
export interface SweepFact {
  ticketId: string
  brief: string
  kind: SweepFactKind
  /** 事件发生时刻（ISO）。渲染时降到五分钟粒度，别让秒级时间戳抖缓存。 */
  since: string
  /** 未读报告条数：`report` 类才有。 */
  unread?: number
  /** 冲突挂起撞的对手与资源：`blocked` 类才有。 */
  waitOn?: readonly { ticketId: string; resources: readonly string[] }[]
  /** 人工挂起的理由：`blocked` 类才有，和 `waitOn` 二选一。 */
  reason?: string
}

export interface SweepFacts {
  /** 记一条；同一个「票 + 类型」重复记只更新内容，保留第一次的时间。 */
  remember(fact: SweepFact): void
  /** 摘条目：不给 `kinds` 就是这张票全摘。 */
  forget(ticketId: string, kinds?: readonly SweepFactKind[]): void
  /** 渲染成上下文文本；没有条目就是空串（宿主据此把快照撤掉）。 */
  text(): string
  /** 现在挂着几条：测试和日志用。 */
  size(): number
}

/** 每个 `kind` 的先后：同一张票上「有报告」比「还没收工」更该先看。 */
const ORDER: readonly SweepFactKind[] = ['report', 'blocked', 'no-report', 'waiting', 'running']

/** 这段话的开头：说明来源，不冒充维护者。 */
export const SWEEP_HEADER = 'dsh-dispatcher 巡检：以下是票台近况，不是维护者在说话。'

/** 五分钟粒度：窗口内文本不变，窗口之间才动一次。 */
function coarseMinutes(since: string, now: Date): number {
  const elapsed = now.getTime() - Date.parse(since)
  const minutes = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 60_000)) : 0
  return Math.max(5, Math.floor(minutes / 5) * 5)
}

function lineOf(fact: SweepFact, now: Date): string {
  const who = `票 ${fact.ticketId}「${fact.brief}」`
  const about = `约 ${coarseMinutes(fact.since, now)} 分钟`
  switch (fact.kind) {
    case 'report':
      return `${who}交了 ${fact.unread ?? 1} 条报告，还没读`
    case 'blocked': {
      // 排队挂起：说清撞谁、撞什么。主会话下一轮就能看到，不用等 60 分钟巡检。
      const waits = fact.waitOn ?? []
      if (waits.length > 0) {
        const resources = [...new Set(waits.flatMap((wait) => wait.resources))].join('、')
        const by = waits.map((wait) => wait.ticketId).join('、')
        return resources
          ? `票 ${fact.ticketId} 因 ${resources} 与 ${by} 冲突挂起，等它关闭后放行。`
          : `票 ${fact.ticketId} 与 ${by} 冲突挂起，等它关闭后放行。`
      }
      const why = fact.reason?.trim()
      return why
        ? `票 ${fact.ticketId} 因「${why}」挂起，等人处理。`
        : `票 ${fact.ticketId} 挂起，等人处理。`
    }
    case 'no-report':
      return `${who}这一轮干完了，一份报告也没交`
    case 'waiting':
      return `${who}干完 ${about}还没收工`
    case 'running':
      return `${who}跑了 ${about}还没停`
  }
}

/**
 * 内存里的一小张表。不落盘：巡检提醒只在「主会话该看一眼」的那段时间有意义，
 * 进程重启后由巡检重新发现，比把过期提醒读回来更可靠。
 */
export function createSweepFacts(deps: { clock?: Clock } = {}): SweepFacts {
  const clock = deps.clock ?? realClock
  const facts = new Map<string, SweepFact>()

  const keyOf = (kind: SweepFactKind, ticketId: string): string => `${kind}:${ticketId}`

  return {
    remember(fact) {
      const key = keyOf(fact.kind, fact.ticketId)
      const existing = facts.get(key)
      facts.set(key, existing ? { ...fact, since: existing.since } : { ...fact })
    },
    forget(ticketId, kinds) {
      for (const kind of kinds ?? ORDER) facts.delete(keyOf(kind, ticketId))
    },
    text() {
      if (facts.size === 0) return ''
      const now = clock.now()
      const lines = [...facts.values()]
        .sort(
          (a, b) =>
            a.ticketId.localeCompare(b.ticketId) ||
            ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
        )
        .map((fact) => lineOf(fact, now))
      return [SWEEP_HEADER, ...lines].join('\n')
    },
    size() {
      return facts.size
    },
  }
}
