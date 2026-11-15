/**
 * 资源串归一化（设计稿 v0.2.3 §5）。
 *
 * 影响面写成资源 URI 清单，一张票一份 writes、一份 reads。归一化在入票前做一
 * 次，之后所有人读同一个值——两票求交靠的就是「同一个路径只有一个写法」：
 *
 * | 前缀  | 例子                               | 含义                          |
 * | ----- | ---------------------------------- | ----------------------------- |
 * | file: | file:/srv/app/data/a.md             | 单个文件的写                  |
 * | dir:  | dir:/srv/app/tmp                   | 整目录操作（rm/mv/tar/rsync） |
 * | git:  | git:/srv/app/dsh-dispatcher        | 一个 git 工作树（不是 remote）|
 * | svc:  | svc:example-service                | systemd 单元                  |
 * | port: | port:61208                         | 监听/占用端口                 |
 * | dev:  | dev:/dev/fb1                       | 屏幕、串口这类设备节点        |
 *
 * 路径类（file / dir / git / dev）的规则只有四条：展开 `~`、相对路径按基准目录
 * 转绝对、能 realpath 就 realpath（解符号链接；不存在就保留字面绝对路径，不抛
 * 错）、去掉尾斜杠（根目录 `/` 除外）。svc 只去 systemd 的 `.service` 后缀，
 * port 只校验范围。
 *
 * 这个模块是纯函数 + 一次 fs 探测，不认识票、不认识 tickets 目录、不写日志。
 * P0 只交付函数与测试，接线留给判定那一批（设计稿 §14 的 P2）。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** 六种资源前缀。 */
export type ResourceKind = 'file' | 'dir' | 'git' | 'svc' | 'port' | 'dev'

/** 前缀全表，顺序即报错文案里的顺序。 */
export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'file',
  'dir',
  'git',
  'svc',
  'port',
  'dev',
]

/** 一张拆好的资源串：`file:/x` → `{ kind: 'file', value: '/x' }`。 */
export interface ParsedResource {
  kind: ResourceKind
  value: string
}

/**
 * 归一化的外部依赖，全部可注入：测试钉死 cwd / home / realpath，生产用默认值。
 */
export interface ResourceOptions {
  /** 相对路径按它展开；默认 `process.cwd()`。 */
  base?: string
  /** `~` 按它展开；默认 `os.homedir()`。 */
  home?: string
  /**
   * 解析符号链接。返回 `undefined` 表示解不了（文件不存在），此时保留字面绝对
   * 路径。默认用 `fs.realpathSync`，异常吞掉。
   */
  realpath?: (path: string) => string | undefined
  /**
   * 探测一个路径是文件还是目录。默认 `fs.statSync`；测试注入假 fs，免得为了
   * git 根探测去真建目录。
   */
  stat?: (path: string) => 'file' | 'dir' | undefined
  /** 读文本文件（`git worktree` 的 `.git` 指针）。默认 `fs.readFileSync`。 */
  readText?: (path: string) => string | undefined
}

/** 一条认不出来的资源串：原样留着给人看，别因为脏数据把判定整锅端了。 */
export interface InvalidResource {
  raw: string
  reason: string
}

/** 一批资源串扫完的结果：认出来的、认不出来的分开。 */
export interface ResourceScan {
  resources: string[]
  invalid: InvalidResource[]
}

/** 一个路径落在哪个 git 仓库里。 */
export interface GitRoot {
  /** `.git` 所在的那一层：主仓库根，或 worktree 的工作树根。 */
  top: string
  /** 共用仓库根：worktree 解析到主仓库，主仓库就是自己。 */
  root: string
  /** true = 这是 `git worktree add` 出来的工作树。 */
  worktree: boolean
}

/** 默认 realpath：文件不存在、权限不够都当「解不了」，不抛。 */
function defaultRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** 默认 stat：不存在、权限不够都当「探不到」，不抛。 */
function defaultStat(path: string): 'file' | 'dir' | undefined {
  try {
    const info = statSync(path)
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
    return undefined
  } catch {
    return undefined
  }
}

