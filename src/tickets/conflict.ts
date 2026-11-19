/**
 * 两票资源冲突判定（设计稿 v0.2.4 §6）。
 *
 * 输入是两张票的资源声明，`{ writes, reads }`，元素是 `resources.ts` 那六种前缀
 * 的资源串；进来先过一次 `scanGitResources`，两票只在同一个写法下求交。输出
 * 三档：strong（拦）、weak（提示放行）、none（不冲突），附人话理由与撞上的资源。
 *
 * 判据按写对写分档，只有两边都写才可能强冲突：一边只读、一边写一律降到 weak。
 * 目录类（dir / git）一律按路径边界判包含，`/a/b` 与 `/a/bc` 不算祖先。
 * git 退化成目录判断：同一个路径强冲突，互为祖先后代也强冲突，worktree 不单列。
 *
 * 这一层是纯判定：不认识票、不读 desk、不写日志、不碰状态迁移，也没有调用方。
 * 一件故意不管的事：`writes` 为空但票标了 degraded 的目录回填由调用方先做。
 */
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { findGitRoot, parseResource, scanGitResources, scanResources } from './resources'
import type { InvalidResource, ResourceOptions } from './resources'
import type { ResourceKind } from './resources'

/** 判定时可注入的资源探测（测试用假 fs，生产用默认实现）。 */
export interface ConflictOptions {
  resources?: ResourceOptions
}

/** 一张票的声明：写什么、只读什么。缺席就是空。 */
export interface ConflictSide {
  writes?: readonly string[]
  reads?: readonly string[]
}

/** strong 拦、weak 提示放行、none 不相交。 */
export type ConflictLevel = 'strong' | 'weak' | 'none'

/** 判定时认不出来的资源串：标明是哪一侧的，调用方好带上票号 warn。 */
export interface InvalidConflictResource extends InvalidResource {
  side: 'a' | 'b'
}

/** 判定结果：`reasons` 是人话，`resources` 是撞上的归一化资源串。 */
export interface ConflictVerdict {
  level: ConflictLevel
  reasons: string[]
  resources: string[]
  /** 声明里认不出来的串；不影响其余资源的判定，但要让人看见。 */
  invalid?: InvalidConflictResource[]
}

interface Resource {
  kind: ResourceKind
  value: string
  /** 归一化后的原串，回给人看的就是它。 */
  uri: string
}

function toResources(
  raw: readonly string[] | undefined,
  options: ConflictOptions,
): { resources: Resource[]; invalid: InvalidResource[] } {
  const scan = scanGitResources(raw ?? [], options.resources)
  const resources = scan.resources.map((uri) => {
    const { kind, value } = parseResource(uri)
    return { kind, value, uri }
  })
  return { resources, invalid: scan.invalid }
}

/**
 * 不补 git 根的归一化：越界对账只认票面写下的资源，自动补的仓库根会把
 * 「同仓但没声明」的文件也盖过去，那就失去对账意义了。
 */
function toPlainResources(raw: readonly string[] | undefined): Resource[] {
  return scanResources(raw ?? []).resources.map((uri) => {
    const { kind, value } = parseResource(uri)
    return { kind, value, uri }
  })
}

/** 路径边界包含：`/a/b` 含 `/a/b/c`，不含 `/a/bc`；根目录含所有绝对路径。 */
function under(child: string, parent: string): boolean {
  if (child === parent) return true
  if (parent === '/') return true
  return child.startsWith(`${parent}/`)
}

/** 同一个资源，或祖先/后代关系（读与写求交用，包含相等）。 */
function sameRepo(a: Resource, b: Resource, options: ConflictOptions): boolean {
  if (a.kind !== 'git' || b.kind !== 'git') return false
  const ga = findGitRoot(a.value, options.resources)
  const gb = findGitRoot(b.value, options.resources)
  return ga !== undefined && gb !== undefined && ga.root === gb.root
}

