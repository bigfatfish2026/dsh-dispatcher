/**
 * worker 登记表：判活、按 worker 查票、投话/收回，以及「这一轮投出去之后回没回
 * idle」这一小块状态。
 *
 * 以前 desk 里散着一个 `pool` 字段、一个 `idleSeen` Set、一个 ticketsOf 私有方法，
 * 还有一段 workerStateText 自己组合它们；这里收成一个门面：desk 只说「这只活着
 * 吗 / 给它投话 / 它闲不闲」，不再直接摸池子和集合。
 *
 * 真正的会话登记仍在 `workers.ts` 的 WorkerPool 里，这一层不复制状态，只做查询
 * 与转发；`idleSeen` 是库内唯一一份，跨轮次保留（投出一轮就清）。
 */
import type { TicketSnapshot } from '../store'
import type { TicketLog } from '../store/log'
import { ticketsOfWork } from './handle'
import type { WorkerPool } from './workers'

export interface WorkerRegistryDeps {
  pool: WorkerPool
  log: TicketLog
}

export class WorkerRegistry {
  /** 见过 idle 的 worker：handleStatus 收下、再派一轮就划掉。 */
  private readonly idleSeen = new Set<string>()

  constructor(private readonly deps: WorkerRegistryDeps) {}

  /** 派活要的原始池子：spawn 是写入口，不是查询，不在这层包。 */
  get pool(): WorkerPool {
    return this.deps.pool
  }

  /** true 活 / false 死 / undefined 比不了（没有活表）。 */
  alive(workerId: string): boolean | undefined {
    return this.deps.pool.alive(workerId)
  }

  /** 这个 worker 名下的票，含已结的。 */
  ticketsOf(workerId: string): TicketSnapshot[] {
    return ticketsOfWork(this.deps.log, workerId)
  }

  send(workerId: string, sender: unknown, text: string): Promise<string> {
    return this.deps.pool.send(workerId, sender, text)
  }

  abort(workerId: string, reason?: string): Promise<void> {
    return this.deps.pool.abort(workerId, reason)
  }

  abortAll(reason?: string): Promise<void> {
    return this.deps.pool.abortAll(reason)
  }

  /** 这一只刚从一轮里下来。 */
  markIdle(workerId: string): void {
    this.idleSeen.add(workerId)
  }

  /** 又投出去一轮了：它不再是「空闲待派」。 */
  clearIdle(workerId: string): void {
    this.idleSeen.delete(workerId)
  }

  isIdle(workerId: string): boolean {
    return this.idleSeen.has(workerId)
  }

  /**
   * 兜底放行时这只 worker 算什么状态：只给日志，不参与判定。
   *
   * 「已死」= 票上没有 workerId，或者活表里查不到（`alive` 返回 false；没有活表时
   * 返回 undefined，同样没法把活投过去，一样按重起处理）。
   * 「正忙」= 活表里在、但这一轮投出去之后还没回过 idle。
   * 「空闲」= 活表里在、而且见过它 idle。
   */
  describe(ticket: TicketSnapshot): string {
    const workerId = ticket.workerId
    if (!workerId) return '没有 workerId，重起一只'
    const alive = this.alive(workerId)
    if (alive !== true) return `${workerId} 已死（活表 alive=${String(alive)}），重起一只`
    return this.isIdle(workerId)
      ? `${workerId} 空闲，steer 回原会话`
      : `${workerId} 正忙，steer 到下一个 step 边界`
  }
}
