/**
 * `dsh-dispatcher tickets`：给脚本、桌宠和别的进程用的只读命令。
 *
 * 走的是和插件完全相同的路径——`createTicketBackend()` → `TicketLog`（store 的
 * 折叠）→ `TicketReadout`。这里不解析 jsonl、不认识任何事件名，所以后端换
 * redis/sqlite 时这个文件不用改。
 *
 * 参数面（`--help` 打印的就是它）：
 *
 *   dsh-dispatcher tickets [--json] [--open-only] [--id <票号>]
 *                          [--recent <n>] [--state <路径>]
 *                          [--backend <jsonl|sqlite>] [--db <路径>] [--help]
 *
 * 不传 `--backend` / `--db` / `--state` 时读 profile 的 `store.backend` 和
 * `store.file`（没配就是 jsonl + `dispatcher/tickets.jsonl`）。`--state` 是显式
 * 点名 jsonl 日志，给了就按 jsonl 读；`--db` 给了就把后端当成 sqlite。
 *
 * 不加 `--json` 打人看的一行一张票；`--json` 打固定形状的
 * `{v,generatedAt,counts,tickets}`，字段见 `tickets/readout.ts`。
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_STATE_FILE, DEFAULT_STORE_BACKEND } from './defaults'
import { BRIEF_MAX_COLUMNS, createTicketBackend } from './store'
import { TicketLog } from './store/log'
import { TicketReadout, TICKETS_SCHEMA_VERSION } from './tickets/readout'
import type { CliConfig } from './cli-config'
import type { ReadSelection } from './tickets/readout'

export { loadCliConfig, parseDispatcherConfig } from './cli-config'
export type { CliConfig } from './cli-config'

export const USAGE = `用法：dsh-dispatcher tickets [选项]

只读：输出票的当前折叠结果，不写日志。

选项：
  --json             输出 JSON：{"v":${TICKETS_SCHEMA_VERSION},"generatedAt":…,"counts":{…},"tickets":[…]}
  --open-only        只看未结票（open/running/waiting/blocked）；--open 是别名
  --id <票号>        只看这一张（关了也看得到）
  --recent <n>       未结票之外，再带最近 n 张已结票（默认全带）
  --state <路径>     显式点名 jsonl 日志；相对路径按 DSH_HOME 解析
                     （不传就读 profile 的 stateFile，默认 dispatcher/tickets.jsonl）
  --backend <值>     jsonl | sqlite；不传就读 profile 的 store.backend（默认 jsonl）
  --db <路径>        sqlite 库文件，给了就等于 --backend sqlite；相对路径按 DSH_HOME
                     解析。不传就用 profile 的 store.file，再不然跟 stateFile 换后缀
  --help, -h         打印这段

退出码：0 正常；1 点名的票不存在；2 参数不对或打不开日志（含 redis 未实现）。
时间字段一律 ISO 8601（UTC，带 Z），不用 epoch ms。`

/** 输出与退出码的注入点：测试用它抓 stdout/stderr，bin 用 process。 */
export interface CliIo {
  out(text: string): void
  err(text: string): void
}

const consoleIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

/** CLI 的运行时注入：bin 传 profile 配置，测试传临时配置和固定时钟。 */
export interface CliRunOptions {
  config?: CliConfig
  now?: () => Date
}

interface CliOptions {
  json: boolean
  openOnly: boolean
  id?: string
  recentClosed?: number
  state: string
  backend?: string
  db?: string
  help: boolean
}

class UsageError extends Error {}

const BACKENDS = new Set(['jsonl', 'sqlite', 'redis'])

function parse(argv: readonly string[]): CliOptions {
  const args = [...argv]
  // `dsh-dispatcher tickets ...` 和直接 `dsh-dispatcher --json` 都认。
  if (args[0] === 'tickets') args.shift()
  const options: CliOptions = { json: false, openOnly: false, state: '', help: false }
  let sawOpen = false
  let sawRecent = false
  let sawId = false
  let sawState = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const value = (): string => {
      const next = args[index + 1]
      if (next === undefined) throw new UsageError(`${arg} 后面缺一个值`)
      index += 1
      return next
    }
    // `--backend=sqlite` / `--db=/tmp/x.db` 也认，和迁移脚本的参数面一致。
    if (arg?.startsWith('--backend=')) {
      options.backend = arg.slice('--backend='.length)
      continue
    }
    if (arg?.startsWith('--db=')) {
      options.db = arg.slice('--db='.length)
      continue
    }
    switch (arg) {
      case '--json':
        options.json = true
        break
      case '--open-only':
      case '--open':
        options.openOnly = true
        sawOpen = true
        break
      case '--id':
        options.id = value()
        sawId = true
        break
      case '--recent': {
        const raw = value()
        const parsed = Number(raw)
        if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`--recent 要一个非负整数，收到 '${raw}'`)
        options.recentClosed = parsed
        sawRecent = true
        break
      }
      case '--state':
        options.state = value()
        sawState = true
        break
      case '--backend':
        options.backend = value()
        break
      case '--db':
        options.db = value()
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new UsageError(`不认识的参数：${arg}`)
    }
  }
  if (sawId && sawOpen) throw new UsageError('--id 和 --open-only 不能一起用（单票查询本身就是精确指定）')
  if (sawId && sawRecent) throw new UsageError('--id 和 --recent 不能一起用（单票查询不带别的票）')
  if (sawState && !options.state.trim()) throw new UsageError('--state 后面要跟路径')
  if (options.backend !== undefined && !options.backend.trim()) {
    throw new UsageError('--backend 要一个值：jsonl | sqlite')
  }
  if (options.db !== undefined && !options.db.trim()) throw new UsageError('--db 后面要跟路径')
  if (options.backend !== undefined && !BACKENDS.has(options.backend.trim())) {
    throw new UsageError(`--backend 不认识的值：'${options.backend.trim()}'（可选 jsonl / sqlite）`)
  }
  if (options.db !== undefined && options.backend !== undefined && options.backend.trim() !== 'sqlite') {
    throw new UsageError('--db 只能配 --backend sqlite（或者省略 --backend，鱼鱼会自己按 sqlite 算）')
  }
  return options
}

