/**
 * 票日志的事件模型：一行就是一条事件，事件折成票。
 *
 * 这一层只有类型、类型守卫和「一行是哪一类事件」的判定；不认识时间、
 * 不认识 IO，也不认识 TicketDesk。折叠在 `reducer.ts`，落盘与投影在 `log.ts`。
 *
 * 2026-11-04 起事件是带 `kind` 的判别联合（设计文档 §2/§3.1）。2026-11-04 之前
 * 写的行没有 `kind`：它们仍是合法事件，由 `legacyKindOf` 归类、由 reducer 里
 * 那条原封不动的老折叠路径读。两种行共存是常态，不是过渡期的脏数据。
 */

export type TicketStatus = 'open' | 'running' | 'waiting' | 'blocked' | 'done' | 'dropped'

/** 谁下的命令。`sessionId` 是持久会话 id，desk 用它查活表拿到 Agent 本体。 */
export interface Actor {
  kind: 'main' | 'worker'
  sessionId: string
}

/**
 * 这个档是谁定的：主会话自己挂了档（可选探测命中）/ 分类器判定 / 回落配置里的
 * 默认档。`'fallback'` 是常态，不是错误——主会话平时不挂档。
 */
export type PresetSource = 'router' | 'llm' | 'fallback'

export type EntryKind = 'input' | 'report'

/**
 * One message waiting for a worker, or one report a worker handed back. Both
 * are durable: the queue survives a restart, which is the point of keeping it
 * in the log instead of in the session that happened to be alive.
 */
export interface TicketEntry {
  id: string
  at: string
  text: string
  delivered: boolean
  deliveredAt?: string
  /**
   * 落终态时被作废的排队消息：不再投、也不再当「关票后又来了消息」的理由。
   * 只有 `closed` 事件写得出来；老日志里没有这个键。
   */
  voided?: boolean
}

/** One ticket as the tools and the model see it: a fold of its events. */
export interface TicketSnapshot {
  id: string
  goal: string
  /**
   * One-line summary of the goal, for the little screen's second line: at most
   * `BRIEF_MAX_COLUMNS` character columns. Optional because tickets written before
   * 2026-11-02 have no such field — readers fall back to `briefOf()`, which
   * derives the same thing from `goal`.
   */
  brief?: string
  status: TicketStatus
  dir?: string
  note?: string
  /**
   * Human label for the worker (what the little screen shows). 老票里是
   * `t4 查qqbot PR`；新票不再要求调用方写它，由 desk 按档名 + goal 生成。
   */
  owner?: string
  /**
   * The worker's session id as the old `spawn` flow returned it (uuid, optionally
   * with a `session-` prefix). 老票的归属依据；新票一律用 `workerId`。
   */
  ownerId?: string
  createdAt: string
  updatedAt: string
  /**
   * When the ticket last ended (done or dropped), in the log's own time; unset
   * while it is open again.
   */
  closedAt?: string
  /** Messages queued for the worker, oldest first. */
  inputs: TicketEntry[]
  /** Reports the worker handed back, oldest first. */
  reports: TicketEntry[]
  /**
   * 进入当前状态的时刻。20 分钟 / 60 分钟两档提醒按它算，也当提醒指纹：同一轮
   * waiting 只提醒一次，waiting→running→waiting 之后自然能再提醒一次。
   */
  statusSince: string
  /** spawn 返回的 childId，新模型下唯一的归属依据；老票没有。 */
  workerId?: string
  /** 这条活在哪台机器上干：现在恒为本机 id，跨设备预留。 */
  device?: string
  /** 只是标记不是状态：仅 waiting/blocked 有意义，老日志推不出来是 undefined。 */
  workerAlive?: boolean
  /** 定下的档名（t0..t5，来自 profile 的 preset 行）。 */
  preset?: string
  presetSource?: PresetSource
  /** 分类器给的一句理由，只给人看。 */
  presetWhy?: string
  /** 建票那次调用的 requestId（= exec.callId），重复调用靠它认出自己。 */
  requestId?: string
  /**
   * 发布的会话 id。desk 投递时要拿它从活表换成 Agent 本体（`sendMessage` 的
   * sender 必须是活着的那个 Agent）；设计文档第 2 节的接口漏了这一栏，代码里
   * 必须有，不然冷启动投递没有合法的 sender。
   */
  publisher?: string
  /** 第几次派活：spawned / resumed 各 +1。老票一律 0。 */
  epoch: number
  /** 本 epoch 的报告条数；ended 时冻结，resumed 时归零。 */
  epochReports: number
  /** 这个 epoch 是什么时候开的。 */
  epochStartedAt?: string
}

