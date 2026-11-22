/**
 * 档位目录：从 cordis loader 的 entry 结构里读档位声明，不再解析 YAML 文本。
 *
 * 早先这条路是读 `registry.readDocument(id)` 回的 YAML 文本，再用正则找
 * `dsh-preset-toolset` 那行下面的 allow/deny。文本是给人看的渲染结果：补丁、
 * 表达式、缩进任何一处变样，正则就悄悄算错——算错的代价是选档守卫放行一个干
 * 不了活的档，子会话一上手就撞墙。所以那条路连降级都不做。
 *
 * loader 里每个 entry 的 `options.config` 是补丁叠好之后的结构化对象。档位声明
 * （`@deepseek-ai/dsh-agent-preset`）的 config 就是 PresetDefinition
 * `{ id, name, description, order, plugins }`；`plugins[]` 每行是子 entry 的
 * options，`config.allow` / `config.deny` 直接就是字符串数组。这里只读结构。
 *
 * 判据（criteria）也在这里拼：`promptSuffix` 原文 + 由 `allow` 实时推导出的能力
 * 标签。工具名到标签的对应只在 dispatcher 的 `config.criteria.labels` 里维护一份，
 * 本文件不存第二份名单。
 *
 * 扫不到档、或者声明里的 allow/deny 自相矛盾，都不猜：`tools` 回 undefined
 * （= 不分档 = 不做工具限制、全部工具可见），原因挂在 `problem` 上，由目录层
 * 记一行 warn 让人看见。任何情况下不静默。
 */
import type { PresetInfo } from './publish'
import type { PresetTools } from './preset-guard'

/** 声明档位的插件包名。loader entry 的 name 是模块说明符，可能带 scope 前缀。 */
const PRESET_PLUGIN = 'dsh-agent-preset'
/** 减工具面的那行插件。 */
const TOOLSET_PLUGIN = 'dsh-preset-toolset'

// ── 配置形状（`config.criteria`） ─────────────────────────────────

/** 一条能力标签：label 文字 + 一组工具名 glob。 */
export interface CriteriaLabel {
  /** 标签文字，也是输出顺序的依据（按 `labels` 数组顺序）。 */
  label: string
  /** 工具名 glob：只认 `*`，整名锚定，区分大小写。 */
  match: string[]
}

/** `required`：基线必含的名字与缺项处置。 */
export interface CriteriaRequired {
  names: string[]
  /** warn（默认）打 `crit_missing_required`；ignore 不打。缺项本身照算。 */
  onMissing: 'warn' | 'ignore'
}

/**
 * `config.criteria`：判据拼装的唯一配置来源。
 *
 * `labels` 没有默认名单——不在代码里再抄一份。没配就只拼 `promptSuffix`，并打
 * `crit_labels_missing`。
 */
export interface CriteriaConfig {
  labels: CriteriaLabel[]
  required: CriteriaRequired
  /** 有也不出标签的名字。 */
  silent: string[]
  /** 只当告警阈值：实际扫到的档数少于它才打 `crit_presets_short`。不配 = 不校验。 */
  expectedPresets?: number
}

// ── loader entry 的最小形状 ──────────────────────────────────────

/** loader entry 里本文件用得到的字段（`@deepseek-ai/cordis-plugin-loader` 的 Entry）。 */
export interface LoaderEntryLike {
  disabled?: boolean
  options?: {
    id?: string
    name?: string
    config?: unknown
  }
}

/** loader 服务里本文件用得到的部分。 */
export interface PresetLoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

/** 档位声明里的一行子插件（cordis entry options）。 */
export interface PresetPluginRow {
  name?: string
  config?: unknown
}

/** 一档的结构化目录行。 */
export interface PresetCatalogEntry {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: readonly PresetPluginRow[]
  /** 没挂 toolset = undefined；配置写坏了也 undefined，但会带 problem。 */
  tools: PresetTools | undefined
  /** tools 取不到的原因（给日志用）。没挂 toolset 时是「没挂」，不是坏档。 */
  problem?: string
}

// ── 纯函数：空白、glob、标签 ────────────────────────────────────

