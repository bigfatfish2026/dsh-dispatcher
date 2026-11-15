/**
 * 一张票的把手：归属、状态前置条件、谁能写报告，都收在这一层。
 *
 * 以前 `send` / `report` / `declare` / `touch` / `close` / `block` 六个入口各写
 * 一遍「票在不在、是不是这个 worker 的、能不能写」；消息和判定顺序稍有出入就
 * 会出现「同样越权，一个入口拒一个入口放」。这里只做校验，不写票、不持状态，
 * 每次调用现建一个，校验完就丢。
 */
import { isOpen } from '../store'
import type { Actor, TicketSnapshot } from '../store'
import type { TicketLog } from '../store/log'
import { isSameWorker } from './workers'

/** 这个 worker 名下的票，含已结的；巡检与归属校验共用。 */
export function ticketsOfWork(log: TicketLog, workerId: string): TicketSnapshot[] {
  return log.list().filter((ticket) => ticket.workerId !== undefined && isSameWorker(ticket.workerId, workerId))
}

export class TicketHandle {
  constructor(
    private readonly log: TicketLog,
    readonly id: string,
  ) {}

  /**
   * 按 workerId 反查自己名下那张活票。票号不由调用方给，别人的票写不进来；
   * 没票、票已结束都直接报错，别让子会话以为写成功了。
   */
  static forWorker(log: TicketLog, workerId: string, verb: string): TicketHandle {
    const mine = ticketsOfWork(log, workerId)
    if (mine.length === 0) throw new Error('没有挂在这个 worker 上的票')
    const live = mine.filter((ticket) => isOpen(ticket.status))
    if (live.length === 0) {
      // 拿最近那张的号说清楚是哪张结束了，别只回一句「不行」。
      const last = mine.reduce((best, ticket) => (ticket.updatedAt >= best.updatedAt ? ticket : best))
      throw new Error(`票 ${last.id} 已结束（${last.status}），不能再${verb}`)
    }
    // 一张 worker 名下正常情况下只有一张活票；多张时取最近动过的那张，并在
    // 回执里带票号，别让子会话猜自己刚写到哪张上。
    const target = live.reduce((best, ticket) => (ticket.updatedAt >= best.updatedAt ? ticket : best))
    return new TicketHandle(log, target.id)
  }

  /** 票必须存在；不存在和以前一样一句「没有票 X」。 */
  current(): TicketSnapshot {
    const ticket = this.log.get(this.id)
    if (!ticket) throw new Error(`没有票 ${this.id}`)
    return ticket
  }

  /** `dispatch_send` 的前置：票还得开着。 */
  openForSend(): TicketSnapshot {
    const ticket = this.current()
    if (!isOpen(ticket.status)) throw new Error(`票 ${this.id} 已收工，要接着干就开新票`)
    return ticket
  }

  /** `dispatch_block` 的前置：票还得开着，且 error 里带当前状态。 */
  openForBlock(): TicketSnapshot {
    const ticket = this.current()
    if (!isOpen(ticket.status)) throw new Error(`票 ${this.id} 已经 ${ticket.status} 了`)
    return ticket
  }

  /** 只有主会话能收工；worker 交报告。 */
  assertRouterCanClose(actor: Actor | undefined): void {
    if (actor?.kind === 'worker') throw new Error('worker 不能收工：交报告，让主会话关票')
  }

  /** 只有主会话能改状态；worker 交报告。 */
  assertRouterCanBlock(actor: Actor | undefined): void {
    if (actor?.kind === 'worker') throw new Error('worker 不能改票的状态：只能交报告')
  }

  /**
   * 谁能往这张票上写报告：worker 只能写自己名下的票，主会话只能写自己开的票。
   *
   * `source === 'auto'` 的补报是票台自己写的，不经过这里（没有 actor）。
   * 老票没有 publisher（早期版本的行）时放行主会话，只做能做的校验。
   */
  assertMayReport(actor: Actor): void {
    const ticket = this.current()
    if (actor.kind === 'worker') {
      if (!isSameWorker(ticket.workerId, actor.sessionId)) {
        throw new Error(`票 ${ticket.id} 不挂在当前 worker 名下，报告拒收`)
      }
      return
    }
    if (ticket.publisher !== undefined && ticket.publisher !== actor.sessionId) {
      throw new Error(`票 ${ticket.id} 不是这个会话开的，报告拒收`)
    }
  }
}
