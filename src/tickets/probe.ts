/**
 * 探路窗口：探路子会话那一轮的只读钳子。
 *
 * 设计稿 §8：探路和执行是两只子会话，探路那只不该写盘——它只交方案（`declared`），
 * 动手是执行轮的事。宿主给到手的只有「按工具名减面」这一刀
 * （`agent.ctx.tools.restrict`），所以窗口本身很朴素：一张 deny 单，`write` /
 * `edit` / `bash` 三件。
 *
 * 认票靠 `phase`，不靠 `status`：status 由主会话的动作写，phase 由事件折出来
 * （见 `store/reducer.ts`）。窗口跟着「票还在 planning」走，票一转 planned 就
 * 该松手。
 *
 * 装窗口的时机是死的：`agent/created` 只在派活里面发生，而派活是串行的
 * （desk 的那条 `serialize` 队列），所以「刚开票、还没派出去」的单槽登记足够
 * 认领新 worker——`expect()` 在 `pool.start` 之前，`drop()` 在它之后。
 *
 * 拆窗口有三处，全在 desk 里：子会话 idle（交完声明 / 干完一轮）、探路超时降级、
 * 台子收起（`releaseAll`）。
 */
import { agentIdOf, isSameWorker } from './workers'

/** 探路子会话看不到的三件：写文件、改文件、跑命令。 */
export const PROBE_DENY: readonly string[] = ['write', 'edit', 'bash']

/** `restrict` 回来的是拆窗口的手；宿主老一点可能根本没有这一口。 */
type Disposer = () => void

/** 探路窗口眼里的一条 agent：只要能拿到会话 id 和 `ctx.tools.restrict`。 */
export interface ProbeAgent {
  id?: string
  session?: { id?: string }
  ctx?: { tools?: { restrict?: (filter: { deny: readonly string[] }) => unknown } }
}

/** desk 眼里窗口的全部面：只拆，不建（建在 `agent/created` 那一刀里）。 */
export interface ProbePort {
  /** 拆掉这个 worker 的窗口；返回拆没拆到（没装过 / 已经拆过都是 false）。 */
  release(workerId: string): boolean
  /** 按票号拆：超时降级时手上只有票。 */
  releaseTicket(ticketId: string): boolean
}

/**
 * 派活那一刀要的登记面：新 worker 还没冒出来，先把「下一只是哪张票的」记下。
 * 派完之后不管成没成都要撤，别让登记落到下一只无关的 worker 头上。
 */
export interface ProbeRegistry {
  expect(ticketId: string): void
  drop(ticketId: string): void
}

interface Window {
  ticketId: string
  dispose: Disposer
}

export interface ProbeOptions {
  /** 装不上时说一句：不广播、不抛，探路子会话手上有工具也不至于把票开失败。 */
  warn?: (message: string) => void
}

export class ProbeWindows implements ProbePort, ProbeRegistry {
  /** workerId → 窗口。一只 worker 只可能是某一张票的探路子会话，一扇窗够。 */
  private readonly windows = new Map<string, Window>()
  /**
   * 刚开票、还没派出去的那张票。`agent/created` 就发生在派活里面，靠它认领。
   * 只有一槽：派活走 desk 那条串行队列，同时不会有两张票在派。
   */
  private expected?: string
  private readonly warn: (message: string) => void

  constructor(options: ProbeOptions = {}) {
    this.warn = options.warn ?? (() => {})
  }

  /** 下一只派出去的 worker 认这张票（`pool.start` 之前调）。 */
  expect(ticketId: string): void {
    if (this.expected !== undefined && this.expected !== ticketId) {
      // 走到这里说明有人在串行队列外面派活：认领会张冠李戴，喊一声。
      this.warn(`[dispatcher] 探路登记被覆盖：${this.expected} → ${ticketId}`)
    }
    this.expected = ticketId
  }

  /** 派活结束（成或败）：单槽的使命到此为止。 */
  drop(ticketId: string): void {
    if (this.expected === ticketId) this.expected = undefined
  }

  /**
   * 新 worker 到了：是那张刚开出来的探路票就装窗口。
   *
   * `phaseOf` 现查快照而不是缓存：票可能在这几毫秒里已经被降级或收工。
   * 返回装上的 workerId（没装返回 undefined），给日志和测试看。
   */
  adopt(agent: ProbeAgent, phaseOf: (ticketId: string) => { phase?: string } | undefined): string | undefined {
    const ticketId = this.expected
    if (!ticketId) return undefined
    // 不是 planning 就不装了：一次性消费掉登记，别让它落到下一只无关的 worker 头上。
    this.expected = undefined
    if (phaseOf(ticketId)?.phase !== 'planning') return undefined
    const restrict = agent.ctx?.tools?.restrict
    const workerId = agentIdOf(agent) ?? agent.session?.id
    if (!workerId || typeof restrict !== 'function') {
      // 宿主没给这一口（或者 agent 还没挂 ctx）：宁可让它手上有工具，也别把
      // 探路失败变成开票失败。
      this.warn(`[dispatcher] 探路窗口装不上（票 ${ticketId}）：agent 没有 ctx.tools.restrict`)
      return undefined
    }
    let dispose: unknown
    try {
      dispose = restrict.call(agent.ctx?.tools, { deny: [...PROBE_DENY] })
    } catch (error) {
      this.warn(
        `[dispatcher] 探路窗口装不上（票 ${ticketId}）：${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
    if (typeof dispose !== 'function') {
      this.warn(`[dispatcher] 探路窗口装不上（票 ${ticketId}）：restrict 没给回收函数`)
      return undefined
    }
    this.windows.set(workerId, { ticketId, dispose: dispose as Disposer })
    return workerId
  }

  /** 这只 worker 的窗口拆了没有。 */
  has(workerId: string): boolean {
    return this.windows.has(workerId)
  }

  get size(): number {
    return this.windows.size
  }

  /** 票号 → workerId（诊断和小屏用）。 */
  workerOf(ticketId: string): string | undefined {
    for (const [workerId, window] of this.windows) {
      if (window.ticketId === ticketId) return workerId
    }
    return undefined
  }

  release(workerId: string): boolean {
    const exact = this.windows.get(workerId)
    if (exact) {
      this.dispose(workerId, exact)
      return true
    }
    // 宿主给的 id 可能带 `session-` 前缀或者换过写法：按变体认一遍。
    for (const [key, window] of [...this.windows]) {
      if (!isSameWorker(key, workerId)) continue
      this.dispose(key, window)
      return true
    }
    return false
  }

  releaseTicket(ticketId: string): boolean {
    let released = false
    for (const [workerId, window] of [...this.windows]) {
      if (window.ticketId !== ticketId) continue
      this.dispose(workerId, window)
      released = true
    }
    return released
  }

  /** 台子收起：全拆。 */
  releaseAll(): void {
    for (const [workerId, window] of [...this.windows]) this.dispose(workerId, window)
  }

  private dispose(workerId: string, window: Window): void {
    this.windows.delete(workerId)
    try {
      window.dispose()
    } catch (error) {
      // 拆窗口失败不该把 idle 那条路带塌：票该怎么走还怎么走。
      this.warn(
        `[dispatcher] 探路窗口拆不开（票 ${window.ticketId}）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
