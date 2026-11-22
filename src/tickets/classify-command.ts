/**
 * 命令判定：问一次小模型「这张票需不需要真的执行命令」。
 *
 * 选档守卫原先靠 `commandHint` + `DEFAULT_COMMAND_KEYWORDS` 猜这件事：词表既要
 * 躲开「digit 命中 git」「category 命中 cat」这种误伤，又要不漏「拿工具跑测试」
 * 这类活，两头都不讨巧。现在改成问一次 flash 档小模型，一句话回 yes/no；词表
 * 退成兜底——调用失败、超时、回话里没有那一行，才退回 `commandHint`。
 *
 * 三条边界，跟选档分类器（classify.ts）一个口径：
 *
 * - **强信号优先。** 任务书里明写「需要执行命令」「要用 bash 跑命令」时不给模型
 *   留否定的余地：直接 yes，这一条不花调用。模型判 no 而任务书命中命令类词
 *   （grep/解压/journalctl）时，也以任务书为准——这是早先那两张白跑票
 *   的直接教训。
 * - **失败不猜。** 调用失败、超时、解析不出 `NEEDS_COMMAND` 行，都退回词表，
 *   并 warn 一行说明退到了哪张表、命中了哪个词；不静默当「不要命令」。
 * - **日志里没有任务书原文。** 只记模型、耗时、结论和命中的词。goal/brief 是
 *   使用方写的话，落进日志再被谁读走都是泄漏。
 */
import type { LlmStreamChunk, LlmService } from './classify'
import { deadline, parseModelRoute, parseNeedsCommand, TimeoutReason } from './classify'
import { commandHint, DEFAULT_COMMAND_KEYWORDS } from './preset-guard'
import type { GeminiDecision } from './gemini-decision'

/** 判定要读的三样：目标、一行摘要、工作目录。 */
export interface NeedsCommandInput {
  goal: string
  brief: string
  dir?: string
}

/** 判定结论的来源：给日志和守卫说清这个布尔值是谁给的。 */
export type NeedsCommandSource =
  /** 任务书自己写明要跑命令（强信号），没花调用。 */
  | 'strong'
  /** 模型给的结论。 */
  | 'llm'
  /** 模型不中用，退回关键词表（命中即 yes）。 */
  | 'keyword'
  /** 模型没结论，本机 decision 桥给出高置信 yes（D2 第三层）。 */
  | 'gemini'

export interface NeedsCommandVerdict {
  needsCommand: boolean
  source: NeedsCommandSource
  /** 命中的关键词：强信号或词表兜底时有，模型判定时没有。 */
  matchedKeyword?: string
}

/** 判定器依赖：跟 `createLlmClassifier` 同一套 llm 设施，模型/超时另给。 */
export interface CommandJudgeDeps {
  /** 惰性取 `ctx.llm`：服务没起来时退回词表，不拖住开票。 */
  llm: () => LlmService | undefined
  /** `provider/model`，例如 `deepseek/deepseek-flash`。 */
  model: string
  /** 推理档 id；空串 = 不传，用路由默认。判一行 yes/no，给 off 就够。 */
  effort: string
  /** 短超时：判定晚到不如按词表先派。 */
  timeoutMs: number
  /** 兜底词表；缺省用 `DEFAULT_COMMAND_KEYWORDS`。 */
  keywords?: readonly string[]
  maxOutputTokens?: number
  warn?: (message: string) => void
  /**
   * 第三层：本机 gemini-decision 桥（方案 D2）。不传 / 开关关着 = 走老路，
   * 一次请求都不发。只在模型判不出结论时问一次，强信号与模型结论都不经过它。
   */
  decide?: GeminiDecision
}

/** 一行 yes/no 的输出上限；给多了纯浪费。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 20

/** 日志里的置信度只留三位小数：够看趋势，也不把上游浮点原文抄进日志。 */
function fixed3(value: number | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(3) : '0.000'
}

/** 失败原因换成方案 §5 的 kind 枚举（region_400 / rate_429 / upstream_5xx / network / -）。 */
function failKind(reason: string | undefined): string {
  const code = String(reason ?? '')
  if (code === 'http_400') return 'region_400'
  if (code === 'http_429') return 'rate_429'
  if (/^http_5\d\d$/.test(code)) return 'upstream_5xx'
  if (code === 'timeout' || code === 'network') return 'network'
  return '-'
}