/** 相对路径按 DSH_HOME 解析，和插件里的 `resolveStateFile()` 同一口径。 */
function resolveStatePath(configured: string): string {
  if (isAbsolute(configured)) return configured
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, configured)
}

/** 最终交给 createTicketBackend 的三样东西。 */
interface StoreSelection {
  backend: string
  stateFile: string
  dbFile?: string
}

/**
 * 参数 > profile 配置 > 默认值。`--state` 是显式点名 jsonl 日志，所以它本身
 * 就把后端钉成 jsonl；要读 sqlite 还得给 `--backend sqlite` 或 `--db`。
 */
function resolveStore(options: CliOptions, config: CliConfig): StoreSelection {
  const configuredState = (config.stateFile ?? '').trim() || DEFAULT_STATE_FILE
  const stateFile = resolveStatePath((options.state ?? '').trim() || configuredState)

  const explicitBackend = options.backend?.trim()
  const configuredBackend = (config.store?.backend ?? '').trim()
  let backend: string
  if (options.db !== undefined) backend = 'sqlite'
  else if (explicitBackend) backend = explicitBackend
  else if ((options.state ?? '').trim()) backend = DEFAULT_STORE_BACKEND
  else backend = configuredBackend || DEFAULT_STORE_BACKEND

  const configuredDb = (config.store?.file ?? '').trim()
  const dbRaw = (options.db ?? '').trim() || configuredDb
  const dbFile = backend === 'sqlite' && dbRaw ? resolveStatePath(dbRaw) : undefined
  return { backend, stateFile, dbFile }
}

function ticketLine(view: { id: string; status: string; ageMinutes: number; brief: string; stale: boolean; pendingInputs: number; pendingReports: number }): string {
  const marks = [
    view.stale ? '!' : '',
    view.pendingInputs ? `»${view.pendingInputs}` : '',
    view.pendingReports ? `«${view.pendingReports}` : '',
  ].join('')
  return `${marks ? `${marks} ` : ''}${view.id} ${view.status} ${view.ageMinutes}m：${view.brief}`
}

function selectionOf(options: CliOptions): ReadSelection {
  if (options.id) return { id: options.id }
  if (options.openOnly) return { open: true }
  return options.recentClosed === undefined ? {} : { recentClosed: options.recentClosed }
}

/**
 * 跑一次命令，返回退出码；不调 `process.exit()`，bin 和测试都能自己决定怎么收尾。
 */
export function runTicketsCli(
  argv: readonly string[],
  io: CliIo = consoleIo,
  runOptions: CliRunOptions = {},
): number {
  let options: CliOptions
  try {
    options = parse(argv)
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`)
    return 2
  }
  if (options.help) {
    io.out(`${USAGE}\n`)
    return 0
  }

  let log: TicketLog
  try {
    const selected = resolveStore(options, runOptions.config ?? {})
    log = new TicketLog(
      createTicketBackend({
        backend: selected.backend,
        stateFile: selected.stateFile,
        dbFile: selected.dbFile,
      }),
    )
  } catch (error) {
    io.err(`打开票日志失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const readout = new TicketReadout(log, {
    briefMaxColumns: BRIEF_MAX_COLUMNS,
    waitingMinutes: 20,
    blockedMinutes: 60,
    now: runOptions.now,
  })
  const selection = selectionOf(options)
  const payload = readout.payload(selection)

  if (options.json) {
    io.out(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    const head = `${payload.counts.openTotal} open`
    if (payload.tickets.length === 0) {
      io.out(`${head}, none listed\n`)
    } else {
      io.out(`${head}\n${payload.tickets.map(ticketLine).join('\n')}\n`)
    }
  }

  if (options.id && payload.tickets.length === 0) {
    io.err(`没有票 ${options.id}\n`)
    return 1
  }
  return 0
}