/** 拼装和日志共用：连续空白（含换行）折成一个空格 + strip。 */
export function normalizeWhitespace(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 工具名 glob：`*` 通配任意长度（含空），整名锚定，区分大小写。
 *
 * 只认 `*`——工具名里没有 `?` / `[]`，多一套通配语法只多一个漂移面。不含 `*`
 * 就是全等。
 */
export function globMatches(pattern: string, name: string): boolean {
  if (typeof pattern !== 'string' || pattern === '') return false
  if (!pattern.includes('*')) return pattern === name
  const body = pattern
    .split('*')
    .map((part) => escapeRegExp(part))
    .join('.*')
  return new RegExp(`^${body}$`).test(name)
}

/** 标签匹配结果：有/无的标签（按 labels 顺序）+ 谁都没命中的工具名。 */
export interface LabelMatchResult {
  /** 命中的标签文字，按 `labels` 数组顺序，同标签去重。 */
  have: string[]
  /** 没命中的标签文字，按 `labels` 数组顺序，同标签去重。 */
  lack: string[]
  /** 没被任何 label 命中的工具名，按 allow 顺序去重。 */
  unknown: string[]
}

/**
 * 按 `labels` 数组顺序做 glob 匹配。
 *
 * 一条工具可以命中多个标签（`bash` + `sbi_query` → 「执行命令」「SBI 语料」都出）；
 * 同一个标签文字命中多次只留一个。`unknown` 只表示「没被任何 label 命中」，
 * required / silent 的过滤在 `composeCriteria` 里做——这个函数只认 allow 与
 * labels 两样输入。
 */
export function labelsFromAllow(allow: Iterable<string>, labels: readonly CriteriaLabel[]): LabelMatchResult {
  const names = [...new Set([...allow].filter((name) => typeof name === 'string' && name !== ''))]
  const rows = (labels ?? []).filter(
    (label): label is CriteriaLabel =>
      Boolean(label) && typeof label.label === 'string' && label.label.trim() !== '',
  )
  const have: string[] = []
  const lack: string[] = []
  const seen = new Set<string>()
  for (const label of rows) {
    const text = label.label.trim()
    const patterns = Array.isArray(label.match) ? label.match : []
    const hit = names.some((name) => patterns.some((pattern) => globMatches(pattern, name)))
    if (seen.has(text)) continue
    seen.add(text)
    if (hit) have.push(text)
    else lack.push(text)
  }
  const unknown: string[] = []
  for (const name of names) {
    const matched = rows.some((label) =>
      (Array.isArray(label.match) ? label.match : []).some((pattern) => globMatches(pattern, name)),
    )
    if (!matched) unknown.push(name)
  }
  return { have, lack, unknown }
}

/** `composeCriteria` 的结果：拼好的正文 + warn 用的四栏。 */
export interface ComposedCriteria {
  /** promptSuffix 归一文本 + 工具面那行（labels 空时只有前者）。 */
  text: string
  have: string[]
  lack: string[]
  /** 没命中任何标签、也不在 required/silent 里的工具名。 */
  unknown: string[]
  /** `required.names` 里不在 allow 的名字（onMissing 只决定打不打 warn，不影响这一栏）。 */
  missingRequired: string[]
  /** labels 没配（或空数组）：没拼工具面那行。 */
  labelsMissing: boolean
}

/**
 * 拼一档判据（文档 1.5 那四步）。
 *
 * 1. `promptSuffix` 空白归一；
 * 2. 名字优先级：silent → required → labels；
 * 3. 标签按 `labels` 顺序输出「有 …；无 …」；
 * 4. labels 没配就只留 promptSuffix，并置 `labelsMissing` 让调用方打 warn。
 *
 * `allow` 是扣完 deny 之后的工具面名单（调用方负责先扣）。纯函数：不碰 loader、
 * ctx、fs，也不打日志。
 */
export function composeCriteria(
  promptSuffix: string,
  allow: Iterable<string>,
  criteria: CriteriaConfig,
): ComposedCriteria {
  const suffix = normalizeWhitespace(promptSuffix)
  const names = [...new Set([...allow].filter((name) => typeof name === 'string' && name !== ''))]
  const silent = new Set(criteria.silent ?? [])
  const requiredNames = criteria.required?.names ?? []
  const required = new Set(requiredNames)
  const missingRequired = requiredNames.filter((name) => !names.includes(name))
  const labels = criteria.labels ?? []

  // 名字优先级：silent / required 命中就不参与标签匹配，也不算「未匹配」。
  const labeled = names.filter((name) => !silent.has(name) && !required.has(name))
  const matched = labelsFromAllow(labeled, labels)
  const unknown = labels.length === 0 ? [] : matched.unknown

  if (labels.length === 0) {
    return { text: suffix, have: [], lack: [], unknown, missingRequired, labelsMissing: true }
  }
  // 空集合不占位：have 为空不写「有 …；」，lack 为空不写「无 …。」；两边都空
  // 整行省略（只剩 promptSuffix），免得拼出「有 无；无 无。」这种话。
  const segments: string[] = []
  if (matched.have.length > 0) segments.push(`有 ${matched.have.join('、')}`)
  if (matched.lack.length > 0) segments.push(`无 ${matched.lack.join('、')}`)
  const line = segments.length > 0 ? `工具面（由 allow 生成）：${segments.join('；')}。` : ''
  return {
    text: line ? (suffix ? `${suffix}\n${line}` : line) : suffix,
    have: matched.have,
    lack: matched.lack,
    unknown,
    missingRequired,
    labelsMissing: false,
  }
}

// ── 纯函数：结构化 plugins → 工具面 ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `@deepseek-ai/dsh-preset-toolset` 也算 `dsh-preset-toolset`。 */
function isPluginNamed(name: unknown, plugin: string): boolean {
  if (typeof name !== 'string') return false
  return name === plugin || name.endsWith(`/${plugin}`)
}

function isToolsetRow(row: unknown): row is PresetPluginRow {
  return isRecord(row) && isPluginNamed(row.name, TOOLSET_PLUGIN)
}

/**
 * 读一个 allow/deny 名单。
 *
 * 没给（undefined/null）= 这一套不启用；给了就得是非空字符串数组——跟
 * `dsh-preset-toolset` 自己的硬校验一致：空数组几乎肯定是配置漏了字段，
 * 当成「什么都不减」会静默放大工具面。
 */
function stringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`${where} 不是数组`)
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') throw new Error(`${where} 里有非字符串或空名字`)
    names.push(item.trim())
  }
  if (names.length === 0) throw new Error(`${where} 是空数组`)
  return names
}