/**
 * 冻结 fixture 用的老形状：新字段一个都没有。
 *
 * 等价性测试拿它只对老字段；新字段（statusSince / epoch / …）单独断言。这样
 * 「老行为不许变」和「新字段怎么折」不会互相绑死——前者零容忍，后者可以改。
 */
export type LegacyTicketSnapshot = Omit<
  TicketSnapshot,
  | 'statusSince'
  | 'workerId'
  | 'device'
  | 'workerAlive'
  | 'preset'
  | 'presetSource'
  | 'presetWhy'
  | 'requestId'
  | 'publisher'
  | 'epoch'
  | 'epochReports'
  | 'epochStartedAt'
>

/** 每条落盘事件的公共栏。 */
export interface EventBase {
  kind: string
  id: string
  at: string
  /** 什么引起的（`tool` / `lifecycle` / `timer` / `reaction`），诊断用。 */
  cause?: string
}

/** 建票：先落这一行，再去 spawn。spawn 失败时票还在、原因写得进去。 */
export interface Published extends EventBase {
  kind: 'published'
  goal: string
  brief: string
  dir?: string
  publisher: string
  preset: string
  presetSource: PresetSource
  presetWhy?: string
  requestId: string
  device?: string
}

/** spawn 履约：workerId 是 spawn 返回的 childId，唯一归属依据。 */
export interface Spawned extends EventBase {
  kind: 'spawned'
  workerId: string
  provider: string
  preset: string
  device?: string
  label?: string
  messageId?: string
}

/** spawn 没履约：票停在 open，原因写进 note。 */
export interface SpawnFailed extends EventBase {
  kind: 'spawn-failed'
  requestId: string
  code?: string
  reason: string
}

/** 小鱼结束了（这一轮干完）：票进 waiting，workerAlive=false。 */
export interface Ended extends EventBase {
  kind: 'ended'
  workerId: string
  device?: string
  stopReason: string
  epochReports: number
}

/** 小鱼这一轮干完但人还在：票进 waiting，workerAlive=true。 */
export interface Idled extends EventBase {
  kind: 'idled'
  workerId: string
  device?: string
}

/** 又派了一轮：票回 running，epoch+1、epochReports 归零。票号不变。 */
export interface Resumed extends EventBase {
  kind: 'resumed'
  workerId: string
  device?: string
  messageId?: string
  epoch: number
}

/** 一条消息排队（还没投到子会话 inbox）。 */
export interface Queued extends EventBase {
  kind: 'queued'
  input: { id: string; text: string }
}

/** 一条排队消息 / 报告送达读者：derived 事件，不广播。 */
export interface Delivered extends EventBase {
  kind: 'delivered'
  entry: { kind: EntryKind; id: string }
}

/** 报告到了。`auto` 是小鱼干完没交报告时由 desk 拿最后一条输出补的。 */
export interface Reported extends EventBase {
  kind: 'reported'
  report: { id: string; text: string }
  source: 'worker' | 'auto'
}

/** 票挂起等外部条件：只有 router 能写，出口是 send / close。 */
export interface Blocked extends EventBase {
  kind: 'blocked'
  reason: string
}

/** 终态唯一入口：done / dropped。落终态时排队未投递的 input 一并作废。 */
export interface Closed extends EventBase {
  kind: 'closed'
  outcome: 'done' | 'dropped'
  note?: string
  /** 被作废的排队 input 条数，只给人看。 */
  voidedInputs?: number
}

/** 老日志里的状态行；新代码不再写它，只是回放时认得出。 */
export interface LegacyStatus extends EventBase {
  kind: 'legacy/status'
  status: TicketStatus
  note?: string
}

