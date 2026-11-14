/**
 * 插件的接线层：把票台（`tickets/desk.ts`）接成模型能调的工具，再把白名单、
 * 提示词和等待守卫装到会话上。
 *
 * 这一层**不写票**。开票、关票、挂起、投递、补报告全在 desk 里，工具只做三件事：
 * 从 `exec` 认出调用方、把参数转过去、把回执收窄成该给模型看的几栏。所以
 * 「工具也能改 status」这种第二条写者从结构上不存在。
 *
 * 也没有第二条队列：`serialize` 就是这个文件里那条 `ticketQueue`，desk 拿着它跑。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Config, DEFAULT_HANDOFF_POLICY, legacySweepWarning, resolveSweepMs, routerAllowList } from './config'
import type { Config as ConfigShape } from './config'
import { truncateColumns } from './store'
import type { Actor, ConflictWait, IntentSpec, TicketOrigin, TicketPlan, TicketStatus } from './store'
import type { WorkerTicketTools } from './tickets/worker-tools'
import { createDesk } from './tickets/desk'
import type { Serialize, TicketView } from './tickets/desk'
import { createLlmClassifier } from './tickets/classify'
import type { LlmService } from './tickets/classify'
import { createNotifier } from './tickets/notify'
import { createSweepFacts } from './tickets/sweep-facts'
import { attachServiceWatch, createSweepDriver } from './tickets/sweep-driver'
import type { SweepDriver, SweepEventsService, SweepScheduleService } from './tickets/sweep-driver'
import { realClock } from './tickets/clock'
import type { PresetCatalog } from './tickets/publish'
import { parseToolsetDocument } from './tickets/preset-guard'
import type { PresetTools } from './tickets/preset-guard'
import type { SubagentSeam } from './tickets/workers'
import { bindRouter } from './router'
import type { RouterAgent, RouterBinding } from './router'
import { isWorkerSession } from './no-wait'
import { installTools } from './installers/tools'
import { installStore } from './installers/store'
import { createWorkerPlane } from './installers/workplane'
import { installRestrict } from './installers/restrict'
import { installPromptGuard } from './installers/prompt'

export const name = 'dsh-dispatcher'
export const inject = ['tools', 'agents']

// Re-export the schema so the loader can validate this plugin's config.
export { Config }

export { DEFAULT_HANDOFF_POLICY as HANDOFF_POLICY }

/**
 * worker 无论配置怎么写都不该拿到的本包工具：开票、发话、读票、关票、挂起、
 * 列表、以及绕过票直接推手机的打点。
 *
 * 子会话手上只留 `dispatch_report` 一个票工具，而且它只往队列里追加一行，碰不到
 * status。`dispatch_block` 也在这里：卡住该用报告说，不该自己把票标成挂起。
 *
 * 拼在 `workerDenyTools` 之后、不进 config 默认值：operator 改写
 * `workerDenyTools` 不该顺手把这几样放回 worker 手里。
 */
export { WORKER_FORBIDDEN_TOOLS } from './installers/restrict'

/** 票事件队列的把手：测试等它排空，生产里没人用。 */
export const ticketEventQueue = new WeakMap<object, () => Promise<void>>()

/** 巡检驱动源的把手：测试点一下「再探一次」，生产里没人读。 */
export const sweepDriverSlot = new WeakMap<object, SweepDriver>()

/** `ctx.get` 拿不到就返回 undefined：票台少一个服务该是降级，不是崩溃。 */
function service<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const found = getter.call(ctx, name)
      if (found !== undefined && found !== null) return found as T
    } catch {
      // 服务没就绪：往下走静态栏。
    }
  }
  const direct = (ctx as unknown as Record<string, unknown>)[name]
  return direct === undefined || direct === null ? undefined : (direct as T)
}

/**
 * 只认 `ctx.get` 的服务探测。
 *
 * `ctx.events` 是 Cordis 自己的事件总线，属性读会被它遮住；`events` 服务必须
 * 走 `ctx.get('events')` 才拿得到（见 dsh-events/plugin.js 的注释）。所以这里
 * 不吃 `service()` 的属性兜底。
 */
function probed<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  try {
    const found = getter.call(ctx, name)
    return found === undefined || found === null ? undefined : (found as T)
  } catch {
    return undefined
  }
}