/**
 * 从 `plugins[]` 读工具面。没有 toolset 行 = `undefined`（没减工具）。
 *
 * 多行 toolset 按 restrict 的语义合并：allow 取交集，deny 取并集，再从交集里扣
 * 掉被 deny 的；全是 deny 就返回并集。结果与以前正则那条路一致，只是不再解析
 * 文本。配置写坏（不是字符串数组、空数组、allow/deny 都没给）一律抛，由调用方
 * 降级为「不分档」并 warn。
 */
export function presetToolsOf(plugins: readonly PresetPluginRow[]): PresetTools | undefined {
  const rows = plugins.filter(isToolsetRow)
  if (rows.length === 0) return undefined

  const allows: Set<string>[] = []
  const denies = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const config = isRecord(row.config) ? row.config : {}
    const where = `${TOOLSET_PLUGIN} 第 ${index + 1} 行`
    const allow = stringList(config.allow, `${where} 的 allow`)
    const deny = stringList(config.deny, `${where} 的 deny`)
    if (allow === undefined && deny === undefined) {
      throw new Error(`${where} 既没有 allow 也没有 deny`)
    }
    if (allow !== undefined) allows.push(new Set(allow))
    if (deny !== undefined) for (const name of deny) denies.add(name)
  }

  if (allows.length > 0) {
    let names = new Set(allows[0]!)
    for (const row of allows.slice(1)) {
      names = new Set([...names].filter((name) => row.has(name)))
    }
    return { mode: 'allow', names: new Set([...names].filter((name) => !denies.has(name))) }
  }
  return { mode: 'deny', names: denies }
}