function sameOrContains(a: Resource, b: Resource, options: ConflictOptions): boolean {
  if (a.kind === b.kind) {
    // dir 按路径边界双向判；git 先看是不是同一个仓库，再看路径边界。
    if (a.kind === 'dir') return under(a.value, b.value) || under(b.value, a.value)
    if (a.kind === 'git') {
      if (a.value === b.value || sameRepo(a, b, options)) return true
      return under(a.value, b.value) || under(b.value, a.value)
    }
    return a.value === b.value
  }
  const dir = a.kind === 'dir' ? a : b.kind === 'dir' ? b : undefined
  if (!dir) return false
  const other = a.kind === 'dir' ? b : a
  // git 与 dir 混着比也走双向路径规则。
  if (other.kind === 'git') return under(other.value, dir.value) || under(dir.value, other.value)
  // file / dev 落在 dir 里才算包含；dir 不可能落在它们里面。
  return under(other.value, dir.value)
}

/**
 * 两边都写、都是 git：判级按设计稿 §6 的两种模式。
 *
 * - 同一个仓库根、都没声明 worktree：强（共享 index/HEAD/stash）；
 * - 同一仓库的两个不同 worktree：不在这里拦，落到 weak；
 * - 一边 worktree、一边仓库根：强（保守，worktree 之外还有共享状态）；
 * - 探不到仓库（老票 / 假路径）：退回原来的路径边界判，相等或互为祖先都强。
 */
function gitGitHit(a: Resource, b: Resource, options: ConflictOptions): string | undefined {
  if (a.value === b.value) return `两票都写同一个 git 路径 ${a.uri}`
  const ga = findGitRoot(a.value, options.resources)
  const gb = findGitRoot(b.value, options.resources)
  if (ga && gb && ga.root === gb.root) {
    if (ga.worktree && gb.worktree && ga.top !== gb.top) return undefined
    return `两票都在同一个 git 仓库 ${ga.root} 里写（${a.uri} / ${b.uri}）`
  }
  if (under(a.value, b.value)) return `git 路径 ${b.uri} 包含 ${a.uri}，两票都在写`
  if (under(b.value, a.value)) return `git 路径 ${a.uri} 包含 ${b.uri}，两票都在写`
  return undefined
}

/** 一票写 dir、一票写 git：git 退化成目录，走同一条路径规则。 */
function dirGitHit(dir: Resource, git: Resource): string | undefined {
  if (dir.value === git.value) return `一票写目录 ${dir.uri}，另一票写同一路径的 git ${git.uri}`
  if (under(git.value, dir.value)) return `一票写目录 ${dir.uri}，另一票写目录里的 git ${git.uri}`
  if (under(dir.value, git.value)) return `一票写 git ${git.uri}，另一票写它里面的目录 ${dir.uri}`
  return undefined
}

/** 两边都写：强冲突的那几条。`undefined` 表示这一对不构成强冲突。 */
function strongHit(a: Resource, b: Resource, options: ConflictOptions): string | undefined {
  if (a.kind === b.kind) {
    switch (a.kind) {
      case 'file':
        return a.value === b.value ? `两票都写同一个文件 ${a.uri}` : undefined
      case 'git':
        return gitGitHit(a, b, options)
      case 'svc':
        return a.value === b.value ? `两票都写同一个服务 ${a.uri}` : undefined
      case 'port':
        return a.value === b.value ? `两票都占同一个端口 ${a.uri}` : undefined
      case 'dev':
        return a.value === b.value ? `两票都占同一个设备 ${a.uri}` : undefined
      case 'dir':
        if (a.value === b.value) return `两票都写同一个目录 ${a.uri}`
        if (under(a.value, b.value)) return `目录 ${b.uri} 包含 ${a.uri}，两票都在写`
        if (under(b.value, a.value)) return `目录 ${a.uri} 包含 ${b.uri}，两票都在写`
        return undefined
    }
  }
  const dir = a.kind === 'dir' ? a : b.kind === 'dir' ? b : undefined
  if (!dir) return undefined
  const other = a.kind === 'dir' ? b : a
  if (other.kind === 'file' && under(other.value, dir.value)) {
    return `一票写整个目录 ${dir.uri}，另一票写目录里的文件 ${other.uri}`
  }
  if (other.kind === 'git') return dirGitHit(dir, other)
  return undefined
}

