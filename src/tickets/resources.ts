/**
 * 资源串归一化（设计稿 v0.2.3 §5）。
 *
 * 影响面写成资源 URI 清单，一张票一份 writes、一份 reads。归一化在入票前做一
 * 次，之后所有人读同一个值——两票求交靠的就是「同一个路径只有一个写法」：
 *
 * | 前缀  | 例子                               | 含义                          |
 * | ----- | ---------------------------------- | ----------------------------- |
 * | file: | file:/home/user/fatfish/a.md      | 单个文件的写                  |
 * | dir:  | dir:/home/user/fatfish/tmp        | 整目录操作（rm/mv/tar/rsync） |
 * | git:  | git:/home/user/dev/dsh-dispatcher | 一个 git 工作树（不是 remote）|
 * | svc:  | svc:dsh-example                      | systemd 单元                  |
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
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

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
}

/** 默认 realpath：文件不存在、权限不够都当「解不了」，不抛。 */
function defaultRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
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
 * 也别把一个 `a/b` 当成 file: 存进去——求交时它和 `file:/home/x/a/b` 不相等。
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
