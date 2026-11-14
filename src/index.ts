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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config, DEFAULT_HANDOFF_POLICY, legacySweepWarning, resolveSweepMs, routerAllowList } from './config'
import type { Config as ConfigShape } from './config'
import { createTicketBackend, resolveStateFile, truncateColumns } from './store'
import type { Actor, ConflictWait, IntentSpec, TicketOrigin, TicketPlan, TicketStatus } from './store'
import { createTicketEventPublisher } from './store/bus'
import type { TicketEventsService, TicketEventPublisher } from './store/bus'
import { TicketLog } from './store/log'
import { ProbeWindows } from './tickets/probe'
import { WorkerTicketTools } from './tickets/worker-tools'
import { createWorkerWatch } from './tickets/watch'
import { createDesk } from './tickets/desk'
import type { Serialize, TicketView } from './tickets/desk'
import { createLlmClassifier } from './tickets/classify'
import type { LlmService } from './tickets/classify'
import { createNotifier } from './tickets/notify'
import { createSweepFacts } from './tickets/sweep-facts'
import { attachServiceWatch, createSweepDriver } from './tickets/sweep-driver'
import type { SweepDriver, SweepEventsService, SweepScheduleService } from './tickets/sweep-driver'
import { realClock } from './tickets/clock'
import { TICKETS_SERVICE, TicketReadout } from './tickets/readout'
import { TicketSnapshotFile } from './tickets/snapshot'
import type { PresetCatalog } from './tickets/publish'
import { parseToolsetDocument } from './tickets/preset-guard'
import type { PresetTools } from './tickets/preset-guard'
import type { SubagentSeam } from './tickets/workers'
import { bindRouter } from './router'
import type { RouterAgent, RouterBinding } from './router'
import { isWorkerSession, noWaitReason } from './no-wait'
import { sendProgress } from './progress'
import { TICKET_STATUSES, TOOL_NAMES } from './protocol'

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
export const WORKER_FORBIDDEN_TOOLS = [
  TOOL_NAMES.open,
  TOOL_NAMES.send,
  TOOL_NAMES.read,
  TOOL_NAMES.close,
  TOOL_NAMES.block,
  TOOL_NAMES.list,
  TOOL_NAMES.progressNote,
]

const STATUSES = TICKET_STATUSES

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

/** 从 `exec` 认出调用方。没有会话 id 就不干——票得记在谁名下。 */
function actorOf(exec: unknown): Actor {
  const agent = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent
  const sessionId = agent?.session?.id
  if (!sessionId) throw new Error('不知道是哪个会话在调这个工具：票得记在发起人名下')
  return { kind: 'main', sessionId }
}

/**
 * 调 `dispatch_report` 的调用者身份：worker 会话标 worker，其余按主会话。
 * 归属判定在 desk 里（`assertMayReport`），这里只负责把身份带过去；拿不到
 * 会话 id 就当场报错，别把报告记到一张不知道谁的票上。
 */
function callerActorOf(exec: unknown): Actor {
  const agent = (exec as { agent?: { session?: { id?: string; header?: { origin?: string } } } } | undefined)?.agent
  const sessionId = agent?.session?.id
  if (!sessionId) throw new Error('不知道是哪个会话在调这个工具：报告得记在发起人名下')
  return { kind: isWorkerSession(agent?.session?.header?.origin) ? 'worker' : 'main', sessionId }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return items.length > 0 ? items.map((item) => item.trim()) : undefined
}

/**
 * 把工具参数里的 `intent` 收敛成协议形状：只留认识的栏，空值丢掉。
 *
 * 模型多塞的键不进日志；`reversibility` 给了不认识的值就整栏丢掉，不静默
 * 降级成 `auto`（那等于把闸拆了），也不报错——2026-11-14 起 intent 只由
 * `dispatch_declare` 交，声明里写错一个字不该把整条声明拒掉。
 */
function intentSpecOf(raw: unknown): IntentSpec | undefined {
  const value = objectOf(raw)
  if (!value) return undefined
  const spec: IntentSpec = {}
  const impact = objectOf(value.impact)
  if (impact) {
    const paths = stringsOf(impact.paths)
    const services = stringsOf(impact.services)
    const remotes = stringsOf(impact.remotes)
    if (paths || services || remotes) {
      spec.impact = {
        ...(paths ? { paths } : {}),
        ...(services ? { services } : {}),
        ...(remotes ? { remotes } : {}),
      }
    }
  }
  const writes = stringsOf(value.writes)
  const reads = stringsOf(value.reads)
  if (writes) spec.writes = writes
  if (reads) spec.reads = reads
  if (value.reversibility === 'auto' || value.reversibility === 'manual' || value.reversibility === 'none') {
    spec.reversibility = value.reversibility
  }
  const dryRun = objectOf(value.dryRun)
  if (dryRun && typeof dryRun.ok === 'boolean') {
    const detail = typeof dryRun.detail === 'string' && dryRun.detail.trim() ? dryRun.detail.trim() : undefined
    spec.dryRun = { ok: dryRun.ok, ...(detail ? { detail } : {}) }
  }
  const undo = objectOf(value.undo)
  if (undo && typeof undo.kind === 'string' && typeof undo.howto === 'string') {
    const ref = typeof undo.ref === 'string' && undo.ref.trim() ? undo.ref.trim() : undefined
    spec.undo = { kind: undo.kind.trim(), ...(ref ? { ref } : {}), howto: undo.howto.trim() }
  }
  return Object.keys(spec).length > 0 ? spec : undefined
}

/**
 * 把工具参数里的 `plan` 收敛成协议形状：只留 summary / files，空值丢掉。
 *
 * 文件只到「路径 + 大概做什么」，行号和 diff 不进声明——那是执行轮的账本事。
 */
function planSpecOf(raw: unknown): TicketPlan | undefined {
  const value = objectOf(raw)
  if (!value) return undefined
  const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
  const files = Array.isArray(value.files)
    ? value.files
        .map((item) => objectOf(item))
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item) => {
          const path = typeof item.path === 'string' ? item.path.trim() : ''
          const what = typeof item.what === 'string' ? item.what.trim() : ''
          return { path, ...(what ? { what } : {}) }
        })
        .filter((item) => item.path)
    : []
  if (!summary && files.length === 0) return undefined
  return { ...(summary ? { summary } : {}), ...(files.length ? { files } : {}) }
}

