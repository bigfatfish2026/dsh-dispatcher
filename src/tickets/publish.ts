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
import type { PresetSource, TicketEvent, TicketStatus } from '../store'
import type { PresetTools } from './preset-guard'
import type { Clock } from './clock'
import type { WorkerPool } from './workers'
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
   * 这轮要不要真的执行命令。三态：true 必须查、false 不查关键词、
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

export interface PromptInput {
  ticketId: string
  goal: string
  brief: string
  dir?: string
  epoch: number
}

/**
 * 票台给的活长什么样：票号、目标原文、交报告与卡住的规矩。
 *
 * 这段是 worker 全部的「票」知识，所以三件事各写一句、一句不许含糊：
 * 交活只走 `dispatch_report`；票的状态不归 worker 管；卡住 = 说清卡点然后停，
 * 等主会话 `dispatch_send` 送话进来（子会话报告是单向的，问了没人当场答）。
 */
export function buildPrompt(input: PromptInput): string {
  const lines = [
    `你在为票 ${input.ticketId} 干活（第 ${input.epoch} 轮）。`,
    `目标：${input.goal}`,
  ]
  if (input.dir) lines.push(`工作目录：${input.dir}`)
  lines.push(
    `交活只走 dispatch_report：把这一轮的结论写进票 ${input.ticketId}，交完就停。`,
    '票的状态只有主会话能改：你手上只有 dispatch_report 这一个票工具，别自己标完成、别自己挂起。',
    `卡住就停：在报告里说清卡在哪、缺什么，然后等人回话（主会话会用 dispatch_send 把话送到票 ${input.ticketId}）。`,
    '别在报告里提问式的等回音：报告是单向的，没人当场回答。',
  )
  return lines.join('\n')
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
  })

  const label = buildLabel(id, input.brief)
  let registration
  try {
    registration = await input.pool.start({
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
        }),
      parent: input.parent,
      ...(intent.dir ? { cwd: intent.dir } : {}),
      ...(input.config.maxDepth ? { maxDepth: input.config.maxDepth } : {}),
    })
  } catch (error) {
    // 票已经落盘了：记下原因，让它停在 open 上等人处理，不假装没开过。
    input.commit({
      kind: 'spawn-failed',
      id,
      at: input.now.toISOString(),
      cause: 'lifecycle',
      requestId,
      code: (error as { code?: unknown }).code ? String((error as { code?: unknown }).code) : 'spawn-failed',
      reason: messageOf(error),
    })
    throw new Error(`票 ${id} 开出来了，但派活失败：${messageOf(error)}`)
  }

  try {
    input.commit({
      kind: 'spawned',
      id,
      at: input.now.toISOString(),
      cause: 'lifecycle',
      workerId: registration.workerId,
      provider: input.config.provider,
      preset: input.decision.preset,
      ...(input.config.device ? { device: input.config.device } : {}),
      label,
      ...(registration.activation.messageId ? { messageId: registration.activation.messageId } : {}),
    })
  } catch (error) {
    // 派出去却记不上账：这条子会话不属于任何票，只能尽力收回。没有幂等键，
    // 也没有事务可回滚——这是补偿，不是原子性。
    await input.pool.abort(registration.workerId, 'spawn 记账失败')
    try {
      input.commit({
        kind: 'spawn-failed',
        id,
        at: input.now.toISOString(),
        cause: 'reaction',
        requestId,
        code: 'log-write-failed',
        reason: messageOf(error),
      })
    } catch {
      // 日志根本写不动：票留在 published，至少人看得见。
    }
    throw new Error(`票 ${id} 派出去了，但记账失败，已尽力收回 worker：${messageOf(error)}`)
  }

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
