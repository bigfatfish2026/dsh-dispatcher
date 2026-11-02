import { minutesSince, pending } from './store'
import type { TicketSnapshot } from './store'

/**
 * 僵尸票巡检的纯逻辑：给一个票快照列表，挑出「不会再有进展、但还挂在 open/running」的票。
 *
 * 为什么单独一个文件：判定要能在进程外跑（自检脚本直接 import），不碰 ctx、不碰定时器、
 * 不写票日志。sweep 只负责把结果并进那一条 followup。
 */

/** 没有活表可查时的默认静默阈值，单位分钟。 */
export const DEFAULT_ZOMBIE_MINUTES = 20

/** 新建票的宽限：dispatch_open 写 owner 与 subagent 注册之间可能差几秒。 */
export const DEFAULT_FRESH_MINUTES = 2

export type ZombieReason = 'worker-gone' | 'silent'

export interface ZombieHit {
  ticket: TicketSnapshot
  reason: ZombieReason
  /** 最后活动（reports 最后一条 or updatedAt）距今多少分钟。 */
  idleMinutes: number
  /** 票里还没被主会话读走的报告条数。 */
  pendingReports: number
  /**
   * 节流指纹：报告条数 + 最后活动时间 + 状态。
   *
   * 不用 updatedAt：巡检自己也会往日志里追加事件（把排队消息交给活着的 worker、
   * 给已关票清账），那会刷新 updatedAt——用它当指纹，这些动作会让刚推过的票下一轮
   * 再推一遍。最后一条报告的 at 和 status 都不会被投递动作改，只有真·新报告或状态
   * 变化（reopen）才会变。
   */
  fingerprint: string
}

export type AliveLookup = (owner: string) => boolean | undefined

export interface ZombieOptions {
  now?: Date
  /** 静默阈值（分钟）。 */
  zombieMinutes?: number
  /** 新建票宽限（分钟）。 */
  freshMinutes?: number
  /**
   * 按 owner 查活。返回 true/false 表示真查到了；返回 undefined 表示查不到
   * （owner 是短标签，或者运行环境没有 agents 服务）。
   */
  isAlive?: AliveLookup
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * owner 是不是一个能拿去查活表的 session id。
 *
 * 票的 owner 是主会话随手填的：现场既有裸 uuid（和 sessions 目录同名），也有
 * 「重启小鱼」这种短标签。短标签根本不在活表里，拿它查必然查不到，所以那种票
 * 只能走 silent 档，不能判 worker-gone——否则每张短标签票都会被误杀。
 */
export function looksLikeSessionId(owner: string | undefined): boolean {
  if (!owner) return false
  return UUID.test(owner) || UUID.test(owner.replace(/^session-/, ''))
}

/** status 的 open/running 才算僵尸候选；waiting/blocked 是人等着，done/dropped 已结束。 */
function isCandidate(ticket: TicketSnapshot): boolean {
  return ticket.status === 'open' || ticket.status === 'running'
}

/** 最后活动时间：最后一条报告的时间，没有报告就看票自己的 updatedAt。 */
export function lastActivity(ticket: TicketSnapshot): string {
  const last = ticket.reports[ticket.reports.length - 1]
  return last?.at ?? ticket.updatedAt
}

export function evaluateZombies(tickets: readonly TicketSnapshot[], options: ZombieOptions = {}): ZombieHit[] {
  const now = options.now ?? new Date()
  const zombieMinutes = options.zombieMinutes ?? DEFAULT_ZOMBIE_MINUTES
  const freshMinutes = options.freshMinutes ?? DEFAULT_FRESH_MINUTES
  const hits: ZombieHit[] = []

  for (const ticket of tickets) {
    if (!isCandidate(ticket)) continue
    const idleMinutes = minutesSince(lastActivity(ticket), now)
    const ageMinutes = minutesSince(ticket.createdAt, now)
    const alive = ticket.owner && looksLikeSessionId(ticket.owner) ? options.isAlive?.(ticket.owner) : undefined

    let reason: ZombieReason | undefined
    // 前者优先：owner 确实查不到活了，票多久没动静都救不回来。
    if (alive === false && ageMinutes >= freshMinutes) reason = 'worker-gone'
    else if (idleMinutes >= zombieMinutes) reason = 'silent'
    if (!reason) continue

    hits.push({
      ticket,
      reason,
      idleMinutes,
      pendingReports: pending(ticket.reports).length,
      fingerprint: `${ticket.reports.length}|${lastActivity(ticket)}|${ticket.status}`,
    })
  }

  return hits
}

/** 这轮该不该推：指纹和上次推的那次一样就跳过。 */
export function shouldPush(hit: ZombieHit, pushed: ReadonlyMap<string, string>): boolean {
  return pushed.get(hit.ticket.id) !== hit.fingerprint
}

/** goal 截断，摘要里不铺整句任务书。 */
export function shortGoal(goal: string, limit = 40): string {
  const text = goal.trim().replace(/\s+/g, ' ')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 一句话摘要：一次最多列三张，多的只说张数。不带报告正文——正文由报告投递那段
 * 单独负责，这里只负责提醒「这几张不会自己动了」。
 */
export function summarizeZombies(hits: readonly ZombieHit[], limit = 3): string {
  const shown = hits.slice(0, limit).map((hit) => {
    const reports = hit.pendingReports > 0 ? `，未读报告 ${hit.pendingReports} 条` : ''
    return `${hit.ticket.id} 疑似没动静 ${hit.idleMinutes} 分钟（${hit.reason}）${reports}：${shortGoal(hit.ticket.goal)}`
  })
  const rest = hits.length - shown.length
  const tail = rest > 0 ? `；另有 ${rest} 张` : ''
  return `${shown.join('；')}${tail}`
}
