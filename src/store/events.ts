/**
 * 票日志的事件模型：一行就是一条事件，事件折成票。
 *
 * 这一层只有类型、类型守卫和「一行是哪一类事件」的判定；不认识时间、
 * 不认识 IO，也不认识 TicketDesk。折叠在 `reducer.ts`，落盘与投影在 `log.ts`。
 *
 * 此前事件是带 `kind` 的判别联合（设计文档 §2/§3.1）。早期版本
 * 写的行没有 `kind`：它们仍是合法事件，由 `legacyKindOf` 归类、由 reducer 里
 * 那条原封不动的老折叠路径读。两种行共存是常态，不是过渡期的脏数据。
 */

import { TICKET_PHASES, TICKET_STATUSES } from '../protocol'

/** 六种状态的字面值唯一定义在 `protocol.ts`，这里只取联合类型。 */
export type TicketStatus = (typeof TICKET_STATUSES)[number]

/**
 * 这张票是谁提的：人（主会话）还是 ego。老票没有这一栏，读起来一律当 `main`。
 *
 * 只用来喂分级闸：`ego` 不许自己提不可撤的动作。`worker` 不在这一栏里——
 * 子会话不提票，它只干活、记账。
 */
export type TicketOrigin = 'main' | 'ego'

/** 一步动作能不能撤：能自动对消 / 只能人工按指南撤 / 撤不回。 */
export type Reversibility = 'auto' | 'manual' | 'none'

/** 动作会碰什么。三栏都可空，但写清才有审计价值。 */
export interface IntentImpact {
  paths?: string[]
  services?: string[]
  remotes?: string[]
}

/** 预演结果：`ok:false` 是闸降级的依据，`detail` 是人看的理由。 */
export interface IntentDryRun {
  ok: boolean
  detail?: string
}

/**
 * 一条动作怎么撤。`howto` 必须是具体命令或具体路径——「回滚即可」这种空话
 * 在 `tickets/revert.ts` 里被挡下；撤不回的动作写清「撤不回，替代动作是 …」。
 */
export interface IntentUndo {
  kind: string
  ref?: string
  howto: string
}

/**
 * 建票时带的意图栏（设计文档路线 3 的「意图」）。整栏可选：老调用、老票都没有
 * 它，行为一个字节不变。
 */
export interface IntentSpec {
  /**
   * 影响面资源串（设计稿 §5 的六前缀：file / dir / git / svc / port / dev），
   * 这张票会写的资源。老票、老调用没有这一栏，缺席就是空数组。
   */
  writes?: string[]
  /** 同上，只读的资源。冲突判定拿两边 writes 求交，只读只降级成弱冲突。 */
  reads?: string[]
  impact?: IntentImpact
  reversibility?: Reversibility
  dryRun?: IntentDryRun
  undo?: IntentUndo
}

/** 方案里的一条：动哪个文件、大概做什么。只到文件级，不含行号也不含 diff。 */
export interface PlanFile {
  path: string
  what?: string
}

/**
 * 探路子会话交的方案要点（设计稿 §4「plan 只到文件级」）。
 *
 * 整栏可选：老票、快路径开的票都没有它。`summary` 是一段话说清整张票怎么干；
 * `files` 是「改哪几个文件、每个文件大概做什么」，给执行子会话和审计看。
 */
export interface TicketPlan {
  summary?: string
  files?: PlanFile[]
}

/** 账本里的一条动作：子会话（或主会话）自述「我做了什么、怎么撤」。 */
export interface ActionLogEntry {
  /** 票内序号，1 起；同一张票里递增，给人按顺序读。 */
  step: number
  actor: 'main' | 'worker'
  summary: string
  undo: IntentUndo
  at: string
}

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
 * 探路阶段位：`planning` 探路子会话在跑，`planned` 方案与意图已落票，`blocked`
 * 判定撞上了更强的票、排队等放行，`running` 执行轮。和 `status` 是两个维度
 * ——status 只说「这活到哪一步了」，phase 只说「探路窗口开着没有 / 排队等谁」。
 * 快路径（不探路）的票没有这一栏，老票也没有。
 */
/** 探路/排队相位的字面值唯一定义在 `protocol.ts`，这里只取联合类型。 */
export type TicketPhase = (typeof TICKET_PHASES)[number]