/** 调用编号当幂等键：同一次调用重放不许开第二张票。 */
function requestIdOf(exec: unknown): string | undefined {
  const callId = (exec as { callId?: unknown } | undefined)?.callId
  return typeof callId === 'string' && callId ? callId : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * phase 的中文标记：票面只有 status 时，探路中/等放行/排队三档在屏上跟干活
 * 票长得一模一样。只在 phase 有值且不是 `running` 时补，老票不会撑出 undefined。
 */
const PHASE_MARKS: Record<string, string> = {
  planning: '探路中',
  planned: '待放行',
  queued: '冲突排队',
}

/** 票面上给人看的补充：status=blocked 是「等人」，phase=queued 是「等资源」。 */
const STATUS_MARKS: Record<string, string> = {
  blocked: '等人',
}

function statusMark(status: string | undefined): string {
  const mark = status ? STATUS_MARKS[status] : undefined
  return mark ? `（${mark}）` : ''
}

function phaseMark(phase: string | undefined): string {
  const mark = phase ? PHASE_MARKS[phase] : undefined
  return mark ? `（${mark}）` : ''
}

function ticketLine(view: TicketView): string {
  const marks = [
    view.stale ? '!' : '',
    view.pendingInputs ? '»' + view.pendingInputs : '',
    view.pendingReports ? '«' + view.pendingReports : '',
  ].join('')
  return `${marks ? marks + ' ' : ''}${view.id} ${view.status}${statusMark(view.status)}${phaseMark(view.phase)}：${view.brief}`
}

/**
 * intent / plan 的文本行：模型看到的是 render 出来的文本，光有 JSON 字段不够，
 * 所以两个工具都在票行下面各补一两行。太长就截，别把列表撑成报告。
 */
/** 越界项回显用：路径类资源脱掉前缀，和任务书里的路径写法对齐。 */
function displayPath(uri: string): string {
  return uri.replace(/^(?:file|dir|git|dev):/, '')
}

export function intentPlanLines(view: {
  intent?: IntentSpec
  plan?: TicketPlan
  waitOn?: ConflictWait[]
  weakWith?: string[]
  outOfScope?: string[]
}): string[] {
  const lines: string[] = []
  const plan = view.plan
  if (plan) {
    const files = (plan.files ?? []).map((file) => file.path).filter(Boolean)
    const summary = plan.summary?.trim()
    const tail = files.length ? `（${files.join('、')}）` : ''
    lines.push(`    ${truncateColumns(`plan：${summary ?? ''}${tail}`, 200)}`)
  }
  const intent = view.intent
  if (intent) {
    const parts: string[] = []
    const impact = intent.impact
    for (const [label, list] of [
      ['paths', impact?.paths],
      ['services', impact?.services],
      ['remotes', impact?.remotes],
    ] as const) {
      if (list && list.length) parts.push(`${label} ${list.join(' ')}`)
    }
    if (intent.writes?.length) parts.push(`writes ${intent.writes.length}`)
    if (intent.reads?.length) parts.push(`reads ${intent.reads.length}`)
    if (intent.reversibility) parts.push(`reversibility ${intent.reversibility}`)
    if (intent.undo) parts.push(`undo ${intent.undo.kind}`)
    if (parts.length) lines.push(`    ${truncateColumns(`intent：${parts.join(' · ')}`, 200)}`)
  }
  // 排队与弱冲突各占一行：模型看的是 render 出来的文本，光有 JSON 字段看不见
  // 「为什么这张票没动」。
  for (const wait of view.waitOn ?? []) {
    const resources = wait.resources.length ? ` (${wait.resources.join(' ')})` : ''
    lines.push(`    ${truncateColumns(`waiting on ${wait.ticketId}${resources}`, 200)}`)
  }
  if (view.weakWith?.length) {
    lines.push(`    ${truncateColumns(`weak conflict：${view.weakWith.join('、')}（放行）`, 200)}`)
  }
  // 越界对账：最多列 5 个，多的只报还剩几处；没有越界就一个字都不加。
  if (view.outOfScope?.length) {
    const total = view.outOfScope.length
    const paths = view.outOfScope.slice(0, 5).map(displayPath)
    // 路径太长时宁可少列两个，也要把「等 N 处」留在行尾：截断砍掉的恰好是它。
    let line = ''
    for (let count = paths.length; count >= 1; count -= 1) {
      const rest = total - count
      const candidate = `越界：${paths.slice(0, count).join('、')}${rest > 0 ? ` 等 ${rest} 处` : ''}`
      line = candidate
      if (truncateColumns(candidate, 200) === candidate) break
      line = truncateColumns(candidate, 200)
    }
    lines.push(`    ${line}`)
  }
  return lines
}

export function apply(ctx: Context, config: ConfigShape): void {
  const logger = (ctx as unknown as { logger?: Record<string, ((message: string) => void) | undefined> }).logger
  const warn = (message: string): void => {
    logger?.warn?.(message)
  }
  const info = (message: string): void => {
    logger?.info?.(message)
  }

  // 票日志：唯一写者。第三个参数把每一条追加广播成 `dispatcher/ticket`，票台
  // 不靠它改状态（状态只在自己的事件处理里折），宿主和别的插件可以监听。
  //
  // 第四道口是 dsh-events：服务在、后端也支持「外部落库 + 只补投影」时，
  // 事件走 publish、类型在这里注册；服务不在就整条退回直写，行为跟以前一样。
  // 这是硬要求：dsh-events 没挂载时票台必须完全照旧。
  const backend = createTicketBackend(
    {
      backend: config.store?.backend,
      stateFile: resolveStateFile(config.stateFile),
      dbFile: config.store?.file ? resolveStateFile(config.store.file) : undefined,
    },
    warn,
  )
  // 惰性探测：dsh-events 可能比 dispatcher 晚 apply（loader 并发，行序不保证），
  // 所以 apply 时探到的「没有」不能定终身。每次 commit 再问一次：拿到服务就换
  // 发布器，服务没了就清缓存回直写。
  let cachedEvents: TicketEventsService | undefined
  let cachedPublisher: TicketEventPublisher | undefined
  let reportedNoBackend = false
  const resolvePublisher = (): TicketEventPublisher | undefined => {
    const current = service<TicketEventsService>(ctx, 'events')
    if (!current) {
      cachedEvents = undefined
      cachedPublisher = undefined
      return undefined
    }
    // 服务对象没换就复用上次结论（包括「注册失败」），别每次 commit 都重试。
    if (current === cachedEvents) return cachedPublisher
    cachedEvents = current
    if (typeof current.publish !== 'function' || typeof current.defineEvent !== 'function') {
      cachedPublisher = undefined
      return undefined
    }
    if (typeof backend.adoptPublished !== 'function') {
      cachedPublisher = undefined
      if (!reportedNoBackend) {
        reportedNoBackend = true
        info(`[dispatcher] events 服务在，但 ${backend.location} 不支持外部落库：票事件走直写`)
      }
      return undefined
    }
    cachedPublisher = createTicketEventPublisher(current, warn)
    info(
      cachedPublisher
        ? '[dispatcher] 票事件 -> dsh-events（publish，类型已注册）'
        : '[dispatcher] events 类型没注册上：票事件走直写',
    )
    return cachedPublisher
  }

  // apply 时先探一次，只为了把启动日志写清楚；结果不当作永久结论。
  const publisher = resolvePublisher()
  if (!publisher) {
    info('[dispatcher] 没有 events 服务：票事件走直写（commit 时继续探测）')
  }

  const log = new TicketLog(
    backend,
    warn,
    (event) => {
      ;(ctx as unknown as { emit?: (name: string, payload: unknown) => void }).emit?.('dispatcher/ticket', event)
    },
    publisher,
    resolvePublisher,
  )

  // ── 统一只读出口 ────────────────────────────────────────────────
  // `/tickets` 指令（进程内）与桌宠（读文件/子进程）看的是同一份读数：CLI、
  // `dispatcher/tickets` 这个 service、桌面快照文件都从 TicketReadout 出，而
  // TicketReadout 只认 store 折好的快照。以后日志换 redis，消费者的形状不变。
  const readout = new TicketReadout(log, {
    briefMaxColumns: config.briefMaxColumns,
    waitingMinutes: config.waitingMinutes,
    blockedMinutes: config.blockedMinutes,
  })
  const provider = (ctx as unknown as { provide?: (name: string, value: unknown) => unknown }).provide
  if (typeof provider === 'function') {
    try {
      provider.call(ctx, TICKETS_SERVICE, readout)
    } catch (error) {
      // 热重载时同名服务可能还没被上一份 fiber 释放：降级成只有 CLI/文件可用。
      warn(`[dispatcher] ${TICKETS_SERVICE} 服务没挂上：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 桌面快照：每次 commit 之后同步重写，内容没变就不落盘。空 snapshotFile 跟着
  // 日志走（同目录的 tickets.snapshot.json），所以默认就是 $DSH_HOME/dispatcher/。
  const snapshotFile = (config.snapshotFile ?? '').trim()
  const snapshotPath = snapshotFile
    ? resolveStateFile(snapshotFile)
    : join(dirname(resolveStateFile(config.stateFile)), 'tickets.snapshot.json')
  if (config.snapshotEnabled ?? true) {
    const snapshots = new TicketSnapshotFile(
      readout,
      { file: snapshotPath, recentClosed: config.snapshotRecentClosed ?? 20 },
      warn,
    )
    snapshots.write()
    const stop = log.onCommitted(() => {
      snapshots.write()
    })
    ctx.effect(() => () => {
      stop()
    }, 'dsh-dispatcher.snapshot')
    info(`[dispatcher] 只读快照 -> ${snapshotPath}`)
  }

  // 全插件只有这一条队列：票台的每一次写都排在它上面，工具调用之间不会互相插队。
  let ticketQueue: Promise<void> = Promise.resolve()
  const serialize: Serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const run = ticketQueue.then(work)
    ticketQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  ticketEventQueue.set(ctx as object, () => ticketQueue)

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

  // ── 探路窗口：只给正在探路的那只子会话减工具 ──────────────────────
  // 票在 planning 阶段 = 探路轮：它只出方案，写盘是执行轮的事。窗口认票靠快照
  // 的 phase（事件折出来的），不靠 status。装窗口这一刀只能在 `agent/created`
  // 里——宿主不给我们「派活前先改这只 agent」的别的口。
  const probeWindows = new ProbeWindows({ warn })

  // ── 子会话的状态订阅：被挡就真停手 ────────────────────────────────
  // `spawned` 那一刻按票订上（desk 把事件喂进来，见 `desk.feedWatch`），被挡时
  // 先同步标记、再 cancel 打断当前这一轮、然后推一句短话。另外给 worker 会话
  // 装一道写类工具守卫：票被挡期间 `write` / `edit` / `bash` 直接拒，打断之后
  // 那一轮也别想再落下手。订阅失败一律只 warn，不影响票台。
  const workerWatch = createWorkerWatch({
    agents: () => {
      const agents = agentsOf()
      return agents ? { get: (id: string) => agents.get?.(id) } : undefined
    },
    warn,
    info,
  })
  ctx.effect(() => () => workerWatch.dispose(), 'dsh-dispatcher.worker-watch')

  /** 已经装过守卫的 worker 会话（同一只装一次）。 */
  const guardedWorkers = new WeakSet<object>()
  const workerGuardStops = new Set<() => void>()
  /**
   * 给一只 worker 会话装「被挡期间不许写」的工具守卫。判不判是每次调用现查的
   * （`workerWatch.writeBlockReason`），所以装上去之后就跟着票的状态走。
   */
  const installWorkerGuard = (agent: unknown): void => {
    const scope = agent as {
      session?: { id?: string; header?: { origin?: string } }
      ctx?: {
        effect?: (callback: () => () => void, label?: string) => unknown
        tools?: {
          guard?: (guard: (execution: { name: string; arguments: unknown }) => string | undefined) => unknown
        }
      }
    }
    if (!isWorkerSession(scope?.session?.header?.origin)) return
    if (guardedWorkers.has(agent as object)) return
    const workerId = scope.session?.id
    const guard = scope.ctx?.tools?.guard
    if (!workerId || typeof guard !== 'function') return
    guardedWorkers.add(agent as object)
    try {
      const stop = guard.call(scope.ctx?.tools, (execution) =>
        workerWatch.writeBlockReason(workerId, execution.name),
      )
      if (typeof stop !== 'function') return
      const release = stop as () => void
      workerGuardStops.add(release)
      scope.ctx?.effect?.(
        () => () => {
          workerGuardStops.delete(release)
          release()
        },
        'dsh-dispatcher.worker-block-guard',
      )
    } catch (error) {
      warn(
        `[dispatcher] 子会话 ${workerId} 的停手守卫没装上：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // 热重载时活表里可能已经有一批 worker：先补一遍，别只等新建那一刀。
  for (const agent of agentsOf()?.list() ?? []) installWorkerGuard(agent)

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
      installWorkerGuard(agent)
      // 重启/热重载之后这只子会话名下的票还开着：补订阅，别让它变成聋子。
      desk.adoptWorker((agent as { session?: { id?: string } }).session?.id)
    }
    return undefined
  })
  ctx.effect(() => () => {
    probeWindows.releaseAll()
    for (const release of [...workerGuardStops]) release()
  }, 'dsh-dispatcher.probe-windows')
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

  // ── 派活规矩：只给主会话，子会话有自己的任务书 ────────────────────
  const handoffText = config.handoffPolicy ? (config.handoffPolicyText ?? '').trim() : ''
  if (handoffText) {
    let announced = false
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const header = (context as { agent?: { session?: { header?: AgentHeader } } })?.agent?.session?.header
      if (header?.origin === 'subagent') return assembled
      if (!announced) {
        announced = true
        info(`[dispatcher] hand-off policy injected into the main session prompt (${handoffText.length} chars)`)
      }
      return {
        ...assembled,
        sections: [...assembled.sections, { name: 'dispatcher:handoff', order: 95, text: handoffText }],
      }
    })
  }

  // ── 巡检事实：走动态上下文快照，不往主会话里塞 user 消息 ────────
  // 宿主每次都把上下文重新渲染成一条 runtime-context 快照；文本没变就不落盘，
  // 变了才追加一条新的。模型看见的是「环境状态」，不是谁下的命令——这就是
  // 巡检提醒不再被主会话当成维护者说话的根。worker 不需要票台近况，跳过。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const header = (context as { agent?: { session?: { header?: AgentHeader } } })?.agent?.session?.header
    if (header?.origin === 'subagent') return assembled
    const text = sweepFacts.text()
    if (!text) return assembled
    // interpolate: false —— 票的 brief 是自由文本，别让 {{…}} 被当成提示词变量。
    const contexts = Array.isArray(assembled.contexts) ? assembled.contexts : []
    return {
      ...assembled,
      contexts: [...contexts, { name: 'dispatcher:sweep', text, interpolate: false }],
    }
  })

  // ── 等待守卫：主会话不许把回话卡在长命令上 ──────────────────────
  // 提示词里写了「别自己耗着」也可能被忽略；这一层是真拦住。装在各会话的 ctx
  // 上，所以有两个拥有者：会话先没了走 agent.ctx 的 effect，插件先没了走插件的
  // teardown。release 幂等，撤两次没事。
  if (config.noWaitGuard) {
    const limits = { maxCommandMs: config.maxCommandMs, maxWaitMs: config.maxWaitMs }
    const guarded = new WeakSet<object>()
    const guardReleases = new Set<() => void>()
    let announced = false
    const install = (agent: {
      session: { header: AgentHeader }
      ctx: {
        effect: (callback: () => () => void, label?: string) => unknown
        tools: { guard: (guard: (execution: { name: string; arguments: unknown }) => string | undefined) => () => void }
      }
    }): void => {
      if (isWorkerSession(agent.session.header.origin) || guarded.has(agent)) return
      guarded.add(agent)
      let stopGuard: (() => void) | undefined = agent.ctx.tools.guard((execution) =>
        noWaitReason(execution.name, (execution.arguments ?? {}) as Record<string, unknown>, limits),
      )
      const release = (): void => {
        const stop = stopGuard
        stopGuard = undefined
        guardReleases.delete(release)
        stop?.()
      }
      guardReleases.add(release)
      agent.ctx.effect(() => release, 'dsh-dispatcher.no-wait')
      if (!announced) {
        announced = true
        info('[dispatcher] waiting guard installed on the main session')
      }
    }
    for (const agent of agentsOf()?.list() ?? []) install(agent as never)
    ctx.on('agent/created', ({ agent }) => {
      install(agent as never)
      return undefined
    })
    ctx.effect(() => () => {
      for (const release of [...guardReleases]) release()
    }, 'dsh-dispatcher.no-wait-teardown')
  }

  // ── 七个工具：router 六个 + worker 一个 ──────────────────────────
  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.open,
      description:
        'Open a ticket and hand the work to a 子会话 in one step: the desk picks the preset, starts the 子会话, writes the ticket and returns its id. Call it before answering the person — never spawn a subagent yourself. Every ticket starts with a read-only probe round: that first 子会话 has no write / edit / bash, reads the code and hands its plan and intent back with dispatch_declare before anything is touched. dispatch_open takes neither intent nor probe — there is no path that skips the probe round.',
      parameters: {
        goal: { type: 'string', required: true, description: 'What the 子会话 is asked to do, verbatim and complete.' },
        brief: {
          type: 'string',
          required: true,
          description:
            'Required: the one line the little screen shows under the ticket title — a short phrase, not a sentence. At most briefMaxColumns character columns (34 by default), a 汉字 counts 2, so about 17 汉字 is the ceiling. Empty, whitespace-only or punctuation-only is rejected.',
        },
        dir: { type: 'string', description: 'Working directory the 子会话 should use, if any.' },
        origin: {
          type: 'string',
          enum: ['main', 'ego'],
          description:
            'Who is opening this ticket. Omit for main (the person / main session). ego must pass "ego".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            openCount: { type: 'number' },
            duplicate: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.duplicate
              ? `ticket ${value.id} already open (same request, ${value.openCount} open)`
              : value.reason
                ? `ticket ${value.id} held in waiting, 子会话 not started: ${value.reason}`
                : `ticket ${value.id} opened, 子会话 started (${value.openCount} open)`,
          },
        ],
      },
      async execute(args, exec) {
        const raw = args as unknown as Record<string, unknown>
        // 老调用方还会塞 intent：不静默忽略——那会让人以为意图已经落库。
        // 明说去哪儿交，模型下一轮就会改用 dispatch_declare。
        if (raw.intent !== undefined) {
          throw new Error(
            'dispatch_open 不再收 intent：子会话探路后会自己用 dispatch_declare 交代 intent',
          )
        }
        // probe 开关也删了：所有票一律探路，没有「不探路直接干」的快路径。
        // 静默忽略会让人以为快路径还在，所以照 intent 的做法明拒。
        if (raw.probe !== undefined) {
          throw new Error('dispatch_open 不再收 probe：所有票一律先探路，没有跳过的快路径')
        }
        const receipt = await desk.open(
          {
            goal: args.goal,
            brief: args.brief,
            ...(args.dir ? { dir: args.dir } : {}),
            ...(requestIdOf(exec) ? { requestId: requestIdOf(exec) as string } : {}),
            ...(raw.origin ? { origin: raw.origin as TicketOrigin } : {}),
          },
          actorOf(exec),
        )
        return {
          id: receipt.id,
          status: receipt.status,
          openCount: receipt.openCount,
          ...(receipt.duplicate ? { duplicate: receipt.duplicate } : {}),
          ...(receipt.reason ? { reason: receipt.reason } : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.send,
      description:
        'Put one more message into an open ticket. The 子会话 receives it now if it is idle, otherwise on its next turn. A finished ticket refuses it: open a new one.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        text: { type: 'string', required: true, description: 'What to tell the 子会话, verbatim.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            delivered: { type: 'boolean' },
            pendingInputs: { type: 'number' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `ticket ${value.id}: ${value.delivered ? 'delivered' : `queued (${value.pendingInputs} waiting)`}`,
          },
        ],
      },
      async execute(args, exec) {
        const receipt = await desk.send(args.id, args.text, actorOf(exec))
        return {
          id: receipt.id,
          status: receipt.status,
          delivered: receipt.delivered,
          pendingInputs: receipt.pendingInputs,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.read,
      description:
        'Read reports the 子会话 left on tickets and mark them delivered. Omit id to read every open ticket with unread reports.',
      parameters: {
        id: { type: 'string', description: 'Ticket id; omit for every ticket with unread reports.' },
        limit: { type: 'number', description: 'Max report lines per ticket (default 20).' },
        includeRead: { type: 'boolean', description: 'Also return reports already read.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            returned: { type: 'number' },
            markedRead: { type: 'number' },
            tickets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string' },
                  phase: { type: 'string' },
                  goal: { type: 'string' },
                  pendingReports: { type: 'number' },
                  intent: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      writes: { type: 'array', items: { type: 'string' } },
                      reads: { type: 'array', items: { type: 'string' } },
                      impact: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          paths: { type: 'array', items: { type: 'string' } },
                          services: { type: 'array', items: { type: 'string' } },
                          remotes: { type: 'array', items: { type: 'string' } },
                        },
                      },
                      reversibility: { type: 'string', enum: ['auto', 'manual', 'none'] },
                      dryRun: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
                      },
                      undo: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          kind: { type: 'string' },
                          ref: { type: 'string' },
                          howto: { type: 'string' },
                        },
                      },
                    },
                  },
                  plan: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      summary: { type: 'string' },
                      files: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: { path: { type: 'string' }, what: { type: 'string' } },
                        },
                      },
                    },
                  },
                  outOfScope: { type: 'array', items: { type: 'string' } },
                  reports: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        n: { type: 'number' },
                        at: { type: 'string' },
                        read: { type: 'boolean' },
                        text: { type: 'string' },
                        truncated: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const tickets = value.tickets ?? []
          if (tickets.length === 0) return [{ type: 'text', text: 'no reports' }]
          const blocks = tickets.map((ticket) => {
            const head = `ticket ${ticket.id} ${ticket.status}${statusMark(ticket.status)}${phaseMark(ticket.phase)}：${ticket.goal}`
            const body = (ticket.reports ?? []).map(
              (report) => `  #${report.n}${report.read ? ' (read)' : ''} ${report.text}`,
            )
            // 同 dispatch_list：render 的值按 TicketView 读。
            return [head, ...intentPlanLines(ticket as TicketView), ...body].join('\n')
          })
          return [{ type: 'text', text: blocks.join('\n') }]
        },
      },
      async execute(args) {
        const page = await desk.read(typeof args.id === 'string' && args.id ? args.id : undefined, {
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(args.includeRead === true ? { includeRead: true } : {}),
        })
        // 看过的票从巡检事实里摘掉：下一轮快照里它就不出现了。
        for (const ticket of page.tickets) sweepFacts.forget(ticket.id, ['report', 'no-report'])
        let returned = 0
        let markedRead = 0
        const tickets = page.tickets.map((ticket) => {
          const reports = ticket.reports.map((line, index) => {
            if (!line.read) markedRead += 1
            // 一条报告可能很长：截到 4000 字，别把上下文一次塞满。
            const text = line.text.length > 4000 ? line.text.slice(0, 4000) : line.text
            return {
              n: line.n ?? index + 1,
              at: line.at,
              read: line.read,
              text,
              ...(text.length < line.text.length ? { truncated: true } : {}),
            }
          })
          returned += reports.length
          return {
            id: ticket.id,
            status: ticket.status,
            ...(ticket.phase ? { phase: ticket.phase } : {}),
            goal: ticket.goal,
            pendingReports: ticket.pendingReports,
            ...(ticket.intent ? { intent: ticket.intent } : {}),
            ...(ticket.plan ? { plan: ticket.plan } : {}),
            ...(ticket.outOfScope?.length ? { outOfScope: ticket.outOfScope } : {}),
            reports,
          }
        })
        return { tickets, returned, markedRead }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.close,
      description:
        'Close a ticket for good: done when the work landed, dropped when it was abandoned. Messages still queued on it are voided and the 子会话 is stopped.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        outcome: {
          type: 'string',
          enum: ['done', 'dropped'],
          description: "done (default) = the work landed; dropped = abandoned.",
        },
        note: { type: 'string', description: 'One line on how it ended.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            closed: { type: 'boolean' },
            openCount: { type: 'number' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.closed
              ? `ticket ${value.id} ${value.status} (${value.openCount} open)`
              : `ticket ${value.id} was already ${value.status}`,
          },
        ],
      },
      async execute(args, exec) {
        const outcome: 'done' | 'dropped' = args.outcome === 'dropped' ? 'dropped' : 'done'
        const receipt = await desk.close(args.id, {
          outcome,
          ...(args.note ? { note: args.note } : {}),
          actor: actorOf(exec),
        })
        // 收工的票不再需要巡检提醒：条目全摘。
        sweepFacts.forget(receipt.id)
        return { id: receipt.id, status: receipt.status, closed: receipt.closed, openCount: receipt.openCount }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.block,
      description:
        'Park an open ticket as blocked while a person decides something. Router only: a 子会话 reports the blocker instead and waits.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        reason: { type: 'string', required: true, description: 'What is being waited on, in one line.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, status: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: `ticket ${value.id} ${value.status}` }],
      },
      async execute(args, exec) {
        const receipt = await desk.block(args.id, args.reason, actorOf(exec))
        return { id: receipt.id, status: receipt.status }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.list,
      description:
        'List tickets, oldest first. A leading ! marks one that has gone quiet, »n counts messages the 子会话 has not received, «n counts reports you have not read.',
      parameters: {
        status: { type: 'string', enum: STATUSES, description: 'Only this status.' },
        includeClosed: { type: 'boolean', description: 'Also list done and dropped tickets.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            openCount: { type: 'number' },
            tickets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string' },
                  phase: { type: 'string' },
                  brief: { type: 'string' },
                  ageMinutes: { type: 'number' },
                  stale: { type: 'boolean' },
                  statusSince: { type: 'string' },
                  preset: { type: 'string' },
                  pendingInputs: { type: 'number' },
                  pendingReports: { type: 'number' },
                  waitOn: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        ticketId: { type: 'string' },
                        resources: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                  weakWith: { type: 'array', items: { type: 'string' } },
                  outOfScope: { type: 'array', items: { type: 'string' } },
                  intent: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      writes: { type: 'array', items: { type: 'string' } },
                      reads: { type: 'array', items: { type: 'string' } },
                      impact: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          paths: { type: 'array', items: { type: 'string' } },
                          services: { type: 'array', items: { type: 'string' } },
                          remotes: { type: 'array', items: { type: 'string' } },
                        },
                      },
                      reversibility: { type: 'string', enum: ['auto', 'manual', 'none'] },
                      dryRun: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
                      },
                      undo: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          kind: { type: 'string' },
                          ref: { type: 'string' },
                          howto: { type: 'string' },
                        },
                      },
                    },
                  },
                  plan: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      summary: { type: 'string' },
                      files: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: { path: { type: 'string' }, what: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const tickets = value.tickets ?? []
          const head = `${value.openCount} open`
          if (tickets.length === 0) return [{ type: 'text', text: `${head}, none listed` }]
          return [
            {
              type: 'text',
              text: [
                head,
                ...tickets.flatMap((ticket) => [
                  `  ${ticketLine(ticket as TicketView)}`,
                  // 值的真实形状是 TicketView（schema 推导出来的形状每栏都可选，
                  // 跟 IntentSpec 的必填项对不上），和上面 ticketLine 同一个读法。
                  ...intentPlanLines(ticket as TicketView),
                ]),
              ].join('\n'),
            },
          ]
        },
      },
      async execute(args) {
        const all = args.includeClosed === true
        const wanted = args.status as TicketStatus | undefined
        const views = desk
          .list({ all: all || wanted !== undefined })
          .filter((view) => !wanted || view.status === wanted)
        // 列表里已经出现过的票，不必再在巡检快照里重复一遍。
        for (const view of views) sweepFacts.forget(view.id)
        return {
          openCount: desk.list().length,
          tickets: views.map((view) => ({
            id: view.id,
            status: view.status,
            ...(view.phase ? { phase: view.phase } : {}),
            brief: view.brief,
            ageMinutes: view.ageMinutes,
            stale: view.stale,
            statusSince: view.statusSince,
            ...(view.preset ? { preset: view.preset } : {}),
            pendingInputs: view.pendingInputs,
            pendingReports: view.pendingReports,
            ...(view.intent ? { intent: view.intent } : {}),
            ...(view.plan ? { plan: view.plan } : {}),
            ...(view.waitOn?.length ? { waitOn: view.waitOn } : {}),
            ...(view.weakWith?.length ? { weakWith: view.weakWith } : {}),
            ...(view.outOfScope?.length ? { outOfScope: view.outOfScope } : {}),
          })),
        }
      },
    }),
  )

  // worker 侧的票工具之一：追加一行，改不了任何状态。
  const reportTool = defineTool({
    name: TOOL_NAMES.report,
    description:
      'Hand a report back on the ticket you are working. Append-only: the ticket state stays where it is, the router decides. Call it once when this round is done, or to state a blocker and stop.',
    parameters: {
      id: { type: 'string', required: true, description: 'Ticket id you were given.' },
      text: { type: 'string', required: true, description: 'What you did, found, or are blocked on.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          epoch: { type: 'number' },
          pendingReports: { type: 'number' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `report recorded on ticket ${value.id} (round ${value.epoch})` },
      ],
    },
    async execute(args, exec) {
      const receipt = await desk.report(args.id, args.text, 'worker', callerActorOf(exec))
      return { id: receipt.id, epoch: receipt.epoch, pendingReports: receipt.pendingReports }
    },
  })

  ctx.tools.register(reportTool)

  // 探路交活：票号不给，按调用者反查自己名下那张票，别人的票写不进来。
  // 也不碰状态：declared 只是信息，转 planned 由主会话的动作写。
  const declareTool = defineTool({
    name: TOOL_NAMES.declare,
    description:
      'Declare your plan and reversal intent on the ticket you are working. Ticket id is not a parameter: the desk looks up the ticket attached to this worker, so you cannot write on someone else\'s. Append-only, status untouched. Refused when no ticket is attached to this worker or the ticket is already done/dropped.',
    parameters: {
      plan: {
        type: 'object',
        additionalProperties: false,
        description: 'What you intend to do: a summary and the files you will touch (file level, no line numbers).',
        properties: {
          summary: { type: 'string', description: 'One paragraph on how this ticket gets done.' },
          files: {
            type: 'array',
            description: 'Files you plan to change, each with roughly what happens to it.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true, description: 'Concrete file path.' },
                what: { type: 'string', description: 'One line: what changes in this file.' },
              },
            },
          },
        },
      },
      intent: {
        type: 'object',
        additionalProperties: false,
        description:
          'Reversal intent: writes, reads, impact, reversibility, dryRun, undo. This is where intent comes from now — dispatch_open does not take it.',
        properties: {
          writes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Resources this ticket will write, as URIs: file:/dir:/git:/svc:/port:/dev: (see the six prefixes). Optional.',
          },
          reads: {
            type: 'array',
            items: { type: 'string' },
            description: 'Same URI form: resources this ticket only reads. Optional.',
          },
          impact: {
            type: 'object',
            additionalProperties: false,
            description: 'What the work touches. Paths, services and remotes, as concrete strings.',
            properties: {
              paths: { type: 'array', items: { type: 'string' }, description: 'File or directory paths.' },
              services: { type: 'array', items: { type: 'string' }, description: 'systemd units or other services.' },
              remotes: { type: 'array', items: { type: 'string' }, description: 'git remotes / hosts / accounts.' },
            },
          },
          reversibility: {
            type: 'string',
            enum: ['auto', 'manual', 'none'],
            description:
              'auto = the side effect is confined and can be undone in one step; manual = a person has to follow undo.howto; none = cannot be taken back (restart, push, sent message).',
          },
          dryRun: {
            type: 'object',
            additionalProperties: false,
            description: 'Result of a rehearsal (--dry-run, config dump, diff).',
            properties: {
              ok: { type: 'boolean', required: true, description: 'Whether the rehearsal passed.' },
              detail: { type: 'string', description: 'One line a person can read when ok=false.' },
            },
          },
          undo: {
            type: 'object',
            additionalProperties: false,
            description: 'How to undo it. howto must be a concrete command or a concrete path.',
            properties: {
              kind: { type: 'string', required: true, description: 'file / git / service / message / config …' },
              ref: { type: 'string', description: 'Backup path, commit sha, message id, unit name.' },
              howto: { type: 'string', required: true, description: 'The exact command or path a person would run.' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          epoch: { type: 'number' },
          files: { type: 'number' },
          resources: { type: 'number' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          // 回执只说「交上了」，不说「放行」：冲突判定要等探路子会话 idle 那一拍，
          // 以前的英文回执被子会话读成「已经判过、放行了」。
          text: `ticket ${value.id} 已登记 ${value.files} 个文件、${value.resources} 个资源，等探路收工后判定冲突`,
        },
      ],
    },
    async execute(args, exec) {
      // 票号不收：按调用者的会话 id 反查归属，desk 只许写到这张票上。
      const raw = args as unknown as { plan?: unknown; intent?: unknown }
      const receipt = await desk.declare(
        actorOf(exec).sessionId,
        planSpecOf(raw.plan) ?? {},
        intentSpecOf(raw.intent) ?? {},
      )
      return {
        id: receipt.id,
        status: receipt.status,
        epoch: receipt.epoch,
        files: receipt.files,
        resources: receipt.resources,
      }
    },
  })

  ctx.tools.register(declareTool)

  // 收尾自报：执行子会话干完把实际动过的文件报上来，给关票那一刀对账。
  // 归属跟 dispatch_declare 同一套反查，票号不由调用方给；不碰状态。
  // t2（只读探路）和 t3（记忆）的白名单里没有它：探路轮不该报「动过什么」。
  const touchTool = defineTool({
    name: TOOL_NAMES.touch,
    description:
      'Report the files you actually touched this round on the ticket you are working. Ticket id is not a parameter: the desk looks up the ticket attached to this worker, so you cannot report on someone else\'s. Append-only and status untouched; calls merge by path. Refused when no ticket is attached to this worker or the ticket is already done/dropped.',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        description:
          'Absolute file paths you actually wrote or edited (a file: prefix is also accepted). Directories and other resource prefixes are passed through.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          paths: { type: 'number' },
          total: { type: 'number' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `touched ${value.paths} path(s) on ticket ${value.id} (${value.total} total)`,
        },
      ],
    },
    async execute(args, exec) {
      const raw = (args as { paths?: unknown }).paths
      const listed = Array.isArray(raw)
        ? raw.filter((path): path is string => typeof path === 'string' && path.trim() !== '')
        : []
      // 裸路径补 file: 前缀：normalizeResources 只认六种前缀，这里是最靠近
      // 「人写路径」的那一层，别让子会话为了报个文件先学资源串语法。
      const paths = listed.map((path) => {
        const trimmed = path.trim()
        return /^(?:file|dir|git|svc|port|dev):/i.test(trimmed) ? trimmed : `file:${trimmed}`
      })
      const receipt = await desk.touch(actorOf(exec).sessionId, paths)
      return { id: receipt.id, paths: receipt.paths, total: receipt.total }
    },
  })

  ctx.tools.register(touchTool)

  // 三件装给 worker 用：`publish.ts` 派活回来按 workerId 伸一次手，`agent/created`
  // 那一刀按 origin 再伸一次，谁先到谁装（`attach` 幂等）。
  workerTicketTools = new WorkerTicketTools({ definitions: [reportTool, declareTool, touchTool], warn })
  ctx.effect(() => () => workerTicketTools?.detachAll(), 'dsh-dispatcher.worker-tools')

  // 动作账本：子会话（和主会话）每干完一步就记一条。附录用，不改状态。
  // 不进 WORKER_FORBIDDEN_TOOLS：子会话必须能写账，否则「可撤回」只剩意图那一栏。
  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.logAction,
      description:
        'Append one action to a ticket ledger right after you actually did it. Log every step with a side effect: writing or editing a file, any git operation, changing config or profile, sending a message, restarting/stopping a service, running a command that changes state. Append-only: the ticket status is never touched. undo.howto must be a concrete command or a concrete path (for something that cannot be undone, write the compensating action) — generic lines like "revert it" are rejected.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id this action belongs to.' },
        summary: {
          type: 'string',
          required: true,
          description: 'One line: what you actually did (file:line, commit, unit, message target). At most 300 characters.',
        },
        undo: {
          type: 'object',
          additionalProperties: false,
          required: true,
          description: 'How to take this step back.',
          properties: {
            kind: { type: 'string', required: true, description: 'file / git / service / message / config …' },
            ref: { type: 'string', description: 'Backup path, commit sha, message id, unit name.' },
            howto: {
              type: 'string',
              required: true,
              description: 'The exact command or path a person would run, e.g. "cp /home/user/x.yml.bak /home/user/x.yml".',
            },
          },
        },
        step: {
          type: 'integer',
          description: 'Step number in this ticket. Omit to append after the last step.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            step: { type: 'number' },
            actions: { type: 'number' },
            at: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `action #${value.step} logged on ticket ${value.id} (${value.actions} on record)` },
        ],
      },
      async execute(args, exec) {
        // 谁在记：worker 的 session header 带 origin='subagent'；主会话没有。
        const agent = (exec as { agent?: { session?: { header?: { origin?: string } } } }).agent
        const actor = isWorkerSession(agent?.session?.header?.origin) ? 'worker' : 'main'
        const receipt = await desk.logAction(
          args.id,
          {
            summary: args.summary,
            undo: args.undo,
            ...(args.step !== undefined ? { step: args.step } : {}),
          },
          actor,
        )
        return { id: receipt.id, step: receipt.step, actions: receipt.actions, at: receipt.at }
      },
    }),
  )

  // ── 打点：一行进度直接推到维护者手机上 ────────────────────────────
  // 不写 jsonl、不叫醒任何会话。推送失败只在日志里记一笔，不抛给模型——打点是
  // 顺手的礼貌，不该拖住干活。P3 起主会话和子会话的白名单里都没有它（子会话该用
  // dispatch_report），工具留着给手工调用和老的测试会话。
  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.progressNote,
      description:
        'Push one line of progress straight to the person on QQ. No session is woken and nothing is written to disk.',
      parameters: {
        text: { type: 'string', required: true, description: "One line of progress, short and in the person's own terms." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { sent: { type: 'boolean' } },
        },
        render: (_args, value) => [
          { type: 'text', text: value.sent ? 'progress pushed to the person' : 'progress not pushed (notify failed)' },
        ],
      },
      async execute(args) {
        const result = await sendProgress(args.text, {
          script: config.notifyScript,
          timeoutMs: config.notifyTimeoutMs,
          log: warn,
        })
        return { sent: result.sent }
      },
    }),
  )

  // ── 主会话白名单 + worker 反向名单 ──────────────────────────────
  // 顺序有讲究：这一段必须跑在所有 `ctx.tools.register` 之后。装载器拿 allow
  // 名单去注册表点名，点不到的按「名字写错」剔掉；热重载时先装白名单会把本插件
  // 自己的 dispatch_* 当错名扔掉。
  if (config.routerRestrict || config.workerToolDeny || config.workerPromptPrune) {
    const routerSeen = new WeakSet<object>()
    const bindings = new Set<RouterBinding>()
    const bound = new WeakMap<object, RouterBinding>()
    let announced = false
    let workerAnnounced = false
    let tearingDown = false
    const registry = {
      get(name: string): unknown {
        const tools = (ctx as { tools?: { get?: (name: string) => unknown } }).tools
        return tools?.get?.(name)
      },
      names(): readonly string[] {
        const tools = (ctx as { tools?: { schemas?: () => readonly { name: string }[] } }).tools
        try {
          return (tools?.schemas?.() ?? []).map((schema) => schema.name)
        } catch {
          return []
        }
      },
    }
    const options = {
      allow: routerAllowList(config),
      // deny 叠加、越减越少，跟 allow 不打架。拼在配置之后、不进默认值。
      deny: config.workerToolDeny ? [...new Set([...config.workerDenyTools, ...WORKER_FORBIDDEN_TOOLS])] : [],
      pruneWorkerPrompt: config.workerPromptPrune,
      escapeFile: config.routerEscapeFile,
      log: warn,
      info,
      registry,
    }
    const install = (agent: RouterAgent): void => {
      const worker = isWorkerSession(agent.session.header.origin)
      if (worker ? !config.workerToolDeny && !config.workerPromptPrune : !config.routerRestrict) return
      let binding = bound.get(agent)
      if (binding === undefined) {
        if (routerSeen.has(agent)) return
        routerSeen.add(agent)
        binding = bindRouter(agent, options)
        bound.set(agent, binding)
        bindings.add(binding)
        const own = binding
        agent.ctx.effect(() => () => {
          own.dispose()
          bindings.delete(own)
        }, 'dsh-dispatcher.router-release')
      } else {
        binding.sync()
      }
      const outcome = binding.outcome()
      if (worker) {
        if ((outcome === 'denied' || outcome === 'updated') && !workerAnnounced) {
          workerAnnounced = true
          info(`[dispatcher] worker subagents hide ${binding.installed().length} tool(s): ${binding.installed().join(', ')}`)
        }
        return
      }
      if ((outcome === 'installed' || outcome === 'updated') && !announced) {
        announced = true
        info(
          `[dispatcher] router whitelist installed on the main session (${binding.installed().length}/${options.allow.length} tools registered)`,
        )
      }
    }
    for (const agent of agentsOf()?.list() ?? []) install(agent as never)
    ctx.on('agent/created', ({ agent }) => {
      install(agent as never)
      return undefined
    })
    ctx.on('tools/change', () => {
      if (tearingDown) return undefined
      for (const binding of [...bindings]) binding.sync()
      return undefined
    })
    ctx.effect(() => () => {
      tearingDown = true
      for (const binding of [...bindings]) binding.dispose()
      bindings.clear()
    }, 'dsh-dispatcher.router-teardown')
  }
}
