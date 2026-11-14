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
  TicketPlan,
  TicketSnapshot,
  TicketStatus,
} from '../store'
import { newEntryId, newTicketId } from '../store/log'
import type { TicketLog } from '../store/log'
import type { Clock } from './clock'
import { realClock } from './clock'
import { createNotifier } from './notify'
import type { IdleReason, OwnerNotifier } from './notify'
import { judgeConflict, outOfScopePaths } from './conflict'
import type { ConflictLevel, ConflictSide } from './conflict'
import { normalizeResources } from './resources'
import { buildLabel, buildPrompt, decidePreset, normalizeBrief, publishTicket, startWorker } from './publish'
import type { ProbePort, ProbeRegistry } from './probe'
import type { WorkerToolPort } from './worker-tools'
import type { Classifier, PresetCatalog, PresetDecision, TicketIntent, TicketReceipt } from './publish'
import { checkPresetChoice, DEFAULT_COMMAND_KEYWORDS, PresetRejectedError } from './preset-guard'
import type { PresetRejection } from './preset-guard'
import { auditClosedTickets, checkRevertIntent, normalizeUndo, REVERT_AUDIT_DAYS, RevertRejectedError } from './revert'
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
export type {
  RevertAuditFinding,
  RevertAuditKind,
  RevertAuditReport,
  RevertGateCode,
  RevertGateDecision,
} from './revert'

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
   * 同时干活的票上限：只数 `status === 'running' && phase !== 'blocked'` 的票。
   *
   * 名额拆成两个独立计数后这里只管执行；排队另有 `maxQueued`。老配置里的
   * `maxOpen` 仍能加载，但不再参与计数（按默认 8 处理）。
   */
  maxExec: number
  /** 同时排队的票上限：只数 `phase === 'blocked'` 的票（挂起等放行）。 */
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
  classifyTimeoutMs: 8000,
  allowedPresets: [],
  commandKeywords: DEFAULT_COMMAND_KEYWORDS,
  rejectOnMismatch: true,
  provider: 'spawn',
  maxDepth: 2,
  maxExec: 8,
  maxQueued: 4,
  briefMaxColumns: 34,
  waitingMinutes: 20,
  blockedMinutes: 60,
  runningReminderMinutes: 0,
  sweepMs: 10_000,
  freshMinutes: 2,
  autoReport: true,
  noReportSignal: true,
  repeatWindowMinutes: 10,
  revertAuditDays: REVERT_AUDIT_DAYS,
  revertAuditMs: 60 * 60 * 1000,
  probeTimeoutMinutes: 2,
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
  pendingReports: number
  reports: ReadLine[]
  /** 建票意图；老票没有这一栏。 */
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
  private readonly pool: WorkerPool
  private readonly notifier: OwnerNotifier
  private readonly warn: (message: string) => void
  private readonly device?: string
  /** 提醒指纹：`id:reason:statusSince`。同一轮同一理由只提醒一次。 */
  private readonly reminded = new Map<string, string>()
  /** 上一轮撤回审计的时刻；`undefined` = 还没跑过。 */
  private lastAuditAt: number | undefined = undefined
  /** 最近一次审计报告（只读把手，给读数和手工核对用）。 */
  private lastRevertAudit: RevertAuditReport | undefined = undefined
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
    this.pool = createWorkerPool({
      subagents: deps.subagents,
      agents: deps.agents ?? (() => undefined),
      warn: this.warn,
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

      // 分级闸：只对带 intent 的票生效，老票 / 老调用原样放行。拒绝在这里、
      // 在名额和分类器之前——被拒的票一个字节都不写。
      const gate = checkRevertIntent({ origin: intent.origin, intent: intent.intent })
      if (gate.action === 'reject') {
        const head = Array.from(goal).slice(0, 40).join('')
        this.warn(
          `[dispatcher] 撤回闸驳回 code=${gate.code} origin=${intent.origin ?? 'main'} brief=${brief} goal=${head} 原因=${gate.reason}`,
        )
        throw new RevertRejectedError(gate.code, gate.reason)
      }
      const hold = gate.action === 'downgrade' ? gate.reason : undefined

      const openCount = tickets.filter((ticket) => isOpen(ticket.status)).length
      // 名额拆成两本账：正在干的和排队挂起的分开数，谁满了说谁，不合并成一个总数。
      const execCount = tickets.filter(
        (ticket) => ticket.status === 'running' && ticket.phase !== 'blocked',
      ).length
      const queuedCount = tickets.filter((ticket) => ticket.phase === 'blocked').length
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
        // 探路票不继承主会话当前挂的档。子会话的会话档在 spawn 那一刻钉死
        // （`SessionHeader.agentPreset` 是 durable 的，`tools.restrict` 只减
        // 不加），放行后的执行轮是 followup 复用同一个会话，改不了档——探路轮
        // 落成只读档就等于把执行轮的 write / bash / dispatch_touch 一起钉死。
        // 主会话当前挂的档是它自己那一轮的事，不该落成这张票的会话档。
        ...(intent.probe === true ? {} : { routerPreset: this.deps.routerPreset?.() }),
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
        pool: this.pool,
        commit: (event) => this.commit(event),
        config: {
          provider: this.config.provider,
          maxDepth: this.config.maxDepth,
          ...(this.device ? { device: this.device } : {}),
        },
        openCount,
        ...(hold ? { hold } : {}),
        ...(this.deps.probe ? { probeWindows: this.deps.probe } : {}),
        ...(this.deps.workerTools ? { workerTools: this.deps.workerTools } : {}),
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
      const ticket = this.log.get(id)
      if (!ticket) throw new Error(`没有票 ${id}`)
      if (!isOpen(ticket.status)) {
        throw new Error(`票 ${id} 已收工，要接着干就开新票`)
      }
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

  async report(id: string, text: string, source: 'worker' | 'auto' = 'worker'): Promise<ReportReceipt> {
    return this.serialize(async () => {
      const body = text.trim()
      if (!body) throw new Error('report 不能为空')
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
    return this.ticketsOf(workerId).map((ticket) => this.view(ticket))
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
      if (!summary && files.length === 0 && resources === 0) {
        throw new Error('declare 至少要给 plan 或 intent：空声明没法判定')
      }

      const target = this.liveTicketOf(workerId, '声明')

      // 没给的那一栏沿用票上已有的：声明是补充，不是把开票时的意图清空。
      const nextPlan = summary || files.length
        ? { ...(summary ? { summary } : {}), ...(files.length ? { files } : {}) }
        : target.plan ?? {}
      const nextIntent = Object.keys(intent).length > 0 ? intent : target.intent ?? {}

      this.commit({
        kind: 'declared',
        id: target.id,
        at: this.at(),
        cause: 'tool',
        plan: nextPlan,
        intent: nextIntent,
        workerId,
      })
      // 重新声明会把 phase 从 blocked 折回 planned：排队作废，挂起那条也撤掉。
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
      const target = this.liveTicketOf(workerId, '报路径')
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
      if (actor?.kind === 'worker') throw new Error('worker 不能改票的状态：只能交报告')
      const ticket = this.log.get(id)
      if (!ticket) throw new Error(`没有票 ${id}`)
      if (!isOpen(ticket.status)) throw new Error(`票 ${id} 已经 ${ticket.status} 了`)
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
      const ticket = this.log.get(id)
      if (!ticket) throw new Error(`没有票 ${id}`)
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
      if (opts.actor?.kind === 'worker') throw new Error('worker 不能收工：交报告，让主会话关票')
      const ticket = this.log.get(id)
      if (!ticket) throw new Error(`没有票 ${id}`)
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
      // 先落盘再收 worker：反过来的话，abort 触发的 ended 可能先到，票还没进终态。
      if (ticket.workerId) await this.pool.abort(ticket.workerId, `票 ${id} 已收工`)
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
        // 探路超时：跟下面三档提醒各走各的，降级完这一张票就不再扫了。
        if (ticket.phase === 'planning' && this.degradeProbe(ticket, now)) continue
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
    await this.pool.abortAll('desk disposed')
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private at(): string {
    return this.clock.now().toISOString()
  }

  private commit(event: TicketEvent): void {
    this.log.commit(event)
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
      const alive = this.pool.alive(ticket.workerId)
      try {
        const messageId = await this.pool.send(ticket.workerId, sender, next.text)
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

  private ticketsOf(workerId: string): TicketSnapshot[] {
    return this.log
      .list()
      .filter((ticket) => ticket.workerId !== undefined && isSameWorker(ticket.workerId, workerId))
  }

  /**
   * 按 workerId 反查自己名下那张活票。declare 与 touch 共用：票号不由调用方给，
   * 别人的票写不进来；没票、票已结束都直接报错，别让子会话以为写成功了。
   */
  private liveTicketOf(workerId: string, verb: string): TicketSnapshot {
    const mine = this.ticketsOf(workerId)
    if (mine.length === 0) throw new Error('没有挂在这个 worker 上的票')
    const live = mine.filter((ticket) => isOpen(ticket.status))
    if (live.length === 0) {
      // 拿最近那张的号说清楚是哪张结束了，别只回一句「不行」。
      const last = mine.reduce((best, ticket) => (ticket.updatedAt >= best.updatedAt ? ticket : best))
      throw new Error(`票 ${last.id} 已结束（${last.status}），不能再${verb}`)
    }
    // 一张 worker 名下正常情况下只有一张活票；多张时取最近动过的那张，并在
    // 回执里带票号，别让子会话猜自己刚写到哪张上。
    return live.reduce((best, ticket) => (ticket.updatedAt >= best.updatedAt ? ticket : best))
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
    extra: { waitOn?: readonly ConflictWait[]; reason?: string } = {},
  ): void {
    void this.notifier
      .blocked({
        ticketId: ticket.id,
        brief: briefOf(ticket, this.config.briefMaxColumns),
        ...(extra.waitOn?.length ? { waitOn: extra.waitOn } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
      })
      .catch((error) => this.warn(`挂起提醒没记上：${messageOf(error)}`))
  }

  /** 票放行或收工：把挂起那条摘掉。 */
  private forgetBlocked(ticketId: string): void {
    void this.notifier
      .resumed(ticketId)
      .catch((error) => this.warn(`挂起提醒没摘掉：${messageOf(error)}`))
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
    for (const ticket of this.ticketsOf(workerId)) {
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
   * 这张票在判定里长什么样。
   *
   * 声明里的 writes/reads 原样用。只有降级票（`degraded`：探路超时，声明没等到）
   * 才按设计稿 §8 兜底：拿 `plan.files` 的父目录，连 plan 都没有才拿票的 dir
   * 整片算写——它没声明清楚，不能当「不冲突」。
   *
   * 正常的票 writes 空就是纯读票：reads 里有什么只按只读算，不许顶成写。验证票
   * 读一份文档却被判成写整片目录、跟别人撞上排队，就是这里以前无条件兜底造成的。
   */
  private conflictSide(ticket: TicketSnapshot): ConflictSide {
    const writes = [...(ticket.intent?.writes ?? [])]
    const reads = [...(ticket.intent?.reads ?? [])]
    if (ticket.degraded === true && writes.length === 0) {
      for (const file of ticket.plan?.files ?? []) {
        const parent = dirname(file.path)
        const uri = `dir:${parent}`
        if (parent && parent !== '.' && !writes.includes(uri)) writes.push(uri)
      }
      if (writes.length === 0 && ticket.dir) writes.push(`dir:${ticket.dir}`)
    }
    return { writes, reads }
  }

  /**
   * 拿这张票去撞现在所有没收工的票（自己不算）。
   *
   * 强冲突按排队序号（`seq` 升序，就是开票先后）记 `{ ticketId, resources }`，
   * 弱冲突只留票号：前者拦、后者只是票面上一行提示。判定本身是纯函数，这里只管
   * 挑对手和汇总；同一张对手票只记一次。没有 seq 的老票仍按 createdAt / id 排，
   * 见 `store/log.ts` 的 `byQueueOrder`。
   *
   * 排在自己**后面**的排队票不算阻塞：它在等我先走（FIFO）。排在前面的排队票
   * 照样拦——前排没放行，后面的不许抢跑。放行那条路靠这一条做到「依次放行」。
   */
  private judgeTicket(ticket: TicketSnapshot): {
    level: ConflictLevel
    waitOn: ConflictWait[]
    weak: string[]
  } {
    const all = this.log.list()
    const mine = this.conflictSide(ticket)
    const myIndex = all.findIndex((row) => row.id === ticket.id)
    const waitOn: ConflictWait[] = []
    const weak: string[] = []
    let strong = false
    for (const [index, other] of all.entries()) {
      if (other.id === ticket.id || !isOpen(other.status)) continue
      if (other.phase === 'blocked' && index > myIndex) continue
      const verdict = judgeConflict(mine, this.conflictSide(other))
      if (verdict.level === 'none') continue
      if (verdict.level === 'strong') {
        strong = true
        waitOn.push({ ticketId: other.id, resources: [...verdict.resources] })
      } else if (!weak.includes(other.id)) {
        weak.push(other.id)
      }
    }
    return { level: strong ? 'strong' : weak.length > 0 ? 'weak' : 'none', waitOn, weak }
  }

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
      },
    })

    const workerId = ticket.workerId
    if (workerId && this.pool.alive(workerId) === true) {
      // 续派前先拆探路窗口，跟 handleStatus 那条 idle 路一个口径：巡检兜底捞起
      // 一张 planned 票时，探路子会话可能早就交完声明、idle 事件却丢了（重启、事
      // 件被吞），窗口还挂在它身上。先把只读钳子松开，再投下一句，否则执行轮
      // 手里少 write / edit / bash 三件，只能干看着。
      this.closeProbe(ticket, workerId)
      try {
        const messageId = await this.pool.send(workerId, parent, prompt)
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
        pool: this.pool,
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
   * 强冲突只落 `conflict-checked`（phase=blocked + waitOn），一个字节的 status
   * 都不写，票停在原地等放行；其余先落判定（phase=running + 弱冲突提示）再派
   * 原任务。派不出去就把 phase 退回 planned——票面不许出现在干活其实没人。
   */
  private async admit(ticket: TicketSnapshot): Promise<boolean> {
    const current = this.log.get(ticket.id) ?? ticket
    if (!isOpen(current.status) || current.phase !== 'planned') return false
    const verdict = this.judgeTicket(current)
    if (verdict.level === 'strong') {
      this.commit({
        kind: 'conflict-checked',
        id: current.id,
        at: this.at(),
        cause: 'reaction',
        level: 'strong',
        waitOn: verdict.waitOn,
        ...(verdict.weak.length > 0 ? { weak: verdict.weak } : {}),
      })
      const blockedBy = verdict.waitOn.map((wait) => wait.ticketId).join('、')
      this.warn(`票 ${current.id} 撞上 ${blockedBy}，先排队等放行`)
      // 排队的那一刻写进巡检事实，主会话下一轮就能看见在等谁。
      this.rememberBlocked(this.log.get(current.id) ?? current, { waitOn: verdict.waitOn })
      return false
    }
    this.commit({
      kind: 'conflict-checked',
      id: current.id,
      at: this.at(),
      cause: 'reaction',
      level: verdict.level,
      waitOn: [],
      ...(verdict.weak.length > 0 ? { weak: verdict.weak } : {}),
    })
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
   * FIFO：按排队序号 `seq` 升序（就是开票先后；老票按 createdAt / id）扫
   * `phase === 'blocked'`，一张一张来——先放行完这张、让它的 phase 落成
   * running，再判下一张，否则三张票会同时看到「对手已经不在了」一起冲出去。
   * 派不出去就留在队里，等下次收工再试。
   */
  private async releaseBlocked(): Promise<string[]> {
    const released: string[] = []
    for (const queued of this.log.list()) {
      if (!isOpen(queued.status) || queued.phase !== 'blocked') continue
      const current = this.log.get(queued.id)
      if (!current || !isOpen(current.status) || current.phase !== 'blocked') continue
      const verdict = this.judgeTicket(current)
      if (verdict.level === 'strong') {
        // 排队的对手换了（收工前又开了新的票占同一片）：重写名单；没变就不写，
        // 不然每次收工都往日志里塞一遍同样的行。
        if (!sameWait(current.waitOn ?? [], verdict.waitOn)) {
          this.commit({
            kind: 'conflict-checked',
            id: current.id,
            at: this.at(),
            cause: 'reaction',
            level: 'strong',
            waitOn: verdict.waitOn,
            ...(verdict.weak.length > 0 ? { weak: verdict.weak } : {}),
          })
          // 对手换了：事实里的名单跟着换，不另起一条。
          this.rememberBlocked(this.log.get(current.id) ?? current, { waitOn: verdict.waitOn })
        }
        continue
      }
      this.commit({
        kind: 'conflict-checked',
        id: current.id,
        at: this.at(),
        cause: 'reaction',
        level: verdict.level,
        waitOn: [],
        ...(verdict.weak.length > 0 ? { weak: verdict.weak } : {}),
      })
      if (!(await this.startTask(current))) {
        this.rollbackPlanned(current)
        continue
      }
      // 放行了：挂起那条从事实里撤掉，别让它一直挂在主会话的上下文里。
      this.forgetBlocked(current.id)
      released.push(current.id)
    }
    return released
  }

  /**
   * 拆探路窗口：探路子会话 idle 下来，只读钳子该松。
   *
   * 纯释放——除了「票还停在 planning」时补一条空声明，不写别的东西：交过声明
   * 的票（phase 已是 planned）这里一个字节都不落。补声明的 plan/intent 照抄票上
   * 的（没有就是空对象），因为 idle 只说明「这一轮说完了」，没说清方案是什么。
   */
  private closeProbe(ticket: TicketSnapshot, sessionId: string): void {
    const probe = this.deps.probe
    if (!probe) return
    probe.release(ticket.workerId ?? sessionId)
    if (ticket.phase !== 'planning') return
    const current = this.log.get(ticket.id) ?? ticket
    // 这中间可能已经被别人的 commit 转成 planned（比如子会话刚交了声明）：再查一次。
    if (current.phase !== 'planning') return
    this.commit({
      kind: 'declared',
      id: current.id,
      at: this.at(),
      cause: 'lifecycle',
      plan: current.plan ?? {},
      intent: current.intent ?? {},
      workerId: current.workerId ?? sessionId,
    })
  }

  /**
   * 探路超时：票停在 planning 太久，说明这只探路子会话要么没交活要么没了。
   *
   * 不拦巡检——它只是巡检里的一小段。降级的语义是「声明拿不到了」：按整片 dir
   * 当写进兜底（设计稿 §8），票转 planned 并标 degraded，窗口拆掉；执行轮照常
   * 由主会话的动作推进。
   */
  private degradeProbe(ticket: TicketSnapshot, now: Date): boolean {
    const since = minutesSince(ticket.epochStartedAt ?? ticket.statusSince, now)
    if (since < this.config.probeTimeoutMinutes) return false
    const probe = this.deps.probe
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
    return true
  }

  /**
   * worker 变 idle：票该进 waiting，但先看队列——有排队的话这一轮还没完，
   * 投过去继续干（设计 §4 第 5 行）。投递失败就留在 running，等下一条或巡检。
   */
  private async handleStatus(payload: unknown): Promise<void> {
    const record = (payload ?? {}) as { status?: unknown; agent?: unknown }
    const sessionId = agentIdOf(record.agent)
    if (record.status !== 'idle' || !sessionId) return
    for (const ticket of this.ticketsOf(sessionId)) {
      if (ticket.status !== 'running') continue
      // 探路窗口先拆，再投排队的话：探路子会话 idle 下来就说明它这一轮说完了，
      // 后面投进来的活要能写盘。拆窗口本身不碰 status，票还在 planning 才补声明。
      this.closeProbe(ticket, sessionId)
      const current = this.log.get(ticket.id) ?? ticket
      // 探路收工就是判定那一刻：这一轮不是「进 waiting」，而是判冲突然派执行轮。
      // 判输了就排队（phase=blocked），status 一个字节都不动，人就停在 idle。
      if (current.phase === 'planned') {
        await this.admit(current)
        continue
      }
      if (pending(ticket.inputs).length > 0) {
        const delivered = await this.deliverQueued(ticket.id)
        if (delivered > 0) continue
        // 投不出去：票还是 running，但没有真活在跑。落 waiting 但标记人还在。
      }
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
    for (const ticket of this.ticketsOf(sessionId)) {
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

/** 排队名单有没有变：没变就不重复写日志（每次收工都会重扫一遍）。 */
function sameWait(a: readonly ConflictWait[], b: readonly ConflictWait[]): boolean {
  if (a.length !== b.length) return false
  return a.every((wait, i) => {
    const other = b[i]
    return wait.ticketId === other.ticketId && wait.resources.join('\n') === other.resources.join('\n')
  })
}

export function createDesk(deps: DeskDeps): TicketDesk {
  return new TicketDesk(deps)
}
