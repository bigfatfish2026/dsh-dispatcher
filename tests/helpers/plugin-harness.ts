/**
 * 插件层的台子：把 `apply()` 装进一个假 ctx，然后像模型那样点工具。
 *
 * 这里只假宿主：工具表、活表、事件总线、服务解析（`ctx.get`）、日志。票台本身
 * 是真的，票日志落在临时目录里，所以这些测试测的是「接线对不对」，不是重测票台。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_HANDOFF_POLICY, DEFAULT_ROUTER_TOOLS, DEFAULT_WORKER_DENY_TOOLS } from '../../src/config'
import { DEFAULT_COMMAND_KEYWORDS } from '../../src/tickets/preset-guard'
import type { Config } from '../../src/config'
import { apply, ticketEventQueue } from '../../src/index'
import type { PromptAssemblyHook } from '../../src/prompt'
import { fakeSubagents } from './desk-harness'

const tempDirs: string[] = []

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-plugin-'))
  tempDirs.push(dir)
  return dir
}

export function cleanTempDirs(): void {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = tempDir()
  return {
    stateFile: join(dir, 'tickets.jsonl'),
    defaultPreset: 't1',
    presetStrategy: 'static',
    classifyModel: 'deepseek/deepseek-flash',
    classifyEffort: 'off',
    classifyTimeoutMs: 8000,
    allowedPresets: [],
    commandKeywords: [...DEFAULT_COMMAND_KEYWORDS],
    rejectOnMismatch: true,
    provider: 'spawn',
    maxDepth: 2,
    maxOpen: 8,
    briefMaxColumns: 34,
    // 定时器关掉：插件层测的是接线，不是拍子。schema 的最小值 500 只校验 yml，
    // 这里直接给 desk 的配置，0 = 不起定时器。
    sweepMs: 0,
    waitingMinutes: 20,
    blockedMinutes: 60,
    runningReminderMinutes: 0,
    freshMinutes: 2,
    autoReport: true,
    noReportSignal: true,
    repeatWindowMinutes: 10,
    handoffPolicy: true,
    handoffPolicyText: DEFAULT_HANDOFF_POLICY,
    noWaitGuard: true,
    maxCommandMs: 30000,
    maxWaitMs: 5000,
    routerRestrict: true,
    routerEscapeFile: join(dir, 'no-restrict'),
    snapshotFile: '',
    snapshotEnabled: true,
    snapshotRecentClosed: 20,
    routerTools: [...DEFAULT_ROUTER_TOOLS],
    extraRouterTools: [],
    workerToolDeny: true,
    workerDenyTools: [...DEFAULT_WORKER_DENY_TOOLS],
    workerPromptPrune: true,
    notifyScript: join(dir, 'notify.sh'),
    notifyTimeoutMs: 5000,
    ...overrides,
  }
}

export interface FakeAgent {
  id: string
  session: { id: string; header: { origin?: string } }
  status?: string
  messages: string[]
  followup(message: { content?: Array<{ text?: string }> }): Promise<unknown>
  ctx: {
    effect(callback: () => () => void, label?: string): unknown
    on(event: string, listener: PromptAssemblyHook): () => void
    tools: {
      restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
      get(name: string): unknown
      guard(guard: (execution: { name: string; arguments: unknown }) => string | undefined): () => void
    }
  }
}

export interface FakePluginHost {
  ctx: Record<string, unknown>
  registry: Set<string>
  tools: Map<string, ToolDefinition>
  restricted: string[][]
  denied: string[][]
  lifted: number[]
  infos: string[]
  warnings: string[]
  changes: string[]
  agents: FakeAgent[]
  createdListeners: Array<(payload: { agent: FakeAgent }) => unknown>
  changeListeners: Array<() => unknown>
  listeners: Map<string, Array<(payload: unknown) => unknown>>
  hooks: PromptAssemblyHook[]
  /** 服务：`ctx.get(name)` 从这里拿。 */
  services: Record<string, unknown>
  makeAgent(origin?: string): FakeAgent
  emit(name: string, payload: unknown): void
  call(name: string, args: Record<string, unknown>, options?: { agent?: FakeAgent; callId?: string }): Promise<unknown>
  definition(name: string): ToolDefinition
  names(): string[]
  /** 等票事件队列排空。 */
  settled(): Promise<void>
}

interface ToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  output?: { schema?: unknown; render?: (args: Record<string, unknown>, value: any) => Array<{ type: string; text: string }> }
  execute(args: Record<string, unknown>, exec: { agent?: unknown; callId?: string }): Promise<unknown>
}

/**
 * 假宿主。`registered` 是装载时注册表里已有的名字（别的插件的工具），
 * `existingAgents` 决定装载那一刻有没有主会话。
 */
