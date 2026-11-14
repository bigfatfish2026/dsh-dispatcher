/**
 * 票台：票的唯一写者。
 *
 * 三层是 router（决定干什么）→ desk（票是什么状态）→ worker（真去干）。只有
 * 这个文件往票日志里写；工具层和宿主回调都通过它，所以「同一张票同时被两条路
 * 改」在结构上就不可能。
 *
 * 三条不写在别处的规矩：
 *
 * - **所有写都在注入的 `serialize` 里跑完。** 今天那条队列是 `src/index.ts` 的
 *   `ticketQueue`；desk 不自建第二条，否则「一个人先入队后被别人抢先」又会回来。
 *   内部辅助函数（投递、补报告）直接 `commit`，不再进队列——否则自锁。
 * - **状态只由这里写。** `subagent/end`、`agent/status`、巡检都只是「信号」，
 *   折成什么状态由 desk 按 §4 的边决定；非法边直接忽略，不报错也不写日志。
 * - **写盘失败和 reconcile 失败不是一回事。** `commit` 同步、会抛；抛了就让调用
 *   方看见（工具报错），不许吞掉——票和现实不一致时，人得知道。
 */
import { dirname } from 'node:path'
import { briefOf, isOpen, minutesSince, pending } from '../store'
import type {
  Actor,
  ConflictWait,
  IntentSpec,
  TicketEvent,
  TicketPhase,
  TicketPlan,
  TicketSnapshot,
  TicketStatus,
} from '../store'
import { byQueueOrder, newEntryId, newTicketId } from '../store/log'
import type { TicketLog } from '../store/log'
import type { Clock } from './clock'
import { realClock } from './clock'
import {
  BLOCKED_MINUTES,
  LONG_WAIT_MINUTES,
  BRIEF_MAX_COLUMNS,
  CLASSIFY_TIMEOUT_MS,
  FRESH_MINUTES,
  MAX_EXEC,
  MAX_QUEUED,
  PROBE_TIMEOUT_MINUTES,
  REPEAT_WINDOW_MINUTES,
  REVERT_AUDIT_DAYS,
  REVERT_AUDIT_MS,
  RUNNING_REMINDER_MINUTES,
  SWEEP_MS,
  WAITING_MINUTES,
} from '../defaults'
import { createNotifier } from './notify'
import type { IdleReason, OwnerNotifier } from './notify'
import type { WorkerWatch } from './watch'
import { outOfScopePaths } from './conflict'
import { normalizeResources, scanResources } from './resources'
import { TicketHandle, ticketsOfWork } from './handle'
import { ConflictArbiter, byClaimOrder } from './arbiter'
import { WorkerRegistry } from './registry'
import { buildLabel, buildPrompt, decidePreset, normalizeBrief, publishTicket, startWorker } from './publish'
import type { ProbePort, ProbeRegistry } from './probe'
import type { WorkerToolPort } from './worker-tools'
import type { Classifier, PresetCatalog, PresetDecision, TicketIntent, TicketReceipt } from './publish'
import { checkPresetChoice, DEFAULT_COMMAND_KEYWORDS, PresetRejectedError } from './preset-guard'
import type { PresetRejection } from './preset-guard'
import { auditClosedTickets, normalizeUndo } from './revert'
import type { RevertAuditReport } from './revert'
import { agentIdOf, createWorkerPool, isSameWorker, workerIdOf } from './workers'
import type { AgentLookup, SubagentSeam, WorkerPool } from './workers'
import { ticketView } from './view'
import type { TicketView } from './view'

export type {
  Classifier,
  ClassifyInput,
  PresetCatalog,
  PresetDecision,
  PresetInfo,
  TicketIntent,
  TicketReceipt,
} from './publish'
export type { Clock } from './clock'
export type { IdleReason, OwnerNotifier } from './notify'
export type { RevertAuditFinding, RevertAuditKind, RevertAuditReport } from './revert'

/**
 * 票台自己的配置。刻意不复用插件那份 `Config`：那一份是给工具面读的，改它的
 * 默认值会动到线上行为；这一份只在接线时逐个字段映射过去。
 */
export interface DeskConfig {
  /** 默认档。没有代码默认值：配置和注册表都不给就拒绝开票。 */
  defaultPreset: string
  presetStrategy: 'llm' | 'static'
  classifyTimeoutMs: number
  /** 允许档位镜像；空数组 = 不校验「档在不在允许清单里」。 */
  allowedPresets: readonly string[]
  /** 「要跑命令」的关键词兜底表。 */
  commandKeywords: readonly string[]
  /** 选档一致性校验总开关。 */
  rejectOnMismatch: boolean
  /** 传给 `startActivation` 的 provider 名。 */
  provider: string
  maxDepth: number
  /**
   * 同时干活的票上限：只数 `status === 'running' && phase !== 'queued'` 的票。
   *
   * 名额拆成两个独立计数后这里只管执行；排队另有 `maxQueued`。老配置里的
   * `maxOpen` 仍能加载，但不再参与计数（按默认 8 处理）。
   */
  maxExec: number
  /** 同时排队的票上限：只数 `phase === 'queued'` 的票（挂起等放行）。 */
  maxQueued: number
  /** 已废弃：名额拆成 `maxExec` / `maxQueued`，这个键只为老配置还能加载而留着。 */
  maxOpen?: number
  briefMaxColumns: number
  waitingMinutes: number
  blockedMinutes: number
  /** 0 = 不发「跑了很久」提醒。 */
  runningReminderMinutes: number
  /** 巡检间隔，毫秒。0 = 不起定时器。 */
  sweepMs: number
  /** disposed 之后多久才认「真没了」，挡掉正常重启的抖动。 */
  freshMinutes: number
  autoReport: boolean
  noReportSignal: boolean
  /** 撤回审计的窗口（天）：只扫最近这些天结的 done 票。 */
  revertAuditDays: number
  /** 撤回审计的节流（毫秒）：0 = 巡检不跑审计。 */
  revertAuditMs: number
  /** 探路窗口的耐心（分钟）：到点还没交声明就降级，按 dir 整片当写进。 */
  probeTimeoutMinutes: number
  /** 排队超过这么多分钟算长等：放掉原 worker，放行时新起一只。 */
  longWaitMinutes: number
  /**
   * 同一个人同一件事在这个窗口内再开票视为重复。
   *
   * 巡检提醒的重复抑制不靠时间窗：指纹里带 `statusSince`，同一轮只提醒一次，
   * 状态轮换后自然能再提醒——比「10 分钟内不再提」精确，也不会漏掉新的一轮。
   */
  repeatWindowMinutes: number
}

export const DESK_DEFAULTS: Omit<DeskConfig, 'defaultPreset'> = {
  presetStrategy: 'llm',
  classifyTimeoutMs: CLASSIFY_TIMEOUT_MS,
  allowedPresets: [],
  commandKeywords: DEFAULT_COMMAND_KEYWORDS,
  rejectOnMismatch: true,
  provider: 'spawn',
  maxDepth: 2,
  maxExec: MAX_EXEC,
  maxQueued: MAX_QUEUED,
  briefMaxColumns: BRIEF_MAX_COLUMNS,
  waitingMinutes: WAITING_MINUTES,
  blockedMinutes: BLOCKED_MINUTES,
  runningReminderMinutes: RUNNING_REMINDER_MINUTES,
  sweepMs: SWEEP_MS,
  freshMinutes: FRESH_MINUTES,
  autoReport: true,
  noReportSignal: true,
  repeatWindowMinutes: REPEAT_WINDOW_MINUTES,
  revertAuditDays: REVERT_AUDIT_DAYS,
  revertAuditMs: REVERT_AUDIT_MS,
  probeTimeoutMinutes: PROBE_TIMEOUT_MINUTES,
  longWaitMinutes: LONG_WAIT_MINUTES,
}

export function deskConfig(partial: Partial<DeskConfig> & { defaultPreset: string }): DeskConfig {
  return { ...DESK_DEFAULTS, ...partial }
}

/** `src/index.ts` 那条队列的形状：一件事跑完才轮到下一件。 */
export type Serialize = <T>(work: () => Promise<T>) => Promise<T>

export interface DeskBus {
  emit(channel: string, payload: unknown): void
}

export interface DeskHost {
  on(name: string, listener: (payload: unknown) => unknown): unknown
}

export interface DeskDeps {
  log: TicketLog
  serialize: Serialize
  clock?: Clock
  bus?: DeskBus
  host?: DeskHost
  subagents: () => SubagentSeam | undefined
  agents?: () => AgentLookup | undefined
  presets: PresetCatalog
  classify?: Classifier
  /** 主会话当前挂的档（可选探测）；没有就不问。 */
  routerPreset?: () => string | undefined
  notifier?: OwnerNotifier
  /**
   * 子会话自己的状态订阅（`watch.ts`）：`spawned` 那一刻按票挂上，被挡/放行/收工
   * 各推一句。desk 只负责把事件喂进去，打断与守卫在 watch 那一层。
   */
  watch?: WorkerWatch
  /** 探路窗口（`probe.ts`）：desk 只拆不建，装窗口在 `agent/created` 那一刀。 */
  probe?: ProbePort & ProbeRegistry
  /**
   * 票工具的兜底注册（`worker-tools.ts`）：declare / report / touch 按 agent 层
   * 装到 worker 身上，跟档位的 allow 名单无关。desk 只管在派活那两处把手伸过去。
   */
  workerTools?: WorkerToolPort
  config: Partial<DeskConfig> & { defaultPreset: string }
  /** 本机标识，写进 `device`。 */
  device?: string
  warn?: (message: string) => void
}

/** 工具面看到的票：换算在 `tickets/view.ts`，这里原样转出去。 */
export type { TicketView } from './view'

export interface SendReceipt {
  id: string
  status: TicketStatus
  delivered: boolean
  pendingInputs: number
}

export interface ReportReceipt {
  id: string
  epoch: number
  pendingReports: number
}

