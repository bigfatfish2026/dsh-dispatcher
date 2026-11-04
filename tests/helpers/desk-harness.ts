/**
 * 票台测试的台子：内存后端 + 假子会话 + 假活表 + 假时钟 + 假分类器。
 *
 * 一个真子会话都不开、一分钱不花。`serialize` 用真的串行链（不是直通），因为
 * 「两个人同时开票」正是这套东西最容易出错的地方，测试里不该把它省掉。
 */
import { TicketLog } from '../../src/store/log'
import type { TicketBackend, TicketBroadcast, TicketEvent } from '../../src/store'
import { fakeClock } from '../../src/tickets/clock'
import type { FakeClock } from '../../src/tickets/clock'
import { TicketDesk, deskConfig } from '../../src/tickets/desk'
import type { DeskConfig, DeskDeps, Serialize } from '../../src/tickets/desk'
import type { Classifier, PresetCatalog, PresetInfo } from '../../src/tickets/publish'
import type { PresetTools } from '../../src/tickets/preset-guard'
import type { AgentLookup, SubagentActivation, SubagentSeam, SubagentSpec } from '../../src/tickets/workers'

/** 内存后端：能数行数、能指定「哪一条写不进」，其余照契约来。 */
export class MemoryBackend implements TicketBackend {
  readonly location = 'memory://tickets'
  private events: TicketEvent[] = []
  /** 让某一条事件写失败：模拟落盘出错，测补偿路径。 */
  failOn?: (event: TicketEvent) => boolean

  changed(): boolean {
    return false
  }

  load(): TicketEvent[] {
    return [...this.events]
  }

  append(event: TicketEvent): void {
    if (this.failOn?.(event)) throw new Error(`写不进这条事件：${(event as { kind?: string }).kind ?? 'legacy'}`)
    this.events.push(event)
  }

  get events_(): TicketEvent[] {
    return [...this.events]
  }

  get count(): number {
    return this.events.length
  }

  kinds(): string[] {
    return this.events.map((event) => (event as { kind?: string }).kind ?? 'legacy')
  }
}

export interface FakeSubagents {
  seam: SubagentSeam
  spawned: SubagentSpec[]
  sent: { target: string; text: string }[]
  disposed: string[]
  failNext: (error: Error) => void
}

export function fakeSubagents(): FakeSubagents {
  let seq = 0
  let failure: Error | undefined
  const spawned: SubagentSpec[] = []
  const sent: { target: string; text: string }[] = []
  const disposed: string[] = []
  const seam: SubagentSeam = {
    async startActivation(spec) {
      if (failure) {
        const error = failure
        failure = undefined
        throw error
      }
      spawned.push(spec)
      seq += 1
      const childId = `worker-${seq}`
      const activation: SubagentActivation = {
        childId,
        messageId: `msg-${seq}`,
        dispose: async () => {
          disposed.push(childId)
        },
      }
      return activation
    },
    async sendMessage(_sender, targetId, content) {
      sent.push({ target: targetId, text: content[0]?.text ?? '' })
      return `sent-${sent.length}`
    },
  }
  return {
    seam,
    spawned,
    sent,
    disposed,
    failNext: (error) => {
      failure = error
    },
  }
}

/** 活表：默认只有主会话；`spawned` 出来的 worker 由 `markAlive` 加进去。 */
export function fakeAgents(...ids: string[]): AgentLookup & { markAlive(id: string): void; markGone(id: string): void } {
  const agents = new Map<string, unknown>()
  for (const id of ids) agents.set(id, { id })
  return {
    get: (id) => agents.get(id),
    markAlive: (id) => agents.set(id, { id }),
    markGone: (id) => agents.delete(id),
  }
}

export const TEST_PRESETS: PresetInfo[] = [
  { id: 't1', name: '快活' },
  { id: 't2', name: '慢活' },
]

/**
 * 假注册表。`toolMap` 是「每个档的工具面」：给 Error 测 rule0（装不上），
 * 不给就是 undefined（没挂 toolset = 全局工具面，能跑命令）。
 */
export type FakeToolSpec = Record<string, PresetTools | Error | undefined>

