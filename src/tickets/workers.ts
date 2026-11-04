/**
 * worker 的登记表：谁派出去的、还活不活、怎么收回来。
 *
 * 这一层只认结构，不认 cordis：`startActivation` / `sendMessage` 的形状按
 * `dsh-tool-subagent` 的实际实现抄（lib/index.js:462-482），但传进来的是接口，
 * 测试塞假实现就行，一个真子会话都不会开。
 *
 * 两条硬规矩：
 *
 * 1. **不把工具轮的 signal 传下去。** 工具轮结束就 abort，照抄的话派出去的活
 *    会在开票那一刻被掐死。每条 worker 自己一个 `AbortController`，收票、
 *    超时、关了票台才 abort。
 * 2. **spawn 和记账不是事务。** `startActivation` 没有幂等键，成功之后写日志
 *    失败没法回滚；这一层只负责「尽力收回」（`abort`），补偿的判断在 publish。
 */
import { idVariants, matchesId } from '../ids'

export interface PromptBlock {
  type: 'text'
  text: string
}

export interface SubagentSpec {
  provider: string
  label: string
  request: {
    prompt: PromptBlock[]
    parent: unknown
    cwd?: string
    agentPreset?: string
    maxDepth?: number
  }
  signal: AbortSignal
  delivery: 'parent'
}

export interface SubagentActivation {
  childId: string
  messageId?: string
  result?: Promise<unknown>
  dispose(): Promise<void> | void
}

/** `ctx.subagents` 里票台用到的那两个方法。 */
export interface SubagentSeam {
  startActivation(spec: SubagentSpec): Promise<SubagentActivation>
  sendMessage(
    sender: unknown,
    targetId: string,
    content: PromptBlock[],
    options?: { signal?: AbortSignal },
  ): Promise<string>
}

/** `ctx.agents` 的判活窗口：拿到活对象就是活的。 */
export interface AgentLookup {
  get(id: string): unknown
}

export interface WorkerStartInput {
  ticketId: string
  provider: string
  preset: string
  label: string
  prompt: string
  parent: unknown
  cwd?: string
  maxDepth?: number
}

export interface WorkerRegistration {
  workerId: string
  ticketId: string
  parent: unknown
  activation: SubagentActivation
  controller: AbortController
}

export interface WorkerPool {
  start(input: WorkerStartInput): Promise<WorkerRegistration>
  /** 送一段话给活着的 worker；拿不到活对象时由子会话管理器冷启动。 */
  send(workerId: string, sender: unknown, text: string): Promise<string>
  /** true 活 / false 死 / undefined 比不了（没有活表）。 */
  alive(workerId: string): boolean | undefined
  abort(workerId: string, reason?: string): Promise<void>
  abortAll(reason?: string): Promise<void>
  registrations(): WorkerRegistration[]
}

export interface WorkerPoolDeps {
  subagents: () => SubagentSeam | undefined
  agents: () => AgentLookup | undefined
  warn?: (message: string) => void
}

/** 一次工具轮的话，包装成子会话要的 content 数组。 */
export function textBlocks(text: string): PromptBlock[] {
  return [{ type: 'text', text }]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createWorkerPool(deps: WorkerPoolDeps): WorkerPool {
  const warn = deps.warn ?? (() => {})
  const live = new Map<string, WorkerRegistration>()
  /**
   * 冷票的 controller：进程重启后票还在 running，但登记表是空的。给这些 worker
   * 也留一个 controller，`close` 时能 abort，不至于「关了票它还在跑」。
   */
  const parked = new Map<string, AbortController>()

  function controllerFor(workerId: string): AbortController {
    const known = live.get(workerId)?.controller ?? parked.get(workerId)
    if (known) return known
    const fresh = new AbortController()
    parked.set(workerId, fresh)
    return fresh
  }

  return {
    async start(input) {
      const seam = deps.subagents()
      if (!seam) throw new Error('subagents 服务不可用：现在派不了活')
      const controller = new AbortController()
      const activation = await seam.startActivation({
        provider: input.provider,
        label: input.label,
        request: {
          prompt: textBlocks(input.prompt),
          parent: input.parent,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          agentPreset: input.preset,
          ...(input.maxDepth ? { maxDepth: input.maxDepth } : {}),
        },
        // 故意不传调用方的 signal：工具轮一结束它就会 abort。
        signal: controller.signal,
        delivery: 'parent',
      })
      // childId 是唯一的归属证据：`SubagentRunInfo` 里没有它，所以票台自己记。
      const registration: WorkerRegistration = {
        workerId: activation.childId,
        ticketId: input.ticketId,
        parent: input.parent,
        activation,
        controller,
      }
      live.set(registration.workerId, registration)
      parked.delete(registration.workerId)
      return registration
    },

    async send(workerId, sender, text) {
      const seam = deps.subagents()
      if (!seam) throw new Error('subagents 服务不可用：现在送不了话')
      return seam.sendMessage(sender, workerId, textBlocks(text), {
        signal: controllerFor(workerId).signal,
      })
    },

    alive(workerId) {
      const agents = deps.agents()
      if (!agents) return undefined
      return agents.get(workerId) !== undefined && agents.get(workerId) !== null
    },

    async abort(workerId, reason) {
      const registration = live.get(workerId)
      live.delete(workerId)
      const parkedController = parked.get(workerId)
      parked.delete(workerId)
      const controller = registration?.controller ?? parkedController
      try {
        controller?.abort(reason ?? 'ticket closed')
      } catch (error) {
        warn(`abort ${workerId} 失败：${messageOf(error)}`)
      }
      // dispose 也是尽力而为：子和解器已经没了就当收好了。
      try {
        await registration?.activation.dispose()
      } catch (error) {
        warn(`dispose ${workerId} 失败：${messageOf(error)}`)
      }
    },

    async abortAll(reason) {
      const ids = new Set([...live.keys(), ...parked.keys()])
      for (const id of ids) await this.abort(id, reason)
    },

    registrations: () => [...live.values()],
  }
}

/** `subagent/end` 那条信号里，我们自己记下的 worker id。 */
export function workerIdOf(info: unknown): string | undefined {
  const id = (info as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id ? id : undefined
}

/** `agent/status`、`agent/disposed` 这类信号的 agent 对象 → 会话 id。 */
export function agentIdOf(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return value
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' && id ? id : undefined
}

/** 这条信号是不是属于某张票记下的 worker。 */
export function isSameWorker(recorded: string | undefined, incoming: string): boolean {
  if (!recorded) return false
  if (recorded === incoming) return true
  if (idVariants(recorded).has(incoming)) return true
  return matchesId(recorded, incoming)
}
