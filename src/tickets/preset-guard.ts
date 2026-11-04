/**
 * 选档守卫：在「档名合法」之外再问一句「这活干得了吗」。
 *
 * 分类器只回一个档名加一句理由（classify.ts），它说 t2 就 t2——哪怕任务书写着
 * 「要真的用 bash 跑命令」。2026-11-04 那两张 git 勘察票就是这么派空的：一张
 * 白跑，一张补跑。这一层不看模型怎么措辞，只对两件事实：
 *
 *   1. 任务要不要执行命令（模型声明的 `needsCommand`；false 也查关键词，命中即矛盾）；
 *   2. 这个档的工具面里有没有能执行命令的工具（从档位声明的 YAML 读 allow/deny）。
 *
 * 三条规则按顺序判，第一条中就不往下走：
 *
 * - **rule0** 档不存在 / 装不上：`toolsOf` 抛错（读不到声明、解析不出工具面）
 *   也归这里。解析失败一律不放行——宁可拦错一次让人看见，不静默派错。
 * - **rule1** 档不在 `allowedPresets` 镜像里。镜像由接线层从配置抄一份，启动
 *   时对注册表校验（见 src/index.ts）。
 * - **rule2** 任务要跑命令、而档里没有命令工具。驳回，并给一个有命令工具的
 *   档名当建议（按 allow 名单长度取最省的那档）。
 *
 * 驳回不建票：票是小屏和 /tickets 上给人看的，闪一张假票会让人以为派过活。
 * `checkPresetChoice` 只返回驳回理由，接线层（desk）记一行 rejected 日志再把
 * `PresetRejectedError` 甩给工具层，`dispatch_open` 的返回文本就是它。
 *
 * 工具面解析的对象是 preset 注册表的 `readDocument(id)`——它回的是档位声明里
 * `plugins` 的 YAML 文本，不是工具名列表（注册表没有这个 API）。所以这里只做
 * 一件窄事：找 `dsh-preset-toolset` 那行下面的 `allow` / `deny` 序列。没挂
 * toolset = 没减工具 = 全局工具面都在，能跑命令。换档位写法时先看这段。
 */

/** 能执行命令的工具名。名单只在这里维护，判断处一律走 `toolRunsCommands`。 */
export const COMMAND_TOOLS: readonly string[] = [
  'bash',
  'shell',
  'run_command',
  'execute_command',
  'terminal',
]

/** MCP 那类名字是 `mcp__server__tool`，只认最后一段。 */
export function toolRunsCommands(name: string): boolean {
  if (COMMAND_TOOLS.includes(name)) return true
  const at = name.lastIndexOf('__')
  return at >= 0 && COMMAND_TOOLS.includes(name.slice(at + 2))
}

/** 一个档的工具面：allow = 只留这些，deny = 挡掉这些。 */
export interface PresetTools {
  mode: 'allow' | 'deny'
  names: ReadonlySet<string>
}

/** 这个档能不能执行命令。没挂 toolset（undefined）= 没减工具 = 能。 */
export function presetRunsCommands(tools: PresetTools | undefined): boolean {
  if (tools === undefined) return true
  const hasCommandTool = [...tools.names].some(toolRunsCommands)
  // deny 模式下「有命令工具」意味着它被挡了。
  return tools.mode === 'allow' ? hasCommandTool : !hasCommandTool
}

/** 声明里那行 `- name: 'dsh-preset-toolset'`（引号可有可无）。 */
const TOOLSET_NAME_LINE = /^(\s*)-\s*name:\s*['"]?dsh-preset-toolset['"]?\s*$/

function unquote(value: string): string {
  return value
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim()
}

/**
 * 从 `readDocument(id).content` 里读工具面。
 *
 * - 没有任何 toolset 行 → `undefined`（没减工具）。
 * - 多行 toolset 时按 restrict 的语义合并：allow 取交集，deny 取并集，再从交集里
 *   扣掉被 deny 的。全是 deny 就返回并集。
 *
 * YAML 是 `dump()` 出来的，所以只认「缩进 + 短横线」这一种形状；认不出就是
 * 「没有工具面声明」，由调用方决定是放行还是驳回（本文件的选择是驳回）。
 */
export function parseToolsetDocument(content: string): PresetTools | undefined {
  const lines = content.split(/\r?\n/)
  const rows: { mode: 'allow' | 'deny'; names: Set<string> }[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const head = TOOLSET_NAME_LINE.exec(lines[index] ?? '')
    if (!head) continue
    const pluginIndent = (head[1] ?? '').length

    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan] ?? ''
      const trimmed = line.trim()
      if (trimmed === '') continue
      const indent = line.length - line.trimStart().length
      // 回到同层或更外层：这一行 toolset 的声明结束了。
      if (indent <= pluginIndent) break
      const key = /^\s*(allow|deny):\s*$/.exec(line)
      if (!key) continue
      const keyIndent = indent
      const names = new Set<string>()
      for (let item = scan + 1; item < lines.length; item += 1) {
        const entry = lines[item] ?? ''
        const text = entry.trim()
        if (text === '') continue
        const itemIndent = entry.length - entry.trimStart().length
        if (itemIndent <= keyIndent) break
        const value = /^-\s*(.+?)\s*$/.exec(text)
        if (value?.[1]) names.add(unquote(value[1]))
      }
      rows.push({ mode: key[1] === 'allow' ? 'allow' : 'deny', names })
    }
  }

  if (rows.length === 0) return undefined
  const allows = rows.filter((row) => row.mode === 'allow')
  const denies = rows.filter((row) => row.mode === 'deny')
  if (allows.length > 0) {
    let names = new Set(allows[0]!.names)
    for (const row of allows.slice(1)) {
      names = new Set([...names].filter((name) => row.names.has(name)))
    }
    const denied = new Set(denies.flatMap((row) => [...row.names]))
    return { mode: 'allow', names: new Set([...names].filter((name) => !denied.has(name))) }
  }
  return { mode: 'deny', names: new Set(denies.flatMap((row) => [...row.names])) }
}