/**
 * 冲突排队：撞哪张票、撞的是哪几个归一化资源串（`dir:/a/b` 这种）。
 * 只在 phase 是 `queued` 时有内容，放行时整栏清空。
 */
export interface ConflictWait {
  ticketId: string
  resources: string[]
}

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
   * earlier versions have no such field — readers fall back to `briefOf()`, which
   * derives the same thing from `goal`.
   */
  brief?: string
  status: TicketStatus
  dir?: string
  note?: string
  /**
   * Human label for the worker (what the little screen shows). 老票里是
   * `t4 查 example PR`；新票不再要求调用方写它，由 desk 按档名 + goal 生成。
   */
  owner?: string
  /**
   * The worker's session id as the old `spawn` flow returned it (uuid, optionally
   * with a `session-` prefix). 老票的归属依据；新票一律用 `workerId`。
   */
  ownerId?: string
  /**
   * 排队序号：开票时按「当前日志里最大的 seq + 1」发一个，单调递增，落在
   * `published` 事件里，重放能原样折回来。排队放行的先后只认它——同一毫秒开
   * 的两张票 createdAt 一模一样，靠它将 FIFO 定死（老代码在这儿退化成按 id
   * 字典序）。
   *
   * 早期版本的老票没有这一栏，读起来是 undefined；排序退回 createdAt
   * 升序、再按 id 兜底，448 张线上票照常能读能排。
   *
   * 跟 `store/sqlite.ts` 里 `events.seq`（事件在日志里的行号）是两码事：那个
   * 是日志序号，这个是票的排队序号。
   */
  seq?: number
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
  /** 提票人：`main`（人/主会话）或 `ego`。老票没有这一栏，读起来是 `main`。 */
  origin?: TicketOrigin
  /** 由 `dispatch_declare` 的 `declared` 折进来：影响面、可撤性、预演、撤回指南；老票没有就是 undefined。 */
  intent?: IntentSpec
  /** 探路子会话交的方案（`declared` 折进来）；没探路或老票就是 undefined。 */
  plan?: TicketPlan
  /**
   * 探路阶段位（`planning` / `declared` / `conflict-checked` / `closed` 折出来）：
   * 只说「探路窗口开着没有、在不在队里」，跟 status / statusSince / closedAt
   * 各走各的。快路径和老票没有。
   */
  phase?: TicketPhase
  /**
   * 交声明那一刻（第一条 `declared.at`）：冲突排队「先来后到」按它比。
   *
   * 判定发生在探路子会话 idle 那一拍，不是 declare 那一拍——两张票谁先被判定
   * 跟谁先抢到资源没关系，只有声明时刻能定先后。只认第一次声明：重新声明、
   * 降级、派活失败回滚都不刷新它，否则排队顺序会被后来的动作改掉。快路径和
   * 老票没有这一栏，排序退回排队序号 `seq`。
   */
  declaredAt?: string
  /**
   * 冲突排队：这张票在 `blocked` 时撞的是谁、撞了什么（`conflict-checked` 折
   * 进来）。放行或重新声明时清空。老票、快路径的票没有这一栏。
   */
  waitOn?: ConflictWait[]
  /**
   * 弱冲突的票号：判定是「提示放行」，不排队，但票面上要看得见撞过谁。
   * 同样由 `conflict-checked` 折进来。
   */
  weakWith?: string[]
  /** 探路超时降级：声明没等到，按 dir 兜底算影响面（`declared.degraded` 折进来）。 */
  degraded?: boolean
  /**
   * 执行子会话收尾自报的实际动过的路径（`touch-reported` 折进来，多条按首次出现
   * 顺序合并去重：一轮里分几次报不该只剩最后一批）。不参与 status 判定，只给
   * 越界对账看。
   */
  touched?: string[]
  /**
   * 收工时对上声明 writes 的越界项（`closed.outOfScope` 折进来）：hooks 在关票
   * 那一刻算一次，之后一直留在票面上，dispatch_list / dispatch_read 各铺一行。
   * 没有越界或没有声明就整个键不出现。
   */
  outOfScope?: string[]
  /**
   * 动作账本：`action-logged` 一条条折进来，append-only。和 `reports` 平行，
   * 不参与 status / isTerminal 的判定——收工的票也还能补记最后几步。
   */
  actions: ActionLogEntry[]
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
  | 'origin'
  | 'intent'
  | 'plan'
  | 'phase'
  | 'waitOn'
  | 'weakWith'
  | 'degraded'
  | 'touched'
  | 'outOfScope'
  | 'actions'
  | 'seq'
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
  /**
   * 排队序号：`TicketLog.commit` 给每一行没带 seq 的 `published` 补一个「日志里
   * 现有最大 seq + 1」，写进事件也就是写进日志——重启后重放能拿回同一个值，
   * 新开的票接着最大值往下数，不会从 1 重来。
   *
   * 早期版本的建票行没有这一栏；折叠出来的老票 seq 就是 undefined。
   */
  seq?: number
  dir?: string
  publisher: string
  preset: string
  presetSource: PresetSource
  presetWhy?: string
  requestId: string
  device?: string
  /**
   * 谁提的：`main` / `ego`。老调用不写，折叠时按 `main` 兜底；写进事件是为了
   * 审计能区分「人点的不可撤动作」和「ego 想点的」。
   */
  origin?: TicketOrigin
  /**
   * 开票意图。此前 `dispatch_open` 不再收 intent，这个键只出现在
   * 老日志里；新票的意图走 `declared` 事件，reducer 折叠时照样认这一栏。
   */
  intent?: IntentSpec
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

