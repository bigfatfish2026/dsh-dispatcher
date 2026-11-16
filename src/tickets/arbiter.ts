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
import { dirname, isAbsolute, resolve } from 'node:path'
import { isOpen } from '../store'
import type { ConflictWait, TicketEvent, TicketSnapshot } from '../store'
import { byQueueOrder } from '../store/log'
import type { TicketLog } from '../store/log'
import type { Clock } from './clock'
import { isWideDirRoot, judgeConflict } from './conflict'
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
  /** 已经 warn 过的大根目录（票号+资源串）：弱冲突每轮都重判，只喊一次。 */
  private readonly wideDirWarned = new Set<string>()

  constructor(private readonly deps: ConflictArbiterDeps) {}

  /**
   * 一张票的声明面：writes/reads 原样用；降级票（声明没等到）只拿 plan.files 的
   * 父目录兜底——相对路径按票的 dir 解析成绝对路径；票上没有 dir 的相对路径直接
   * 跳过，绝不按宿主 cwd 猜。
   *
   * 以前这里还有一层「连 plan 都没有就拿票的 dir 整片算写」，降级票于是凭空产出
   * `dir:/home/julia`，把整棵树都锁死（23 条 waitOn 里 15 条来自降级票）。整片
   * 目录不等于真在写：没有 plan 就什么也不兜底，等它真写文件时由 declare/touch
   * 自己的声明来挡。
   */
  side(ticket: TicketSnapshot): ConflictSide {
    const writes = [...(ticket.intent?.writes ?? [])]
    const reads = [...(ticket.intent?.reads ?? [])]
    if (ticket.degraded === true && writes.length === 0) {
      const dir = ticket.dir?.trim()
      for (const file of ticket.plan?.files ?? []) {
        const raw = typeof file.path === 'string' ? file.path.trim() : ''
        if (!raw) continue
        const absolute = isAbsolute(raw) ? raw : dir ? resolve(dir, raw) : undefined
        if (!absolute) continue
        const parent = dirname(absolute)
        if (!parent || parent === '.') continue
        const uri = `dir:${parent}`
        if (!writes.includes(uri)) writes.push(uri)
      }
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
        // 撞在「大根目录」上的强冲突降成 weak：显式声明 dir:/、dir:/home、
        // dir:<home>、dir:<仓库根> 是合法的整根操作，但拿它当强冲突等于把整棵树
        // 锁死。留一行 warn 让人看见，票照常放行、只标弱提示。
        const wide = verdict.resources.filter((uri) => isWideDirRoot(uri))
        if (wide.length > 0) {
          for (const uri of wide) {
            const key = `${ticket.id}:${other.id}:${uri}`
            if (this.wideDirWarned.has(key)) continue
            this.wideDirWarned.add(key)
            this.deps.warn(
              `[dispatcher] 票 ${ticket.id} 与 ${other.id} 撞在大根目录 ${uri}：只判 weak 放行，` +
                '别拿整棵树当强冲突；真要独占请声明具体子目录',
            )
          }
          if (!weak.includes(other.id)) weak.push(other.id)
          continue
        }
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
