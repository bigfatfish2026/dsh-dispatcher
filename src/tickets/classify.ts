/**
 * 选档分类器：真调一次小模型，问它这张活该派给哪个档。
 *
 * 只做一件事：拼 prompt、调 `ctx.llm`、把回答解析成一个档名 + 一句理由。档位
 * 名单从调用方给的注册表快照来（`ClassifyInput.presets`），这个文件里没有
 * 任何档名——加档删档只动 profile。
 *
 * 三条边界：
 *
 * - **失败就是失败。** 超时、报错、模型不存在、回答里没有合法档名，一律抛；
 *   回落默认档是 `publish.ts` 的事，这一层不许自己猜一个档。
 * - **日志里没有 prompt。** 一张票的 goal/brief 是主人写的话，落进日志再被谁
 *   读走都是泄漏。只记模型、耗时、结论和一行原因。
 * - **链路形状按 `dsh-session-title-llm` 抄**（`lib/index.js:160-215`）：
 *   `prepareCall(config, signal, configure)` → `call.stream({...call.config, ...})`。
 *   这个包不依赖 `dsh-llm`，所以下面按结构收窄，测试塞假的 llm 就行。
 */
import type { ClassifyChoice, Classifier, ClassifyInput, PresetInfo } from './publish'

/** `ctx.llm` 里票台用到的那两栏。 */
export interface LlmStreamChunk {
  type: string
  text?: string
  reason?: { kind?: string; failure?: { message?: string; code?: string } }
}

export interface LlmPreparedCall {
  config: Record<string, unknown>
  stream(options: Record<string, unknown>): AsyncIterable<LlmStreamChunk>
}

export interface LlmService {
  prepareCall(
    config: { provider: string; model: string } & Record<string, unknown>,
    signal?: AbortSignal,
    configure?: (controls: Record<string, unknown>, model: unknown) => Record<string, unknown>,
  ): Promise<LlmPreparedCall>
}

export interface ClassifierDeps {
  /** 惰性取 `ctx.llm`：服务没起来时只有选档失败，别的照常。 */
  llm: () => LlmService | undefined
  /** `provider/model`，例如 `deepseek-official/deepseek-flash`。 */
  model: string
  /** 推理档 id；空串 = 不传，用路由默认。 */
  effort: string
  timeoutMs: number
  /** 回答最多多少 token：一句档名加一句理由，给多了纯浪费。 */
  maxOutputTokens?: number
  warn?: (message: string) => void
}

const CLASSIFY_TIMEOUT_CODE = 'DISPATCHER_CLASSIFY_TIMEOUT'
const DEFAULT_MAX_OUTPUT_TOKENS = 200

/** 时限内没回话就 abort：这个 promise 已经没用了，别把开票卡住。 */
class TimeoutReason extends Error {
  readonly code = CLASSIFY_TIMEOUT_CODE
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`${CLASSIFY_TIMEOUT_CODE} after ${timeoutMs}ms`)
    this.name = 'TimeoutReason'
    this.timeoutMs = timeoutMs
  }
}

/**
 * `@deepseek-ai/dsh-timeout` 的 `deadline()` 同款：上游取消 + 定时 abort 融成
 * 一个信号，dispose 清定时器。抄进来是因为本包不依赖它（依赖面只有 cordis /
 * schemastery / dsh-tools），而行为就这三行，抄比多一个运行时依赖便宜。
 */
function deadline(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  makeReason: () => Error,
): { signal: AbortSignal; dispose(): void } {
  if (!(timeoutMs > 0)) {
    return { signal: upstream ?? new AbortController().signal, dispose() {} }
  }
  const timer = new AbortController()
  const handle = setTimeout(() => timer.abort(makeReason()), timeoutMs)
  // 定时器不该拖住进程退出；测试里 fake timer 没有 unref 也能跑。
  ;(handle as unknown as { unref?: () => void }).unref?.()
  return {
    signal: upstream ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
    dispose() {
      clearTimeout(handle)
    },
  }
}

/** `provider/model` → 两栏。只按第一个斜杠切，模型名里带斜杠是合法的。 */
export function parseModelRoute(model: string): { provider: string; model: string } {
  const trimmed = model.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`classifyModel 要写成 provider/model（现在：${trimmed || '(空)'}）`)
  }
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
}

function presetLine(preset: PresetInfo): string {
  const name = preset.name?.trim()
  const detail = (preset.description ?? preset.whenToUse ?? '').trim()
  const head = name ? `${preset.id}（${name}）` : preset.id
  return detail ? `- ${head}：${detail}` : `- ${head}`
}

/**
 * system prompt：档位表 + 一条硬判据 + 输出格式。
 *
 * 「要写盘或要跑命令就不许给只读档」这句必须原样留着：模型很容易把「看一下
 * 这个仓库」判成只读档，鱼拿到手就干瞪眼。
 */
