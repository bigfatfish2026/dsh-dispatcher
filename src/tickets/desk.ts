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
import { briefOf, isOpen, minutesSince, pending } from '../store'
import type { Actor, TicketEvent, TicketSnapshot, TicketStatus } from '../store'
import { newEntryId, newTicketId } from '../store/log'
import type { TicketLog } from '../store/log'
import type { Clock } from './clock'
import { realClock } from './clock'
import { createNotifier } from './notify'
import type { IdleReason, OwnerNotifier } from './notify'
import { decidePreset, normalizeBrief, publishTicket } from './publish'
import type { Classifier, PresetCatalog, TicketIntent, TicketReceipt } from './publish'
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

/**
 * 票台自己的配置。刻意不复用插件那份 `Config`：那一份是给工具面读的，改它的
 * 默认值会动到线上行为；这一份只在接线时逐个字段映射过去。
 */
export interface DeskConfig {
  /** 默认档。没有代码默认值：配置和注册表都不给就拒绝开票。 */
  defaultPreset: string
  presetStrategy: 'llm' | 'static'
  classifyTimeoutMs: number
  /** 传给 `startActivation` 的 provider 名。 */
  provider: string
  maxDepth: number
  maxOpen: number
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
  provider: 'spawn',
  maxDepth: 2,
  maxOpen: 8,
  briefMaxColumns: 34,
  waitingMinutes: 20,
  blockedMinutes: 60,
  runningReminderMinutes: 0,
  sweepMs: 10_000,
  freshMinutes: 2,
  autoReport: true,
  noReportSignal: true,
  repeatWindowMinutes: 10,
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
}

export interface BlockReceipt {
  id: string
  status: TicketStatus
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
}

export interface ReadPage {
  tickets: ReadTicket[]
}

export interface MaintainReport {
  /** 这一轮发出去的提醒条数（被抑制的不算）。巡检不写日志，所以只有这一个数。 */
  signals: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
  private attached = false
  private timer: unknown
  /** 上一拍巡检还在 serialize 队列里排队或正在跑：闸着，这一拍直接跳过。 */
  private sweeping = false
  private stopped = false

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
      if (openCount >= this.config.maxOpen) {
        throw new Error(`已经 ${openCount} 张票没收工（上限 ${this.config.maxOpen}）：先关几张再开`)
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
        routerPreset: this.deps.routerPreset?.(),
        requestPreset: intent.preset,
        goal,
        brief,
        ...(dir ? { dir } : {}),
        sessionId: actor.sessionId,
        classifyTimeoutMs: this.config.classifyTimeoutMs,
        clock: this.clock,
        warn: this.warn,
      })

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
      return { id, status: 'blocked' }
    })
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
      this.commit({
        kind: 'closed',
        id,
        at: this.at(),
        cause: 'tool',
        outcome,
        ...(note ? { note } : {}),
        ...(voided > 0 ? { voidedInputs: voided } : {}),
      })
      // 先落盘再收 worker：反过来的话，abort 触发的 ended 可能先到，票还没进终态。
      if (ticket.workerId) await this.pool.abort(ticket.workerId, `票 ${id} 已收工`)
      return { id, status: outcome, closed: true, openCount: this.openCount() }
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
    if (this.config.sweepMs > 0) {
      this.timer = this.clock.setInterval(() => {
        // 闸：上一拍还堵在 serialize 队列里（或正在跑）就跳过这一拍，
        // 不往队列里堆空转的 maintain。
        if (this.sweeping) return
        this.sweeping = true
        void this.maintain()
          .catch((error) => this.fail('sweep', undefined, error))
          .finally(() => {
            this.sweeping = false
          })
      }, this.config.sweepMs)
    }
  }

  /** 巡检：只看状态、只发信号，不改任何票。 */
  async maintain(): Promise<MaintainReport> {
    return this.serialize(async () => {
      const now = this.clock.now()
      let signals = 0
      for (const ticket of this.log.list()) {
        if (!isOpen(ticket.status)) continue
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
      return { signals }
    })
  }

  /** 关台：停定时器、收回所有 worker。之后再 `attach` 不生效。 */
  async dispose(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clock.clearInterval(this.timer)
      this.timer = undefined
    }
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

  /** 交报告：append-only，不动状态；`worker` 来源才提醒主人。 */
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

export function createDesk(deps: DeskDeps): TicketDesk {
  return new TicketDesk(deps)
}