/**
 * 关键词兜底用的默认表。示意的都是「会动到系统」的动词/命令名；真的调表在
 * 配置里（config.commandKeywords），这里只是没配时的兜底。
 */
export const DEFAULT_COMMAND_KEYWORDS: readonly string[] = [
  '需要执行命令',
  '执行命令',
  '跑命令',
  '跑测试',
  '跑一下',
  '实测',
  '构建',
  '编译',
  '安装',
  'git',
  'npm',
  'npx',
  'pnpm',
  'bash',
  'systemctl',
  '脚本',
  '重跑',
  'grep',
  'zstd',
  'gunzip',
  'sed',
  'awk',
  'curl',
  'journalctl',
  '解压',
  '日志',
  '会话记录',
  'cat',
  '排序',
  '统计',
  '跑一遍',
  '执行',
]

/** 分句：负向词只否决它所在的那一句，不能把整张任务书一起否决掉。 */
const CLAUSE_SEPARATOR = /[。；;！!？?\n，,]/

/** 出现这些词的分句不算「要跑命令」；「别」要躲开「特别/区别/别人」。 */
const NEGATIVE_WORDS = ['不许', '不准', '不要', '禁止', '无需', '不用', '不得', '不能', '勿']
const NEGATIVE_BIE = /别(?!的|处|人|是)/