/** 子会话结束了（这一轮干完）：票进 waiting，workerAlive=false。 */
export interface Ended extends EventBase {
  kind: 'ended'
  workerId: string
  device?: string
  stopReason: string
  epochReports: number
}

/** 子会话这一轮干完但人还在：票进 waiting，workerAlive=true。 */
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

/** 报告到了。`auto` 是子会话干完没交报告时由 desk 拿最后一条输出补的。 */
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

/**
 * 分级闸把票降级到 waiting：`dryRun.ok === false` 的票不派活，先停在 waiting
 * 等人看。和 `blocked` 分开：blocked 是「等外部条件」，gated 是「预演没过」。
 */
export interface Gated extends EventBase {
  kind: 'gated'
  reason: string
}

/**
 * 动作账本一行：子会话（或主会话）每干完一步就 append 一条。只追加，不碰
 * status / isTerminal——收工的票也还能补记。自述不可信，所以审计会抽查。
 */
export interface ActionLogged extends EventBase {
  kind: 'action-logged'
  /** 票号（和公共栏的 id 同一个值，写出来是为了读原始行时不靠上下文）。 */
  ticketId: string
  actor: 'main' | 'worker'
  /** 票内序号，1 起；工具层不传时由票台按最后一条 +1。 */
  step: number
  summary: string
  undo: IntentUndo
}

/**
 * 探路开始：留一条痕，说明「这张票已经有人在看档了」。
 *
 * 刻意不动 status：状态仍只由主会话的 open / touch / close / sweep 四个动作写
 * （设计稿 §7 的红线）。这条与 `declared` 一起只交代探路轮的起止。
 */
export interface Planning extends EventBase {
  kind: 'planning'
  /** 探路子会话的档名（只读档），审计用。 */
  preset?: string
  /** 探路那个子会话的 sessionId；回收探路轮时认它。 */
  workerId?: string
}

/**
 * 探路交活：方案与意图一次落齐。
 *
 * 设计稿 §6 的判定要读 intent.writes，而 published 是开票凭证、append-only 改
 * 不了，所以「重写意图」只能是一条新事件。`plan` 与 `intent` 两份都在这里，
 * reducer 折进快照时**不碰 status**——转 planned 由主会话的 action 写。
 */
export interface Declared extends EventBase {
  kind: 'declared'
  plan: TicketPlan
  intent: IntentSpec
  /** 交声明的那只探路子会话的 sessionId，审计用。 */
  workerId?: string
  /**
   * 这条声明是不是超时降级补的：探路窗口到点没等到交活，按 `dir` 整片当写进
   * 兜底。只给对账和巡检看，不额外开事件种类——一条消息一次写完。
   */
  degraded?: boolean
}

/**
 * 执行子会话收尾自报：这一轮实际动过的路径，给越界对账看（设计稿 §12）。
 *
 * 和 `action-logged` 一样只追加信息、不碰 status；后报的覆盖前一次（对账只对
 * 最近这一轮，攒着会混轮次）。
 */
export interface TouchReported extends EventBase {
  kind: 'touch-reported'
  actor: 'main' | 'worker'
  paths: string[]
}

