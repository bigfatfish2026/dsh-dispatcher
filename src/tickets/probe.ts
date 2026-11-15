/**
 * 探路窗口：探路子会话那一轮的只读钳子。
 *
 * 设计稿 §8：探路和执行是两个子会话，探路子会话不该写盘——它只交方案（`declared`），
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
 * 认领新 worker——`expect()` 在 `pool.start` 之前。
 *
 * 但登记只记票号认不了人：宿主的 `agent/created` 是在 `startActivation` 返回
 * 之前发出来的，那一瞬派活方还拿不到 childId。所以 spawn 回来之后要补一刀
 * `bind()` 把 worker 的会话身份记进登记项；身份没落地的 `agent/created` 先挂在
 * `held` 里，等 bind 认领——别让别人的新会话把登记吃掉（早先审计那条）。
 *
 * 拆窗口有三处，全在 desk 里：子会话 idle（交完声明 / 干完一轮）、探路超时降级、
 * 台子收起（`releaseAll`）。超时那处拆完就当场判冲突然派执行轮，不等 idle——
 * 这扇窗拆掉只说明「这票不再只读」，跟「谁来接着干」没关系。超时那处若是登记
 * 从头到尾没被预期会话领走，`expire()` 会打一行固定文案，别静默放行。
 */
import { WRITE_TOOLS } from '../protocol'
import { agentIdOf, isSameWorker } from './workers'

// 探路子会话看不到的三件（写文件、改文件、跑命令）与「被挡停手」共用同一份
// 协议名单，顺序也统一在 protocol.ts 里。

/** `restrict` 回来的是拆窗口的手；宿主老一点可能根本没有这一口。 */
type Disposer = () => void

/** 探路窗口眼里的一条 agent：只要能拿到会话 id 和 `ctx.tools.restrict`。 */
export interface ProbeAgent {
  id?: string
  session?: { id?: string }
  ctx?: { tools?: { restrict?: (filter: { deny: readonly string[] }) => unknown } }
}

/** agent 的稳定身份：`id` 优先，退到 `session.id`。判「是不是那个子会话」就靠它。 */
function agentKey(agent: ProbeAgent | undefined): string | undefined {
  return agentIdOf(agent) ?? agent?.session?.id
}

/** desk 眼里窗口的全部面：只拆，不建（建在 `agent/created` 那一刀里）。 */
export interface ProbePort {
  /** 拆掉这个 worker 的窗口；返回拆没拆到（没装过 / 已经拆过都是 false）。 */
  release(workerId: string): boolean
  /** 按票号拆：超时降级时手上只有票。 */
  releaseTicket(ticketId: string): boolean
}

/**
 * 派活那一刀要的登记面：新 worker 还没冒出来，先把「下一只是哪张票的」记下；
 * spawn 回来拿到 worker 的 agentId / sessionId 之后再 `bind` 补上身份。
 * 派完之后不管成没成都要撤，别让登记落到下一只无关的 worker 头上。
 */
export interface ProbeRegistry {
  expect(ticketId: string): void
  /**
   * spawn 回来补身份：worker 的 agentId（= sessionId）。
   *
   * 可选：测试里的假件不实现它时，`agent/created` 那一刀就认不了人，窗口装不上，
   * 会退到探路超时降级——宁可失败也别乱认。
   */
  bind?(ticketId: string, workerId: string): void
  /** 派活结束（成或败）：单槽的使命到此为止。 */
  drop(ticketId: string): void
  /**
   * 探路超时还没被预期会话领走：清掉登记，返回「确实有一份没被领走的登记」，
   * 让 desk 知道该按失败降级。已经装过窗口的登记早就被消费了，这里返回 false。
   */
  expire?(ticketId: string): boolean
}

interface Window {
  ticketId: string
  dispose: Disposer
}

/** 一串登记的账：这票的探路子会话是谁、还没认出来的 agent 先挂哪儿。 */
interface Expectation {
  ticketId: string
  /** spawn 回来补的 worker 身份；还没回来时 undefined，adopt 判不了人。 */
  workerId?: string
  /** 身份没落地之前冒出来的 agent：不能判、不能装，也不能把登记吃掉。 */
  held: ProbeAgent[]
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
  private expected?: Expectation
  private readonly warn: (message: string) => void

  constructor(options: ProbeOptions = {}) {
    this.warn = options.warn ?? (() => {})
  }