/** 两边都写、又没到强冲突：同 dir 下不同 file、同仓库不同 worktree 算弱。 */
function weakHit(a: Resource, b: Resource, options: ConflictOptions): string | undefined {
  if (a.kind === 'git' && b.kind === 'git') {
    if (a.value === b.value) return undefined
    const ga = findGitRoot(a.value, options.resources)
    const gb = findGitRoot(b.value, options.resources)
    if (ga && gb && ga.root === gb.root && ga.worktree && gb.worktree && ga.top !== gb.top) {
      return `同一个 git 仓库 ${ga.root} 的两个 worktree（${a.uri} / ${b.uri}），按文件级并行`
    }
    return undefined
  }
  if (a.kind !== 'file' || b.kind !== 'file') return undefined
  if (a.value === b.value) return undefined
  const parent = dirname(a.value)
  if (parent !== dirname(b.value)) return undefined
  return `两票写同一个目录 ${parent} 下的不同文件`
}

/** 一边只读、一边写：资源相同或包含就算弱冲突。 */
function readonlyHit(read: Resource, write: Resource, options: ConflictOptions): string | undefined {
  if (!sameOrContains(read, write, options)) return undefined
  return `一票只读 ${read.uri}，另一票会写 ${write.uri}`
}

/**
 * 大根目录：显式声明 `dir:/`、`dir:/home`、home 本身、仓库根这种，一片就盖住整
 * 棵树。它合法（整根操作确实存在），但不能拿它当强冲突把别的票全挡死——那正是
 * `dir:<home>` 锁死整棵树的那条路。判定只把这个资源降成 weak，由 arbiter
 * 喊一行。判据只看相等，不看祖先：`dir:/home/alice/work` 这种具体目录照旧强冲突。
 */
const WIDE_DIR_ROOTS: readonly string[] = ['/', '/home', '/root', '/usr', '/etc', '/var', '/opt', '/boot']

/** 这条归一化资源串是不是「大根目录」。非 dir、认不出来的串一律 false。 */
export function isWideDirRoot(uri: string): boolean {
  let parsed
  try {
    parsed = parseResource(uri)
  } catch {
    return false
  }
  if (parsed.kind !== 'dir') return false
  const roots = [...WIDE_DIR_ROOTS, homedir(), process.cwd()]
  return roots.some((root) => parsed.value === (root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root))
}

/**
 * 判两票的冲突。`a` / `b` 的 `writes` / `reads` 会先归一化；同一对资源只记一次
 * 理由，撞上的资源串按首次出现顺序去重。
 */
