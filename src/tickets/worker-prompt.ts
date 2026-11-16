/**
 * worker 提示词：一段所有 worker 共用，一段按档追加。
 *
 * 两段都只是「后缀」——不改 `buildPrompt` 那套任务书模板（票号、工作目录、
 * dispatch_report 交活那几句一个字都不动），也不覆盖主会话的 handoffPolicyText。
 * 空串 = 不追加；两段都空时拼出来是空串，调用方据此连 section 都不加，模型那边
 * 不会看见空段落或者多出来的分隔线。
 *
 * 注入落点是真·系统提示词（`system-prompt/assemble` 的 section），不是首条
 * 消息：宿主的 `startActivation` 没有 systemPrompt 入口（`SubagentStartRequest`
 * 只有 cwd / agentPreset / label / prompt / parent / signal / agentOptions /
 * outputSchema / maxDepth），但子会话的系统提示词装配照样走这个钩子，所以这
 * 是最靠前、又不碰任务书的位置。
 */
import type { PresetPromptConfig } from '../config'

/** 从 `presets` 配置里取某一档的 `promptSuffix`；没配、写成字符串、档名对不上都回空串。 */
export function presetPromptSuffix(
  entries: readonly PresetPromptConfig[] | undefined,
  presetId: string | undefined,
): string {
  const id = typeof presetId === 'string' ? presetId.trim() : ''
  if (!id || !Array.isArray(entries)) return ''
  for (const entry of entries) {
    // 字符串写法只表达「这档存在、不追加」，不该被当成要匹配的文本。
    if (typeof entry === 'string') continue
    if (typeof entry.name !== 'string' || entry.name.trim() !== id) continue
    const suffix = typeof entry.promptSuffix === 'string' ? entry.promptSuffix.trim() : ''
    return suffix
  }
  return ''
}

/**
 * 两段拼成一段：共用在前，档位在后，中间空一行。
 *
 * 任一段是空串（或全空白）就只剩另一段，不会留下前导/尾随空行；两段都空返回
 * 空串，调用方据此跳过注入。
 */
export function composeWorkerPrompt(shared: string | undefined, perPreset: string | undefined): string {
  const head = typeof shared === 'string' ? shared.trim() : ''
  const tail = typeof perPreset === 'string' ? perPreset.trim() : ''
  if (!head) return tail
  if (!tail) return head
  return `${head}\n\n${tail}`
}