interface AgentLike {
  session?: { id?: string; header?: { origin?: string } }
  status?: string
  followup?: (message: unknown) => Promise<unknown>
}

interface AgentsService {
  list(): AgentLike[]
  get?: (id: string) => AgentLike | undefined
}

interface PresetRow {
  id?: string
  name?: string
  description?: string
}

interface PresetRegistry {
  list?: () => Promise<PresetRow[]>
  /** 注册表自己认的默认档。 */
  defaultId?: string
  composedPreset?: (ctx: unknown) => string | undefined
  /** 一个档的声明（plugins 的 YAML 文本）。选档守卫拿它读 allow/deny。 */
  readDocument?: (id: string) => Promise<{ content?: string }>
}

interface AgentHeader {
  origin?: string
}

export { intentPlanLines } from './tools-shared'

export function apply(ctx: Context, config: ConfigShape): void {
  const logger = (ctx as unknown as { logger?: Record<string, ((message: string) => void) | undefined> }).logger
  const warn = (message: string): void => {
    logger?.warn?.(message)
  }
  const info = (message: string): void => {
    logger?.info?.(message)
  }

  const { log, readout, serialize } = installStore(ctx, config, {
    warn,
    info,
    service,
    setQueue: (drain) => ticketEventQueue.set(ctx as object, drain),
  })

  // ── 服务探针 ────────────────────────────────────────────────────
  const agentsOf = (): AgentsService | undefined => service<AgentsService>(ctx, 'agents')
  const llmOf = () => service<LlmService>(ctx, 'llm')
  const registryOf = () => service<PresetRegistry>(ctx, 'agentPresets')

  let warnedNoReadDocument = false

  /** 选档守卫的工具面缓存；解析失败不缓存（下一次还会重新读一遍）。 */
  const presetToolsCache = new Map<string, PresetTools | undefined>()
  ctx.on('tools/change', () => {
    presetToolsCache.clear()
  })

  const presets: PresetCatalog = {
    async list() {
      const registry = registryOf()
      let rows: PresetRow[] = []
      try {
        rows = (await registry?.list?.()) ?? []
      } catch (error) {
        warn(`[dispatcher] 读不到档位注册表：${error instanceof Error ? error.message : String(error)}`)
        return []
      }
      return rows
        .filter((row) => typeof row.id === 'string' && row.id.length > 0)
        .map((row) => ({
          id: row.id as string,
          ...(row.name ? { name: row.name } : {}),
          ...(row.description ? { description: row.description } : {}),
        }))
    },
    defaultId() {
      const id = registryOf()?.defaultId
      return typeof id === 'string' && id ? id : undefined
    },
    async tools(id) {
      // 档位声明是 YAML 文本，读一次解一次太浪费：按 id 缓存。热重载时插件
      // 整份重来，缓存跟着没了；tools/change（MCP 工具上下线）也清一次。
      if (presetToolsCache.has(id)) return presetToolsCache.get(id)
      const registry = registryOf()
      if (typeof registry?.readDocument !== 'function') {
        // 宿主注册表没有读声明这一口（老版本）：工具面未知，按「没减工具」算，
        // 不拿没依据的猜测去驳回，但要说一声——这道门此时只剩两档。
        if (!warnedNoReadDocument) {
          warnedNoReadDocument = true
          warn('[dispatcher] 档位注册表没有 readDocument，选档校验只能看档名，读不到工具面')
        }
        return undefined
      }
      const document = await registry.readDocument(id)
      const content = typeof document?.content === 'string' ? document.content : ''
      if (!content.trim()) throw new Error(`档 ${id} 的声明是空的`)
      const tools = parseToolsetDocument(content)
      presetToolsCache.set(id, tools)
      return tools
    },
  }


  // 允许档位镜像是从 profile 手抄的：启动时对一遍注册表，抄错的名字要吭声。
  void (async () => {
    const allowed = config.allowedPresets ?? []
    if (allowed.length === 0) return
    const rows = await presets.list()
    if (rows.length === 0) return // 注册表还没就绪：不误报。
    const known = new Set(rows.map((row) => row.id))
    const missing = allowed.filter((id) => !known.has(id))
    if (missing.length > 0) {
      warn(`[dispatcher] allowedPresets 里有注册表没有的档：${missing.join(' / ')}（这几档永远选不到）`)
    }
  })()

  /**
   * 巡检事实：主会话该知道的票台近况。它走动态上下文（下一段的 assemble 钩子），
   * 不走 `followup`——注进去的 user 消息会被模型当成维护者发的话。
   *
   * `dispatch_list` / `dispatch_read` / `dispatch_close` 见过哪些票，就把对应条目
   * 摘掉；没读的继续挂着。
   */
  const sweepFacts = createSweepFacts()

  /**
   * 主会话自己挂的档（可选探测）。主会话通常没挂档——profile 里 `agentPreset`
   * 是给 `tool-subagent` 的，不是给主会话的——所以这里多数时候返回 undefined，
   * 选档退回 `config.defaultPreset`。探测失败一律当没有。
   */
  const routerPreset = (): string | undefined => {
    const registry = registryOf()
    if (typeof registry?.composedPreset !== 'function') return undefined
    for (const agent of agentsOf()?.list() ?? []) {
      const origin = agent.session?.header?.origin
      if (isWorkerSession(origin)) continue
      try {
        const id = registry.composedPreset(agent)
        if (typeof id === 'string' && id) return id
      } catch {
        // 这个会话还没 compose 出档：下一个。
      }
    }
    return undefined
  }

  const classifier = createLlmClassifier({
    llm: llmOf,
    model: config.classifyModel,
    effort: config.classifyEffort,
    timeoutMs: config.classifyTimeoutMs,
    warn,
  })

  /**
   * 提醒落在哪个会话上。
   *
   * 有 `to`（被挡/放行那张票的开票方）就先指名送它——这台机器上挂两个主会话
   * 时，话不能推给另一个；指名的不在活表（会话没了/重启过）再回落第一个主会话，
   * 至少别把话吞掉。子会话不收票台通知：它只在执行轮里干活。
   */
  const wake = async (body: string, to?: string): Promise<boolean> => {
    const usable = (agent: AgentLike): boolean =>
      !isWorkerSession(agent.session?.header?.origin) && typeof agent.followup === 'function'
    const deliver = async (agent: AgentLike): Promise<boolean> => {
      await agent.followup!({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: 'dsh-dispatcher' },
      })
      return true
    }
    const list = agentsOf()?.list() ?? []
    if (to) {
      const named = list.find((agent) => agent.session?.id === to)
      if (named && usable(named)) return deliver(named)
    }
    for (const agent of list) {
      if (!usable(agent)) continue
      return deliver(agent)
    }
    return false
  }

  // 巡检间隔：新键 sweepMs 说了算，老键 sweepMinutes 显式配了才折算并 warn 一句。
  const sweepMs = resolveSweepMs(config)
  const legacySweep = legacySweepWarning(config)
  if (legacySweep) warn(`[dispatcher] ${legacySweep}`)

  // ── worker 平面：探路窗口、被挡停手、写类工具守卫 ────────────────
  const { probeWindows, workerWatch, installGuard } = createWorkerPlane(ctx, {
    agents: agentsOf,
    warn,
    info,
  })

  // 三个票工具的兜底注册：定义在下面注册完之后才建（`workerTicketTools` 先留空），
  // 但 `agent/created` 只在新会话冒出来时才触发，那时候它已经在了。
  let workerTicketTools: WorkerTicketTools | undefined
  ctx.on('agent/created', ({ agent }) => {
    probeWindows.adopt(agent as never, (id) => log.get(id))
    // worker 的工具面由档位定，但 declare / report / touch 三件按 agent 层再装
    // 一道：档位的 allow 名单只滤镜全局工具面，`restrict` 动不了按 agent 注册
    // 的这几件（见 `worker-tools.ts`）。认人跟 router 一个口径。
    const origin = (agent as { session?: { header?: { origin?: string } } }).session?.header?.origin
    if (isWorkerSession(origin)) {
      workerTicketTools?.attach(agent as never)
      installGuard(agent)
      // 重启/热重载之后这只子会话名下的票还开着：补订阅，别让它变成聋子。
      desk.adoptWorker((agent as { session?: { id?: string } }).session?.id)
    }
    return undefined
  })
  const desk = createDesk({
    log,
    serialize,
    bus: {
      emit: (channel, payload) => {
        // 只留一行日志：报告正文不进这里，提醒里的摘要已经是全部该看的。
        const head = (payload ?? {}) as { id?: unknown; reason?: unknown; stopReason?: unknown }
        info(`[dispatcher] ${channel}${head.id ? `（票 ${String(head.id)}）` : ''}`)
      },
    },
    host: {
      on: (event, listener) => ctx.on(event as never, listener as never),
    },
    subagents: () => service<SubagentSeam>(ctx, 'subagents'),
    agents: () => {
      const agents = agentsOf()
      if (!agents) return undefined
      return { get: (id: string) => agents.get?.(id) }
    },
    presets,
    classify: config.presetStrategy === 'static' ? undefined : classifier,
    routerPreset,
    notifier: createNotifier({ wake, facts: sweepFacts, quiet: false, warn }),
    watch: workerWatch,
    probe: probeWindows,
    workerTools: {
      attach: (workerId) =>
        workerTicketTools?.attachById(workerId, () => {
          const agents = agentsOf()
          return agents ? { get: (id: string) => agents.get?.(id) } : undefined
        }) ?? false,
    },
    config: {
      defaultPreset: config.defaultPreset,
      presetStrategy: config.presetStrategy,
      classifyTimeoutMs: config.classifyTimeoutMs,
      allowedPresets: config.allowedPresets,
      commandKeywords: config.commandKeywords,
      rejectOnMismatch: config.rejectOnMismatch,
      provider: config.provider,
      maxDepth: config.maxDepth,
      maxExec: config.maxExec,
      maxQueued: config.maxQueued,
      briefMaxColumns: config.briefMaxColumns,
      waitingMinutes: config.waitingMinutes,
      blockedMinutes: config.blockedMinutes,
      runningReminderMinutes: config.runningReminderMinutes,
      sweepMs,
      freshMinutes: config.freshMinutes,
      autoReport: config.autoReport,
      noReportSignal: config.noReportSignal,
      repeatWindowMinutes: config.repeatWindowMinutes,
    },
    warn,
  })
  desk.attach()
  ctx.effect(() => () => {
    void desk.dispose()
  }, 'dsh-dispatcher.desk')

  // ── 巡检驱动源：dsh-timer 的 tick 优先，拿不到就自己数秒 ────────
  // 发布和订阅同一刀上线：注册成功才停自己的 setInterval；schedule 不在、
  // 注册被拒（含 EV-006）都保留自己的定时器，并各打一行日志说明当前谁在驱动。
  // tick 中途断流由 driver 的 watchdog 兜回自己的定时器——巡检不会因为
  // tick 没了就静默停摆，也不会出现两路同时驱动。
  const sweepDriver = createSweepDriver({
    desk,
    events: () => probed<SweepEventsService>(ctx, 'events'),
    schedule: () => probed<SweepScheduleService>(ctx, 'schedule'),
    every: sweepMs,
    clock: realClock,
    info,
    warn,
  })
  // 每拍落定后重新探一次：schedule 比 dispatcher 晚 apply、或者中途被撤掉，
  // 都靠这一眼发现（第一次探测在下面）。
  desk.onPulse(() => sweepDriver.reconcile())
  sweepDriver.reconcile()
  sweepDriverSlot.set(ctx as unknown as object, sweepDriver)
  // schedule 一就绪就重挂规则，不用等下一拍巡检（也不等下一个 tick）。
  // 监听器内部整只包了 try/catch：events 的 emit 不兜错，冒出去会弄挂 timer 的 apply。
  const detachServiceWatch = attachServiceWatch(
    (event, listener) => ctx.on(event as never, listener as never),
    sweepDriver,
    { warn },
  )
  ctx.effect(() => {
    return () => {
      detachServiceWatch()
      sweepDriver.dispose()
    }
  }, 'dsh-dispatcher.sweep')

  // ── 提示词注入：交接规矩、巡检事实、等待守卫 ────────────────────
  installPromptGuard(ctx, config, { sweepFacts, info, agents: agentsOf })

  // ── 十一个工具：router 六个 + worker 三件 + 账本 + 打点 ─────────
  workerTicketTools = installTools(ctx, { config, desk, sweepFacts, warn })

  // ── 主会话白名单 + worker 反向名单 ──────────────────────────────
  // 顺序有讲究：这一段必须跑在所有 `ctx.tools.register` 之后。
  installRestrict(ctx, config, { agents: agentsOf, warn, info })
}
