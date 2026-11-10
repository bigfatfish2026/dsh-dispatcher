/**
 * 建票：定档 → 落 `published` → 派活 → 落 `spawned`。三件事的顺序不能换。
 *
 * 先落盘再派人，是因为 `startActivation` 没有幂等键：反过来的话，派成功了而记
 * 账失败，票就不存在，活却真的在跑。现在的顺序最坏情况是「票在、活没派」——
 * 人看得见、能重试、能关掉。
 *
 * 定档用分类器，但分类器是可选件：没配、超时、报错、给的名字不在注册表里，
 * 全部落回配置里的默认档。主会话自己点名的档是另一回事——名字不在注册表就
 * 直接拒绝，不许猜一个近似的。
 */
import { briefIsBlank, truncateColumns } from '../store'
import type { IntentSpec, PresetSource, TicketEvent, TicketOrigin, TicketStatus } from '../store'
import type { PresetTools } from './preset-guard'
import type { Clock } from './clock'
import type { WorkerPool, WorkerRegistration } from './workers'
import type { ProbeRegistry } from './probe'
import type { WorkerToolPort } from './worker-tools'
import { textBlocks } from './workers'

/** 注册表里的一档：只取票台用得上的两栏。 */
export interface PresetInfo {
  id: string
  name?: string
  description?: string
  whenToUse?: string
}

export interface PresetCatalog {
  list(): Promise<PresetInfo[]>
  /** 注册表自己认的默认档；配置没写时的兜底。 */
  defaultId?(): string | undefined
  /**
   * 一个档的工具面（allow/deny 名单）。读不到就抛：选档守卫按「档装不上」
   * 驳回，不猜。没挂 toolset 的档返回 undefined（没减工具）。
   */
  tools(id: string): Promise<PresetTools | undefined>
}

export interface ClassifyInput {
  goal: string
  brief: string
  dir?: string
  presets: PresetInfo[]
  /** 发起这张票的会话；分类器的调用记在它名下，读日志时能对上人。 */
  sessionId?: string
}

export interface ClassifyChoice {
  preset: string
  why?: string
  /**
   * 这轮要不要真的执行命令。三态：true 必须查、false 也查关键词（命中即矛盾）、
   * undefined（模型没给）只走关键词兜底。
   */
  needsCommand?: boolean
}

/** 分类器：给一段活，说该用哪个档。假实现见测试，真实现接 LLM。 */
export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassifyChoice | string | undefined>
}

export interface PresetDecision {
  preset: string
  source: PresetSource
  why?: string
  /** 分类器声明的「要跑命令」；没给就 undefined，交给关键词兜底。 */
  needsCommand?: boolean
}

export interface DecideInput {
  presets: PresetCatalog
  classify?: Classifier
  strategy: 'llm' | 'static'
  /** 配置里的默认档。空串 = 没配，退到注册表的 defaultId。 */
  defaultPreset?: string
  /** 主会话自己挂的档（可选探测命中）；不在注册表就不算数。 */
  routerPreset?: string
  /** 调用方点名的档。 */
  requestPreset?: string
  goal: string
  brief: string
  dir?: string
  /** 发起这张票的会话（分类调用记在它名下）。 */
  sessionId?: string
  classifyTimeoutMs: number
  clock: Clock
  warn?: (message: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 到点就不要这个 promise 了：分类器慢不该把开票卡住。 */
function withTimeout<T>(work: Promise<T>, ms: number, clock: Clock): Promise<T> {
  if (!(ms > 0)) return work
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const handle = clock.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`超时（${ms}ms）`))
    }, ms)
    work.then(
      (value) => {
        if (settled) return
        settled = true
        clock.clearTimeout(handle)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clock.clearTimeout(handle)
        reject(error)
      },
    )
  })
}