function clauseIsNegative(clause: string): boolean {
  if (NEGATIVE_WORDS.some((word) => clause.includes(word))) return true
  return NEGATIVE_BIE.test(clause)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 拉丁关键词按整词认，中文按包含认：`git` 不该命中 `digit`。 */
function clauseHasKeyword(clause: string, keyword: string): boolean {
  const word = keyword.trim()
  if (!word) return false
  if (/^[A-Za-z0-9._-]+$/.test(word)) {
    return new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(word)}(?![A-Za-z0-9._-])`, 'i').test(clause)
  }
  return clause.includes(word)
}

/**
 * 任务书里的「要跑命令」迹象，返回命中的词（给日志用）。
 *
 * 负向分句先剔掉：任务书写「不许跑命令，只读文件」时，这一句里的「跑命令」不算。
 */
export function commandHint(goal: string, keywords: readonly string[] = DEFAULT_COMMAND_KEYWORDS): string | undefined {
  for (const clause of goal.split(CLAUSE_SEPARATOR)) {
    if (clause.trim() === '' || clauseIsNegative(clause)) continue
    for (const keyword of keywords) {
      if (clauseHasKeyword(clause, keyword)) return keyword.trim()
    }
  }
  return undefined
}

export type RejectRule = 'preset-unavailable' | 'not-allowed' | 'needs-command-no-bash'

export interface PresetRejection {
  rule: RejectRule
  preset: string
  /** 一行内部原因（进日志）。 */
  reason: string
  /** 给模型和主人看的整段文本（dispatch_open 的错误就是它）。 */
  message: string
  /** rule2 专用：命中的关键词，方便以后调表。 */
  matchedKeyword?: string
}

/** 驳回：desk 记完日志就把这个甩给工具层，不建票。 */
export class PresetRejectedError extends Error {
  readonly rule: RejectRule
  readonly preset: string

  constructor(rejection: PresetRejection) {
    super(rejection.message)
    this.name = 'PresetRejectedError'
    this.rule = rejection.rule
    this.preset = rejection.preset
  }
}

export interface PresetCheckInput {
  preset: string
  /** 档的中文名，写进驳回文本（t2（只读））。 */
  label?: string
  /** 分类器声明的三态：true 必查、false 也查关键词（命中即矛盾）、undefined 只走关键词兜底。 */
  needsCommand?: boolean
  goal: string
  /** 允许档位镜像；空数组 = 不校验 rule1。 */
  allowedPresets: readonly string[]
  keywords: readonly string[]
  /** 读一个档的工具面；抛错按 rule0 驳回。 */
  toolsOf: (id: string) => Promise<PresetTools | undefined>
  /** 注册表里的档名，用来判「档不存在」和挑建议档。 */
  candidates: readonly string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 最省的「有命令工具」档：allow 名单越短越省；没挂 toolset 的排最后。 */
async function suggestCommandPreset(
  candidates: readonly string[],
  allowedPresets: readonly string[],
  toolsOf: (id: string) => Promise<PresetTools | undefined>,
): Promise<string | undefined> {
  const pool = allowedPresets.length > 0 ? candidates.filter((id) => allowedPresets.includes(id)) : candidates
  const big = Number.MAX_SAFE_INTEGER
  let best: string | undefined
  let bestCost = big
  for (const id of pool) {
    let tools: PresetTools | undefined
    try {
      tools = await toolsOf(id)
    } catch {
      continue
    }
    if (!presetRunsCommands(tools)) continue
    const cost = tools === undefined ? big - 1 : tools.mode === 'allow' ? tools.names.size : big - 2
    if (cost < bestCost) {
      bestCost = cost
      best = id
    }
  }
  return best
}

/**
 * 判一张票的档配不配这活。返回 undefined = 放行。
 *
 * 顺序固定，rule0 → rule1 → rule2；每条只判一次，不合并理由——驳回文本要能
 * 直接照着重开，混三条原因反而看不清该改哪。
 */
export async function checkPresetChoice(input: PresetCheckInput): Promise<PresetRejection | undefined> {
  const label = input.label ? `${input.preset}（${input.label}）` : input.preset

  // rule0：档要在注册表里，装得上（工具面读不出来也算装不上）。
  if (input.candidates.length > 0 && !input.candidates.includes(input.preset)) {
    const known = input.candidates.join(' / ')
    return {
      rule: 'preset-unavailable',
      preset: input.preset,
      reason: `注册表里没有 ${input.preset}`,
      message: `选档驳回：没有 ${input.preset} 这个档（现有：${known}）。换一个档再开票。`,
    }
  }
  let tools: PresetTools | undefined
  try {
    tools = await input.toolsOf(input.preset)
  } catch (error) {
    const reason = `读不到 ${input.preset} 的工具面：${messageOf(error)}`
    return {
      rule: 'preset-unavailable',
      preset: input.preset,
      reason,
      message: `选档驳回：档 ${label} 装不上（${reason}）。解析不出工具面就不派活，换一档再开。`,
    }
  }

  // rule1：档要在允许清单里。
  if (input.allowedPresets.length > 0 && !input.allowedPresets.includes(input.preset)) {
    const allowed = input.allowedPresets.join(' / ')
    return {
      rule: 'not-allowed',
      preset: input.preset,
      reason: `不在 allowedPresets（${allowed}）里`,
      message: `选档驳回：选出来的档 ${label} 不在允许档位里（只有 ${allowed}）。从这几个里挑一个重开。`,
    }
  }

  // rule2：任务要跑命令，档里就得有命令工具。
  let matchedKeyword: string | undefined
  let needsCommand = false
  let contradiction = false
  if (input.needsCommand === true) {
    needsCommand = true
  } else {
    // false 也查一遍：模型说「不用命令」但任务书里明写着 grep/解压/journalctl，
    // 这是自相矛盾，按要命令处理。undefined 维持原样（只靠关键词兜底）。
    matchedKeyword = commandHint(input.goal, input.keywords)
    needsCommand = matchedKeyword !== undefined
    contradiction = input.needsCommand === false && matchedKeyword !== undefined
  }
  if (!needsCommand || presetRunsCommands(tools)) return undefined

  const suggestion = await suggestCommandPreset(input.candidates, input.allowedPresets, input.toolsOf)
  const evidence =
    input.needsCommand === true
      ? '分类器判断这轮要执行命令'
      : contradiction
        ? `任务书里出现命令类词「${matchedKeyword ?? ''}」，判成不需要执行命令`
        : `任务书命中关键词「${matchedKeyword ?? ''}」`
  const advice = suggestion
    ? `建议改用 ${suggestion}（有 bash），或`
    : '换一个有 bash 的档，或'
  return {
    rule: 'needs-command-no-bash',
    preset: input.preset,
    reason: `任务要执行命令，${label} 没有命令工具（${evidence}）`,
    ...(matchedKeyword ? { matchedKeyword } : {}),
    message:
      `选档驳回：任务要执行命令，但 ${label}档没有 bash（该档 allow 名单里没有命令工具）。` +
      (contradiction
        ? `任务书里出现命令类词「${matchedKeyword ?? ''}」，判成不需要执行命令，前后矛盾；`
        : '') +
      `改任务书：${advice}把「只读/纯勘察」改成明确写「要用 bash 跑命令」，然后再开一张票。`,
  }
}
