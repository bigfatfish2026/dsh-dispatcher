/**
 * 子会话订阅**自己那张票**的状态事件。
 *
 * 以前子会话看不见票面：被挡住、放行、收工全靠主会话转述，得等下一轮才知道。
 * 这里的做法是「按票自动挂订阅」：`spawned` 那一刻登记 `ticketId ↔ workerId`，
 * 之后票台每次落 `blocked` / 放行 / `closed` 都往这只子会话推一句话，短句、带票号
 * 与状态，不塞 JSON。
 *
 * 四条规矩：
 *
 * 1. **被挡是真停手，不是嘴上说。** 票一 blocked，先同步把这只 worker 记成
 *    「被挡」——worker 会话上的工具守卫（`writeBlockReason`，index.ts 装在
 *    agent 的 `ctx.tools.guard` 上）立刻开始拒 `write` / `edit` / `bash`；紧接着
 *    `agent.cancel({ kind: 'hook' }, { keepInbox: true })` 把正在跑的那一轮真打断。
 *    `keepInbox` 是为了不把已经排在队里的活扔掉：dsh-agent 的注释写明「取消之后
 *    提交的唤醒输入排到下一轮，等被中断的活动收敛到 idle 再跑」，所以打断之后这
 *    只子会话还能被叫起来，通知与放行都不会丢。
 * 2. **通知失败不许影响票台。** 会话没了、`followup` 抛错，都只 `warn` 一行然后
 *    返回 false；票台的判定与排队一个字节都不动。
 * 3. **放行只对“被票台按住的”那只说。** 没被按住的票（正常收工、主会话自己发话
 *    继续）不推「已放行」——多一条消息只会让它多跑一轮空转。
 * 4. **订阅和退订都要留痕。** 订上时 info 一行，写明哪只子会话订了哪张票。
 *
 * 这一层不读票、不写票：订阅从 `desk.commit` 喂进来，文案只用喂进来的那几栏。
 */
import { randomUUID } from 'node:crypto'
import type { Clock } from './clock'
import { realClock } from './clock'

/** 票台会推给子会话的四种事件。 */
export type WatchKind = 'blocked' | 'released' | 'closed' | 'dropped'

/**
 * 票被挡期间不许动的工具。
 *
 * `bash` 也算写：一条 `sed -i` 就改盘了，跟 `write` 没有区别。只读的看票工具
 * （`dispatch_report` / `dispatch_read` / `dispatch_declare`）不在名单里。
 */
export const BLOCKED_WRITE_TOOLS: readonly string[] = ['bash', 'edit', 'write']

/** 冲突里的一行：谁挡的、撞在哪些资源上。 */
export interface WatchWait {
  ticketId: string
  resources: readonly string[]
  brief?: string
}

/** blocked 通知的原料：冲突排队给 waitOn，人工挂起给 reason。 */
export interface BlockedNotice {
  ticketId: string
  brief: string
  waitOn?: readonly WatchWait[]
  reason?: string
}

/** 放行通知的原料：挡在前面的票收工了。 */
export interface ReleasedNotice {
  ticketId: string
  brief: string
  releasedBy?: readonly string[]
}

/** 结束通知的原料：票干完了还是被放弃。 */
export interface ClosedNotice {
  ticketId: string
  brief: string
  outcome: 'done' | 'dropped'
}

/** 一条已发出的通知（测试与日志用，不进票）。 */
export interface WatchNotice {
  kind: WatchKind
  ticketId: string
  workerId: string
  text: string
  at: string
  /** 投递结果：会话没了 / 投不进去都是 false。 */
  delivered: boolean
}

/** 一条订阅：哪只子会话盯着哪张票。 */
export interface WatchSubscription {
  ticketId: string
  workerId: string
  /** 被票台按住了（blocked 通知打断过它），等放行或收工才解开。 */
  parked: boolean
  /** 订上的时刻。 */
  since: string
}

/**
 * 活表里的那只子会话，这里只用得到三口。
 *
 * `steer` 优先于 `followup`：正在跑的那一轮在下一个 step 边界读到通知，不另起
 * 一轮空转；idle 时 steer 照样开一轮。宿主老一点没有 `steer` 就退回 `followup`。
 */
export interface WatchAgent {
  id?: string
  status?: string
  cancel?: (cause: { kind: 'hook'; reason: string }, options?: { keepInbox?: boolean }) => void
  followup?: (message: unknown) => unknown
  steer?: (message: unknown) => unknown
}

/** 活表的最小面：拿到那只 agent 本身。 */
export interface WatchAgents {
  get(id: string): unknown
}

export interface WorkerWatchDeps {
  agents: () => WatchAgents | undefined
  warn?: (message: string) => void
  info?: (message: string) => void
  clock?: Clock
  /** 消息 id 生成：测试里换成定值。 */
  newId?: () => string
}

