/**
 * 票台与巡检接线的安装：服务探针、预设目录、分类器、wake、worker 平面、
 * createDesk、巡检驱动源、service watch、agent/created 接线。
 *
 * 从 apply() 整段搬出来。agent/created 里要装的三件票工具由调用方通过
 * getWorkerTools 延迟提供（它们要等工具注册段跑完才存在）。
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import { legacySweepWarning, resolveSweepMs } from '../config'
import type { TicketLog } from '../store/log'
import { createDesk } from '../tickets/desk'
import type { CommandJudge, Serialize } from '../tickets/desk'
import { createLlmClassifier } from '../tickets/classify'
import type { LlmService } from '../tickets/classify'
import { classifyNeedsCommand } from '../tickets/classify-command'
import type { NeedsCommandInput } from '../tickets/classify-command'
import { createNotifier } from '../tickets/notify'
import { createSweepFacts } from '../tickets/sweep-facts'
import type { SweepFacts } from '../tickets/sweep-facts'
import { attachServiceWatch, createSweepDriver } from '../tickets/sweep-driver'
import type { SweepDriver, SweepEventsService, SweepScheduleService } from '../tickets/sweep-driver'
import { realClock } from '../tickets/clock'
import { parseToolsetDocument } from '../tickets/preset-guard'
import type { PresetTools } from '../tickets/preset-guard'
import type { PresetCatalog } from '../tickets/publish'
import type { SubagentSeam } from '../tickets/workers'
import type { WorkerTicketTools } from '../tickets/worker-tools'
import { isWorkerSession } from '../no-wait'
import { createWorkerPlane } from './workplane'

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
  defaultId?: string
  composedPreset?: (ctx: unknown) => string | undefined
  readDocument?: (id: string) => Promise<{ content?: string }>
}

export interface DeskInstallerDeps {
  log: TicketLog
  serialize: Serialize
  service<T>(ctx: Context, name: string): T | undefined
  probed<T>(ctx: Context, name: string): T | undefined
  warn: (message: string) => void
  info: (message: string) => void
  getWorkerTools: () => WorkerTicketTools | undefined
  setSweepDriver?: (driver: SweepDriver) => void
}

export interface DeskInstallerResult {
  desk: ReturnType<typeof createDesk>
  sweepFacts: SweepFacts
  agentsOf: () => AgentsService | undefined
}

/**
 * 档位目录：注册表读取、默认档、工具面解析与缓存。导出给单测直接喂假注册表，
 * 安装器里只负责接真服务。
 */
export function createPresetCatalog(
  registryOf: () => PresetRegistry | undefined,
  warn: (message: string) => void,
  cache: Map<string, PresetTools | undefined> = new Map(),
): PresetCatalog {
  let warnedNoReadDocument = false
  return {
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
      if (cache.has(id)) return cache.get(id)
      const registry = registryOf()
      if (typeof registry?.readDocument !== 'function') {
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
      cache.set(id, tools)
      return tools
    },
  }
}

/** 把一句话推给主会话：指名会话优先，退回落第一个能 followup 的主会话。 */
export function createWake(agentsOf: () => AgentsService | undefined) {
  return async (body: string, to?: string): Promise<boolean> => {
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
}

export function installDesk(ctx: Context, config: Config, deps: DeskInstallerDeps): DeskInstallerResult {
  const { warn, info, log, serialize } = deps
  // ── 服务探针 ────────────────────────────────────────────────────
  const agentsOf = (): AgentsService | undefined => deps.service<AgentsService>(ctx, 'agents')
  const llmOf = () => deps.service<LlmService>(ctx, 'llm')
  const registryOf = () => deps.service<PresetRegistry>(ctx, 'agentPresets')


  /** 选档守卫的工具面缓存；解析失败不缓存（下一次还会重新读一遍）。 */
  const presetToolsCache = new Map<string, PresetTools | undefined>()
  ctx.on('tools/change', () => {
    presetToolsCache.clear()
  })

  const presets = createPresetCatalog(registryOf, warn, presetToolsCache)


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
   * 不走 `followup`——注进去的 user 消息会被模型当成使用方发的话。
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
   * 命令判定：一次 flash 档小模型调用，问「这活要不要真跑命令」。
   *
   * `static` 策略是「不花那次调用选档」，这里也一并不花：守卫退回关键词表
   * （`commandKeywords`），行为跟改造前一致。`llm` 策略才接。
   */
  const judgeCommand: CommandJudge | undefined =
    config.presetStrategy === 'static'
      ? undefined
      : (input: NeedsCommandInput) =>
          classifyNeedsCommand(input, {
            llm: llmOf,
            model: config.commandHintModel,
            effort: config.commandHintEffort,
            timeoutMs: config.commandHintTimeoutMs,
            keywords: config.commandKeywords,
            warn,
          })

  /**
   * 提醒落在哪个会话上。
   *
   * 有 `to`（被挡/放行那张票的开票方）就先指名送它——这台机器上挂两个主会话
   * 时，话不能推给另一个；指名的不在活表（会话没了/重启过）再回落第一个主会话，
   * 至少别把话吞掉。子会话不收票台通知：它只在执行轮里干活。
   */
  const wake = createWake(agentsOf)

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
  ctx.on('agent/created', ({ agent }) => {
    probeWindows.adopt(agent as never, (id) => log.get(id))
    // worker 的工具面由档位定，但 declare / report / touch 三件按 agent 层再装
    // 一道：档位的 allow 名单只滤镜全局工具面，`restrict` 动不了按 agent 注册
    // 的这几件（见 `worker-tools.ts`）。认人跟 router 一个口径。
    const origin = (agent as { session?: { header?: { origin?: string } } }).session?.header?.origin
    if (isWorkerSession(origin)) {
      deps.getWorkerTools()?.attach(agent as never)
      installGuard(agent)
      // 重启/热重载之后这个子会话名下的票还开着：补订阅，别让它变成聋子。
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
    subagents: () => deps.service<SubagentSeam>(ctx, 'subagents'),
    agents: () => {
      const agents = agentsOf()
      if (!agents) return undefined
      return { get: (id: string) => agents.get?.(id) }
    },
    presets,
    classify: config.presetStrategy === 'static' ? undefined : classifier,
    ...(judgeCommand ? { judgeCommand } : {}),
    routerPreset,
    notifier: createNotifier({ wake, facts: sweepFacts, quiet: false, warn }),
    watch: workerWatch,
    probe: probeWindows,
    workerTools: {
      attach: (workerId) =>
        deps.getWorkerTools()?.attachById(workerId, () => {
          const agents = agentsOf()
          return agents ? { get: (id: string) => agents.get?.(id) } : undefined
        }) ?? false,
    },
    config: {
      defaultPreset: config.defaultPreset,
      presetStrategy: config.presetStrategy,
      classifyTimeoutMs: config.classifyTimeoutMs,
      commandHintModel: config.commandHintModel,
      commandHintEffort: config.commandHintEffort,
      commandHintTimeoutMs: config.commandHintTimeoutMs,
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
    events: () => deps.probed<SweepEventsService>(ctx, 'events'),
    schedule: () => deps.probed<SweepScheduleService>(ctx, 'schedule'),
    every: sweepMs,
    clock: realClock,
    info,
    warn,
  })
  // 每拍落定后重新探一次：schedule 比 dispatcher 晚 apply、或者中途被撤掉，
  // 都靠这一眼发现（第一次探测在下面）。
  desk.onPulse(() => sweepDriver.reconcile())
  sweepDriver.reconcile()
  deps.setSweepDriver?.(sweepDriver)
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

  return { desk, sweepFacts, agentsOf }
}