export function judgeConflict(a: ConflictSide, b: ConflictSide, options: ConflictOptions = {}): ConflictVerdict {
  const scanWritesA = toResources(a.writes, options)
  const scanWritesB = toResources(b.writes, options)
  const scanReadsA = toResources(a.reads, options)
  const scanReadsB = toResources(b.reads, options)
  const writesA = scanWritesA.resources
  const writesB = scanWritesB.resources
  const invalid: InvalidConflictResource[] = [
    ...scanWritesA.invalid.map((item) => ({ ...item, side: 'a' as const })),
    ...scanReadsA.invalid.map((item) => ({ ...item, side: 'a' as const })),
    ...scanWritesB.invalid.map((item) => ({ ...item, side: 'b' as const })),
    ...scanReadsB.invalid.map((item) => ({ ...item, side: 'b' as const })),
  ]
  const unknownOnlyA =
    invalid.some((item) => item.side === 'a') && writesA.length === 0 && scanReadsA.resources.length === 0
  const unknownOnlyB =
    invalid.some((item) => item.side === 'b') && writesB.length === 0 && scanReadsB.resources.length === 0
  const withInvalid = (verdict: ConflictVerdict): ConflictVerdict =>
    invalid.length > 0 ? { ...verdict, invalid } : verdict
  const reasons: string[] = []
  const resources: string[] = []
  const seenReason = new Set<string>()
  const seenResource = new Set<string>()
  const note = (reason: string, pair: readonly Resource[]): void => {
    if (!seenReason.has(reason)) {
      seenReason.add(reason)
      reasons.push(reason)
    }
    for (const resource of pair) {
      if (seenResource.has(resource.uri)) continue
      seenResource.add(resource.uri)
      resources.push(resource.uri)
    }
  }

  for (const wa of writesA) {
    for (const wb of writesB) {
      const hit = strongHit(wa, wb, options)
      if (hit) note(hit, [wa, wb])
    }
  }
  if (reasons.length > 0) return withInvalid({ level: 'strong', reasons, resources })

  for (const wa of writesA) {
    for (const wb of writesB) {
      const hit = weakHit(wa, wb, options)
      if (hit) note(hit, [wa, wb])
    }
  }
  const readsA = scanReadsA.resources
  const readsB = scanReadsB.resources
  for (const read of readsA) {
    for (const write of writesB) {
      const hit = readonlyHit(read, write, options)
      if (hit) note(hit, [read, write])
    }
  }
  for (const read of readsB) {
    for (const write of writesA) {
      const hit = readonlyHit(read, write, options)
      if (hit) note(hit, [read, write])
    }
  }
  if (reasons.length > 0) return withInvalid({ level: 'weak', reasons, resources })

  // 一边的声明里一条都认不出来：没法证明不冲突，按保守判弱放行，但要说清楚。
  if (unknownOnlyA || unknownOnlyB) {
    return withInvalid({
      level: 'weak',
      reasons: ['声明的资源串无法识别，按保守判弱处理'],
      resources: [],
    })
  }
  return withInvalid({ level: 'none', reasons: [], resources: [] })
}

/**
 * 一条声明 writes 是否覆盖 touched 里的某一项。
 *
 * 沿用上面同一套路径边界（`under`）：同 kind 的 file/svc/port/dev 要相等，
 * dir 与 git 按「落在里面」判；跨 kind 时只有目录声明能覆盖落在里面的路径，
 * 文件声明覆盖不了目录。
 */
function covers(write: Resource, item: Resource): boolean {
  if (write.kind === item.kind) {
    if (write.kind === 'dir' || write.kind === 'git') return under(item.value, write.value)
    return write.value === item.value
  }
  if (write.kind === 'dir') {
    if (item.kind === 'git' || item.kind === 'file' || item.kind === 'dev') {
      return under(item.value, write.value)
    }
    return false
  }
  if (write.kind === 'git') {
    if (item.kind === 'file' || item.kind === 'dev' || item.kind === 'dir') {
      return under(item.value, write.value)
    }
    return false
  }
  return false
}

/** 越界对账的白名单：条目写法见 `defaults.ts` 的 `DEFAULT_OUT_OF_SCOPE_ALLOW`。 */
export interface OutOfScopeOptions {
  /**
   * 合理产物白名单。空数组（或不给）= 不过滤，老行为。路径已由 `scanResources`
   * 归一化成绝对路径，比对按目录边界做，`/tmp` 不会误命中 `/tmpfoo`。
   */
  allow?: readonly string[]
  /**
   * 票的工作目录（规范化后的绝对路径）。票就在 `/tmp` 里干活时，`/tmp/` 这条
   * 绝对前缀白名单不该把票自己的业务文件一起放过——落在工作目录下的照旧对账，
   * 工作目录之外的临时产物才忽略。
   */
  base?: string
}

/** 取路径最后一段。 */
function baseName(value: string): string {
  const at = value.lastIndexOf('/')
  return at < 0 ? value : value.slice(at + 1)
}

/** 去尾斜杠，根目录 `/` 保留。 */
function trimSlash(value: string): string {
  let out = value
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** 只认 `*` 的通配：够覆盖 `*.bak`、`*.bak-*` 这些写法，不做正则展开。 */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === text[t]) {
      p += 1
      t += 1
      continue
    }
    if (p < pattern.length && pattern[p] === '*') {
      star = p
      p += 1
      mark = t
      continue
    }
    if (star >= 0) {
      p = star + 1
      mark += 1
      t = mark
      continue
    }
    return false
  }
  while (p < pattern.length && pattern[p] === '*') p += 1
  return p === pattern.length
}