export interface CloseReceipt {
  id: string
  status: TicketStatus
  /** false = 本来就是终态，这次一个字节都没写。 */
  closed: boolean
  openCount: number
  /** 关票时对账出的越界项（归一化资源串）；没有越界就没有这一栏。 */
  outOfScope?: string[]
}

export interface BlockReceipt {
  id: string
  status: TicketStatus
}

/** 探路声明的回执：写到了哪张票、声明了几个文件几个资源。 */
export interface DeclareReceipt {
  id: string
  status: TicketStatus
  epoch: number
  files: number
  resources: number
}

/** 收尾自报的回执：写到了哪张票、这次报了几条、票上现在一共几条。 */
export interface TouchReceipt {
  id: string
  paths: number
  total: number
}

/** 记一条动作账本的回执：序号和这张票现在一共几条，方便下一条接着记。 */
export interface ActionReceipt {
  id: string
  step: number
  actions: number
  at: string
}

export interface ReadLine {
  id: string
  /** 这张票整段报告里的序号（1 起），不随 limit 变。 */
  n: number
  at: string
  /** 读之前是否已经读过；这次调用之后一律算读过。 */
  read: boolean
  text: string
}

export interface ReadTicket {
  id: string
  goal: string
  brief: string
  status: TicketStatus
  /** 探路/排队阶段位：快路径与老票没有这一栏。 */
  phase?: TicketPhase
  pendingReports: number
  reports: ReadLine[]
  /** 票上的意图（`declared` 折进来）；老票或没交声明就没有这一栏。 */
  intent?: IntentSpec
  /** 探路方案；快路径或老票没有这一栏。 */
  plan?: TicketPlan
  /** 关票时对出来的越界项；没有越界或没对过账就没有这一栏。 */
  outOfScope?: string[]
}

export interface ReadPage {
  tickets: ReadTicket[]
}

export interface MaintainReport {
  /** 这一轮发出去的提醒条数（被抑制的不算）。巡检不写日志，所以只有这一个数。 */
  signals: number
}

/**
 * 巡检由谁驱动：
 * - `interval`：票台自己的定时器（`sweepMs`，默认 10 秒）；
 * - `tick`：外部事件 `dispatcher.sweep.tick`（dsh-timer 的 `schedule` 规则）。
 *
 * 两者只能有一个活着。换源走 `driveSweep`，同一时刻切换，绝不留第二条。
 */
export type SweepSource = 'interval' | 'tick'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 名额满了的拒绝文案：说清是哪个满、各多少张、上限多少。
 *
 * 两本账分开报，绝不把 8 + 4 加成一个 12——执行和排队是两种名额。
 */
function quotaFullText(
  counts: { exec: number; queued: number },
  full: { exec: boolean; queued: boolean },
  limits: { maxExec: number; maxQueued: number },
): string {
  const exec = `正在干 ${counts.exec} 张（上限 ${limits.maxExec}）`
  const queued = `排队 ${counts.queued} 张（上限 ${limits.maxQueued}）`
  const which =
    full.exec && full.queued
      ? '执行和排队名额都满了'
      : full.exec
        ? '执行名额满了'
        : '排队名额满了'
  return `${which}：${exec}，${queued}：${full.exec ? '先关几张再开' : '先等放行再开'}`
}

/** 一条动作摘要的上限：账本是给人扫的，一句说清，别抄整份报告。 */
const ACTION_SUMMARY_MAX = 300

export class TicketDesk {
  private readonly config: DeskConfig
  private readonly log: TicketLog
  private readonly serialize: Serialize
  private readonly clock: Clock
  private readonly registry: WorkerRegistry
  private readonly notifier: OwnerNotifier
  private readonly warn: (message: string) => void
  private readonly device?: string
  /** 提醒指纹：`id:reason:statusSince`。同一轮同一理由只提醒一次。 */
  private readonly reminded = new Map<string, string>()
  /**
   * 见过 idle 的 worker：handleStatus 收下、再派一轮就划掉。
   *
   * 只用来认「worker 空闲」这一种状态，给兜底那行日志和排查用。判「要不要放行」
   * 只看票面 phase=planned，绝不靠这个集合有没有它的名字——探路子会话在降级前已经
   * idle 过的那条路（t-mwgc7327-kc8h 拆掉兜底之后的真死锁），集合里有它也不会再
   * 来第二个 idle 事件，靠它就等于靠一个已经发生过、不会重来的信号。
   */
  private readonly idleSeen = new Set<string>()
  /** 上一轮撤回审计的时刻；`undefined` = 还没跑过。 */
  private lastAuditAt: number | undefined = undefined
  /** 最近一次审计报告（只读把手，给读数和手工核对用）。 */
  private lastRevertAudit: RevertAuditReport | undefined = undefined
  private readonly arbiter: ConflictArbiter
  private attached = false
  private timer: unknown
  /** 上一拍巡检还在 serialize 队列里排队或正在跑：闸着，这一拍直接跳过。 */
  private sweeping = false
  private stopped = false
  /** 当前驱动源。默认自己的定时器；外部 tick 接管时切到 `tick`。 */
  private sweepSource: SweepSource = 'interval'
  /** 每一拍落定后的回调（驱动源探测挂这儿）；抛错不影响巡检。 */
  private readonly pulseWatchers = new Set<() => void>()

  constructor(private readonly deps: DeskDeps) {
    this.config = deskConfig(deps.config)
    this.log = deps.log
    this.serialize = deps.serialize
    this.clock = deps.clock ?? realClock
    this.device = deps.device
    this.warn = deps.warn ?? (() => {})
    this.registry = new WorkerRegistry({
      pool: createWorkerPool({
        subagents: deps.subagents,
        agents: deps.agents ?? (() => undefined),
        warn: this.warn,
      }),
      log: this.log,
    })
    this.arbiter = new ConflictArbiter({
      log: this.log,
      clock: this.clock,
      warn: this.warn,
      commit: (event) => this.commit(event),
    })
    this.notifier =
      deps.notifier ??
      createNotifier({
        quiet: false,
        warn: this.warn,
      })
  }

  // ── 读 ──────────────────────────────────────────────────────────────

  get(id: string): TicketView | undefined {
    const ticket = this.log.get(id)
    return ticket ? this.view(ticket) : undefined
  }

  list(opts: { all?: boolean } = {}): TicketView[] {
    const all = opts.all ?? false
    return this.log
      .list()
      .filter((ticket) => all || isOpen(ticket.status))
      .map((ticket) => this.view(ticket))
  }

  /**
   * 读报告并标记已读。`includeRead` 用来翻历史；默认只给没读过的。
   *
   * 标记已读本身是一条 `delivered` 事件——一条代码路径管到底，不像以前那样
   * 「读」居然是改票。
   */
  async read(
    id?: string,
    opts: { limit?: number; includeRead?: boolean } = {},
  ): Promise<ReadPage> {
    return this.serialize(async () => {
      if (id && !this.log.get(id)) throw new Error(`没有票 ${id}`)
      const limit = Math.max(1, opts.limit ?? 20)
      const includeRead = opts.includeRead ?? false
      // 点名就看那一张（关了也看得到）；不点名只看没结的票——收工票上的报告
      // 得由主会话自己按 id 去取，别让它悄悄把队列读空。
      const tickets = id ? [this.log.get(id)!] : this.log.list().filter((ticket) => isOpen(ticket.status))
      const page: ReadTicket[] = []
      // limit 是这一轮的总预算：点名时给这张票，不点名时跨票分。
      let budget = limit
      for (const ticket of tickets) {
        if (budget <= 0) break
        const unread = pending(ticket.reports)
        const chosen = (includeRead ? ticket.reports : unread).slice(0, budget)
        if (chosen.length === 0) continue
        budget -= chosen.length
        const lines: ReadLine[] = chosen.map((entry) => ({
          id: entry.id,
          // 序号是这张票整段报告里的位置：limit 先取走几条也不把号顶掉。
          n: ticket.reports.findIndex((report) => report.id === entry.id) + 1,
          at: entry.at,
          read: entry.delivered,
          text: entry.text,
        }))
        for (const entry of chosen) {
          if (entry.delivered) continue
          this.commit({
            kind: 'delivered',
            id: ticket.id,
            at: this.at(),
            cause: 'tool',
            entry: { kind: 'report', id: entry.id },
          })
        }
        page.push({
          id: ticket.id,
          goal: ticket.goal,
          brief: briefOf(ticket, this.config.briefMaxColumns),
          status: ticket.status,
          ...(ticket.phase ? { phase: ticket.phase } : {}),
          // 记完账再数：这一轮读走的就不算未读了。
          pendingReports: pending((this.log.get(ticket.id) ?? ticket).reports).length,
          reports: lines,
          ...(ticket.intent ? { intent: ticket.intent } : {}),
          ...(ticket.plan ? { plan: ticket.plan } : {}),
          ...(ticket.outOfScope?.length ? { outOfScope: ticket.outOfScope } : {}),
        })
      }
      return { tickets: page }
    })
  }

  // ── 写 ──────────────────────────────────────────────────────────────