export function buildClassifySystem(presets: readonly PresetInfo[]): string {
  return [
    '你是派活分诊：读一张待派工单，从下面这几个档里挑一个给小鱼。',
    '档位：',
    ...presets.map(presetLine),
    '判据：这一轮要写盘、要改文件、要跑命令的，就一定不能给只会读的档；拿不准就给工具最全的那个常规档。',
    '另起一行写 NEEDS_COMMAND: yes 或 no——这轮要不要真的执行命令（只读看文件、只查记忆都算 no）。',
    '只输出三样：第一行档名（原样照抄上面的 id），第二行一句理由，最后一行 NEEDS_COMMAND: yes|no。别写解释、别写别的档。',
  ].join('\n')
}

export function buildClassifyInput(input: ClassifyInput): string {
  const lines = [`目标：${input.goal}`, `摘要：${input.brief}`]
  if (input.dir) lines.push(`工作目录：${input.dir}`)
  return lines.join('\n')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 宽容解析：多余引号、句号、`档位：` 前缀、后面跟一句理由都认。
 *
 * 只认整词：`t1` 不能命中 `t10`，也不能命中 `at1x`。同一段里出现多个档名时
 * 取最先出现的那个——模型的第一个词通常就是结论。
 */
/**
 * 分类器的第三行：`NEEDS_COMMAND: yes|no`。
 *
 * 只有 yes / no 两态加「没写」；认 true/false 和中文是给模型手滑留的余地。
 * 没写就返回 undefined——这时选档守卫只看关键词兜底，不把「没表态」当成「不要」。
 */
export function parseNeedsCommand(text: string): boolean | undefined {
  const found = /NEEDS_COMMAND\s*[:：]\s*(yes|no|true|false|是|否)/i.exec(text)
  if (!found?.[1]) return undefined
  const value = found[1].toLowerCase()
  return value === 'yes' || value === 'true' || value === '是'
}

export function parseChoice(text: string, presets: readonly PresetInfo[]): ClassifyChoice | undefined {
  const ids = presets.map((preset) => preset.id).filter((id) => id.length > 0)
  if (ids.length === 0) return undefined
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    let best: { id: string; at: number } | undefined
    for (const id of ids) {
      const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(id)}(?![A-Za-z0-9_-])`)
      const found = pattern.exec(line)
      if (!found) continue
      if (!best || found.index < best.at) best = { id, at: found.index }
    }
    if (!best) continue
    // 理由 = 档名后面那一截；同一行没有就借下一行的第一句。
    let why = line.slice(best.at + best.id.length)
    why = why.replace(/^[\s：:，,。.\-—"'「」（）()【】\[\]]+/, '')
    if (!why) {
      const next = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0) ?? ''
      why = next.trim()
    }
    why = why.replace(/[\s。.;；]+$/, '').trim()
    // 理由不许太长：它是给人看的一行，不是模型的思考过程。
    const shortened = Array.from(why).slice(0, 120).join('')
    const needsCommand = parseNeedsCommand(text)
    return {
      preset: best.id,
      ...(shortened ? { why: shortened } : {}),
      ...(needsCommand !== undefined ? { needsCommand } : {}),
    }
  }
  return undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 真分类器。所有失败都抛，回落由 publish.ts 做。 */
export function createLlmClassifier(deps: ClassifierDeps): Classifier {
  const warn = deps.warn ?? (() => {})
  const maxOutputTokens = deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS

  return {
    async classify(input: ClassifyInput): Promise<ClassifyChoice> {
      if (input.presets.length === 0) throw new Error('没有档位可选')
      const llm = deps.llm()
      if (!llm?.prepareCall) throw new Error('llm 服务不可用：选不了档')
      const route = parseModelRoute(deps.model)
      const effort = deps.effort.trim()
      const scoped = deadline(undefined, deps.timeoutMs, () => new TimeoutReason(deps.timeoutMs))
      const startedAt = Date.now()
      try {
        const call = await llm.prepareCall(
          { ...route, ...(effort ? { reasoningEffort: effort } : {}), maxTokens: maxOutputTokens },
          scoped.signal,
        )
        const options: Record<string, unknown> = {
          ...call.config,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: buildClassifyInput(input) }],
            },
          ],
          system: buildClassifySystem(input.presets),
          signal: scoped.signal,
        }
        let text = ''
        for await (const chunk of call.stream(options)) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'finish') {
            const kind = chunk.reason?.kind
            if (kind === 'error' || kind === 'aborted') {
              throw new Error(`模型报错：${chunk.reason?.failure?.message ?? kind}`)
            }
          }
        }
        // 被时限掐断时流会正常结束、一个字都没有；这时候要报超时，别误报「没给出档名」。
        if (scoped.signal.aborted) {
          throw (scoped.signal.reason as Error | undefined) ?? new TimeoutReason(deps.timeoutMs)
        }
        const choice = parseChoice(text, input.presets)
        if (!choice) {
          // 回答本身不记：里面可能带着工单原文。
          warn(`[dispatcher] 分类器没给出合法档名（${route.model}，${text.length} 字），用默认档`)
          throw new Error('模型没给出合法档名')
        }
        return choice
      } catch (error) {
        warn(
          `[dispatcher] 分类器失败（${route.provider}/${route.model}，${Date.now() - startedAt}ms）：${messageOf(error)}`,
        )
        throw error
      } finally {
        scoped.dispose()
      }
    },
  }
}