/** 扫描时把「配置漂了」的现场交出去；纯函数不自己打日志。 */
export interface ScanHooks {
  /** 同一个档名出现两条 entry：后者覆盖前者（不许静默）。 */
  onDuplicate?(id: string): void
  /** 是档位声明但 config 缺 id / plugins 不是数组：跳过并说明。 */
  onInvalid?(reason: string): void
}

/**
 * 扫一整棵 loader tree，回 `id → 目录行`。
 *
 * disabled 的 entry 跳过：它不会挂载，工具面也就无从谈起；拿它去校验，守卫会按
 * 「没挂 toolset = 全工具」放行一个其实装不上的档。同 id 后出现的覆盖先出现的，
 * 并走 `hooks.onDuplicate`（loader 里档名本该唯一，重复说明配置漂了）。
 * 是档位声明但缺 id / plugins 不是数组的，跳过并走 `hooks.onInvalid`。
 */
export function scanPresetEntries(
  entries: Iterable<LoaderEntryLike>,
  hooks: ScanHooks = {},
): Map<string, PresetCatalogEntry> {
  const out = new Map<string, PresetCatalogEntry>()
  for (const entry of entries) {
    if (entry?.disabled === true) continue
    const raw = entry.options?.config
    const named = isPluginNamed(entry.options?.name, PRESET_PLUGIN)
    const hasToolset = isRecord(raw) && Array.isArray(raw.plugins) && raw.plugins.some(isToolsetRow)
    // 两个入口都认：entry 的模块名，或者 plugins 里挂着减工具面的那行。
    if (!named && !hasToolset) continue
    if (!isRecord(raw)) {
      hooks.onInvalid?.(`entry ${entry.options?.id ?? '(无 id)'} 的 config 不是对象`)
      continue
    }
    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
      hooks.onInvalid?.(`entry ${entry.options?.id ?? '(无 id)'} 缺 id`)
      continue
    }
    const id = raw.id.trim()
    if (!Array.isArray(raw.plugins)) {
      hooks.onInvalid?.(`档 ${id} 的 plugins 不是数组`)
      continue
    }
    if (out.has(id)) hooks.onDuplicate?.(id)

    const plugins = raw.plugins as PresetPluginRow[]
    const row: PresetCatalogEntry = { id, plugins, tools: undefined }
    if (typeof raw.name === 'string' && raw.name.trim()) row.name = raw.name.trim()
    if (typeof raw.description === 'string' && raw.description.trim()) {
      row.description = raw.description.trim()
    }
    if (typeof raw.order === 'number' && Number.isFinite(raw.order)) row.order = raw.order
    try {
      row.tools = presetToolsOf(plugins)
    } catch (error) {
      row.problem = `档 ${id} 的 toolset 声明读不出：${messageOf(error)}`
    }
    out.set(id, row)
  }
  return out
}

// ── 目录工厂：缓存、惰性重扫、降级 warn、判据拼装 ────────────────

/** 判据快照：给回放导出口（`crit_src` / 降级清单 / 各档正文）。 */
export interface PresetCriteriaSnapshot {
  src: 'loader' | 'degraded'
  presets: PresetInfo[]
  degraded: { preset: string; reason: string }[]
  /**
   * 各档拼好的判据正文。键是 loader 扫到的档名，不写死成 `Verdict` 枚举：
   * 档数按扫到的行数算，与 1.5 的档数不写死一致；写死六档就是第二份真相。
   */
  rules: Partial<Record<string, string>>
  /** 整段判据（多档拼一起）的说明位；当前留空，回放侧按 rules 取。 */
  instructions: string
}

/** 目录要用到的注册表部分：只服务 list() 兜底与 defaultId()。 */
export interface PresetRegistryLike {
  list?: () => Promise<readonly { id?: string; name?: string; description?: string }[]>
  defaultId?: string
}

export interface PresetCatalogDeps {
  /** 每次调用都重新取一遍 entries（loader 可能在 apply 之后才叠完 patch）。 */
  entries(): Iterable<LoaderEntryLike>
  /** 注册表：只在目录还没扫到东西时兜底 list()，defaultId 一直用它。 */
  registryOf?(): PresetRegistryLike | undefined
  /** 某档的 promptSuffix 原文（来自 `config.presets`）。 */
  promptSuffixOf?(id: string): string
  criteria: CriteriaConfig
  warn(message: string): void
  info?(message: string): void
}