/** 发给桥的那句话：只有票面事实，超 800 字截断；不许进日志。 */
function bridgeState(input: NeedsCommandInput): string {
  const text = `目标：${String(input.goal ?? '').trim()}\n摘要：${String(input.brief ?? '').trim()}`.trim()
  return text.length > 800 ? `${text.slice(0, 800)}…` : text
}

/**
 * D2 第三层：模型判不出结论时，问一次本机桥「这活要不要真的执行命令」。
 *
 * 采纳条件写死：桥判 yes 且 confidence ≥ cfg.minConfidence 才替代关键词表；
 * 桥判 no、置信度不够、超时、校验不过，一律回 undefined，调用方照旧走词表。
 * 顺序写死：先跑完模型那条路，失败之后才问桥。
 */
async function adviseNeedsCommand(
  input: NeedsCommandInput,
  deps: CommandJudgeDeps,
): Promise<NeedsCommandVerdict | undefined> {
  const decide = deps.decide
  if (!decide?.enabled) return undefined
  const result = await decide.ask({
    state: bridgeState(input),
    instructions:
      '这张工单要派给子会话执行。只判断一件事：它需不需要真的运行命令（bash、脚本、git、测试、解压、journalctl 之类）？'
      + '完全不用跑命令、只读文件就能做完的活答 no；看起来是只读排查但要跑命令才能完成的，答 yes。',
    criteria: {
      yes: '需要真的执行命令：要跑 bash / 脚本 / 测试 / git / 解压 / 查进程和日志，只读文件做不完',
      no: '不需要执行命令：只读文件、grep 文本、联网查、翻记忆就能做完',
    },
  })
  if (!result.ok) {
    deps.warn?.(
      `gemini:fail site=dispatcher.command kind=${failKind(result.reason)} ms=${result.ms} reason=${result.reason}`,
    )
    return undefined
  }
  const taken = result.choice === 'yes' && Number(result.confidence) >= decide.cfg.minConfidence
  deps.warn?.(
    `gemini:call site=dispatcher.command choice=${result.choice} conf=${fixed3(result.confidence)} ms=${result.ms}`,
  )
  deps.warn?.(
    `gemini:use site=dispatcher.command taken=${taken ? 1 : 0} why=${taken ? 'advice_yes' : 'rule_wins'} conf=${fixed3(result.confidence)}`,
  )
  return taken ? { needsCommand: true, source: 'gemini' } : undefined
}

/**
 * 「任务书明写要执行命令」的强信号词。
 *
 * 只收显式声明，不收 grep/日志这类宽词：宽词交给模型判，否则每次任务书里提一句
 * 「日志」就短路，模型判定等于没接。
 */
export const STRONG_COMMAND_SIGNALS: readonly string[] = [
  '需要执行命令',
  '执行命令',
  '跑命令',
  '要用 bash',
  '要用bash',
  '用 bash 跑',
  '用bash跑',
]

/**
 * system prompt：一条硬判据 + 一行输出格式。
 *
 * 「日志/会话记录/压缩包算要命令」这句必须留着：模型很容易把「翻一下会话记录」
 * 判成不用命令，子会话拿到手连 grep 都没有。
 */
export function buildNeedsCommandSystem(): string {
  return [
    '你是命令判定的分诊：读一张待派工单，只回答一件事——干完这张活，这个任务需不需要真的运行程序。',
    '算需要执行命令的包括但不限于：跑 bash 或脚本、grep/find/sed/awk、zstd/gzip/tar 解压、journalctl/systemctl、git 命令、ps/top/df、curl、编译构建、安装依赖、跑测试、统计排序去重。',
    '日志、会话记录、备份包、压缩包不是普通文本文件：查它们必须用命令，算需要。',
    '真正不用命令的只有：读工作区里的普通文本或图片、查长期记忆和向量索引、上网搜资料、控制设备（放歌开灯）。',
    '任务书里已经写明「需要执行命令」的，一律 yes。',
    '只输出一行：NEEDS_COMMAND: yes 或 NEEDS_COMMAND: no。别写解释、别写别的。',
  ].join('\n')
}

export function buildNeedsCommandInput(input: NeedsCommandInput): string {
  const lines = [`目标：${input.goal}`, `摘要：${input.brief}`]
  if (input.dir) lines.push(`工作目录：${input.dir}`)
  return lines.join('\n')
}

