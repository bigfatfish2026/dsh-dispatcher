/**
 * 两票资源冲突判定（设计稿 v0.2.4 §6）。
 *
 * 输入是两张票的资源声明，`{ writes, reads }`，元素是 `resources.ts` 那六种前缀
 * 的资源串；进来先过一次 `normalizeResources`，两票只在同一个写法下求交。输出
 * 三档：strong（拦）、weak（提示放行）、none（不冲突），附人话理由与撞上的资源。
 *
 * 判据按写对写分档，只有两边都写才可能强冲突：一边只读、一边写一律降到 weak。
 * 目录类（dir / git）一律按路径边界判包含，`/a/b` 与 `/a/bc` 不算祖先。
 * git 退化成目录判断：同一个路径强冲突，互为祖先后代也强冲突，worktree 不单列。
 *
 * 这一层是纯判定：不认识票、不读 desk、不写日志、不碰状态迁移，也没有调用方。
 * 一件故意不管的事：`writes` 为空但票标了 degraded 的目录回填由调用方先做。
 */
import { dirname } from 'node:path'
import { normalizeResources, parseResource } from './resources'
import type { ResourceKind } from './resources'

/** 一张票的声明：写什么、只读什么。缺席就是空。 */
export interface ConflictSide {
  writes?: readonly string[]
  reads?: readonly string[]
}

/** strong 拦、weak 提示放行、none 不相交。 */
export type ConflictLevel = 'strong' | 'weak' | 'none'

/** 判定结果：`reasons` 是人话，`resources` 是撞上的归一化资源串。 */
export interface ConflictVerdict {
  level: ConflictLevel
  reasons: string[]
  resources: string[]
}

interface Resource {
  kind: ResourceKind
  value: string
  /** 归一化后的原串，回给人看的就是它。 */
  uri: string
}

function toResources(raw: readonly string[] | undefined): Resource[] {
  return normalizeResources(raw ?? []).map((uri) => {
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
function sameOrContains(a: Resource, b: Resource): boolean {
  if (a.kind === b.kind) {
    // dir 与 git 都按路径边界双向判；git 退化成目录，不单列。
    if (a.kind === 'dir' || a.kind === 'git') return under(a.value, b.value) || under(b.value, a.value)
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

/** 两边都写、都是 git：按路径边界判，相等或互为祖先后代都强。 */
function gitGitHit(a: Resource, b: Resource): string | undefined {
  if (a.value === b.value) return `两票都写同一个 git 路径 ${a.uri}`
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
function strongHit(a: Resource, b: Resource): string | undefined {
  if (a.kind === b.kind) {
    switch (a.kind) {
      case 'file':
        return a.value === b.value ? `两票都写同一个文件 ${a.uri}` : undefined
      case 'git':
        return gitGitHit(a, b)
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

/** 两边都写、又没到强冲突：同 dir 下不同 file 算弱。 */
function weakHit(a: Resource, b: Resource): string | undefined {
  if (a.kind !== 'file' || b.kind !== 'file') return undefined
  if (a.value === b.value) return undefined
  const parent = dirname(a.value)
  if (parent !== dirname(b.value)) return undefined
  return `两票写同一个目录 ${parent} 下的不同文件`
}

/** 一边只读、一边写：资源相同或包含就算弱冲突。 */
function readonlyHit(read: Resource, write: Resource): string | undefined {
  if (!sameOrContains(read, write)) return undefined
  return `一票只读 ${read.uri}，另一票会写 ${write.uri}`
}

/**
 * 判两票的冲突。`a` / `b` 的 `writes` / `reads` 会先归一化；同一对资源只记一次
 * 理由，撞上的资源串按首次出现顺序去重。
 */
export function judgeConflict(a: ConflictSide, b: ConflictSide): ConflictVerdict {
  const writesA = toResources(a.writes)
  const writesB = toResources(b.writes)
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
      const hit = strongHit(wa, wb)
      if (hit) note(hit, [wa, wb])
    }
  }
  if (reasons.length > 0) return { level: 'strong', reasons, resources }

  for (const wa of writesA) {
    for (const wb of writesB) {
      const hit = weakHit(wa, wb)
      if (hit) note(hit, [wa, wb])
    }
  }
  const readsA = toResources(a.reads)
  const readsB = toResources(b.reads)
  for (const read of readsA) {
    for (const write of writesB) {
      const hit = readonlyHit(read, write)
      if (hit) note(hit, [read, write])
    }
  }
  for (const read of readsB) {
    for (const write of writesA) {
      const hit = readonlyHit(read, write)
      if (hit) note(hit, [read, write])
    }
  }
  if (reasons.length > 0) return { level: 'weak', reasons, resources }

  return { level: 'none', reasons: [], resources: [] }
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

/**
 * 越界对账（P4）：`touched` 里没有被票上声明的 `writes` 覆盖的项。
 *
 * 入参两边都先过 `normalizeResources`，跟冲突判定读同一个写法；输出是归一化后
 * 的资源串，按 touched 的首次出现顺序。没有声明 writes 就没有边界可比，返回
 * 空数组——快路径的票不该因为没写声明就满屏越界。
 */
export function outOfScopePaths(
  touched: readonly string[] | undefined,
  writes: readonly string[] | undefined,
): string[] {
  const declared = toResources(writes)
  if (declared.length === 0) return []
  const outside: string[] = []
  for (const item of toResources(touched)) {
    if (declared.some((write) => covers(write, item))) continue
    outside.push(item.uri)
  }
  return outside
}