  async open(intent: TicketIntent, actor: Actor): Promise<TicketReceipt> {
    return this.serialize(async () => {
      const goal = intent.goal.trim()
      if (!goal) throw new Error('goal 不能为空')
      const brief = normalizeBrief(intent.brief, this.config.briefMaxColumns)
      const dir = intent.dir?.trim() || undefined
      const tickets = this.log.list()

      // 幂等：同一次调用重放，回执给原票，不 spawn、不调分类器。
      const requestId = intent.requestId?.trim() || undefined
      if (requestId) {
        const same = tickets.find((ticket) => ticket.requestId === requestId)
        if (same) return this.receiptFor(same, true)
      }
      // 疑似重复：同一个人、同一件事、窗口内还没收工。
      const repeat = tickets.find(
        (ticket) =>
          isOpen(ticket.status) &&
          ticket.publisher === actor.sessionId &&
          ticket.goal === goal &&
          (ticket.dir ?? '') === (dir ?? '') &&
          minutesSince(ticket.createdAt, this.clock.now()) <= this.config.repeatWindowMinutes,
      )
      if (repeat) return this.receiptFor(repeat, true)

      const openCount = tickets.filter((ticket) => isOpen(ticket.status)).length
      // 名额拆成两本账：正在干的和排队挂起的分开数，谁满了说谁，不合并成一个总数。
      const execCount = tickets.filter(
        (ticket) => ticket.status === 'running' && ticket.phase !== 'queued',
      ).length
      const queuedCount = tickets.filter((ticket) => ticket.phase === 'queued').length
      const execFull = execCount >= this.config.maxExec
      const queuedFull = queuedCount >= this.config.maxQueued
      if (execFull || queuedFull) {
        throw new Error(
          quotaFullText(
            { exec: execCount, queued: queuedCount },
            { exec: execFull, queued: queuedFull },
            { maxExec: this.config.maxExec, maxQueued: this.config.maxQueued },
          ),
        )
      }

      const parent = this.resolveAgent(actor.sessionId)
      if (!parent) {
        throw new Error(`主会话不在活表里（${actor.sessionId}），派不了活`)
      }

      const decision = await decidePreset({
        presets: this.deps.presets,
        classify: this.deps.classify,
        strategy: this.config.presetStrategy,
        defaultPreset: this.config.defaultPreset,
        // 票一律不继承主会话当前挂的档。子会话的会话档在 spawn 那一刻钉死
        // （`SessionHeader.agentPreset` 是 durable 的，`tools.restrict` 只减
        // 不加），放行后的执行轮是 followup 复用同一个会话，改不了档——那是探路轮
        // 的第二阶段，落成只读档就等于把执行轮的 write / bash / dispatch_touch
        // 一起钉死。主会话当前挂的档是它自己那一轮的事，不该落成这张票的会话档。
        requestPreset: intent.preset,
        goal,
        brief,
        ...(dir ? { dir } : {}),
        sessionId: actor.sessionId,
        classifyTimeoutMs: this.config.classifyTimeoutMs,
        clock: this.clock,
        warn: this.warn,
      })

      // 档定了、票还没建：这是最后一个没有副作用的点。档配不上这活就驳回，
      // 不建票——票是小屏上给人看的，闪一张假票比报错更误导。
      if (this.config.rejectOnMismatch) {
        const rejection = await this.rejectPreset(decision, goal)
        if (rejection) {
          const head = Array.from(goal).slice(0, 40).join('')
          this.warn(
            `[dispatcher] 选档驳回 rule=${rejection.rule} preset=${decision.preset} ` +
              `source=${decision.source} brief=${brief} goal=${head} 原因=${rejection.reason}`,
          )
          throw new PresetRejectedError(rejection)
        }
      }

      const id = newTicketId(this.clock.now())
      return publishTicket({
        id,
        now: this.clock.now(),
        intent: { ...intent, goal, brief },
        brief,
        decision,
        publisher: actor.sessionId,
        parent,
        pool: this.registry.pool,
        commit: (event) => this.commit(event),
        config: {
          provider: this.config.provider,
          maxDepth: this.config.maxDepth,
          ...(this.device ? { device: this.device } : {}),
        },
        openCount,
        ...(this.deps.probe ? { probeWindows: this.deps.probe } : {}),
        ...(this.deps.workerTools ? { workerTools: this.deps.workerTools } : {}),
        // 探路窗口的耐心按毫秒交下去：落 `planning` 那行日志打的就是这个数，
        // 跟 `degradeProbe` 判超时用的是同一个换算，人看日志和实际生效不会差。
        probeTimeoutMs: this.probeTimeoutMs(),
        warn: this.warn,
      })
    })
  }

  /**
   * 给票加一句话并把队列投干净。
   *
   * 终态票直接拒绝，**一个字节都不写**：收工之后再来的消息该走新票，不然
   * 「关掉的票又活过来」会把这套状态机毁掉。
   */
  async send(id: string, text: string, actor?: Actor): Promise<SendReceipt> {
    return this.serialize(async () => {
      const ticket = new TicketHandle(this.log, id).openForSend()
      const body = text.trim()
      if (!body) throw new Error('send 的内容不能为空')

      const entryId = newEntryId(this.clock.now())
      this.commit({
        kind: 'queued',
        id,
        at: this.at(),
        cause: actor?.kind === 'worker' ? 'reaction' : 'tool',
        input: { id: entryId, text: body },
      })
      const delivered = await this.deliverQueued(id)
      const after = this.log.get(id) ?? ticket
      return {
        id,
        status: after.status,
        delivered: delivered > 0,
        pendingInputs: pending(after.inputs).length,
      }
    })
  }

  async report(
    id: string,
    text: string,
    source: 'worker' | 'auto' = 'worker',
    actor?: Actor,
  ): Promise<ReportReceipt> {
    return this.serialize(async () => {
      const body = text.trim()
      if (!body) throw new Error('report 不能为空')
      // 归属校验在写之前：别人的票一个字节都不许落。审计 A10 指的就是这里以前
      // 只收 id、不认人。
      const handle = new TicketHandle(this.log, id)
      if (actor) handle.assertMayReport(actor)
      else handle.current()
      this.appendReport(id, body, source)
      const after = this.log.get(id)!
      return { id, epoch: after.epoch, pendingReports: pending(after.reports).length }
    })
  }

  /**
   * 这个 worker 名下的票，含已结的。
   *
   * `ticketsOf` 是巡检用的私有查找；declare 要按调用者反查归属，读的地方在
   * 工具层，所以单开一个公开口子，别让工具去摸 `log.list()`。
   */
  ticketsOfWork(workerId: string): TicketView[] {
    return this.registry.ticketsOf(workerId).map((ticket) => this.view(ticket))
  }

  /**
   * 热重载/重启后补订阅：活表里已经有这只子会话，但这一份 desk 还没按票给它挂过
   * 订阅。`agent/created` 那一刀会调它，找不到名下的活票就什么也不做。
   */
  adoptWorker(workerId: string | undefined): boolean {
    const watch = this.deps.watch
    if (!watch || !workerId) return false
    const mine = this.registry.ticketsOf(workerId).filter((ticket) => isOpen(ticket.status))
    if (mine.length === 0) return false
    const latest = mine.reduce((best, ticket) => (ticket.updatedAt >= best.updatedAt ? ticket : best))
    return watch.subscribe(latest.id, latest.workerId ?? workerId)
  }

  /**
   * 探路交活：plan 与 intent 一起落成一条 `declared`。
   *
   * 票号**不由调用方给**：按 workerId 反查自己名下那张活票，别人的票写不进来。
   * 查不到票、票已结束都直接报错——reducer 对终态票是静默丢弃，这里静默就等于
   * 让子会话以为声明成功了。
   *
   * 不动 status（设计稿 §7 的红线）：转 planned 仍由主会话的动作写。
   */
  async declare(workerId: string, plan: TicketPlan, intent: IntentSpec): Promise<DeclareReceipt> {
    return this.serialize(async () => {
      const files = (plan.files ?? [])
        .map((file) => {
          const path = file.path.trim()
          const what = file.what?.trim()
          return { path, ...(what ? { what } : {}) }
        })
        .filter((file) => file.path)
      const summary = plan.summary?.trim()
      const resources =
        (intent.impact?.paths?.length ?? 0) +
        (intent.impact?.services?.length ?? 0) +
        (intent.impact?.remotes?.length ?? 0)

      const target = TicketHandle.forWorker(this.log, workerId, '声明').current()

      // 没给的那一栏沿用票上已有的：声明是补充，不是把开票时的意图清空。
      const nextPlan = summary || files.length
        ? { ...(summary ? { summary } : {}), ...(files.length ? { files } : {}) }
        : target.plan ?? {}
      const nextIntent = Object.keys(intent).length > 0 ? intent : target.intent ?? {}
      // 探路是每张票的必经流程，所以声明必须交齐：plan 说清改哪儿，intent 划出
      // 读写边界。少哪一半都不进执行轮——admit 前那道硬校验只认完整的声明。
      if (!summary && files.length === 0) {
        throw new Error('declare 必须给 plan：要改哪几个文件、每个一句话说改什么')
      }
      if (Object.keys(nextIntent).length === 0) {
        throw new Error('declare 必须给 intent：writes / reads 用六个前缀写，再给 reversibility')
      }
      // 新声明先过一遍资源扫描：cmd:/http:/带说明的端口这类串判定层虽然能兜，
      // 但它们不是资源，收进来只会让冲突判定永远按「不认识」处理。历史票不回溯，
      // 这里只拦新的声明。
      const scan = scanResources([...(nextIntent.writes ?? []), ...(nextIntent.reads ?? [])])
      if (scan.invalid.length > 0) {
        const bad = scan.invalid.map((item) => `${item.raw}（${item.reason}）`).join('；')
        throw new Error(
          `声明里的资源串不合法：${bad}。资源只认 file:/…、dir:/…、git:/…、svc:…、port:1-65535、dev:… 六种前缀；` +
            '命令写进 plan.summary，网址写进报告，不要当资源',
        )
      }

      this.commit({
        kind: 'declared',
        id: target.id,
        at: this.at(),
        cause: 'tool',
        plan: nextPlan,
        intent: nextIntent,
        workerId,
      })
      // 重新声明会把 phase 从 queued 折回 planned：排队作废，挂起那条也撤掉。
      this.forgetBlocked(target.id)
      const after = this.log.get(target.id)!
      return {
        id: target.id,
        status: after.status,
        epoch: after.epoch,
        files: files.length,
        resources,
      }
    })
  }