export interface PresetCatalogHandle {
  list(): Promise<PresetInfo[]>
  defaultId(): string | undefined
  tools(id: string): Promise<PresetTools | undefined>
  criteria(): PresetCriteriaSnapshot
  /** 丢掉目录与工具面缓存，下一次读重新扫 loader。 */
  invalidate(): void
}

export function createPresetCatalog(deps: PresetCatalogDeps): PresetCatalogHandle {
  const warn = deps.warn
  const info = deps.info ?? (() => {})
  const warned = new Set<string>()
  const toolsCache = new Map<string, PresetTools | undefined>()
  let directory: Map<string, PresetCatalogEntry>
  let rescanned = false

  const warnOnce = (line: string): void => {
    if (warned.has(line)) return
    warned.add(line)
    warn(line)
  }

  const infoOnce = (line: string): void => {
    if (warned.has(line)) return
    warned.add(line)
    info(line)
  }

  const warnEmptyDirectory = (): void => {
    warnOnce('[dispatcher] preset 目录为空（原因：entries 里没有 @deepseek-ai/dsh-agent-preset），选档退回默认档')
    // 与 crit_src=loader 成对：日志里一眼能看出这一轮判据是降级来的。
    infoOnce('[dispatcher] crit_src=degraded')
  }

  const scan = (): Map<string, PresetCatalogEntry> => {
    try {
      return scanPresetEntries(deps.entries(), {
        onDuplicate: (id) => warnOnce(`[dispatcher] preset 档名重复：${id}（后出现的覆盖前一条）`),
        onInvalid: (reason) => warnOnce(`[dispatcher] preset 声明不可用：${reason}`),
      })
    } catch (error) {
      warn(`[dispatcher] 扫不了 loader 里的档位声明：${messageOf(error)}`)
      return new Map()
    }
  }

  /** apply 时同步扫一次；扫到空是正常时序，不能 `await loader.await()`（会自锁）。 */
  directory = scan()
  if (directory.size === 0) {
    info('[dispatcher] preset 目录首次扫描为空（loader 未就绪），等首次用到再扫')
  }

  /**
   * 首次用到时必重扫一次（不看首扫空不空）；之后命中缓存，不再扫（invalidate 另算）。
   *
   * apply 那次扫描可能只赶上并发挂载的一部分档位，非空也得补扫：缺的档会一直按
   * 「没挂 toolset = 不分档」放行，直到 tools/change 触发 invalidate。
   */
  const current = (): Map<string, PresetCatalogEntry> => {
    if (rescanned) return directory
    rescanned = true
    directory = scan()
    if (directory.size === 0) warnEmptyDirectory()
    else infoOnce(`[dispatcher] preset 目录就绪 crit_src=loader presets=${directory.size}`)
    return directory
  }

  const infoOf = (entry: PresetCatalogEntry): PresetInfo => ({
    id: entry.id,
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.description ? { description: entry.description } : {}),
  })

  /** 拼一档判据；降级档只留 promptSuffix。返回 undefined 表示这档没拼工具面行。 */
  const composeFor = (row: PresetCatalogEntry): string => {
    const suffix = deps.promptSuffixOf?.(row.id) ?? ''
    if (row.tools === undefined || row.tools.mode !== 'allow') {
      // 没挂 toolset / 读坏了 / 只有 deny：没有 allow 名单可推，只留 promptSuffix。
      if (row.problem) {
        warnOnce(`[dispatcher] preset 目录取不到 ${row.id} 的工具面（原因：${row.problem}），按不分档放行`)
      } else if (row.tools) {
        // 只有 deny 名单：工具面按「全部工具减 deny」算，判据推不出「有…无…」。
        // 这不是静默的场合（文档 1.3）。
        warnOnce(`[dispatcher] crit_allow_empty preset=${row.id} reason=deny-only`)
      }
      return normalizeWhitespace(suffix)
    }
    if (row.tools.names.size === 0) {
      // allow 被 deny 扣空：工具面一个都不剩，判据只剩「无 …」。
      warnOnce(`[dispatcher] crit_allow_empty preset=${row.id} reason=allow-emptied`)
    }
    const composed = composeCriteria(suffix, row.tools.names, deps.criteria)
    if (composed.labelsMissing) warnOnce(`[dispatcher] crit_labels_missing preset=${row.id}`)
    for (const tool of composed.unknown) warnOnce(`[dispatcher] crit_unknown_tool preset=${row.id} tool=${tool}`)
    if (deps.criteria.required?.onMissing !== 'ignore') {
      for (const tool of composed.missingRequired) {
        warnOnce(`[dispatcher] crit_missing_required preset=${row.id} tool=${tool}`)
      }
    }
    return composed.text
  }

  return {
    async list() {
      const local = [...current().values()].map(infoOf)
      if (local.length > 0) return local
      // 目录还空着：注册表是第二来源，别把空目录当成「没有档」。
      const registry = deps.registryOf?.()
      let rows: readonly { id?: string; name?: string; description?: string }[] = []
      try {
        rows = (await registry?.list?.()) ?? []
      } catch (error) {
        warn(`[dispatcher] 读不到档位注册表：${messageOf(error)}`)
        return []
      }
      const out: PresetInfo[] = []
      for (const row of rows) {
        if (typeof row.id !== 'string' || row.id.length === 0) continue
        out.push({
          id: row.id,
          ...(row.name ? { name: row.name } : {}),
          ...(row.description ? { description: row.description } : {}),
        })
      }
      return out
    },
    defaultId() {
      const id = deps.registryOf?.()?.defaultId
      return typeof id === 'string' && id ? id : undefined
    },
    async tools(id) {
      if (toolsCache.has(id)) return toolsCache.get(id)
      const current_ = current()
      const row = current_.get(id)
      if (!row) {
        warnOnce(
          current_.size === 0
            ? `[dispatcher] preset 目录取不到 ${id} 的工具面（原因：entries 里没有 @deepseek-ai/dsh-agent-preset），按不分档放行`
            : `[dispatcher] preset 目录取不到 ${id} 的工具面（原因：loader 的 entries 里没有这个档的声明），按不分档放行`,
        )
        return undefined
      }
      if (row.problem) {
        warnOnce(`[dispatcher] preset 目录取不到 ${id} 的工具面（原因：${row.problem}），按不分档放行`)
        return undefined
      }
      if (row.tools === undefined) {
        warnOnce(
          `[dispatcher] preset 目录取不到 ${id} 的工具面（原因：plugins 里没有 ${TOOLSET_PLUGIN}），按不分档放行`,
        )
      } else {
        // 首次用到这档时顺手拼一次判据：crit_* 四种 warn 要能在运行期自己冒出来，
        // 不能等人先调 criteria()（回放导出口还没接）。warnOnce 保证不刷屏。
        composeFor(row)
      }
      toolsCache.set(id, row.tools)
      return row.tools
    },
    criteria() {
      const dir = current()
      const presets = [...dir.values()].map(infoOf)
      const rules: Partial<Record<string, string>> = {}
      const degraded: { preset: string; reason: string }[] = []
      for (const row of dir.values()) {
        rules[row.id] = composeFor(row)
        if (row.tools === undefined) {
          degraded.push({ preset: row.id, reason: row.problem ?? `plugins 里没有 ${TOOLSET_PLUGIN}` })
        }
      }
      // 档数不写死：实际几条就是几条；expectedPresets 只当阈值，不补空档。
      const expected = deps.criteria.expectedPresets
      if (typeof expected === 'number' && dir.size > 0 && dir.size < expected) {
        warnOnce(`[dispatcher] crit_presets_short expected=${expected} got=${dir.size}`)
      }
      return {
        src: dir.size > 0 ? 'loader' : 'degraded',
        presets,
        degraded,
        rules,
        instructions: '',
      }
    },
    invalidate() {
      directory = scan()
      rescanned = false
      toolsCache.clear()
      if (directory.size === 0) {
        // 热重载空档：先别急着报到「目录为空」，等首次用到那次重扫。
        info('[dispatcher] preset 目录重扫为空（loader 未就绪），等首次用到再扫')
      }
    },
  }
}