export interface WorkerWatch {
  /**
   * 给这只子会话订上这张票。幂等：同一对重复订阅只留一条，返回 false。
   *
   * 票换了 worker（原会话没了、重派一只）时按新 worker 覆盖旧订阅——旧那只已经
   * 不在活表里，留着只会把通知推给一个不存在的人。
   */
  subscribe(ticketId: string, workerId: string): boolean
  /** 退掉这张票的订阅（收工/放弃之后）。 */
  drop(ticketId: string): void
  /** 票被挡：标记 + 真打断 + 推一句「停手」。 */
  blocked(input: BlockedNotice): Promise<boolean>
  /** 放行：解开标记 + 推一句「已放行，继续」。没被按住的票不发。 */
  released(input: ReleasedNotice): Promise<boolean>
  /** 收工/放弃：解开标记 + 推一句结束通知，然后退订。 */
  closed(input: ClosedNotice): Promise<boolean>
  /**
   * 解开「被挡」，不推消息。
   *
   * `resume: true` 只松工具守卫、**保留**「按住」标记：票已经判完了、任务书正要
   * 送过去，放行那一句还在路上（`released` 会把它说清）。默认两个都解——主会话
   * 自己给这张票发了话，它已经知道要干什么了。
   */
  clear(ticketId: string, options?: { resume?: boolean }): void
  /**
   * 工具守卫的理由：这只 worker 正被挡、且动的是写类工具时给一句拒词，其余 null。
   */
  writeBlockReason(workerId: string | undefined, toolName: string): string | undefined
  subscriptions(): WatchSubscription[]
  notices(): readonly WatchNotice[]
  dispose(): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 「被谁挡、撞在哪」：冲突与人工挂起两种写法。 */
function blockedWhy(input: BlockedNotice): string {
  const waits = input.waitOn ?? []
  const by = waits.map((wait) => wait.ticketId).join('、')
  if (by) {
    const resources = [...new Set(waits.flatMap((wait) => [...wait.resources]))].join('、')
    return `被 ${by} 挡住${resources ? `，冲突在 ${resources}` : ''}`
  }
  const reason = input.reason?.trim()
  return `等维护者决定${reason ? `（${reason}）` : ''}`
}

/** blocked：票号、状态、被谁挡、冲突资源、现在该停手。 */
export function blockedText(input: BlockedNotice): string {
  return `[票台] 票 ${input.ticketId}「${input.brief}」现在 blocked：${blockedWhy(input)}。停手，别动 write，等放行通知。`
}

/** released：票号、状态、谁收工放行的、接下来干什么。 */
export function releasedText(input: ReleasedNotice): string {
  const by = input.releasedBy?.length ? `（${input.releasedBy.join('、')} 收工了）` : ''
  return `[票台] 票 ${input.ticketId}「${input.brief}」已 released${by}，接着干。`
}

/** closed / dropped：票号、终态、别再动手。 */
export function closedText(input: ClosedNotice): string {
  if (input.outcome === 'dropped') {
    return `[票台] 票 ${input.ticketId}「${input.brief}」已 dropped：这单被放弃，别再动手，停在这里。`
  }
  return `[票台] 票 ${input.ticketId}「${input.brief}」已 closed（done）：这单收工了，别再动手，把手上这轮收尾。`
}

export function createWorkerWatch(deps: WorkerWatchDeps): WorkerWatch {
  const warn = deps.warn ?? (() => {})
  const info = deps.info ?? (() => {})
  const clock = deps.clock ?? realClock
  const newId = deps.newId ?? (() => randomUUID())
  /** ticketId → 订阅。一张票同一时刻只该有一只子会话在干活。 */
  const byTicket = new Map<string, WatchSubscription>()
  /** workerId → 被挡的那张票与理由（工具守卫用）。 */
  const parked = new Map<string, { ticketId: string; why: string }>()
  const sent: WatchNotice[] = []

  const at = (): string => clock.now().toISOString()

  function resolve(workerId: string): WatchAgent | undefined {
    const agents = deps.agents()
    const found = agents?.get(workerId)
    return found ? (found as WatchAgent) : undefined
  }

  function drop(ticketId: string): void {
    const sub = byTicket.get(ticketId)
    if (!sub) return
    byTicket.delete(ticketId)
    if (parked.get(sub.workerId)?.ticketId === ticketId) parked.delete(sub.workerId)
  }

  function clear(ticketId: string, options: { resume?: boolean } = {}): void {
    const sub = byTicket.get(ticketId)
    if (!sub) return
    if (options.resume !== true) sub.parked = false
    if (parked.get(sub.workerId)?.ticketId === ticketId) parked.delete(sub.workerId)
  }

  /**
   * 把一句话送到这只子会话。失败只 warn：会话没了、投不进去都不许往上抛——票台
   * 的判定和排队不能因为一条通知失败而停下。
   *
   * 两条投递路各有各的用处：
   *
   * - **blocked 一定走 `followup`**（唤醒型）。dsh-agent 写明「取消之后提交的
   *   唤醒输入排到下一轮，等被中断的活动收敛到 idle 再跑」，而 steer 的注释写
   *   着「取消可能丢掉待处理的 steering」——被挡那一条恰好跟在 cancel 后面，
   *   必须是前者，丢了它就等于子会话到下一轮才知道自己被挡了。
   * - **放行/收工优先 `steer`**：正在跑的那一轮在下一个 step 边界就读到，不另起
   *   一轮空转；idle 时 steer 照样开一轮。宿主老一点没有 steer 就退回 followup。
   */
  async function deliver(sub: WatchSubscription, kind: WatchKind, text: string): Promise<boolean> {
    const agent = resolve(sub.workerId)
    const target =
      kind === 'blocked'
        ? agent?.followup
        : typeof agent?.steer === 'function'
          ? agent.steer
          : agent?.followup
    if (!agent || typeof target !== 'function') {
      warn(
        `[dispatcher] 票 ${sub.ticketId} 的 ${kind} 通知没送到：子会话 ${sub.workerId} 不在活表里（会话可能已经没了）`,
      )
      sent.push({ kind, ticketId: sub.ticketId, workerId: sub.workerId, text, at: at(), delivered: false })
      return false
    }
    const message = {
      id: newId(),
      role: 'user' as const,
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-dispatcher' },
    }
    try {
      await target.call(agent, message)
    } catch (error) {
      warn(`[dispatcher] 票 ${sub.ticketId} 的 ${kind} 通知没送到（子会话 ${sub.workerId}）：${messageOf(error)}`)
      sent.push({ kind, ticketId: sub.ticketId, workerId: sub.workerId, text, at: at(), delivered: false })
      return false
    }
    sent.push({ kind, ticketId: sub.ticketId, workerId: sub.workerId, text, at: at(), delivered: true })
    return true
  }

  return {
    subscribe(ticketId, workerId) {
      const existing = byTicket.get(ticketId)
      if (existing?.workerId === workerId) return false
      if (existing) parked.delete(existing.workerId)
      byTicket.set(ticketId, { ticketId, workerId, parked: false, since: at() })
      info(
        `[dispatcher] 子会话 ${workerId} 订阅票 ${ticketId} 的状态事件` +
          '（blocked / released / closed / dropped）',
      )
      return true
    },

    drop,

    async blocked(input) {
      const sub = byTicket.get(input.ticketId)
      if (!sub) return false
      const why = blockedWhy(input)
      // 先同步落「被挡」：工具守卫下一次调用就看得到，正在跑的那一轮也别想再写。
      sub.parked = true
      parked.set(sub.workerId, { ticketId: input.ticketId, why })
      const agent = resolve(sub.workerId)
      if (agent && typeof agent.cancel === 'function') {
        try {
          // 真打断当前轮；keepInbox 保住排队里的活，通知走下一轮（见文件头）。
          agent.cancel({ kind: 'hook', reason: `票 ${input.ticketId} blocked：停手等放行` }, { keepInbox: true })
          info(`[dispatcher] 票 ${input.ticketId} 被挡，已打断子会话 ${sub.workerId} 当前这一轮`)
        } catch (error) {
          warn(`[dispatcher] 票 ${input.ticketId} 打断子会话 ${sub.workerId} 失败：${messageOf(error)}`)
        }
      }
      return deliver(sub, 'blocked', blockedText(input))
    },

    async released(input) {
      const sub = byTicket.get(input.ticketId)
      if (!sub) return false
      // 没被按住的票不推「已放行」：正常收工、主会话自己发话继续，都不需要这句。
      if (!sub.parked) return false
      clear(input.ticketId)
      return deliver(sub, 'released', releasedText(input))
    },

    async closed(input) {
      const sub = byTicket.get(input.ticketId)
      if (!sub) return false
      clear(input.ticketId)
      const delivered = await deliver(
        sub,
        input.outcome === 'dropped' ? 'dropped' : 'closed',
        closedText(input),
      )
      byTicket.delete(input.ticketId)
      return delivered
    },

    clear,

    writeBlockReason(workerId, toolName) {
      if (!workerId) return undefined
      if (!BLOCKED_WRITE_TOOLS.includes(toolName)) return undefined
      const held = parked.get(workerId)
      if (!held) return undefined
      return `票 ${held.ticketId} 现在 blocked（${held.why}）：停手，别动 write，等放行。要说话就 dispatch_report 报一句。`
    },

    subscriptions: () => [...byTicket.values()].map((sub) => ({ ...sub })),

    notices: () => sent.map((notice) => ({ ...notice })),

    dispose() {
      byTicket.clear()
      parked.clear()
      sent.length = 0
    },
  }
}