  /**
   * 执行子会话收尾自报：这一轮实际动过的路径。
   *
   * 归属校验跟 declare 一模一样：票号不由调用方给，按 workerId 反查自己名下那张
   * 活票，没票、票已结束都直接报错。路径先过 `normalizeResources`（裸绝对路径
   * 在工具层补好 `file:`），落一条 `touch-reported`；reducer 按首次出现
   * 顺序合并去重，分几次报不会互相覆盖。
   *
   * 不碰 status / statusSince / closedAt：收工的票也允许补记最后一轮。
   */
  async touch(workerId: string, paths: readonly string[]): Promise<TouchReceipt> {
    return this.serialize(async () => {
      const normalized = normalizeResources(paths)
      if (normalized.length === 0) throw new Error('touch 至少要给一个路径')
      const target = TicketHandle.forWorker(this.log, workerId, '报路径').current()
      this.commit({
        kind: 'touch-reported',
        id: target.id,
        at: this.at(),
        cause: 'tool',
        actor: 'worker',
        paths: normalized,
      })
      const after = this.log.get(target.id)!
      return { id: target.id, paths: normalized.length, total: after.touched?.length ?? 0 }
    })
  }

  async block(id: string, reason: string, actor?: Actor): Promise<BlockReceipt> {
    return this.serialize(async () => {
      const handle = new TicketHandle(this.log, id)
      handle.assertRouterCanBlock(actor)
      const ticket = handle.openForBlock()
      const clean = reason.trim()
      if (!clean) throw new Error('block 的理由不能为空')
      if (ticket.status === 'blocked') return { id, status: 'blocked' }
      this.commit({ kind: 'blocked', id, at: this.at(), cause: 'tool', reason: clean })
      // 人工挂起：挂起那刻就往主会话的上下文里放一条。
      this.rememberBlocked(ticket, { reason: clean })
      return { id, status: 'blocked' }
    })
  }

  /**
   * 记一条动作账本：append-only，只追加 `action-logged`，不碰 status。
   *
   * 收工的票也允许补记——最后一步常在关票之后才落笔。`undo` 必须能过
   * `normalizeUndo`（具体命令或具体路径），空话在这里就被挡下，不进日志。
   */
  async logAction(
    id: string,
    input: { summary: string; undo: unknown; step?: number },
    actor: 'main' | 'worker' = 'main',
  ): Promise<ActionReceipt> {
    return this.serialize(async () => {
      const ticket = new TicketHandle(this.log, id).current()
      const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
      if (!summary) throw new Error('summary 不能为空：写清这一步干了什么')
      const length = [...summary].length
      if (length > ACTION_SUMMARY_MAX) {
        throw new Error(`summary 太长（${length} 字）：一句说清，最多 ${ACTION_SUMMARY_MAX} 字`)
      }
      const undo = normalizeUndo(input.undo)
      const last = ticket.actions.reduce((max, action) => Math.max(max, action.step), 0)
      const step = input.step === undefined ? last + 1 : input.step
      if (!Number.isInteger(step) || step < 1) throw new Error('step 必须是正整数（1 起）')
      if (ticket.actions.some((action) => action.step === step)) {
        throw new Error(`票 ${id} 第 ${step} 步已经记过了：省略 step 自动取下一个序号`)
      }
      const at = this.at()
      this.commit({
        kind: 'action-logged',
        id,
        at,
        cause: 'tool',
        ticketId: id,
        actor,
        step,
        summary,
        undo,
      })
      // 回执里的条数从 commit 之后的投影读，别拿 commit 前的快照自己加一。
      return { id, step, actions: this.log.get(id)!.actions.length, at }
    })
  }

  /**
   * 撤回收支审计（只读）。窗口按 `closedAt` 算，默认 `revertAuditDays` 天；
   * 只看 `done` 票，`dropped` 是人主动停的，不算账。
   */
  async auditRevert(opts: { days?: number; now?: Date } = {}): Promise<RevertAuditReport> {
    return this.serialize(async () => this.buildAudit(opts.now ?? this.clock.now(), opts.days))
  }

  /** 最近一次巡检产出的审计报告；还没跑过就是 undefined。 */
  get lastAudit(): RevertAuditReport | undefined {
    return this.lastRevertAudit
  }

  /**
   * 收工的唯一入口。重复调用不写第二行——工具层可能重试，日志不能跟着胖。
   */
  async close(
    id: string,
    opts: { outcome?: 'done' | 'dropped'; note?: string; actor?: Actor } = {},
  ): Promise<CloseReceipt> {
    return this.serialize(async () => {
      const handle = new TicketHandle(this.log, id)
      handle.assertRouterCanClose(opts.actor)
      const ticket = handle.current()
      if (!isOpen(ticket.status)) {
        return { id, status: ticket.status, closed: false, openCount: this.openCount() }
      }
      const outcome = opts.outcome ?? 'done'
      const note = opts.note?.trim()
      const voided = pending(ticket.inputs).length
      // 越界对账（P4）：关票那一刻拿 touched 跟声明的 writes 比，没被覆盖的算越界。
      // 没有声明 writes 就没有边界可比，outOfScopePaths 返回空，不留痕。
      const outOfScope = outOfScopePaths(ticket.touched, ticket.intent?.writes)
      this.commit({
        kind: 'closed',
        id,
        at: this.at(),
        cause: 'tool',
        outcome,
        ...(note ? { note } : {}),
        ...(voided > 0 ? { voidedInputs: voided } : {}),
        ...(outOfScope.length > 0 ? { outOfScope } : {}),
      })
      // 越界不只进回执和票面：推给开票方一句（审计 A8）。best-effort，推不出去
      // 只 warn，不影响关票。
      if (outOfScope.length > 0 && typeof this.deps.notifier?.outOfScope === 'function') {
        try {
          await this.deps.notifier.outOfScope({
            ticketId: id,
            brief: briefOf(ticket, this.config.briefMaxColumns),
            paths: outOfScope,
            ...(ticket.publisher ? { publisher: ticket.publisher } : {}),
          })
        } catch (error) {
          this.warn(`越界提醒没送出去（票 ${id}）：${messageOf(error)}`)
        }
      }
      // 先落盘再收 worker：反过来的话，abort 触发的 ended 可能先到，票还没进终态。
      // 结束通知要赶在 abort 前面，会话还在才推得进去。
      await this.closeWatch(ticket, outcome)
      if (ticket.workerId) await this.registry.abort(ticket.workerId, `票 ${id} 已收工`)
      // 收工了：这张票的挂起提醒不该再挂着（哪怕它本来就是排队票）。
      this.forgetBlocked(id)
      // 收工腾出了资源：排队里的票按开票顺序一审，能走的立刻派执行轮。
      // 放行不写 status（这一批的红线），只把 phase 推到 running。
      await this.releaseBlocked()
      return {
        id,
        status: outcome,
        closed: true,
        openCount: this.openCount(),
        ...(outOfScope.length > 0 ? { outOfScope } : {}),
      }
    })
  }

  // ── 宿主信号 ────────────────────────────────────────────────────────

  /**
   * 订阅宿主事件。幂等：接两次只挂一遍。
   *
   * 订阅失败只 warn：票台还能收工具调用的活，不该因为宿主版本不同就整个不转。
   */
  attach(): void {
    if (this.attached || this.stopped) return
    this.attached = true
    const host = this.deps.host
    if (host) {
      const subscribe = (name: string, handler: (payload: unknown) => Promise<void>) => {
        try {
          host.on(name, (payload: unknown) => {
            void this.react(name, handler, payload)
            return undefined
          })
        } catch (error) {
          this.warn(`${name} 订阅失败：${messageOf(error)}`)
        }
      }
      subscribe('subagent/end', (payload) => this.handleEnd(payload))
      subscribe('agent/status', (payload) => this.handleStatus(payload))
      subscribe('agent/disposed', (payload) => this.handleDisposed(payload))
    }
    this.startInterval()
  }

  /** 跑一拍巡检，直接返回「这一拍有没有真跑」。 */
  pulse(source: SweepSource = 'interval'): boolean {
    if (this.stopped) return false
    // 闸：上一拍还堵在 serialize 队列里（或正在跑）就跳过这一拍，不往队列里堆
    // 空转的 maintain。两条驱动源共用这一个闸——interval 和订阅不可能同时进来。
    if (this.sweeping) return false
    this.sweeping = true
    void this.maintain()
      .catch((error) => this.fail('sweep', undefined, error))
      .finally(() => {
        this.sweeping = false
        for (const watcher of this.pulseWatchers) {
          try {
            watcher()
          } catch (error) {
            this.warn(`sweep 拍后回调失败（${source}）：${messageOf(error)}`)
          }
        }
      })
    return true
  }

  /**
   * 换驱动源。幂等：设成当前源什么都不做；设成 `tick` 立刻停自己的定时器，
   * 设回 `interval` 立刻重新起（`sweepMs` 0 就是不起）。
   */
  driveSweep(source: SweepSource): void {
    if (this.stopped || source === this.sweepSource) return
    this.sweepSource = source
    if (source === 'tick') this.stopInterval()
    else this.startInterval()
  }

  /** 当前谁在驱动巡检。 */
  get sweepDriver(): SweepSource {
    return this.sweepSource
  }

  /** 挂一个「每拍落定后」的回调，返回撤销函数。重复挂同一个函数只算一次。 */
  onPulse(watcher: () => void): () => void {
    this.pulseWatchers.add(watcher)
    return () => {
      this.pulseWatchers.delete(watcher)
    }
  }

  private startInterval(): void {
    if (this.stopped || this.config.sweepMs <= 0 || this.timer !== undefined) return
    if (this.sweepSource !== 'interval') return
    this.timer = this.clock.setInterval(() => {
      this.pulse('interval')
    }, this.config.sweepMs)
  }

  private stopInterval(): void {
    if (this.timer === undefined) return
    this.clock.clearInterval(this.timer)
    this.timer = undefined
  }

