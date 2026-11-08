/**
 * CLI 读运行时的 `store.backend` / `store.file`。
 *
 * CLI 是独立进程，拿不到宿主内存里的 config，所以按 DSH 自己的目录规则去读
 * profile 的 `cordis.patch.yml`：`DSH_PROFILE_DIR` 优先，其次
 * `$DSH_HOME/profiles/$DSH_PROFILE/`。这里只认 `dsh-dispatcher` 这一条 entry 的
 * `config:` 段，别的插件配置一律不看。
 *
 * 为什么手写一个小解析器：这个包不想为了两三个字符串把 yaml 依赖带进 CLI
 * 的构建产物，也不该在每次 `tickets` 调用时 fork 一个 `dsh --dump-config`。
 * 只支持 DSH profile 实际会写出来的那几种形状：块状 map、inline map、单双引号
 * 标量、`#` 注释；读到不认识的行就跳过，读不到就回退到 `src/defaults.ts` 的
 * 默认值，绝不因为配置长得怪而让只读命令崩掉。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 从 profile 里读出来的那一小块配置；缺失的键保持 undefined。 */
export interface CliConfig {
  stateFile?: string
  store?: {
    backend?: string
    file?: string
  }
}

/** 看 DSH_HOME；空串按没配处理（和 resolveStateFile 同口径）。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim()
  return home ? home : join(homedir(), '.dsh')
}

/**
 * profile 的 patch 文件放哪。`DSH_PROFILE_DIR` 是宿主启动时给的，最准；
 * 没有它就按 `DSH_HOME/profiles/<DSH_PROFILE>` 推。两个都没有就返回 undefined
 * （此时就是纯默认值，不猜 profile）。
 */
export function resolveProfileConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.DSH_PROFILE_DIR?.trim()
  if (dir) return join(dir, 'cordis.patch.yml')
  const profile = env.DSH_PROFILE?.trim()
  if (profile) return join(resolveDshHome(env), 'profiles', profile, 'cordis.patch.yml')
  return undefined
}

/** 读 profile 配置；文件不存在、读不动、解析不出来都回退成空对象。 */
export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const file = resolveProfileConfigPath(env)
  if (!file || !existsSync(file)) return {}
  try {
    return parseDispatcherConfig(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** 去掉行尾注释；引号里的 `#` 不算注释。 */
function stripComment(line: string): string {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1
        continue
      }
      if (char === quote) {
        // YAML 单引号里两个 '' 表示一个 '。
        if (quote === "'" && line[index + 1] === "'") {
          index += 1
          continue
        }
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index)
  }
  return line
}

/** 一个 YAML 标量 → string；null/~/空都算空串。 */
function scalar(raw: string): string {
  const value = raw.trim()
  if (!value || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return ''
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : value.slice(1, -1)
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

/** 按顶层逗号切 inline map；引号/花括号里的逗号不算。 */
function splitInline(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: '"' | "'" | undefined
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote) {
      if (quote === '"' && char === '\\') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** 找顶层冒号，返回值的位置；没有就 -1。 */
function inlineColon(text: string): number {
  let depth = 0
  let quote: '"' | "'" | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote) {
      if (quote === '"' && char === '\\') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ':' && depth === 0) return index
  }
  return -1
}

/** `{ backend: sqlite, file: /tmp/x.db }` → map；非 map 返回 undefined。 */
function inlineMap(raw: string): Record<string, string> | undefined {
  const text = raw.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined
  const out: Record<string, string> = {}
  for (const part of splitInline(text.slice(1, -1))) {
    const colon = inlineColon(part)
    if (colon < 0) continue
    const key = part.slice(0, colon).trim()
    if (!key) continue
    out[key] = scalar(part.slice(colon + 1))
  }
  return out
}

/** 把 config 里的 `store` 段吃进结果。 */
function absorbStore(result: CliConfig, value: string): void {
  const key = scalar(value)
  if (!key) return
  result.store ??= {}
  result.store.backend = key
}

/** 把一个 inline config/map 里的已知键吃进结果。 */
function absorbInlineConfig(result: CliConfig, raw: string): void {
  const map = inlineMap(raw)
  if (!map) return
  for (const [key, value] of Object.entries(map)) {
    if (key === 'stateFile') result.stateFile = value
    else if (key === 'store.backend') absorbStore(result, value)
    else if (key === 'store.file') {
      result.store ??= {}
      result.store.file = value
    } else if (key === 'store') {
      const nested = inlineMap(value)
      if (nested) {
        for (const [innerKey, innerValue] of Object.entries(nested)) {
          result.store ??= {}
          if (innerKey === 'backend') result.store.backend = innerValue
          else if (innerKey === 'file') result.store.file = innerValue
        }
      } else {
        absorbStore(result, value)
      }
    }
  }
}

/** 从整份 profile patch 里摘出 `dsh-dispatcher` 的 config 段。 */
export function parseDispatcherConfig(text: string): CliConfig {
  const result: CliConfig = {}
  let entryIndent = -1
  let inConfig = false
  let configIndent = -1
  let storeIndent = -1

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine)
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length

    if (entryIndent < 0) {
      const start = /^\s*-\s+(?:id|name)\s*:\s*(.*)$/.exec(line)
      if (start && scalar(start[1]!) === 'dsh-dispatcher') entryIndent = indent
      continue
    }

    // 下一个同级 list item = 这条 entry 结束；缩进更深的 - 是数组值，不结束。
    if (indent <= entryIndent) break

    const pair = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1]!
    const value = pair[2]!

    if (!inConfig) {
      if (key === 'config') {
        if (value.trim()) absorbInlineConfig(result, value)
        else {
          inConfig = true
          configIndent = indent
        }
      }
      continue
    }

    // 出了 config 段。
    if (indent <= configIndent) {
      inConfig = false
      storeIndent = -1
      continue
    }

    // 出了 store 段，回到 config 的直接子键。
    if (storeIndent >= 0 && indent <= storeIndent) storeIndent = -1

    if (key === 'stateFile') result.stateFile = scalar(value)
    else if (key === 'store') {
      if (value.trim()) {
        const nested = inlineMap(value)
        if (nested) {
          for (const [innerKey, innerValue] of Object.entries(nested)) {
            result.store ??= {}
            if (innerKey === 'backend') result.store.backend = innerValue
            else if (innerKey === 'file') result.store.file = innerValue
          }
        } else {
          absorbStore(result, value)
        }
      } else {
        storeIndent = indent
        result.store ??= {}
      }
    } else if (key === 'store.backend') absorbStore(result, value)
    else if (key === 'store.file') {
      result.store ??= {}
      result.store.file = scalar(value)
    } else if (storeIndent >= 0 && indent > storeIndent) {
      result.store ??= {}
      if (key === 'backend') result.store.backend = scalar(value)
      else if (key === 'file') result.store.file = scalar(value)
    }
  }

  return result
}