/** 只认 `NEEDS_COMMAND: yes|no` 那一行；没写返回 undefined。 */
export const parseNeedsCommandLine = parseNeedsCommand

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 问一次模型；所有失败都抛，兜底由 `classifyNeedsCommand` 做。 */
async function askModel(input: NeedsCommandInput, deps: CommandJudgeDeps): Promise<boolean> {
  const llm = deps.llm()
  if (!llm?.prepareCall) throw new Error('llm 服务不可用：判不了要不要命令')
  const route = parseModelRoute(deps.model)
  const effort = deps.effort.trim()
  const scoped = deadline(undefined, deps.timeoutMs, () => new TimeoutReason(deps.timeoutMs))
  const startedAt = Date.now()
  try {
    const call = await llm.prepareCall(
      {
        ...route,
        ...(effort ? { reasoningEffort: effort } : {}),
        maxTokens: deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
      scoped.signal,
    )
    const options: Record<string, unknown> = {
      ...call.config,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: buildNeedsCommandInput(input) }],
        },
      ],
      system: buildNeedsCommandSystem(),
      signal: scoped.signal,
    }
    let text = ''
    for await (const chunk of call.stream(options) as AsyncIterable<LlmStreamChunk>) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          throw new Error(`模型报错：${chunk.reason?.failure?.message ?? kind}`)
        }
      }
    }
    // 被时限掐断时流会正常结束、一个字都没有：报超时，别误报「没给出那一行」。
    if (scoped.signal.aborted) {
      throw (scoped.signal.reason as Error | undefined) ?? new TimeoutReason(deps.timeoutMs)
    }
    const verdict = parseNeedsCommandLine(text)
    if (verdict === undefined) {
      throw new Error(`模型没给出 NEEDS_COMMAND 行（${route.model}，${text.length} 字）`)
    }
    return verdict
  } catch (error) {
    // 回答本身不记：里面可能带着工单原文。
    throw error instanceof Error
      ? error
      : new Error(`${messageOf(error)}（${route.provider}/${route.model}，${Date.now() - startedAt}ms）`)
  } finally {
    scoped.dispose()
  }
}

/**
 * `commandHint` 的异步替代：这张票要不要真的执行命令。
 *
 * 永远返回结论，不抛：调用方拿到的是「要 / 不要」加一个来源，守卫按这个布尔值
 * fail-closed。强信号 > 模型 > 关键词兜底，三段都在这个函数里定死，别在接线层
 * 再拼一遍。
 */
export async function classifyNeedsCommand(
  input: NeedsCommandInput,
  deps: CommandJudgeDeps,
): Promise<NeedsCommandVerdict> {
  const warn = deps.warn ?? (() => {})
  const keywords = deps.keywords ?? DEFAULT_COMMAND_KEYWORDS

  // 强信号：任务书自己写明要跑命令，直接 yes，不花调用。
  const declared = commandHint(input.goal, STRONG_COMMAND_SIGNALS)
  if (declared) return { needsCommand: true, source: 'strong', matchedKeyword: declared }

  const startedAt = Date.now()
  try {
    const verdict = await askModel(input, deps)
    if (verdict) return { needsCommand: true, source: 'llm' }
    // 模型说不用，任务书里却明摆着命令类词：以任务书为准，不让模型把它否掉。
    const hit = commandHint(input.goal, keywords)
    if (hit) return { needsCommand: true, source: 'keyword', matchedKeyword: hit }
    return { needsCommand: false, source: 'llm' }
  } catch (error) {
    // 第三层（D2）：模型没结论时才问本机桥；开关关着时连这一步都不进。
    const advice = await adviseNeedsCommand(input, deps)
    const hit = commandHint(input.goal, keywords)
    warn(
      `[dispatcher] 命令判定失败（${deps.model}，${Date.now() - startedAt}ms）：${messageOf(error)}；` +
        (advice
          ? 'decision 桥判要执行命令，按桥的结论走'
          : `退回关键词表${hit ? `，命中「${hit}」` : '，没命中'}`),
    )
    if (advice) return advice
    return {
      needsCommand: hit !== undefined,
      source: 'keyword',
      ...(hit ? { matchedKeyword: hit } : {}),
    }
  }
}