/** 默认读文本：读不了就当空，不抛。 */
function defaultReadText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function messageOf(value: string): string {
  return value.trim() || '（空）'
}

/**
 * 拆前缀。前缀大小写不敏感，值原样返回（`file:` 后面可能带相对路径）。
 *
 * 没有前缀、前缀不认识、值为空都抛错：资源串是要落进票里的东西，宁可当场拒绝，
 * 也别把一个 `a/b` 当成 file: 存进去——求交时它和 `file:/srv/app/a/b` 不相等。
 */
export function parseResource(raw: string): ParsedResource {
  if (typeof raw !== 'string') throw new Error('资源串必须是字符串')
  const trimmed = raw.trim()
  const colon = trimmed.indexOf(':')
  if (colon <= 0) {
    throw new Error(
      `资源串「${messageOf(trimmed)}」缺前缀：要写成 ${RESOURCE_KINDS.map((kind) => `${kind}:…`).join(' / ')}`,
    )
  }
  const prefix = trimmed.slice(0, colon).trim().toLowerCase()
  const kind = RESOURCE_KINDS.find((candidate) => candidate === prefix)
  if (!kind) throw new Error(`未知资源前缀「${prefix}」：只认 ${RESOURCE_KINDS.join(' / ')}`)
  const value = trimmed.slice(colon + 1).trim()
  if (!value) throw new Error(`资源串「${messageOf(trimmed)}」只有前缀，没有值`)
  return { kind, value }
}

/** `~` / `~/x` 展开成 home 下的绝对路径；别的原样。 */
function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return `${home}${value.slice(1)}`
  return value
}

/** 去掉尾斜杠，根目录 `/` 保留。 */
function stripTrailingSlash(path: string): string {
  let out = path
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** 路径类资源的归一化：展开 ~ → 转绝对 → realpath（可选）→ 去尾斜杠。 */
function normalizePath(value: string, options: ResourceOptions): string {
  const home = options.home ?? homedir()
  const base = options.base ?? process.cwd()
  const expanded = expandHome(value, home)
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded)
  const realpath = options.realpath ?? defaultRealpath
  // realpath 失败（不存在、断链、权限）就留着字面绝对路径：声明可能指向还没建
  // 的文件，这不该让整张票开不出来。
  const resolved = realpath(absolute) ?? absolute
  return stripTrailingSlash(resolved)
}

/** svc 的写法统一：去 systemd 的 `.service` 后缀（`svc:a.service` 与 `svc:a` 同一资源）。 */
function normalizeService(value: string): string {
  const name = value.trim().replace(/\.service$/, '')
  if (!name) throw new Error(`资源串「${messageOf(value)}」没有单元名`)
  return name
}

/** port 只收 1–65535 的整数，输出十进制（`port:061208` 与 `port:61208` 同一资源）。 */
function normalizePort(value: string): string {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`端口「${messageOf(trimmed)}」不是整数`)
  }
  const port = Number(trimmed)
  if (port < 1 || port > 65535) throw new Error(`端口「${trimmed}」超出 1–65535`)
  return String(port)
}

/**
 * 从路径向上找 `.git`，判断它落在哪个仓库、是不是 worktree。
 *
 * 判据只有两条：`.git` 是目录 = 主仓库根；`.git` 是文件 = worktree 或 submodule，
 * 文件里那行 `gitdir:` 指到共用仓库。worktree 的 `gitdir` 长这样：
 * `/repo/.git/worktrees/<name>`，截到 `/.git/worktrees/` 之前就是共用仓库根。
 * submodule 指到 `.git/modules/<name>`，仓库身份就是 submodule 自己。
 *
 * 路径不存在时一路向上找不到 `.git` 就返回 undefined——声明的文件可能还没建，
 * 不能因为这个判不了冲突。
 */