  /** 巡检：只看状态、只发信号，不改任何票。 */
  async maintain(): Promise<MaintainReport> {
    return this.serialize(async () => {
      const now = this.clock.now()
      let signals = 0
      for (const ticket of this.log.list()) {
        if (!isOpen(ticket.status)) continue
        // 执行轮 worker 已经不在、事件又没来（重启把 subagent/end 吞了）：巡检
        // 兜底把它落 waiting，别让票挂着 running 占执行名额（审计 A2）。planned
        // 票不在这里处理，它归下面的 admit 兜底重派；planning 票归探路超时。
        if (
          ticket.status === 'running' &&
          (ticket.phase === undefined || ticket.phase === 'running') &&
          ticket.workerId &&
          this.registry.alive(ticket.workerId) === false &&
          minutesSince(ticket.updatedAt, now) >= this.config.freshMinutes
        ) {
          this.commit({
            kind: 'ended',
            id: ticket.id,
            at: this.at(),
            cause: 'lifecycle',
            workerId: ticket.workerId,
            stopReason: 'worker-gone',
            epochReports: ticket.epochReports,
          })
          continue
        }
        // 长等（审计 A1）：排队超过 longWaitMinutes 就把原 worker 放掉，票留在
        // blocked；放行时 startTask 发现 worker 已死会新起一只，首条任务书带 plan。
        // 短等不动 worker——上下文还在，前票一关直接投回同一个会话。
        if (
          ticket.phase === 'queued' &&
          ticket.workerId &&
          minutesSince(ticket.updatedAt, now) >= this.config.longWaitMinutes &&
          this.registry.alive(ticket.workerId) === true
        ) {
          await this.registry.abort(ticket.workerId, `票 ${ticket.id} 排队超过 ${this.config.longWaitMinutes} 分钟，先放掉 worker`)
          this.commit({
            kind: 'ended',
            id: ticket.id,
            at: this.at(),
            cause: 'timer',
            workerId: ticket.workerId,
            stopReason: 'long-wait',
            epochReports: ticket.epochReports,
          })
          this.warn(
            `[dispatcher] 票 ${ticket.id} 排队超过 ${this.config.longWaitMinutes} 分钟，放掉 worker ${ticket.workerId}`,
          )
          continue
        }
        // 探路超时：跟下面三档提醒各走各的。降级那一笔写完就当场 admit（见
        // `degradeProbe`），所以降级成功这张票已经不在 planned 了，这一拍到此为止。
        // 只认 status=running：blocked 是排队、waiting 有人在看，都不是「一轮在跑」。
        if (ticket.status === 'running' && ticket.phase === 'planning') {
          if (await this.degradeProbe(ticket, now)) continue
        } else if (ticket.status === 'running' && ticket.phase === 'planned') {
          // 兜底：票面说「方案就绪、等派活」，就该有人接。不看 idle 事件来没来过
          // ——探路子会话可能在降级之前就已经 idle 过一次，那之后不会再有第二个 idle
          // 事件（t-mwgc7327-kc8h 拆掉空声明兜底之后就是这么死锁的）。判据只有
          // 票面两条：phase=planned 且 declaredAt 在；活没活着由 `startTask` 按
          // `pool.alive` 分：真没了就重起一只，还在就把这一轮 steer 回原会话。
          const current = this.log.get(ticket.id) ?? ticket
          if (await this.admit(current)) {
            this.warn(`[dispatcher] 巡检兜底放行票 ${ticket.id}（${this.registry.describe(ticket)}）`)
            continue
          }
          // admit 没派成：要么落成了 blocked（下一拍按 blocked 那档提醒），要么
          // 派活失败退回了 planned（下一拍接着试）。都不在这里再写票。
        }
        const since = minutesSince(ticket.statusSince, now)

        if (ticket.status === 'waiting' && since >= this.config.waitingMinutes) {
          if (this.signal(ticket, 'waiting-20m', since)) signals += 1
          continue
        }
        if (ticket.status === 'blocked' && since >= this.config.blockedMinutes) {
          if (this.signal(ticket, 'blocked-60m', since)) signals += 1
          continue
        }
        if (
          ticket.status === 'running' &&
          this.config.runningReminderMinutes > 0 &&
          since >= this.config.runningReminderMinutes
        ) {
          if (this.signal(ticket, 'running-90m', since)) signals += 1
        }
      }
      // 漏唤醒兜底（审计 A2）：phase=queued 的票，只要 waitOn 里有一张已经
      // 不在日志、已终态、或者停在 waiting 且 worker 已死，就当场再扫一遍队列。
      // 不等 close 事件——前票被重启掐死时根本不会有 close。
      const staleBlocked = this.log.list().some((ticket) => {
        if (!isOpen(ticket.status) || ticket.phase !== 'queued') return false
        const waitOn = ticket.waitOn ?? []
        if (waitOn.length === 0) return true
        return waitOn.some((wait) => {
          const other = this.log.get(wait.ticketId)
          if (!other || !isOpen(other.status)) return true
          return other.status === 'waiting' && other.workerAlive === false
        })
      })
      if (staleBlocked) signals += (await this.releaseBlocked()).length
      // 撤回审计是独立的一段：只扫窗口内 done 票、只发报告、不改任何票。
      // 不塞进上面那个只扫 open 的循环，也不跟着它的 continue 走。
      this.auditIfDue(now)
      return { signals }
    })
  }