export async function decidePreset(input: DecideInput): Promise<PresetDecision> {
  const warn = input.warn ?? (() => {})
  const catalog = await input.presets.list()
  if (catalog.length === 0) throw new Error('preset 注册表是空的：没有档就派不了活')
  const known = new Map(catalog.map((preset) => [preset.id, preset]))

  const named = (id: string, source: PresetSource, why?: string): PresetDecision => {
    // 注册表里没有的名字一律拒绝：拼错一个字母就派成默认档，比开不了票更坏。
    if (!known.has(id)) {
      const names = catalog.map((preset) => preset.id).join(' / ')
      throw new Error(`没有 ${id} 这个 preset（现有：${names}）`)
    }
    return { preset: id, source, ...(why ? { why } : {}) }
  }

  if (input.requestPreset) return named(input.requestPreset, 'router', '主会话点名的档')

  const fallbackId = input.defaultPreset?.trim() || input.presets.defaultId?.() || ''
  if (!fallbackId) throw new Error('没有可用档位：配置里没写 defaultPreset，注册表也没给默认档')
  // 默认档配错是配置事故，早点炸比每张票静默乱派强。
  const fallback = named(fallbackId, 'fallback', '配置的默认档')

  if (input.strategy !== 'llm' || !input.classify) return fallback

  // 主会话挂的档优先于分类器：它自己说了算。
  if (input.routerPreset && known.has(input.routerPreset)) {
    return { preset: input.routerPreset, source: 'router', why: '主会话当前挂的档' }
  }

  let choice: ClassifyChoice | string | undefined
  try {
    choice = await withTimeout(
      input.classify.classify({
        goal: input.goal,
        brief: input.brief,
        ...(input.dir ? { dir: input.dir } : {}),
        presets: catalog,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
      input.classifyTimeoutMs,
      input.clock,
    )
  } catch (error) {
    warn(`分类器没给出结论，用默认档 ${fallback.preset}：${messageOf(error)}`)
    return fallback
  }

  const picked = typeof choice === 'string' ? choice : choice?.preset
  const why = typeof choice === 'string' ? undefined : choice?.why
  if (!picked) return fallback
  if (!known.has(picked)) {
    // 分类器不是人：它写错名字不该让开票失败，但也不能就这么信。
    warn(`分类器给了不存在的档 ${picked}，用默认档 ${fallback.preset}`)
    return { ...fallback, why: `分类器给了不存在的档 ${picked}` }
  }
  return {
    preset: picked,
    source: 'llm',
    ...(why ? { why } : {}),
    ...(typeof choice === 'object' && choice?.needsCommand !== undefined
      ? { needsCommand: choice.needsCommand }
      : {}),
  }
}

/** 一行摘要：空的不许进日志，长了按当前上限截。 */
export function normalizeBrief(brief: string | undefined, maxColumns: number): string {
  const trimmed = brief?.trim() ?? ''
  if (briefIsBlank(trimmed)) throw new Error('brief 不能为空：它是小屏第二行，一句话说清这票干嘛')
  return truncateColumns(trimmed, maxColumns)
}

export function buildLabel(ticketId: string, brief: string): string {
  return truncateColumns(`票 ${ticketId}「${brief}」`, 60)
}

/**
 * 这一轮派的是什么活：
 *
 * - `probe`：探路子会话的第一轮。窗口还开着，`write` / `edit` / `bash` 都装不上，
 *   它只交声明不动手。
 * - `task`：判定放行后的执行轮。原 worker 还活着就把这份任务书投回**同一个
 *   会话**（探路那只已经摸过目录和声明，换一只等于白探），真没了才 spawn 新的
 *   一只；两条路都走这一套任务书。
 * - `degraded`：探路超时降级后投的那一轮。声明没等到，直接干，干完补一份。
 *
 * 不传 = `task`：老调用方（以及自定义 prompt）走原来的任务书，一个字不变。
 */
export type PromptRound = 'probe' | 'task' | 'degraded'

/** 探路时声明过的资源：执行轮拿它划边界，只在 prompt 里念一句。 */
export interface PromptResources {
  writes?: string[]
  reads?: string[]
  reversibility?: string
}

export interface PromptInput {
  ticketId: string
  goal: string
  brief: string
  dir?: string
  epoch: number
  /** 这一轮走哪套任务书；缺省 = 执行轮。 */
  round?: PromptRound
  /** 探路轮交的声明，执行轮开头念一行（票上折出来的 `intent`）。 */
  declared?: PromptResources
}

/**
 * 票台给的活长什么样：票号、目标原文、交报告与卡住的规矩。
 *
 * 这段是 worker 全部的「票」知识，所以三件事各写一句、一句不许含糊：
 * 交活只走 `dispatch_report`；票的状态不归 worker 管；卡住 = 说清卡点然后停，
 * 等主会话 `dispatch_send` 送话进来（子会话报告是单向的，问了没人当场答）。
 *
 * 按轮次分三套：探路轮讲清「只读、交声明」；执行轮只多一行声明过的资源，
 * 末尾提醒别越界；降级轮先认一句探路超时、再让人直接干。三套都带票号和
 * 目标原文——原任务一个字不许截。
 */
export function buildPrompt(input: PromptInput): string {
  const round = input.round ?? 'task'
  const lines = [`你在为票 ${input.ticketId} 干活（第 ${input.epoch} 轮）。`]
  if (round === 'probe') {
    lines.push(
      '这一轮是只读轮：只看不改，write / edit / bash 这轮用不了。',
      '用 read / glob / grep 把活看明白，然后用 dispatch_declare 交两样东西。',
      'plan：要改哪几个文件、每个一句话说改什么；文件级就够，别写行号，也别写函数细节。',
      'intent：writes / reads 用 file: dir: git: svc: port: dev: 六个前缀写资源串，再给一个 reversibility。',
      '报完就直接交活，别试着改文件，也别硬等。',
    )
  } else if (round === 'degraded') {
    lines.push(
      '探路超时，声明一直没等到，这一轮直接干。',
      '干完记得补一份 dispatch_declare：plan 和 intent 照实写，写完再交活。',
    )
  } else {
    lines.push(declaredLine(input.declared))
  }
  lines.push(`目标：${input.goal}`)
  if (input.dir) lines.push(`工作目录：${input.dir}`)
  lines.push(
    `交活只走 dispatch_report：把这一轮的结论写进票 ${input.ticketId}，交完就停。`,
    '票的状态只有主会话能改：你手上只有 dispatch_report 这一个票工具，别自己标完成、别自己挂起。',
    `卡住就停：在报告里说清卡在哪、缺什么，然后等人回话（主会话会用 dispatch_send 把话送到票 ${input.ticketId}）。`,
    '别在报告里提问式的等回音：报告是单向的，没人当场回答。',
  )
  if (round === 'task') lines.push('只动声明里写过的资源，声明之外的东西一律别碰。')
  // 执行轮（含降级轮）收尾要把实际动过的文件报回来，关票时才对得上声明；
  // 探路轮只交声明，不提这个工具。
  if (round !== 'probe') lines.push('干完顺手用 dispatch_touch 报一下你实际碰过哪些文件。')
  return lines.join('\n')
}

/** 执行轮开头那一行：探路声明过的写/读资源；声明是空的就明说，别装成有。 */
function declaredLine(declared: PromptResources | undefined): string {
  const writes = declared?.writes?.filter(Boolean) ?? []
  const reads = declared?.reads?.filter(Boolean) ?? []
  if (writes.length === 0 && reads.length === 0) {
    return '探路时没交资源声明，动手前照票面的工作目录把边界定下来。'
  }
  const parts: string[] = []
  if (writes.length > 0) parts.push(`写 ${writes.join('、')}`)
  if (reads.length > 0) parts.push(`读 ${reads.join('、')}`)
  return `你探路时声明了这些资源：${parts.join('；')}。`
}

/** 派活一次要的全部东西：开票与「放行重投」共用，免得两处各拼一套 spawn 参数。 */
export interface StartWorkerInput {
  ticketId: string
  provider: string
  preset: string
  label: string
  prompt: string
  parent: unknown
  cwd?: string
  maxDepth?: number
  /** 这次派活的记账时刻，`spawned` 行的 at 跟它一致。 */
  at: string
  requestId: string
  device?: string
  pool: WorkerPool
  commit: (event: TicketEvent) => void
  /** 探路登记：成功失败都要撤，别把登记留给下一只无关的子会话。 */
  probeWindows?: ProbeRegistry
  /**
   * 票工具的兜底注册（`worker-tools.ts`）：把 declare / report / touch 按 agent
   * 层装到这只新子会话身上，跟档位的 allow 名单无关。装不上只是少几件工具，不
   * 影响派活记账。
   */
  workerTools?: WorkerToolPort
  /** 失败那句的前半截：开票和重投是两件事，报错里得点明。 */
  failure?: string
}

/**
 * 派一只子会话并把 `spawned` 落盘。开票和放行重投共用这一份，失败路径跟
 * `publishTicket` 原来那段一字不差：先落 `spawn-failed` 让票面留原因，再抛；
 * 派出去却记账失败就 abort 那只 worker 再抛——没有事务，只有补偿。
 */
export async function startWorker(input: StartWorkerInput): Promise<WorkerRegistration> {
  const ticketId = input.ticketId
  let registration: WorkerRegistration
  try {
    registration = await input.pool.start({
      ticketId,
      provider: input.provider,
      preset: input.preset,
      label: input.label,
      prompt: input.prompt,
      parent: input.parent,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.maxDepth ? { maxDepth: input.maxDepth } : {}),
    })
  } catch (error) {
    // 派活没成：单槽登记的使命到此为止，别留给下一只无关的子会话。
    input.probeWindows?.drop(ticketId)
    input.commit({
      kind: 'spawn-failed',
      id: ticketId,
      at: input.at,
      cause: 'lifecycle',
      requestId: input.requestId,
      code: (error as { code?: unknown }).code ? String((error as { code?: unknown }).code) : 'spawn-failed',
      reason: messageOf(error),
    })
    throw new Error(`${input.failure ?? `票 ${ticketId} 开出来了`}，但派活失败：${messageOf(error)}`)
  }

  // 派活结束：窗口已经挂到具体的子会话身上（或者它压根没来）。
  input.probeWindows?.drop(ticketId)

  // 三个票工具按 agent 层再装一道：档位的 allow 名单只滤镜全局工具面，按 agent
  // 注册的这几件不受它管（见 `worker-tools.ts` 头注）。派活刚回来手上只有
  // workerId，活表里查不到就跳过——`agent/created` 那一刀会补上同一次注册。
  input.workerTools?.attach(registration.workerId)

  try {
    input.commit({
      kind: 'spawned',
      id: ticketId,
      at: input.at,
      cause: 'lifecycle',
      workerId: registration.workerId,
      provider: input.provider,
      preset: input.preset,
      ...(input.device ? { device: input.device } : {}),
      label: input.label,
      ...(registration.activation.messageId ? { messageId: registration.activation.messageId } : {}),
    })
  } catch (error) {
    // 派出去却记不上账：这条子会话不属于任何票，只能尽力收回。
    await input.pool.abort(registration.workerId, 'spawn 记账失败')
    try {
      input.commit({
        kind: 'spawn-failed',
        id: ticketId,
        at: input.at,
        cause: 'reaction',
        requestId: input.requestId,
        code: 'log-write-failed',
        reason: messageOf(error),
      })
    } catch {
      // 日志根本写不动：票留在已发布态，至少人看得见。
    }
    throw new Error(`票 ${ticketId} 派出去了，但记账失败，已尽力收回 worker：${messageOf(error)}`)
  }

  return registration
}

export interface TicketIntent {
  goal: string
  brief: string
  dir?: string
  preset?: string
  /** 幂等键：同一次调用重放不许开第二张票。 */
  requestId?: string
  /** 提前拼好的活；不给就按模板生成。 */
  prompt?: string
  /** 谁提的：`main` / `ego`。不传就是 `main`，老调用行为不变。 */
  origin?: TicketOrigin
  /** 撤回意图：影响面、可撤性、预演、撤回指南。不传就是没有，闸放行。 */
  intent?: IntentSpec
  /**
   * 探路开关：true 就先落一条 `planning`，让这只子会话在只读窗口里出方案，
   * 等它交声明（`declared`）再进执行轮。不传就是老路（直接干活）。
   */
  probe?: boolean
}

export interface TicketReceipt {
  id: string
  status: TicketStatus
  preset?: string
  presetSource?: PresetSource
  messageId?: string
  openCount: number
  /** 命中幂等或疑似重复时：这是已有票的号，不是新票。 */
  duplicate?: string
  /** 分级闸降级时给人看的一句原因（status 会是 waiting）。 */
  reason?: string
}

export interface PublishInput {
  id: string
  now: Date
  intent: TicketIntent
  brief: string
  decision: PresetDecision
  publisher: string
  parent: unknown
  pool: WorkerPool
  commit: (event: TicketEvent) => void
  config: { provider: string; device?: string; maxDepth?: number }
  /** 建票前的未收工票数，回执里 +1 给人看。 */
  openCount: number
  /**
   * 分级闸降级：票照建，但不派活、落 `gated` 停在 waiting。值是给人看的原因。
   * 不给就是原路（落票 → 派活）。
   */
  hold?: string
  /**
   * 探路窗口：落 `planning` 之后登记、派活之后撤登记（`probe.ts`）。只探路票用。
   */
  probeWindows?: ProbeRegistry
  /** 票工具的兜底注册，见 `startWorker` 同一个字段。 */
  workerTools?: WorkerToolPort
}

/** 落票 → 派活 → 记 worker。失败路径见文件头。 */
export async function publishTicket(input: PublishInput): Promise<TicketReceipt> {
  const { intent, id } = input
  const at = input.now.toISOString()
  const requestId = intent.requestId ?? id
  input.commit({
    kind: 'published',
    id,
    at,
    cause: 'tool',
    goal: intent.goal,
    brief: input.brief,
    ...(intent.dir ? { dir: intent.dir } : {}),
    publisher: input.publisher,
    preset: input.decision.preset,
    presetSource: input.decision.source,
    ...(input.decision.why ? { presetWhy: input.decision.why } : {}),
    requestId,
    ...(input.config.device ? { device: input.config.device } : {}),
    // 老调用不传这两栏：事件里就没有这两个键，投影按 `main` / 无意图兜底。
    ...(intent.origin ? { origin: intent.origin } : {}),
    ...(intent.intent ? { intent: intent.intent } : {}),
  })

  // 分级闸降级：票照建（人看得见、能接着发话），但不派活，落 waiting。
  if (input.hold) {
    input.commit({
      kind: 'gated',
      id,
      at,
      cause: 'reaction',
      reason: input.hold,
    })
    return {
      id,
      status: 'waiting',
      preset: input.decision.preset,
      presetSource: input.decision.source,
      openCount: input.openCount + 1,
      reason: input.hold,
    }
  }

  // 探路：票先停在 planning，窗口由 `agent/created` 那一刀装（见 probe.ts）。
  // 登记必须在 `pool.start` 之前——新 worker 就是在派活里面冒出来的。
  if (intent.probe === true) {
    input.commit({
      kind: 'planning',
      id,
      at,
      cause: 'tool',
      preset: input.decision.preset,
    })
    input.probeWindows?.expect(id)
  }

  const label = buildLabel(id, input.brief)
  const registration = await startWorker({
    ticketId: id,
    provider: input.config.provider,
    preset: input.decision.preset,
    label,
    prompt:
      intent.prompt?.trim() ||
      buildPrompt({
        ticketId: id,
        goal: intent.goal,
        brief: input.brief,
        ...(intent.dir ? { dir: intent.dir } : {}),
        epoch: 1,
        // 探路票的第一轮是只读轮：任务书得先把「只看不改、交声明」说在前头。
        ...(intent.probe === true ? { round: 'probe' as const } : {}),
      }),
    parent: input.parent,
    ...(intent.dir ? { cwd: intent.dir } : {}),
    ...(input.config.maxDepth ? { maxDepth: input.config.maxDepth } : {}),
    at,
    requestId,
    ...(input.config.device ? { device: input.config.device } : {}),
    pool: input.pool,
    commit: input.commit,
    ...(input.probeWindows ? { probeWindows: input.probeWindows } : {}),
    ...(input.workerTools ? { workerTools: input.workerTools } : {}),
    failure: `票 ${id} 开出来了`,
  })

  return {
    id,
    status: 'running',
    preset: input.decision.preset,
    presetSource: input.decision.source,
    ...(registration.activation.messageId ? { messageId: registration.activation.messageId } : {}),
    openCount: input.openCount + 1,
  }
}

/** 冷启动/重投时给 worker 送话的内容：和 spawn 时同一套包装。 */
export function followupBlocks(text: string) {
  return textBlocks(text)
}