export function findGitRoot(path: string, options: ResourceOptions = {}): GitRoot | undefined {
  const stat = options.stat ?? defaultStat
  const readText = options.readText ?? defaultReadText
  let current = stat(path) === 'file' ? dirname(path) : path
  for (;;) {
    const marker = join(current, '.git')
    const kind = stat(marker)
    if (kind === 'dir') return { top: current, root: current, worktree: false }
    if (kind === 'file') {
      const body = readText(marker) ?? ''
      const line = body.split(/\r?\n/, 1)[0]?.trim() ?? ''
      const match = /^gitdir:\s*(.+)$/.exec(line)
      if (!match) return { top: current, root: current, worktree: true }
      const raw = match[1]!.trim()
      const gitdir = isAbsolute(raw) ? raw : resolve(current, raw)
      const worktrees = `${sep}.git${sep}worktrees${sep}`
      const at = gitdir.indexOf(worktrees)
      if (at >= 0) return { top: current, root: gitdir.slice(0, at), worktree: true }
      // submodule：`.git` 文件指到上级仓库的 modules 目录，仓库身份还是自己。
      return { top: current, root: current, worktree: true }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * 归一化后把「落在 git 仓库里」这件事补成一条 `git:<工作树根>`。
 *
 * 设计稿 §5:64 的自动补全：dir / file 落在仓库内，追加 git 根；worktree 里的
 * 路径追加的是那个 worktree 的根，由冲突判定再按共用仓库根分档。已经声明的
 * `git:` 原样保留；探不到 `.git` 的路径不补。
 */
export function expandGitRoots(raw: readonly string[], options: ResourceOptions = {}): string[] {
  const out = normalizeResources(raw, options)
  const seen = new Set(out)
  for (const uri of [...out]) {
    const { kind, value } = parseResource(uri)
    if (kind !== 'file' && kind !== 'dir' && kind !== 'git') continue
    const git = findGitRoot(value, options)
    if (!git) continue
    const extra = `git:${git.top}`
    if (seen.has(extra)) continue
    seen.add(extra)
    out.push(extra)
  }
  return out
}

/**
 * 一条资源串归一化。返回值仍是同一种 URI 形状（`kind:value`），可以直接落进票、
 * 也可以直接比较相等。
 */
export function normalizeResource(raw: string, options: ResourceOptions = {}): string {
  const { kind, value } = parseResource(raw)
  switch (kind) {
    case 'svc':
      return `svc:${normalizeService(value)}`
    case 'port':
      return `port:${normalizePort(value)}`
    default:
      return `${kind}:${normalizePath(value, options)}`
  }
}

/**
 * 宽容版归一化：认不出来的资源串记下来继续扫，不抛。
 *
 * 判定路径用它——历史票里出现过 `cmd:dsh --profile…`、`http:docs.deepseek.com`、
 * `port:192.0.2.10:8080 (with a note)` 这类写法；一张脏票不该让整轮判定挂掉。
 * 写入口（declare/touch）仍用严格的 `normalizeResources`，新数据先拒掉。
 */
export function scanResources(raw: readonly string[], options: ResourceOptions = {}): ResourceScan {
  const resources: string[] = []
  const invalid: InvalidResource[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    try {
      const normalized = normalizeResource(item, options)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      resources.push(normalized)
    } catch (error) {
      invalid.push({ raw: item, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { resources, invalid }
}

/**
 * 宽容版 + git 根补全：给 conflict 判定用。
 *
 * 认不出来的原串只进 `invalid`，补全只对认出来的路径做。
 */
export function scanGitResources(raw: readonly string[], options: ResourceOptions = {}): ResourceScan {
  const scan = scanResources(raw, options)
  const seen = new Set(scan.resources)
  for (const uri of [...scan.resources]) {
    const { kind, value } = parseResource(uri)
    if (kind !== 'file' && kind !== 'dir' && kind !== 'git') continue
    const git = findGitRoot(value, options)
    if (!git) continue
    const extra = `git:${git.top}`
    if (seen.has(extra)) continue
    seen.add(extra)
    scan.resources.push(extra)
  }
  return scan
}

/**
 * 一批资源串归一化，按首次出现的顺序去重（归一化后相等就是同一个资源）。
 * 声明里同一个文件写两遍不该让求交算两次。
 */
export function normalizeResources(
  raw: readonly string[],
  options: ResourceOptions = {},
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const normalized = normalizeResource(item, options)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}