export function fakePluginHost(
  options: {
    registered?: string[]
    existingAgents?: number
    services?: Record<string, unknown>
  } = {},
): FakePluginHost {
  const registry = new Set<string>(options.registered ?? [])
  const tools = new Map<string, ToolDefinition>()
  const restricted: string[][] = []
  const denied: string[][] = []
  const lifted: number[] = []
  const infos: string[] = []
  const warnings: string[] = []
  const changes: string[] = []
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>()
  const createdListeners: Array<(payload: { agent: FakeAgent }) => unknown> = []
  const changeListeners: Array<() => unknown> = []
  const hooks: PromptAssemblyHook[] = []
  const services: Record<string, unknown> = { ...(options.services ?? {}) }

  const fireChange = (): void => {
    for (const listener of changeListeners) listener()
  }

  const makeAgent = (origin?: string, id?: string): FakeAgent => {
    const name = id ?? `session-${origin ?? 'main'}-${Math.random().toString(16).slice(2, 8)}`
    const agent: FakeAgent = {
      id: name,
      session: { id: name, header: origin ? { origin } : {} },
      messages: [],
      async followup(message) {
        const first = message.content?.[0]?.text
        if (first) agent.messages.push(first)
        return { id: `msg-${agent.messages.length}` }
      },
      ctx: {
        effect: (callback) => callback(),
        on(event: string, listener: PromptAssemblyHook) {
          if (event === 'system-prompt/assemble') hooks.push(listener)
          return () => {}
        },
        tools: {
          restrict(filter) {
            const index = restricted.length
            changes.push('restrict')
            if (filter.allow !== undefined) restricted.push([...filter.allow])
            if (filter.deny !== undefined) denied.push([...filter.deny])
            fireChange()
            return () => {
              lifted.push(index)
            }
          },
          get: (toolName: string) => (registry.has(toolName) ? { name: toolName } : undefined),
          guard: () => () => {},
        },
      },
    }
    return agent
  }

  const agents: FakeAgent[] = Array.from({ length: options.existingAgents ?? 1 }, () => makeAgent())

  const ctx: Record<string, unknown> = {
    agents: {
      list: () => agents,
      get: (id: string) => agents.find((agent) => agent.session.id === id || agent.session.id === `session-${id}`),
    },
    effect: (callback: () => () => void) => callback(),
    get(name: string) {
      return services[name]
    },
    provide(name: string, value: unknown) {
      const owner = name
      services[owner] = value
      return () => {
        if (services[owner] === value) delete services[owner]
      }
    },
    on(event: string, listener: unknown) {
      const list = listeners.get(event) ?? []
      list.push(listener as (payload: unknown) => unknown)
      listeners.set(event, list)
      if (event === 'agent/created') createdListeners.push(listener as (payload: { agent: FakeAgent }) => unknown)
      if (event === 'tools/change') changeListeners.push(listener as () => unknown)
      if (event === 'system-prompt/assemble') hooks.push(listener as PromptAssemblyHook)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(
          event,
          current.filter((entry) => entry !== listener),
        )
      }
    },
    emit(name: string, payload: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
    tools: {
      register(definition: ToolDefinition) {
        tools.set(definition.name, definition)
        registry.add(definition.name)
        changes.push(`register:${definition.name}`)
        fireChange()
        return () => {
          tools.delete(definition.name)
        }
      },
      get: (name: string) => (registry.has(name) ? { name } : undefined),
      schemas: () => [...tools.keys()].map((name) => ({ name })),
    },
    logger: {
      info: (message: string) => {
        infos.push(message)
      },
      warn: (message: string) => {
        warnings.push(message)
      },
    },
  }

  const host: FakePluginHost = {
    ctx,
    registry,
    tools,
    restricted,
    denied,
    lifted,
    infos,
    warnings,
    changes,
    agents,
    createdListeners,
    changeListeners,
    listeners,
    hooks,
    services,
    makeAgent,
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
    definition(name) {
      const found = tools.get(name)
      if (!found) throw new Error(`tool not registered: ${name}`)
      return found
    },
    names: () => [...tools.keys()],
    async settled() {
      const wait = ticketEventQueue.get(ctx as object)
      if (wait) await wait()
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    async call(name, args, callOptions = {}) {
      const definition = host.definition(name)
      const agent = callOptions.agent ?? agents[0]
      return definition.execute(args, {
        ...(agent ? { agent: { session: agent.session, id: agent.id } } : {}),
        ...(callOptions.callId ? { callId: callOptions.callId } : {}),
      })
    },
  }
  return host
}

/** 装一次插件：`services` 里放 subagents / llm / agentPresets。 */
export function mountPlugin(
  options: {
    config?: Partial<Config>
    registered?: string[]
    existingAgents?: number
    services?: Record<string, unknown>
  } = {},
): FakePluginHost & { config: Config; subagents: ReturnType<typeof fakeSubagents>; spied: string[] } {
  const subagents = fakeSubagents()
  const host = fakePluginHost({
    ...(options.registered ? { registered: options.registered } : {}),
    ...(options.existingAgents !== undefined ? { existingAgents: options.existingAgents } : {}),
    services: {
      subagents: subagents.seam,
      // 档位注册表：真宿主里是 agent-preset-registry，这里给最小的样子。
      agentPresets: {
        list: async () => [
          { id: 't1', name: '常规' },
          { id: 't2', name: '只读' },
        ],
        defaultId: 't1',
        // 真宿主读的是档位声明全文；这里给最小可解析的样子：t2 只读，其余能跑。
        readDocument: async (id: string) => ({
          content:
            id === 't2'
              ? "- name: 'dsh-preset-toolset'\n  config:\n    allow:\n      - read\n      - grep\n"
              : "- name: 'dsh-preset-toolset'\n  config:\n    allow:\n      - bash\n      - read\n      - write\n",
        }),
      },
      ...(options.services ?? {}),
    },
  })
  const config = testConfig(options.config)
  apply(host.ctx as never, config)
  return { ...host, config, subagents, spied: [] }
}