export function fakePresets(
  list: PresetInfo[] = TEST_PRESETS,
  defaultId?: string,
  toolMap?: FakeToolSpec,
): PresetCatalog {
  return {
    list: async () => list,
    defaultId: () => defaultId,
    async tools(id: string) {
      if (!toolMap) return undefined
      const value = toolMap[id]
      if (value instanceof Error) throw value
      return value
    },
  }
}

/** 分类器：想说哪档就说哪档；`hang` 用来测超时。 */
export function fakeClassifier(
  answer: string | { preset: string; why?: string; needsCommand?: boolean } | undefined | 'hang' | Error,
): Classifier & { calls: number } {
  const classifier = {
    calls: 0,
    async classify() {
      classifier.calls += 1
      if (answer === 'hang') return new Promise<never>(() => {})
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return classifier
}

/** 真的串行链：后一件事等前一件跑完，异常不打断队列。 */
export function makeSerialize(): Serialize {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)
    return run
  }
}

/** 宿主事件的小发射器：测试直接 `emit('subagent/end', …)` 喂信号。 */
export interface FakeHost {
  on(name: string, listener: (payload: unknown) => unknown): unknown
  emit(name: string, payload: unknown): void
  listeners(name: string): number
}

function fakeHost(): FakeHost {
  const map = new Map<string, ((payload: unknown) => unknown)[]>()
  return {
    on(name, listener) {
      const list = map.get(name) ?? []
      list.push(listener)
      map.set(name, list)
      return undefined
    },
    emit(name, payload) {
      for (const listener of map.get(name) ?? []) listener(payload)
    },
    listeners: (name) => (map.get(name) ?? []).length,
  }
}

/** 等宿主回调那条串行链跑完：一次事件要过几层 microtask。 */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

export interface Harness {
  desk: TicketDesk
  backend: MemoryBackend
  log: TicketLog
  clock: FakeClock
  subagents: FakeSubagents
  agents: ReturnType<typeof fakeAgents>
  broadcasts: TicketBroadcast[]
  bus: { channel: string; payload: unknown }[]
  warnings: string[]
  host: FakeHost
  config: DeskConfig
  main: { kind: 'main'; sessionId: string }
  lines(): number
}

export function makeDesk(
  options: {
    config?: Partial<DeskConfig>
    /** 换掉串行队列：测「队列被占住」时塞一个不放手的手闸。 */
    serialize?: Serialize
    presets?: PresetCatalog
    classify?: Classifier
    now?: Date
    agents?: ReturnType<typeof fakeAgents>
    notifier?: DeskDeps['notifier']
    device?: string
    /** 主会话当前挂的档（可选探测）。 */
    routerPreset?: string
  } = {},
): Harness {
  const backend = new MemoryBackend()
  const broadcasts: TicketBroadcast[] = []
  const log = new TicketLog(backend, undefined, (event) => broadcasts.push(event))
  const clock = fakeClock(options.now)
  const subagents = fakeSubagents()
  const agents = options.agents ?? fakeAgents('session-main')
  const bus: { channel: string; payload: unknown }[] = []
  const warnings: string[] = []
  const host = fakeHost()
  const config = {
    defaultPreset: 't1',
    ...options.config,
  }
  const desk = new TicketDesk({
    log,
    serialize: options.serialize ?? makeSerialize(),
    clock,
    bus: { emit: (channel, payload) => bus.push({ channel, payload }) },
    host,
    subagents: () => subagents.seam,
    agents: () => agents,
    presets: options.presets ?? fakePresets(),
    classify: options.classify,
    ...(options.routerPreset ? { routerPreset: () => options.routerPreset } : {}),
    config,
    device: options.device ?? 'board-test',
    warn: (message) => warnings.push(message),
    ...(options.notifier ? { notifier: options.notifier } : {}),
  })
  return {
    desk,
    backend,
    log,
    clock,
    subagents,
    agents,
    broadcasts,
    bus,
    warnings,
    host,
    config: deskConfig(config),
    main: { kind: 'main', sessionId: 'session-main' },
    lines: () => backend.count,
  }
}

export const INTENT = {
  goal: '把票台拆出来',
  brief: '拆票台',
  requestId: 'req-1',
}