  /** 关台：停定时器、收回所有 worker。之后再 `attach` 不生效。 */
  async dispose(): Promise<void> {
    this.stopped = true
    this.pulseWatchers.clear()
    this.stopInterval()
    await this.registry.abortAll('desk disposed')
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private at(): string {
    return this.clock.now().toISOString()
  }

  private commit(event: TicketEvent): void {
    this.log.commit(event)
    // 票写成了才喂订阅：通知永远挂在「票面已经是这个状态」之后，读到的票和收到
    // 的话不会打架。喂的过程全是 best-effort，不许影响这一笔写（见 `feedWatch`）。
    this.feedWatch(event)
  }

  /**
   * 把刚落的这条票事件转给子会话自己的订阅（`watch.ts`）。
   *
   * 只认几个「票面变了、子会话该知道」的边：`spawned` 订上，`blocked`（人工挂起）
   * 与 `conflict-checked(strong)`（冲突排队）按住它，其余放行边（`resumed` /
   * 投进来一条 message / 弱冲突判定）只解开按住、不发言——那些路径本来就有任务
   * 书或主会话的话送过去，多一句只会让它多跑一轮空转。
   *
   * 整只包了 try/catch：通知这一层出任何岔子，都不该让票写失败、也不该拦住排队。
   */
  private feedWatch(event: TicketEvent): void {
    const watch = this.deps.watch
    if (!watch) return
    const kind = (event as { kind?: unknown }).kind
    if (typeof kind !== 'string') return
    const ticket = this.log.get(event.id)
    const brief = ticket ? briefOf(ticket, this.config.briefMaxColumns) : ''
    try {
      switch (kind) {
        case 'spawned':
          watch.subscribe(event.id, (event as { workerId: string }).workerId)
          return
        case 'blocked':
          void watch.blocked({
            ticketId: event.id,
            brief,
            reason: (event as { reason?: string }).reason ?? '',
          })
          return
        case 'conflict-checked': {
          const verdict = event as { level?: string; waitOn?: ConflictWait[] }
          if (verdict.level === 'strong') {
            void watch.blocked({
              ticketId: event.id,
              brief,
              waitOn: verdict.waitOn ?? [],
            })
          } else {
            // 判完了、任务书马上送过去：先松守卫（票已经不挡了），按住的标记留着，
            // 等 `released` 那一句说清楚再一起撤。
            watch.clear(event.id, { resume: true })
          }
          return
        }
        case 'delivered': {
          // 只有「主会话给子会话发了话」才算放行；报告送达不碰按住状态。
          const entry = (event as { entry?: { kind?: string } }).entry
          if (entry?.kind === 'input') watch.clear(event.id)
          return
        }
        default:
          return
      }
    } catch (error) {
      this.warn(`票 ${event.id} 的状态通知没发出去：${messageOf(error)}`)
    }
  }

  /**
   * 收工前先给这只子会话一句结束通知，再收会话。
   *
   * 顺序不能反：`pool.abort` 会把会话收掉，abort 之后再推就没人接了。通知本身
   * 不抛（`watch.closed` 内部兜住），所以这里等它一下不会拖住票台的判定。
   */
  private async closeWatch(ticket: TicketSnapshot, outcome: 'done' | 'dropped'): Promise<void> {
    const watch = this.deps.watch
    if (!watch || !ticket.workerId) return
    try {
      await watch.closed({
        ticketId: ticket.id,
        brief: briefOf(ticket, this.config.briefMaxColumns),
        outcome,
      })
    } catch (error) {
      this.warn(`票 ${ticket.id} 的结束通知没送到：${messageOf(error)}`)
    }
  }

  private busEmit(channel: string, payload: unknown): void {
    try {
      this.deps.bus?.emit(channel, payload)
    } catch (error) {
      this.warn(`${channel} 发不出去：${messageOf(error)}`)
    }
  }

  private fail(where: string, id: string | undefined, error: unknown): void {
    const message = messageOf(error)
    this.warn(`${where} 失败${id ? `（票 ${id}）` : ''}：${message}`)
    this.busEmit('dispatcher/desk-error', { where, id, message })
  }

  private openCount(): number {
    return this.log.list().filter((ticket) => isOpen(ticket.status)).length
  }

  private buildAudit(now: Date, days = this.config.revertAuditDays): RevertAuditReport {
    return auditClosedTickets(this.log.list(), {
      now,
      days,
      briefOf: (ticket) => briefOf(ticket, this.config.briefMaxColumns),
    })
  }

  /**
   * 巡检里的审计段：按 `revertAuditMs` 节流，只发 `dispatcher/revert-audit`，
   * 不写票、不推手机。每 10 秒扫一遍 800 张 done 票不值当，默认一小时一次。
   */
  private auditIfDue(now: Date): void {
    if (this.config.revertAuditMs <= 0) return
    const last = this.lastAuditAt
    if (last !== undefined && now.getTime() - last < this.config.revertAuditMs) return
    this.lastAuditAt = now.getTime()
    try {
      const report = this.buildAudit(now)
      this.lastRevertAudit = report
      this.busEmit('dispatcher/revert-audit', {
        days: report.days,
        since: report.since,
        scanned: report.scanned,
        findings: report.findings.length,
        text: report.text,
      })
    } catch (error) {
      this.warn(`撤回审计失败：${messageOf(error)}`)
    }
  }

  private view(ticket: TicketSnapshot): TicketView {
    // 换算只此一份（`tickets/view.ts`）：CLI、service、快照文件与工具读数同源。
    return ticketView(ticket, {
      briefMaxColumns: this.config.briefMaxColumns,
      waitingMinutes: this.config.waitingMinutes,
      blockedMinutes: this.config.blockedMinutes,
      now: this.clock.now(),
    })
  }

  private receiptFor(ticket: TicketSnapshot, duplicate: boolean): TicketReceipt {
    return {
      id: ticket.id,
      status: ticket.status,
      ...(ticket.preset ? { preset: ticket.preset } : {}),
      ...(ticket.presetSource ? { presetSource: ticket.presetSource } : {}),
      openCount: this.openCount(),
      ...(duplicate ? { duplicate: ticket.id } : {}),
    }
  }

  /** publisher / worker 的 session id → 活着的 Agent 本体（`sendMessage` 的 sender）。 */
  private resolveAgent(id: string | undefined): unknown {
    if (!id) return undefined
    const agents = this.deps.agents?.()
    if (!agents) return undefined
    const bare = id.replace(/^session-/, '')
    for (const candidate of [id, bare, `session-${bare}`]) {
      const found = agents.get(candidate)
      if (found !== undefined && found !== null) return found
    }
    return undefined
  }

  /**
   * 把队列投干净。一次只投一条、投成功再取下一条：中途失败时剩下的还排在队里，
   * 下一次 idle 或巡检接着投。
   */
  private async deliverQueued(id: string): Promise<number> {
    let delivered = 0
    for (;;) {
      const ticket = this.log.get(id)
      if (!ticket || !isOpen(ticket.status) || !ticket.workerId) return delivered
      const next = pending(ticket.inputs)[0]
      if (!next) return delivered
      const sender = this.resolveAgent(ticket.publisher)
      if (!sender) {
        this.warn(`票 ${id} 的发布会话不在活表（${ticket.publisher ?? '空'}），投不了，先留在队列里`)
        return delivered
      }
      // 只有「真有一轮活在跑」才算 running；waiting/blocked 投递前先记一轮新的。
      const running = ticket.status === 'running' && ticket.workerAlive !== false
      const alive = this.registry.alive(ticket.workerId)
      try {
        const messageId = await this.registry.send(ticket.workerId, sender, next.text)
        if (!running || alive === false) {
          this.commit({
            kind: 'resumed',
            id,
            at: this.at(),
            cause: 'reaction',
            workerId: ticket.workerId,
            messageId,
            epoch: ticket.epoch + 1,
            ...(this.device ? { device: this.device } : {}),
          })
        }
        this.commit({
          kind: 'delivered',
          id,
          at: this.at(),
          cause: 'reaction',
          entry: { kind: 'input', id: next.id },
        })
        delivered += 1
      } catch (error) {
        this.fail('deliver', id, error)
        return delivered
      }
    }
  }

  /** 交报告：append-only，不动状态；`worker` 来源才提醒维护者。 */
  private appendReport(ticketId: string, text: string, source: 'worker' | 'auto'): void {
    const ticket = this.log.get(ticketId)
    if (!ticket) throw new Error(`没有票 ${ticketId}`)
    this.commit({
      kind: 'reported',
      id: ticketId,
      at: this.at(),
      cause: source === 'auto' ? 'reaction' : 'tool',
      report: { id: newEntryId(this.clock.now()), text },
      source,
    })
    if (source !== 'worker') return
    const after = this.log.get(ticketId) ?? ticket
    const pendingReports = pending(after.reports).length
    // 只发摘要：正文在日志里，提醒里再抄一份只会两边不一致。
    this.busEmit('dispatcher/report-arrived', {
      id: ticketId,
      epoch: after.epoch,
      pendingReports,
    })
    void this.notifier
      .reportArrived({
        ticketId,
        brief: briefOf(after, this.config.briefMaxColumns),
        epoch: after.epoch,
        pendingReports,
      })
      .catch((error) => this.warn(`报告提醒没发出去：${messageOf(error)}`))
  }


  private signal(ticket: TicketSnapshot, reason: IdleReason, sinceMinutes: number): boolean {
    // 指纹带 statusSince：同一轮只提醒一次，waiting→running→waiting 能再提醒。
    const fingerprint = `${ticket.id}:${reason}:${ticket.statusSince}`
    if (this.reminded.get(ticket.id) === fingerprint) return false
    this.reminded.set(ticket.id, fingerprint)
    this.busEmit('dispatcher/ticket-idle', {
      id: ticket.id,
      reason,
      sinceMinutes,
      fingerprint,
    })
    void this.notifier
      .idle({
        ticketId: ticket.id,
        brief: briefOf(ticket, this.config.briefMaxColumns),
        reason,
        sinceMinutes,
      })
      .catch((error) => this.warn(`巡检提醒没发出去：${messageOf(error)}`))
    return true
  }

  private emitNoReport(ticketId: string, ticket: TicketSnapshot, stopReason: string): void {
    this.busEmit('dispatcher/ticket-no-report', {
      id: ticketId,
      epoch: ticket.epoch,
      stopReason,
    })
    void this.notifier
      .noReport({
        ticketId,
        brief: briefOf(ticket, this.config.briefMaxColumns),
        epoch: ticket.epoch,
        stopReason,
      })
      .catch((error) => this.warn(`缺报告提醒没发出去：${messageOf(error)}`))
  }

  /**
   * 票挂起那刻记一条巡检事实。
   *
   * 走 facts 不走 followup：主会话下一个回合在 runtime context 里自己看得见。
   * 两处登记（kind 联合、ORDER）都在 `sweep-facts.ts`，漏了会一直挂到 close。
   */
  private rememberBlocked(
    ticket: TicketSnapshot,
    extra: { waitOn?: readonly ConflictWait[]; reason?: string; wake?: boolean } = {},
  ): void {
    // 冲突事实里带上对手的 brief：主会话看见「被谁挡的」不用再翻票。
    const waitOn = extra.waitOn?.map((wait) => {
      const other = this.log.get(wait.ticketId)
      const brief = other ? briefOf(other, this.config.briefMaxColumns) : undefined
      return { ticketId: wait.ticketId, resources: [...wait.resources], ...(brief ? { brief } : {}) }
    })
    void this.notifier
      .blocked({
        ticketId: ticket.id,
        brief: briefOf(ticket, this.config.briefMaxColumns),
        ...(ticket.publisher ? { publisher: ticket.publisher } : {}),
        ...(waitOn?.length ? { waitOn } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
        ...(extra.wake === true ? { wake: true } : {}),
      })
      .catch((error) => this.warn(`挂起提醒没记上：${messageOf(error)}`))
  }

  /** 票放行或收工：把挂起那条摘掉。 */
  private forgetBlocked(ticketId: string): void {
    void this.notifier
      .resumed(ticketId)
      .catch((error) => this.warn(`挂起提醒没摘掉：${messageOf(error)}`))
  }

  /**
   * 冲突排队放行：摘掉挂起事实 + 推开票方一句「轮到它了」。
   *
   * 挡路的票号从票上原来的 `waitOn` 取（这一轮判完 waitOn 已经是空的）；
   * 收工的票还在日志里，brief 不会因为排到它而丢。
   */
  private notifyReleased(ticket: TicketSnapshot): void {
    const releasedBy = (ticket.waitOn ?? []).map((wait) => wait.ticketId)
    this.forgetBlocked(ticket.id)
    // 给被按住的那只子会话一句「已放行」：任务书已经在 `startTask` 里送出去了，
    // 这句排在它后面，被 steer 接在下一个 step 边界，不另起一轮。
    void this.deps.watch
      ?.released({
        ticketId: ticket.id,
        brief: briefOf(ticket, this.config.briefMaxColumns),
        ...(releasedBy.length > 0 ? { releasedBy } : {}),
      })
      .catch((error) => this.warn(`放行通知没送到（票 ${ticket.id}）：${messageOf(error)}`))
    void this.notifier
      .released({
        ticketId: ticket.id,
        brief: briefOf(ticket, this.config.briefMaxColumns),
        ...(ticket.publisher ? { publisher: ticket.publisher } : {}),
        ...(releasedBy.length > 0 ? { releasedBy } : {}),
      })
      .catch((error) => this.warn(`放行提醒没送出去：${messageOf(error)}`))
  }

  /** 宿主信号统一入口：进队列、吞异常——宿主回调里抛错会打断别人的监听。 */
  private async react(
    name: string,
    handler: (payload: unknown) => Promise<void>,
    payload: unknown,
  ): Promise<void> {
    try {
      await this.serialize(() => handler(payload))
    } catch (error) {
      this.fail(name, undefined, error)
    }
  }

  /**
   * 一轮干完。`ended` 之后「干完没交报告」当场判：报告计数冻结在这一轮，
   * 为 0 就补一条（有最后输出时）或发缺报告信号。不靠巡检——巡检会晚 5 分钟，
   * 而且票已经不是 running 了，扫不到。
   */
  private async handleEnd(payload: unknown): Promise<void> {
    const workerId = workerIdOf(payload)
    if (!workerId) return
    const info = (payload ?? {}) as { stopReason?: unknown; lastAssistantMessage?: unknown }
    const stopReason = typeof info.stopReason === 'string' && info.stopReason ? info.stopReason : 'end'
    for (const ticket of this.registry.ticketsOf(workerId)) {
      if (!isOpen(ticket.status) || !ticket.workerId) continue
      const epochReports = ticket.epochReports
      this.commit({
        kind: 'ended',
        id: ticket.id,
        at: this.at(),
        cause: 'lifecycle',
        workerId: ticket.workerId,
        stopReason,
        epochReports,
        ...(this.device ? { device: this.device } : {}),
      })
      // 票台自己打断的那一轮（被挡、关票）不算「干完了」：别把被掐断的半句话
      // 记成报告，也别发「干完没交报告」——那会把主会话往错的方向带。
      if (isInterruptedStop(stopReason)) continue
      if (epochReports > 0) continue
      const last = typeof info.lastAssistantMessage === 'string' ? info.lastAssistantMessage.trim() : ''
      if (this.config.autoReport && last) {
        try {
          this.appendReport(ticket.id, last, 'auto')
        } catch (error) {
          this.fail('autoReport', ticket.id, error)
        }
      } else if (this.config.noReportSignal) {
        this.emitNoReport(ticket.id, this.log.get(ticket.id) ?? ticket, stopReason)
      }
    }
  }

  // ── 冲突判定与排队 ──────────────────────────────────────────────────

  /**
   * 判一张票的档装不装得上这活。返回驳回理由（undefined = 放行）。
   *
   * 开票和「重新 spawn 执行轮」走同一道守卫。守卫本身是纯函数，这里只负责把
   * 注册表和配置递进去，别在两处各写一遍规则。
   */
  private async rejectPreset(decision: PresetDecision, goal: string): Promise<PresetRejection | undefined> {
    const catalog = await this.deps.presets.list()
    const chosen = catalog.find((row) => row.id === decision.preset)
    return checkPresetChoice({
      preset: decision.preset,
      ...(chosen?.name ? { label: chosen.name } : {}),
      ...(decision.needsCommand !== undefined ? { needsCommand: decision.needsCommand } : {}),
      goal,
      allowedPresets: this.config.allowedPresets,
      keywords: this.config.commandKeywords,
      toolsOf: (id) => this.deps.presets.tools(id),
      candidates: catalog.map((row) => row.id),
    })
  }

  /**
   * 派执行轮：探路票收工（或降级）之后，原任务得真的落到一只子会话手上。
   *
   * 原 worker 还在就把这一轮任务书投回**同一个会话**，不再 spawn：`agent/status
   * idle` 只说明这一轮说完了，会话还在活表里；探路那只已经把任务书、目录、声明
   * 都摸过一遍，换一只等于白探（实测 seq 8423 判完冲突、7 ms 后又起了一只新
   * worker，原来那只再没收到过话）。只有活表里真的拿不到它了——ended、服务重启
   * 被 sweep、或者消息投不进去——才重新 spawn。降级轮走同一条路。
   *
   * 档不在这一轮重定：会话的档钉死在 spawn（`dsh-session` 的
   * `SessionHeader.agentPreset` 是 durable 的，`dsh-tools` 的 `restrict` 只减不
   * 加），followup 改不了工具面。所以开票时用的就得是这张票干活的档（见
   * `open`：探路票不吃主会话当前挂的档），探路轮的只读靠探路窗口那三件 deny。
   *
   * 真要 spawn 新的一只时才重新 `decidePreset`，而且必须再过 `rejectPreset`
   * 那道守卫：分类器给出「要命令却没 bash」的档就驳回去，票落 `gated`
   * （status=waiting、note 写驳回理由），等主会话换档或改配置再放，不照派。
   */
  private async startTask(ticket: TicketSnapshot): Promise<boolean> {
    const parent = this.resolveAgent(ticket.publisher)
    if (!parent) {
      this.warn(`票 ${ticket.id} 的发布会话不在活表（${ticket.publisher ?? '空'}），这一轮派不出去`)
      return false
    }
    const brief = briefOf(ticket, this.config.briefMaxColumns)
    const prompt = buildPrompt({
      ticketId: ticket.id,
      goal: ticket.goal,
      brief,
      ...(ticket.dir ? { dir: ticket.dir } : {}),
      epoch: ticket.epoch + 1,
      // 降级票没等到声明：执行轮改走「直接干、干完补一份」那套任务书。
      round: ticket.degraded === true ? 'degraded' : 'task',
      declared: {
        ...(ticket.intent?.writes ? { writes: ticket.intent.writes } : {}),
        ...(ticket.intent?.reads ? { reads: ticket.intent.reads } : {}),
        ...(ticket.intent?.reversibility ? { reversibility: ticket.intent.reversibility } : {}),
        // 方案一起带过去：执行子会话不用拿 goal 重新摸一遍文件（审计 A3）。
        ...(ticket.plan ? { plan: ticket.plan } : {}),
      },
    })

    const workerId = ticket.workerId
    if (workerId && this.registry.alive(workerId) === true) {
      // 续派前先拆探路窗口，跟 handleStatus 那条 idle 路一个口径：巡检兜底捞起
      // 一张 planned 票时，探路子会话可能早就交完声明、idle 事件却丢了（重启、事
      // 件被吞），窗口还挂在它身上。先把只读钳子松开，再投下一句，否则执行轮
      // 手里少 write / edit / bash 三件，只能干看着。
      this.closeProbe(ticket, workerId)
      try {
        const messageId = await this.registry.send(workerId, parent, prompt)
        this.commit({
          kind: 'resumed',
          id: ticket.id,
          at: this.at(),
          cause: 'reaction',
          workerId,
          messageId,
          epoch: ticket.epoch + 1,
          ...(this.device ? { device: this.device } : {}),
        })
        // 老会话的工具面在 spawn 时就装好了（`worker-tools.ts`）；这里再伸一次手
        // 只为了插件热重载后那点漏网：装过就直接返回，不会重复注册。
        this.deps.workerTools?.attach(workerId)
        // 这一轮已经投出去了：它不再是「空闲待派」，等下一次 idle 再记。
        this.registry.clearIdle(workerId)
        return true
      } catch (error) {
        // 活表里还在、话却投不进去：当成真没了，往下走 spawn 那条路。
        this.warn(
          `票 ${ticket.id} 的原 worker（${workerId}）接不住这一轮，改派新的一只：${messageOf(error)}`,
        )
      }
    }

    try {
      const decision = await decidePreset({
        presets: this.deps.presets,
        classify: this.deps.classify,
        strategy: this.config.presetStrategy,
        defaultPreset: this.config.defaultPreset,
        routerPreset: this.deps.routerPreset?.(),
        goal: ticket.goal,
        brief,
        ...(ticket.dir ? { dir: ticket.dir } : {}),
        ...(ticket.publisher ? { sessionId: ticket.publisher } : {}),
        classifyTimeoutMs: this.config.classifyTimeoutMs,
        clock: this.clock,
        warn: this.warn,
      })
      if (this.config.rejectOnMismatch) {
        const rejection = await this.rejectPreset(decision, ticket.goal)
        if (rejection) {
          const head = Array.from(ticket.goal).slice(0, 40).join('')
          this.warn(
            `[dispatcher] 执行轮选档驳回 rule=${rejection.rule} preset=${decision.preset} ` +
              `source=${decision.source} brief=${brief} goal=${head} 原因=${rejection.reason}；` +
              '票挂起等人换档，不照派',
          )
          this.commit({
            kind: 'gated',
            id: ticket.id,
            at: this.at(),
            cause: 'reaction',
            reason: rejection.reason,
          })
          return false
        }
      }
      await startWorker({
        ticketId: ticket.id,
        provider: this.config.provider,
        preset: decision.preset,
        label: buildLabel(ticket.id, brief),
        prompt,
        parent,
        ...(ticket.dir ? { cwd: ticket.dir } : {}),
        ...(this.config.maxDepth ? { maxDepth: this.config.maxDepth } : {}),
        at: this.at(),
        requestId: ticket.requestId ?? ticket.id,
        ...(this.device ? { device: this.device } : {}),
        pool: this.registry.pool,
        commit: (event) => this.commit(event),
        ...(this.deps.workerTools ? { workerTools: this.deps.workerTools } : {}),
        failure: `票 ${ticket.id} 的声明已就绪`,
      })
      return true
    } catch (error) {
      this.fail('dispatch', ticket.id, error)
      return false
    }
  }

  /**
   * 判一次并决定派不派活。返回 true = 这一轮真派出去了。
   *
   * 强冲突只落 `conflict-checked`（phase=queued + waitOn），一个字节的 status
   * 都不写，票停在原地等放行；其余先落判定（phase=running + 弱冲突提示）再派
   * 原任务。派不出去就把 phase 退回 planned——票面不许出现在干活其实没人。
   */
  private async admit(ticket: TicketSnapshot): Promise<boolean> {
    const current = this.log.get(ticket.id) ?? ticket
    if (!isOpen(current.status) || current.phase !== 'planned') return false
    // 硬校验：没有 declared 就不 admit。探路是每张票的必经流程，声明是它的
    // 唯一产物；phase=planned 只由 `declared` 折出来，这里再兜一道——别让将来
    // 任何一条新路径把没声明的票塞进执行轮。
    if (!current.declaredAt) {
      this.warn(`票 ${current.id} 没有声明（没有 declared 事件），不进执行轮`)
      return false
    }
    const verdict = this.arbiter.checkAndRecord(current)
    if (verdict.level === 'strong') {
      const blockedBy = verdict.waitOn.map((wait) => wait.ticketId).join('、')
      this.warn(`票 ${current.id} 撞上 ${blockedBy}，先排队等放行`)
      // 排队的那一刻写进巡检事实，主会话下一轮就能看见在等谁；origin 是 main
      // 的票同时推开票方一句——它就是主会话，在跑的话下一个 step 就收到。
      // ego 提的票只落事实：不把叫人绕过 ego 自己的回合。
      this.rememberBlocked(this.log.get(current.id) ?? current, {
        waitOn: verdict.waitOn,
        wake: (current.origin ?? 'main') !== 'ego',
      })
      return false
    }
    if (!(await this.startTask(current))) {
      this.rollbackPlanned(current)
      return false
    }
    return true
  }

  /**
   * 派活没成：把 phase 退回 `planned`。
   *
   * 复用 `declared` 的折叠（只写 phase / plan / intent / degraded，不碰 status），
   * 所以票面回到「方案就绪、等派活」——这正是设计稿 §11 说的 spawn 失败状态。
   */
  private rollbackPlanned(ticket: TicketSnapshot): void {
    try {
      this.commit({
        kind: 'declared',
        id: ticket.id,
        at: this.at(),
        cause: 'reaction',
        plan: ticket.plan ?? {},
        intent: ticket.intent ?? {},
        ...(ticket.degraded ? { degraded: true } : {}),
      })
    } catch (error) {
      this.fail('rollback', ticket.id, error)
    }
  }

  /**
   * 有票收工了，回头放行排队里的票。
   *
   * FIFO：按 `byClaimOrder`（交声明先后；没声明/同毫秒退回排队序号 `seq`）
   * 扫 `phase === 'queued'`，一张一张来——先放行完这张、让它的 phase 落成
   * running，再判下一张，否则三张票会同时看到「对手已经不在了」一起冲出去。
   * 顺序必须跟判定用同一把尺：按 seq 扫会先把「后声明、票号在前」的那张放
   * 出去，于是真正先声明的反而看着它跑。派不出去就留在队里，等下次收工再试。
   */
  private async releaseBlocked(): Promise<string[]> {
    const released: string[] = []
    const queue = [...this.log.list()].sort(byClaimOrder)
    for (const queued of queue) {
      if (!isOpen(queued.status) || queued.phase !== 'queued') continue
      const current = this.log.get(queued.id)
      if (!current || !isOpen(current.status) || current.phase !== 'queued') continue
      const verdict = this.arbiter.checkAndRecord(current, { onlyIfChanged: true })
      if (verdict.level === 'strong') {
        // 对手换了才重写名单；没变不写，免得每次收工都塞一遍同样的行。
        if (verdict.recorded) {
          this.rememberBlocked(this.log.get(current.id) ?? current, { waitOn: verdict.waitOn })
        }
        continue
      }
      if (!(await this.startTask(current))) {
        this.rollbackPlanned(current)
        continue
      }
      // 放行了：挂起那条从事实里撤掉，再推开票方一句，别让人干等。
      this.notifyReleased(current)
      released.push(current.id)
    }
    return released
  }

  /**
   * 拆探路窗口：探路子会话 idle 下来，只读钳子该松。
   *
   * 纯释放：不补声明、不推 phase。以前这里会给「idle 了但没交声明」的票补一条
   * 空 `declared`，那条就是「不探路也能进执行」的后门——现在声明只能由子会话
   * 自己用 `dispatch_declare` 交，没交就留在 planning，等补声明或巡检超时降级。
   */
  private closeProbe(ticket: TicketSnapshot, sessionId: string): void {
    const probe = this.deps.probe
    if (!probe) return
    probe.release(ticket.workerId ?? sessionId)
  }

  /**
   * 探路超时：票停在 planning 太久，说明这只探路子会话要么没交活要么没了。
   *
   * 不拦巡检——它只是巡检里的一小段。降级的语义是「声明拿不到了」：按整片 dir
   * 当写进兜底（设计稿 §8），票转 planned 并标 degraded，窗口拆掉。
   *
   * 降级写完当场就把这一轮推下去：重取票面、走同一条 `admit`（判冲突 → 没有
   * 冲突就派执行轮）。以前这里只改票面，派活要等那只探路子会话自己回合结束发
   * `agent/status idle`——它要是在降级之前已经 idle 过一次，那之后就再也没有
   * 事件，票永久停 running+planned（今天 8 张票空窗 92 秒到 4 分 54 秒，其中
   * 就有这条路）。所以降级是「拿不到声明」的终点，不是等 idle 的起点。
   *
   * 返回 true = 这张票确实降级了（不管 admit 派没派成，票已经离开 planning）。
   */
  private async degradeProbe(ticket: TicketSnapshot, now: Date): Promise<boolean> {
    const timeoutMs = this.probeTimeoutMs()
    // 毫秒精确：`minutesSince` 把差取整到分钟，92 秒就被四舍五入成 2 分钟判超时。
    // 这里只比毫秒差；时间解析不出来时 NaN 的比较一律 false，宁可晚降级不误降。
    const sinceMs = now.getTime() - Date.parse(ticket.epochStartedAt ?? ticket.statusSince)
    if (!(sinceMs >= timeoutMs)) return false
    const probe = this.deps.probe
    // 窗口没被预期会话领走（身份对不上 / agent/created 压根没来）也算失败：
    // 先让登记那边打日志收账，再照旧走降级，别静默放行带写工具的探路轮。
    probe?.expire?.(ticket.id)
    probe?.releaseTicket(ticket.id)
    try {
      this.commit({
        kind: 'declared',
        id: ticket.id,
        at: this.at(),
        cause: 'timer',
        plan: ticket.plan ?? {},
        intent: ticket.intent ?? {},
        degraded: true,
        ...(ticket.workerId ? { workerId: ticket.workerId } : {}),
      })
    } catch (error) {
      // 降级写不进去只喊一声：巡检不能因为一张票停在 planning 就整拍失败。
      this.warn(`探路降级没写成（票 ${ticket.id}）：${messageOf(error)}`)
      return false
    }
    const current = this.log.get(ticket.id)
    if (!current) return true
    // 当场推进，不等 idle。派不派得成由 admit 判：撞上了就 blocked 排队，
    // 派活失败退回 planned，下一拍巡检兜底接着试。
    await this.admit(current)
    return true
  }

  /**
   * 探路窗口的耐心，毫秒。
   *
   * 配置写分钟（人读的），换算只乘 60000、不做分钟级取整：2 分钟就是 120000ms，
   * 不会被四舍五入提前或者拖后大半分钟。落 `planning` 那行日志打的就是这个数。
   */
  private probeTimeoutMs(): number {
    return Math.max(0, Math.round(this.config.probeTimeoutMinutes * 60_000))
  }

  /**
   * worker 变 idle：票该进 waiting，但先看队列——有排队的话这一轮还没完，
   * 投过去继续干（设计 §4 第 5 行）。投递失败就留在 running，等下一条或巡检。
   */
  private async handleStatus(payload: unknown): Promise<void> {
    const record = (payload ?? {}) as { status?: unknown; agent?: unknown }
    const sessionId = agentIdOf(record.agent)
    if (record.status !== 'idle' || !sessionId) return
    // 记一笔「这只空下来了」，只给兜底的日志和排查用；放行与否不看它（见
    // `idleSeen` 的注释：降级前已经 idle 过的那条路不会再有第二个事件）。
    this.registry.markIdle(sessionId)
    for (const ticket of this.registry.ticketsOf(sessionId)) {
      if (ticket.status !== 'running') continue
      // 探路窗口先拆，再投排队的话：探路子会话 idle 下来就说明它这一轮说完了，
      // 后面投进来的活要能写盘。
      this.closeProbe(ticket, sessionId)
      const current = this.log.get(ticket.id) ?? ticket
      // 探路收工就是判定那一刻：这一轮不是「进 waiting」，而是判冲突然派执行轮。
      // 判输了就排队（phase=queued），status 一个字节都不动，人就停在 idle。
      if (current.phase === 'planned') {
        await this.admit(current)
        continue
      }
      // 探路轮说完了却没交声明：不进执行轮。票留在 planning（status 不动），
      // 等子会话补 declare，或者巡检到点降级；这里不替它补一条空声明。
      if (pending(ticket.inputs).length > 0) {
        const delivered = await this.deliverQueued(ticket.id)
        if (delivered > 0) continue
        // 投不出去：票还是 running，但没有真活在跑。落 waiting 但标记人还在。
      }
      // 这行 continue 不能删（2026-11-14 A7 复查）：没有它就会继续落到下面的
      // `idled`，票变成 status=waiting + phase=planning；而 maintain 的探路降级
      // 只认 status=running && phase=planning，这张票会永久卡住、再没人管。
      if (current.phase === 'planning') continue
      this.commit({
        kind: 'idled',
        id: ticket.id,
        at: this.at(),
        cause: 'lifecycle',
        workerId: ticket.workerId ?? sessionId,
        ...(this.device ? { device: this.device } : {}),
      })
    }
  }

  /**
   * worker 被回收：可能是正常重启（等 freshMinutes 再看），也可能真没了。
   * 不在这里写终态——只把票落成 waiting 并标记人不在。
   */
  private async handleDisposed(payload: unknown): Promise<void> {
    const sessionId = agentIdOf((payload as { agent?: unknown })?.agent)
    if (!sessionId) return
    for (const ticket of this.registry.ticketsOf(sessionId)) {
      if (!isOpen(ticket.status) || !ticket.workerId) continue
      if (minutesSince(ticket.updatedAt, this.clock.now()) < this.config.freshMinutes) continue
      this.commit({
        kind: 'ended',
        id: ticket.id,
        at: this.at(),
        cause: 'lifecycle',
        workerId: ticket.workerId,
        stopReason: 'disposed',
        epochReports: ticket.epochReports,
        ...(this.device ? { device: this.device } : {}),
      })
      this.busEmit('dispatcher/worker-gone', { id: ticket.id, workerId: ticket.workerId })
    }
  }
}

/**
 * 这一轮是不是被「打断」收的：`dsh-agent` 的 turn/end 原因是这几个。
 *
 * 只用来判「要不要补报告」：被打断的一轮不是干完了，硬补一条只会让人误判。
 */
function isInterruptedStop(reason: string): boolean {
  return /^(?:interrupted|aborted|canceled|cancelled)$/i.test(reason)
}

export function createDesk(deps: DeskDeps): TicketDesk {
  return new TicketDesk(deps)
}