/**
 * 冲突判定落票：探路票收工那一刻（以及排队票被放行时）判一次，结果写这里。
 *
 * strong → phase 折成 `queued`，`waitOn` 记撞谁、撞什么；none / weak → phase
 * 折成 `running`，`weak` 记一行提示票号。这个事件**不碰 status / statusSince /
 * closedAt**：排队状态只记在 phase 上，status 仍由主会话的动作和既有生命周期
 * 事件写（设计稿 §7 的红线）。
 */
export interface ConflictChecked extends EventBase {
  kind: 'conflict-checked'
  level: 'none' | 'weak' | 'strong'
  /** strong 时撞上的票与资源；其余写空数组，读的时候不用再判有没有。 */
  waitOn: ConflictWait[]
  /** weak 时撞到的票号：只提示、不阻塞，放行照旧。 */
  weak?: string[]
}

/** 终态唯一入口：done / dropped。落终态时排队未投递的 input 一并作废。 */
export interface Closed extends EventBase {
  kind: 'closed'
  outcome: 'done' | 'dropped'
  note?: string
  /** 被作废的排队 input 条数，只给人看。 */
  voidedInputs?: number
  /**
   * 关票那一刻对账出来的越界项：touched 里没有被声明 writes 覆盖的路径。只在这
   * 一次关票时算，写进事件里跟着票一直留着；没有越界就不写这一栏。
   */
  outOfScope?: string[]
}

/** 老日志里的状态行；新代码不再写它，只是回放时认得出。 */
export interface LegacyStatus extends EventBase {
  kind: 'legacy/status'
  status: TicketStatus
  note?: string
}

/**
 * 早期版本的一行：没有 `kind`，状态、排队、报告、已读全塞在同一形状里。
 * 字段一个不改，原样回放；`legacyKindOf` 负责把它归到今天的广播类别。
 */
export interface LegacyTicketEvent {
  id: string
  at: string
  goal?: string
  brief?: string
  status?: TicketStatus
  /**
   * 排队序号。老行没有它，读起来是 undefined；新代码走 `TicketLog.open()` 时
   * 仍写这种老形状的建票行（不改线上形状），seq 就补在这一栏里，见
   * `TicketLog.withSeq`。折叠规则在 `reducer.ts` 的 `applyLegacy`。
   */
  seq?: number
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
  | Gated
  | ActionLogged
  | Planning
  | Declared
  | TouchReported
  | ConflictChecked
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

/** 这条事件是带 kind 的新事件，还是 早期版本的老行。 */
export function isKindedEvent(event: TicketEvent): event is KindedTicketEvent {
  return typeof (event as { kind?: unknown }).kind === 'string'
}

/**
 * 老行是哪一类事件：状态行、排队、报告、已读、建票。
 *
 * 名字带 legacy 是有意的：新事件由 `kindOf` 直接读 `kind`，这个函数只负责把
 * 没有 `kind` 的行推成今天的广播类别，行为必须和 早期版本完全一样。
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
 * 新事件刻意折回老的五个类别（published→open，其余状态类→status，
 * queued→input，reported→report，delivered→delivered）：广播形状不变，现有
 * 监听器一条分支都不用改。
 *
 * `action-logged` 归 `report`：它和报告一样只追加数组、不动状态，监听器按
 * 「有新内容了」处理就够；`gated` 归 `status`，因为它确实换了状态。
 *
 * 三个探路 / 对账事件：`declared` 与 `touch-reported` 都只追加
 * 内容、不动状态，归 `report`；`planning` 同理不动状态，但它标的是「探路轮
 * 开始」这一件事，落到类别上只能是 `status`（广播类别只有五种，不为它扩）。
 */
export function kindOf(event: TicketEvent): TicketEventKind {
  if (!isKindedEvent(event)) return legacyKindOf(event)
  switch (event.kind) {
    case 'published':
      return 'open'
    case 'queued':
      return 'input'
    case 'reported':
    case 'action-logged':
    case 'declared':
    case 'touch-reported':
      return 'report'
    // 判定改了 phase，广播类别按「票动了」归 status；它不碰 status 本身。
    case 'conflict-checked':
      return 'status'
    case 'delivered':
      return 'delivered'
    case 'planning':
      return 'status'
    default:
      return 'status'
  }
}
