/**
 * 冲突仲裁：拿一张票去撞所有未结票，给出 strong / weak / none，并把判定结果
 * 落成 `conflict-checked`。
 *
 * 以前判定、告警、写票、FIFO 排序散在 desk 的 judgeTicket / admit /
 * releaseBlocked 三处，同一条规则抄两遍；这里收成一处：desk 只决定「strong 就
 * 排队、其余派活」，不再自己解读 verdict。
 *
 * 纯读 + 一次 commit：不认识 Timer、不碰 status，也不管 worker。排队时长、放行
 * 后派活仍由 desk 做。
 */
import { dirname } from 'node:path'
import { isOpen } from '../store'
import type { ConflictWait, TicketEvent, TicketSnapshot } from '../store'
import { byQueueOrder } from '../store/log'
import type { TicketLog } from '../store/log'
import type { Clock } from './clock'
import { judgeConflict } from './conflict'
import type { ConflictLevel, ConflictSide } from './conflict'
import { scanResources } from './resources'

export interface ConflictDecision {
  level: ConflictLevel
  waitOn: ConflictWait[]
  weak: string[]
}

export interface ConflictArbiterDeps {
  log: TicketLog
  clock: Clock
  warn: (message: string) => void
  commit: (event: TicketEvent) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 排队先后：交声明时间 → 开票序号。同一条尺子给判定和放行用。 */
export function byClaimOrder(a: TicketSnapshot, b: TicketSnapshot): number {
  const mine = a.declaredAt
  const other = b.declaredAt
  if (mine && other) {
    if (mine !== other) return mine < other ? -1 : 1
    return byQueueOrder(a, b)
  }
  if (mine) return -1
  if (other) return 1
  return byQueueOrder(a, b)
}

/** 排队名单有没有变：没变就不重复写日志（每次收工都会重扫一遍）。 */
function sameWait(a: readonly ConflictWait[], b: readonly ConflictWait[]): boolean {
  if (a.length !== b.length) return false
  return a.every((wait, index) => {
    const other = b[index]
    return wait.ticketId === other?.ticketId && wait.resources.join('\n') === other.resources.join('\n')
  })
}

export class ConflictArbiter {
  /** 已经 warn 过的坏资源串（票号+原串），别每次巡检都重复喊。 */
  private readonly invalidWarned = new Set<string>()

  constructor(private readonly deps: ConflictArbiterDeps) {}

  /**
   * 一张票的声明面：writes/reads 原样用；只有降级票（声明没等到）按设计稿 §8
   * 拿 plan.files 的父目录兜底，连 plan 都没有才拿票的 dir 整片算写。
   */
  side(ticket: TicketSnapshot): ConflictSide {
    const writes = [...(ticket.intent?.writes ?? [])]
    const reads = [...(ticket.intent?.reads ?? [])]
    if (ticket.degraded === true && writes.length === 0) {
      for (const file of ticket.plan?.files ?? []) {
        const parent = dirname(file.path)
        const uri = `dir:${parent}`
        if (parent && parent !== '.' && !writes.includes(uri)) writes.push(uri)
      }
      if (writes.length === 0 && ticket.dir) writes.push(`dir:${ticket.dir}`)
    }
    return { writes, reads }
  }

  /** 拿这张票去撞所有未结票（自己不算）。只判，不写票。 */
  judge(ticket: TicketSnapshot): ConflictDecision {
    const all = this.deps.log.list()
    const mine = this.side(ticket)
    // 脏声明不该把判定整锅端了：认不出来的串先喊一声（带票号与原文），判定继续。
    const scan = scanResources([...(mine.writes ?? []), ...(mine.reads ?? [])])
    for (const bad of scan.invalid) {
      const key = `${ticket.id}:${bad.raw}`
      if (this.invalidWarned.has(key)) continue
      this.invalidWarned.add(key)
      this.deps.warn(
        `[dispatcher] 票 ${ticket.id} 的资源串不合法：${bad.raw}（${bad.reason}），按不认识处理继续判`,
      )
    }
    const waitOn: ConflictWait[] = []
    const weak: string[] = []
    let strong = false
    for (const other of all) {
      if (other.id === ticket.id || !isOpen(other.status)) continue
      // 停在 waiting 且 worker 已经不在的票不占资源：等有人重新派活时 admit 会再判。
      if (other.status === 'waiting' && other.workerAlive === false) continue
      // 排在自己后面的票不挡自己：FIFO 只看前面还欠着谁的账。
      if (byClaimOrder(other, ticket) >= 0) continue
      let verdict
      try {
        verdict = judgeConflict(mine, this.side(other))
      } catch (error) {
        // 判定本身出了意料外的岔子：按 weak 放行并留痕，别让一张脏票打断整轮。
        this.deps.warn(
          `[dispatcher] 票 ${ticket.id} 与 ${other.id} 冲突判定失败，按 weak 兜底：${messageOf(error)}`,
        )
        weak.push(other.id)
        continue
      }
      if (verdict.level === 'none') continue
      if (verdict.level === 'strong') {
        strong = true
        waitOn.push({ ticketId: other.id, resources: [...verdict.resources] })
      } else if (!weak.includes(other.id)) {
        weak.push(other.id)
      }
    }
    return { level: strong ? 'strong' : weak.length > 0 ? 'weak' : 'none', waitOn, weak }
  }

  /**
   * 判一次并把结果落成 `conflict-checked`。
   *
   * `onlyIfChanged` 给放行队列用：strong 的排队名单没变就不重复写同一条日志。
   * 返回 `recorded` 让调用方决定要不要跟着更新巡检事实。
   */
  checkAndRecord(ticket: TicketSnapshot, options: { onlyIfChanged?: boolean } = {}): ConflictDecision & {
    recorded: boolean
  } {
    const verdict = this.judge(ticket)
    if (
      options.onlyIfChanged &&
      verdict.level === 'strong' &&
      sameWait(ticket.waitOn ?? [], verdict.waitOn)
    ) {
      return { ...verdict, recorded: false }
    }
    this.deps.commit({
      kind: 'conflict-checked',
      id: ticket.id,
      at: this.deps.clock.now().toISOString(),
      cause: 'reaction',
      level: verdict.level,
      waitOn: verdict.level === 'strong' ? verdict.waitOn : [],
      ...(verdict.weak.length > 0 ? { weak: verdict.weak } : {}),
    })
    return { ...verdict, recorded: true }
  }
}