/** 一条白名单条目是否命中这个路径（值已归一化成绝对路径）。 */
function entryMatches(value: string, name: string, segments: readonly string[], entry: string): boolean {
  // 带通配：先按文件名比（`*.bak`），条目里有 `/` 再按整条路径比。
  if (entry.includes('*')) {
    if (wildcardMatch(entry, name)) return true
    if (entry.includes('/') && wildcardMatch(entry, value)) return true
    return false
  }
  // 绝对目录前缀：只认边界，`/tmp` 不吃 `/tmpfoo`。
  if (entry.startsWith('/')) {
    const dir = trimSlash(entry)
    return value === dir || value.startsWith(`${dir}/`)
  }
  // 任意层级的目录段，或末尾的文件名（`.DS_Store`）。
  const seg = trimSlash(entry)
  return segments.includes(seg) || name === seg
}

/**
 * 这一条归一化资源串是不是「合理产物」——备份、临时文件、构建/库目录这类，
 * 不该算进收工越界。
 *
 * 只看文件类资源（file / dir / git）：svc / port / dev 不是文件路径，按目录段
 * 猜它们没有意义。`value` 已经是绝对路径（`normalizeResource` 做过），比对用
 * 目录边界，`/tmp/a` 命中 `/tmp/`，`/tmpfoo` 不命中。
 *
 * `base` 是票的工作目录：票本身就在 `/tmp/xxx`（或某个 backups 目录）里干活时，
 * 那片目录里的东西是这张票的业务面，白名单不该整片放过——工作目录之下一律
 * 照旧对账，工作目录之外的产物才忽略。
 */
export function isAllowedProduct(uri: string, allow: readonly string[], base?: string): boolean {
  if (allow.length === 0) return false
  let parsed
  try {
    parsed = parseResource(uri)
  } catch {
    return false
  }
  if (parsed.kind !== 'file' && parsed.kind !== 'dir' && parsed.kind !== 'git') return false
  const value = parsed.value
  const name = baseName(value)
  const segments = value.split('/').filter((segment) => segment.length > 0)
  const scope = base ? trimSlash(base) : undefined
  if (scope) {
    // 工作目录自己就落在某条白名单目录里：它下面的东西按业务面处理。
    const scopeName = baseName(scope)
    const scopeSegments = scope.split('/').filter((segment) => segment.length > 0)
    const scopeIsProductDir = allow.some((raw) => {
      const entry = raw.trim()
      return entry.length > 0 && entryMatches(scope, scopeName, scopeSegments, entry)
    })
    if (scopeIsProductDir && (value === scope || value.startsWith(`${scope}/`))) return false
  }
  return allow.some((raw) => {
    const entry = raw.trim()
    return entry.length > 0 && entryMatches(value, name, segments, entry)
  })
}

/**
 * 越界对账（P4）：`touched` 里没有被票上声明的 `writes` 覆盖、也不属于合理产物
 * 的项。
 *
 * 入参两边都先过 `scanResources`，跟冲突判定读同一个写法；输出是归一化后
 * 的资源串，按 touched 的首次出现顺序。没有声明 writes 就没有边界可比，返回
 * 空数组——快路径的票不该因为没写声明就满屏越界。
 *
 * 白名单只挡「票外产物」（备份、临时文件、构建输出），业务源码不在此列：
 * 声明之外的 `src/` 文件照样报出来。
 */
export function outOfScopePaths(
  touched: readonly string[] | undefined,
  writes: readonly string[] | undefined,
  options: OutOfScopeOptions = {},
): string[] {
  const declared = toPlainResources(writes)
  if (declared.length === 0) return []
  const allow = options.allow ?? []
  const outside: string[] = []
  for (const item of toPlainResources(touched)) {
    if (isAllowedProduct(item.uri, allow, options.base)) continue
    if (declared.some((write) => covers(write, item))) continue
    outside.push(item.uri)
  }
  return outside
}