  /** 下一只派出去的 worker 认这张票（`pool.start` 之前调）。 */
  expect(ticketId: string): void {
    const previous = this.expected?.ticketId
    if (previous !== undefined && previous !== ticketId) {
      // 走到这里说明有人在串行队列外面派活：认领会张冠李戴，喊一声。
      this.warn(`[dispatcher] 探路登记被覆盖：${previous} → ${ticketId}`)
    }
    this.expected = { ticketId, held: [] }
  }

  /**
   * spawn 回来补身份：这只 worker 才是这张票的探路子会话。
   *
   * `agent/created` 通常已经在派活里面来过了，那一刀只能把 agent 挂在 `held`
   * 里（认不了人）；这里按身份把匹配的那只领出来装窗口。
   */
  bind(ticketId: string, workerId: string): void {
    const expected = this.expected
    if (!expected || expected.ticketId !== ticketId) return
    expected.workerId = workerId
    for (const agent of expected.held) {
      if (!isSameWorker(workerId, agentKey(agent) ?? '')) continue
      // 认领成功：登记到此为止，窗口挂到这个子会话身上。
      this.expected = undefined
      this.install(expected, agent)
      return
    }
    // 还没冒出来（或者事件晚到）：登记留着，等 `agent/created` 那一刀按身份认。
  }

  /** 派活结束（成或败）：单槽的使命到此为止。 */
  drop(ticketId: string): void {
    if (this.expected?.ticketId === ticketId) this.expected = undefined
  }

  /**
   * 探路超时还没被预期会话领走：清掉登记，打一行固定文案，返回确实有登记。
   *
   * 这是失败路径：窗口没装成，票照旧走 desk 的探路超时降级（planned +
   * degraded），不静默放行。
   */
  expire(ticketId: string): boolean {
    if (this.expected?.ticketId !== ticketId) return false
    this.expected = undefined
    this.warn(`[probe] 窗口未被预期会话领取 id=${ticketId} 超时降级`)
    return true
  }

  /**
   * 新 worker 到了：是那张刚开出来的探路票就装窗口。
   *
   * 判据是身份：登记里补过 workerId 之后，会话/agent id 对不上的一律忽略，
   * 登记不消耗——别的新会话不能把探路子会话的窗口吃掉。身份还没补上时判不了，
   * 先挂进 `held` 等 bind，也不消耗。
   *
   * `phaseOf` 现查快照而不是缓存：票可能在这几毫秒里已经被降级或收工。
   * 返回装上的 workerId（没装返回 undefined），给日志和测试看。
   */
  adopt(agent: ProbeAgent, phaseOf: (ticketId: string) => { phase?: string } | undefined): string | undefined {
    const expected = this.expected
    if (!expected) return undefined
    const workerId = agentKey(agent)
    // 没有 id 就判不了是不是那个子会话：忽略，也不消耗登记。
    if (!workerId) return undefined
    if (expected.workerId === undefined) {
      // spawn 还没回来：身份不明，先挂着。bind 会把匹配的那只领走。
      if (!expected.held.some((held) => agentKey(held) === workerId)) expected.held.push(agent)
      return undefined
    }
    // 不是这张票的探路子会话：忽略，登记留给真正那只。
    if (!isSameWorker(expected.workerId, workerId)) return undefined
    this.expected = undefined
    // 不是 planning 就不装了：一次性消费掉登记，别让它落到下一只无关的 worker 头上。
    if (phaseOf(expected.ticketId)?.phase !== 'planning') return undefined
    return this.install(expected, agent)
  }

  /** 装窗口：登记已在调用方消费掉，这里只管 restrict 与记账。 */
  private install(expected: Expectation, agent: ProbeAgent): string | undefined {
    const ticketId = expected.ticketId
    const restrict = agent.ctx?.tools?.restrict
    const workerId = agentKey(agent)
    if (!workerId || typeof restrict !== 'function') {
      // 宿主没给这一口（或者 agent 还没挂 ctx）：宁可让它手上有工具，也别把
      // 探路失败变成开票失败。
      this.warn(`[dispatcher] 探路窗口装不上（票 ${ticketId}）：agent 没有 ctx.tools.restrict`)
      return undefined
    }
    let dispose: unknown
    try {
      dispose = restrict.call(agent.ctx?.tools, { deny: [...WRITE_TOOLS] })
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
    // 登记也一起收掉：票已经离开探路（降级或收工），别再等一只不会来的子会话。
    if (this.expected?.ticketId === ticketId) this.expected = undefined
    return released
  }

  /** 台子收起：全拆。 */
  releaseAll(): void {
    for (const [workerId, window] of [...this.windows]) this.dispose(workerId, window)
    this.expected = undefined
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
