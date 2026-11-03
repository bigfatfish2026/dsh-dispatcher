import { minutesSince, pending } from './store'
import type { TicketSnapshot } from './store'

/**
 * 僵尸票巡检的纯逻辑：给一个票快照列表，挑出「不会再有进展」的票。
 *
 * 两类候选：还挂在 open/running 上的僵尸票，以及「已经 waiting、票里却一条报告都没有」
 * 的票——小鱼退了不等于交了活，这种票原来两边的池子都不收，落 waiting 就彻底失联。
 *
 * 为什么单独一个文件：判定要能在进程外跑（自检脚本直接 import），不碰 ctx、不碰定时器、
 * 不写票日志。sweep 只负责把结果并进那一条 followup。
 */

/** 没有活表可查时的默认静默阈值，单位分钟。 */
export const DEFAULT_ZOMBIE_MINUTES = 20

/** waiting 但一条报告都没有的票，默认盯多少分钟。 */
export const DEFAULT_NO_REPORT_MINUTES = 5

/** 新建票的宽限：dispatch_open 写 owner 与 subagent 注册之间可能差几秒。 */
export const DEFAULT_FRESH_MINUTES = 2

export type ZombieReason = 'worker-gone' | 'silent' | 'no-report'

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
  /** waiting 且票内无报告时，盯多少分钟就推（分钟）。 */
  noReportMinutes?: number
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

/**
 * status 的 open/running 才算僵尸候选；waiting 走下面「无报告」那一档，blocked 是人等着，
 * done/dropped 已结束。
 */
function isCandidate(ticket: TicketSnapshot): boolean {
  return ticket.status === 'open' || ticket.status === 'running'
}

/**
 * 节流指纹：报告条数 + 最后活动时间 + 状态。
 *
 * 补报之后 reports.length 变、指纹跟着变，同一张票该再推就再推；没补报也不会
 * 被投递动作刷出来的 updatedAt 骗着重复推。
 */
function fingerprintOf(ticket: TicketSnapshot): string {
  return `${ticket.reports.length}|${lastActivity(ticket)}|${ticket.status}`
}

/** 最后活动时间：最后一条报告的时间，没有报告就看票自己的 updatedAt。 */
export function lastActivity(ticket: TicketSnapshot): string {
  const last = ticket.reports[ticket.reports.length - 1]
  return last?.at ?? ticket.updatedAt
}

export function evaluateZombies(tickets: readonly TicketSnapshot[], options: ZombieOptions = {}): ZombieHit[] {
  const now = options.now ?? new Date()
  const zombieMinutes = options.zombieMinutes ?? DEFAULT_ZOMBIE_MINUTES
  const noReportMinutes = options.noReportMinutes ?? DEFAULT_NO_REPORT_MINUTES
  const freshMinutes = options.freshMinutes ?? DEFAULT_FRESH_MINUTES
  const hits: ZombieHit[] = []

  for (const ticket of tickets) {
    const idleMinutes = minutesSince(lastActivity(ticket), now)

    // waiting 不等于交活：小鱼退出了、票里却一条报告都没有，说明它没交活就走了。
    // 这一档有单独的阈值（noReportMinutes），也不参与下面的 worker-gone / silent：
    // waiting 本来就意味着 worker 已经不在，再拿活表去判死没有意义。
    // waiting 且已经有报告的票不是候选——那是主会话该收的活，不是失联。
    if (ticket.status === 'waiting') {
      if (ticket.reports.length > 0) continue
      if (idleMinutes < noReportMinutes) continue
      hits.push({
        ticket,
        reason: 'no-report',
        idleMinutes,
        pendingReports: 0,
        fingerprint: fingerprintOf(ticket),
      })
      continue
    }

    if (!isCandidate(ticket)) continue
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
      fingerprint: fingerprintOf(ticket),
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
 *
 * `no-report` 单独一句，因为它要能直接指导处置：小鱼退了、票里一条报告都没有，
 * 主会话该做的是叫它补报，或者自己去看它到底干了什么。
 */
export function summarizeZombies(hits: readonly ZombieHit[], limit = 3): string {
  const shown = hits.slice(0, limit).map((hit) => {
    if (hit.reason === 'no-report') {
      return `${hit.ticket.id} 的小鱼退了但票里一条报告都没有（${hit.idleMinutes} 分钟），去 dispatch_send 叫它补报，或者自己看它干了什么：${shortGoal(hit.ticket.goal)}`
    }
    const reports = hit.pendingReports > 0 ? `，未读报告 ${hit.pendingReports} 条` : ''
    return `${hit.ticket.id} 疑似没动静 ${hit.idleMinutes} 分钟（${hit.reason}）${reports}：${shortGoal(hit.ticket.goal)}`
  })
  const rest = hits.length - shown.length
  const tail = rest > 0 ? `；另有 ${rest} 张` : ''
  return `${shown.join('；')}${tail}`
}
