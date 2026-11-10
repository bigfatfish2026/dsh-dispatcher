/**
 * 票工具在 worker 会话上的兜底注册。
 *
 * 档位的 allow 名单只是一层「全局工具面」的滤镜：`dsh-tools` 的 `restrict`
 * 是相交滤镜（对注册表名字点名），而按 agent 层注册的工具不受它管——
 * `ToolRuntime.register` 的注释写着「Scoped tools shadow globals」，
 * 同一份 lib/index.js:2985-3010 写着「Restrictions intersect; scoped
 * registrations remain visible」。所以三个票工具（`dispatch_declare` /
 * `dispatch_report` / `dispatch_touch`）直接注册到 worker 那只 agent 的 `ctx`
 * 上，档位再窄、白名单再漏，子会话也报得了活、报得了碰过哪些文件。
 *
 * 只加这三件，别的一概不碰：`write` / `edit` / `bash` 照旧由档位和探路窗口
 * 压着，探路轮的只读性质不因为这里多注册了什么而松。
 *
 * 注册要幂等：同一条路有两个人会调——`publish.ts` 的 `startWorker`（派活回来
 * 手上已有 workerId）和 `index.ts` 的 `agent/created`（那时候 agent 才真的
 * 能挂东西）。谁先到谁装，后到的那次什么也不做。
 */
import { agentIdOf, isSameWorker } from './workers'

type Disposer = () => void

/** 宿主老一点可能根本没有这一口：`agent.ctx.tools.register`。 */
export interface AgentToolScope {
  id?: string
  session?: { id?: string }
  ctx?: { tools?: { register?: (definition: never) => unknown } }
}

/** desk / publish 眼里这一口的全部面：只装，不拆（拆是台子收起时的事）。 */
export interface WorkerToolPort {
  /** 给这只 worker 装上三个票工具；已经装过、或者拿不到 agent。都算 false。 */
  attach(workerId: string): boolean
}

export interface WorkerToolsOptions {
  /** 三个票工具的 `defineTool` 结果，按名字排好序传进来。 */
  definitions: readonly unknown[]
  warn?: (message: string) => void
}

export class WorkerTicketTools {
  private readonly definitions: readonly unknown[]
  private readonly warn: (message: string) => void
  /** workerId → 拆掉这三件的回收函数。 */
  private readonly attached = new Map<string, Disposer[]>()

  constructor(options: WorkerToolsOptions) {
    this.definitions = options.definitions
    this.warn = options.warn ?? (() => {})
  }

  /**
   * 给这只 agent 装上三个票工具。返回真装上没有（已经装过算 false，不是失败）。
   *
   * 装的过程出岔子就喊一声、把已经装上的拆回去：宁可让子会话少一件工具，也别
   * 把「派活」变成「开票失败」。
   */
  attach(target: AgentToolScope | string | undefined): boolean {
    const workerId = agentIdOf(target)
    if (!workerId) return false
    if (this.find(workerId)) return false
    const agent = typeof target === 'string' ? undefined : target
    if (!agent) {
      this.warn(`[dispatcher] 票工具装不上（worker ${workerId}）：手上只有 id，拿不到 agent.ctx`)
      return false
    }
    const register = agent.ctx?.tools?.register
    if (typeof register !== 'function') {
      this.warn(`[dispatcher] 票工具装不上（worker ${workerId}）：agent 没有 ctx.tools.register`)
      return false
    }
    const disposers: Disposer[] = []
    try {
      for (const definition of this.definitions) {
        const dispose = register.call(agent.ctx?.tools, definition as never)
        if (typeof dispose === 'function') disposers.push(dispose as Disposer)
      }
    } catch (error) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 拆不动就算了：这几件工具跟着 agent 一起走。
        }
      }
      this.warn(
        `[dispatcher] 票工具装不上（worker ${workerId}）：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
    this.attached.set(workerId, disposers)
    return true
  }

  /**
   * 按 workerId 装：先查活表要 agent，拿不到就静悄悄地跳过——`startWorker` 走
   * 这条，派活刚回来 agent 可能还没落表，`agent/created` 那一刀会补上同一次
   * 注册，两条路都嚷太吵了。
   */
  attachById(workerId: string | undefined, lookup: () => { get(id: string): unknown } | undefined): boolean {
    const id = agentIdOf(workerId)
    if (!id) return false
    if (this.find(id)) return false
    const agent = lookup()?.get(id)
    if (!agent) return false
    return this.attach(agent as AgentToolScope)
  }

  has(workerId: string | undefined): boolean {
    const id = agentIdOf(workerId)
    return id ? this.find(id) !== undefined : false
  }

  get size(): number {
    return this.attached.size
  }

  /** 拆掉一只的（agent 收了就跟着收，平时只有台子收起才用得上）。 */
  detach(workerId: string | undefined): boolean {
    const id = agentIdOf(workerId)
    if (!id) return false
    const found = this.find(id)
    if (!found) return false
    this.drop(found[0], found[1])
    return true
  }

  detachAll(): void {
    for (const [workerId, disposers] of [...this.attached]) this.drop(workerId, disposers)
  }

  private find(workerId: string): [string, Disposer[]] | undefined {
    const exact = this.attached.get(workerId)
    if (exact) return [workerId, exact]
    // 宿主给的 id 可能带 `session-` 前缀或者换过写法，跟探路窗口用同一套认法。
    for (const [key, disposers] of this.attached) {
      if (isSameWorker(key, workerId)) return [key, disposers]
    }
    return undefined
  }

  private drop(workerId: string, disposers: Disposer[]): void {
    this.attached.delete(workerId)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 同 attach：拆不动不影响别的。
      }
    }
  }
}