/**
 * 2026-11-04 之前的一行：没有 `kind`，状态、排队、报告、已读全塞在同一形状里。
 * 字段一个不改，原样回放；`legacyKindOf` 负责把它归到今天的广播类别。
 */
export interface LegacyTicketEvent {
  id: string
  at: string
  goal?: string
  brief?: string
  status?: TicketStatus
  dir?: string
  note?: string
  owner?: string
  ownerId?: string
  input?: { id: string; text: string }
  report?: { id: string; text: string }
  delivered?: { kind: EntryKind; id: string }
}

export type TicketEvent =
  | Published
  | Spawned
  | SpawnFailed
  | Ended
  | Idled
  | Resumed
  | Queued
  | Delivered
  | Reported
  | Blocked
  | Closed
  | LegacyStatus
  | LegacyTicketEvent

/** 所有带 `kind` 的事件；reducer 用它把老行分出去。 */
export type KindedTicketEvent = Extract<TicketEvent, { kind: string }>

/** 新事件名，给 reducer 的 switch 用。 */
export type TicketEventKindName = KindedTicketEvent['kind']

/** What one appended log line did, as the event bus announces it. */
export type TicketEventKind = 'open' | 'status' | 'input' | 'report' | 'delivered'

/**
 * What goes on the bus after a successful append: which ticket moved and in
 * what way. Deliberately not the whole line — a listener that needs the ticket
 * reads it from the projection (one shared fold, not one per listener).
 *
 * 新事件也归到这五类里：广播的形状不变，老的监听方（投递、清账、僵尸判定）
 * 不用为一个新事件名各加一条分支。
 */
export interface TicketBroadcast {
  id: string
  at: string
  kind: TicketEventKind
  /** 内部 reaction 写出来的行：事件照发，但不再投给 reaction。 */
  derived?: boolean
}

/**
 * 一行能 parse 不等于它是一条事件：崩溃留下的 null、数字、数组、缺 id/at 的
 * 行都在这里被挡下。放过去的话 `event.id` 会抛 TypeError，而 `list()` 是每个
 * dispatch_* 的第一步——一处脏行就能把整套工具打死。
 *
 * 后端（`store/jsonl.ts`）在 load 时已经筛过一遍；折叠自己再挡一次，是因为
 * fixture、测试和别的后端都可能把没筛过的数组直接交给 reducer。
 */
export function isTicketEvent(value: unknown): value is TicketEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as { id?: unknown; at?: unknown; kind?: unknown }
  if (typeof event.id !== 'string' || typeof event.at !== 'string') return false
  // `kind` 缺省是老行；给了就必须是字符串，数字/对象一律当脏行。
  return event.kind === undefined || typeof event.kind === 'string'
}

/** 这条事件是带 kind 的新事件，还是 2026-11-04 之前的老行。 */
export function isKindedEvent(event: TicketEvent): event is KindedTicketEvent {
  return typeof (event as { kind?: unknown }).kind === 'string'
}

/**
 * 老行是哪一类事件：状态行、排队、报告、已读、建票。
 *
 * 名字带 legacy 是有意的：新事件由 `kindOf` 直接读 `kind`，这个函数只负责把
 * 没有 `kind` 的行推成今天的广播类别，行为必须和 2026-11-04 之前完全一样。
 */
export function legacyKindOf(event: LegacyTicketEvent): TicketEventKind {
  if (event.delivered) return 'delivered'
  if (event.input) return 'input'
  if (event.report) return 'report'
  // A creation line is the only one that carries a goal together with status
  // open; every later status line is a change, including a reopen to open.
  if (event.goal !== undefined && event.status === 'open') return 'open'
  return 'status'
}

/**
 * 任意一行事件在总线上的类别。
 *
 * 2026-11-04 的新事件刻意折回老的五个类别（published→open，其余状态类→status，
 * queued→input，reported→report，delivered→delivered）：广播形状不变，现有
 * 监听器一条分支都不用改。
 */
export function kindOf(event: TicketEvent): TicketEventKind {
  if (!isKindedEvent(event)) return legacyKindOf(event)
  switch (event.kind) {
    case 'published':
      return 'open'
    case 'queued':
      return 'input'
    case 'reported':
      return 'report'
    case 'delivered':
      return 'delivered'
    default:
      return 'status'
  }
}
