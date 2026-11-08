#!/usr/bin/env bash
# 切换 sqlite 之后的只读核对：一条命令出一张表。
#
#   scripts/verify-after-switch.sh --before <切换前 tickets --json 的落盘文件>
#                                  [--db <库路径>] [--jsonl <日志路径>]
#                                  [--service dsh-qqbot] [--since <时间>] [--skip-log]
#
# 核对项（对应 docs/switch-to-sqlite.md 的 g）：
#   1. profile 的 store.backend 已经是 sqlite；
#   2. 库文件存在、CLI 能通过默认配置读到；
#   3. 票数、未结票数、状态计数与切换前逐票一致（时间派生字段除外）；
#   4. 库里的 events 条数与 jsonl 行数对得上，meta.lastSeq 同步；
#   5. 重启后的服务日志里没有 sqlite 报错（--skip-log 可跳过）。
#
# 不写票、不改库、不动 ~/.dsh；派一张小票并关掉那一步是写操作，留给主会话手工。
# 退出码：0 全部 PASS（SKIP 不算失败）；1 有 FAIL；2 用法/输入不对。

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
BEFORE=""
DB=""
JSONL=""
SERVICE="${SERVICE:-dsh-qqbot}"
SINCE=""
SKIP_LOG=0

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --before)
      [[ $# -ge 2 ]] || { echo "--before 后面要跟文件" >&2; exit 2; }
      BEFORE=$2
      shift 2
      ;;
    --db)
      [[ $# -ge 2 ]] || { echo "--db 后面要跟路径" >&2; exit 2; }
      DB=$2
      shift 2
      ;;
    --jsonl)
      [[ $# -ge 2 ]] || { echo "--jsonl 后面要跟路径" >&2; exit 2; }
      JSONL=$2
      shift 2
      ;;
    --service)
      [[ $# -ge 2 ]] || { echo "--service 后面要跟服务名" >&2; exit 2; }
      SERVICE=$2
      shift 2
      ;;
    --since)
      [[ $# -ge 2 ]] || { echo "--since 后面要跟 journalctl 的时间" >&2; exit 2; }
      SINCE=$2
      shift 2
      ;;
    --skip-log)
      SKIP_LOG=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "不认识的参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BEFORE" ]]; then
  echo "缺 --before <切换前 tickets --json 落盘文件>" >&2
  exit 2
fi
if [[ ! -f "$BEFORE" ]]; then
  echo "切换前快照不存在：$BEFORE" >&2
  exit 2
fi
if [[ ! -f "$ROOT/lib/tickets-cli.js" ]]; then
  echo "找不到 $ROOT/lib/tickets-cli.js：先在仓库里 npm run build" >&2
  exit 2
fi

export ROOT BEFORE DB JSONL SERVICE SINCE SKIP_LOG
exec node --input-type=module - <<'NODE'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const { loadCliConfig, runTicketsCli } = await import(
  pathToFileURL(join(process.env.ROOT, 'lib', 'tickets-cli.js')).href
)

const env = process.env
const dshHome = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const config = loadCliConfig(env)

function absPath(file) {
  return isAbsolute(file) ? file : join(dshHome, file)
}

function deriveDb(stateFile) {
  if (/\.jsonl$/i.test(stateFile)) return stateFile.replace(/\.jsonl$/i, '.db')
  if (/\.(db|sqlite|sqlite3)$/i.test(stateFile)) return stateFile
  return `${stateFile}.db`
}

const rows = []
function add(item, expected, actual, ok) {
  rows.push({ item, expected: String(expected), actual: String(actual), ok })
}
function resultOf(ok) {
  return ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP'
}

let before
try {
  before = JSON.parse(readFileSync(env.BEFORE, 'utf8'))
} catch (error) {
  console.error(`读不了切换前快照 ${env.BEFORE}：${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

let current = null
let cliError = ''
let currentText = ''
const cliCode = runTicketsCli(
  ['tickets', '--json'],
  {
    out: (text) => {
      currentText += text
    },
    err: (text) => {
      cliError += text
    },
  },
  { config },
)
try {
  current = JSON.parse(currentText)
} catch {
  current = null
}

// ── 1. 配置与库文件 ─────────────────────────────────────────────
const backend = (config.store?.backend ?? '').trim() || 'jsonl'
add('配置 store.backend', 'sqlite', backend, backend === 'sqlite')

let dbFile = env.DB?.trim() || (config.store?.file ?? '').trim()
if (dbFile) dbFile = absPath(dbFile)
else {
  const state = (config.stateFile ?? '').trim() || 'dispatcher/tickets.jsonl'
  dbFile = deriveDb(absPath(state))
}
let dbSize = -1
if (existsSync(dbFile)) {
  try {
    dbSize = statSync(dbFile).size
  } catch {
    dbSize = -1
  }
}
add('库文件', '存在', dbSize >= 0 ? `${dbFile} (${dbSize} B)` : `${dbFile} 缺失`, dbSize >= 0)

add(
  'CLI 默认读取',
  'rc=0',
  cliCode === 0 && current ? 'rc=0' : `rc=${cliCode} ${cliError.trim()}`,
  cliCode === 0 && current !== null,
)

// ── 2. 逐票与计数 ───────────────────────────────────────────────
const beforeTickets = Array.isArray(before.tickets) ? before.tickets : []
const currentTickets = Array.isArray(current?.tickets) ? current.tickets : []
add('票数', beforeTickets.length, currentTickets.length, currentTickets.length === beforeTickets.length)

const beforeCounts = before.counts ?? {}
const currentCounts = current?.counts ?? {}
const countKeys = ['open', 'running', 'waiting', 'blocked', 'openTotal']
const countsMatch = countKeys.every((key) => (beforeCounts[key] ?? 0) === (currentCounts[key] ?? 0))
add(
  '未结票数（openTotal）',
  beforeCounts.openTotal ?? 0,
  currentCounts.openTotal ?? 0,
  (beforeCounts.openTotal ?? 0) === (currentCounts.openTotal ?? 0),
)
add(
  '状态计数',
  JSON.stringify(beforeCounts),
  JSON.stringify(currentCounts),
  countsMatch,
)

// 时间派生字段（generatedAt / ageMinutes / stale）不参与比对：切换前后时钟不同。
const STABLE = [
  'id',
  'brief',
  'goal',
  'status',
  'owner',
  'createdAt',
  'updatedAt',
  'closedAt',
  'statusSince',
  'workerAlive',
  'pendingInputs',
  'pendingReports',
  'reportsCount',
  'epoch',
  'epochReports',
  'preset',
  'presetSource',
  'dir',
  'note',
  'device',
]
function stable(view) {
  const out = {}
  for (const key of STABLE) out[key] = view?.[key] ?? null
  return JSON.stringify(out)
}
const beforeById = new Map(beforeTickets.map((ticket) => [ticket.id, ticket]))
const currentById = new Map(currentTickets.map((ticket) => [ticket.id, ticket]))
const mismatch = []
for (const [id, ticket] of beforeById) {
  const got = currentById.get(id)
  if (!got) mismatch.push(`${id}(缺)`)
  else if (stable(ticket) !== stable(got)) mismatch.push(id)
}
for (const id of currentById.keys()) {
  if (!beforeById.has(id)) mismatch.push(`${id}(多)`)
}
add(
  '逐票字段（除时间派生）',
  `${beforeById.size} 张一致`,
  mismatch.length === 0 ? `${currentById.size} 张一致` : `${mismatch.length} 张不符：${mismatch.slice(0, 5).join(', ')}`,
  mismatch.length === 0,
)

// ── 3. 事件条数与 meta ──────────────────────────────────────────
const jsonlFile = absPath(env.JSONL?.trim() || (config.stateFile ?? '').trim() || 'dispatcher/tickets.jsonl')
let jsonlLines = -1
if (existsSync(jsonlFile)) {
  try {
    jsonlLines = readFileSync(jsonlFile, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length
  } catch {
    jsonlLines = -1
  }
}

let dbEvents = -1
let lastSeq = -1
let dbProblem = ''
if (existsSync(dbFile)) {
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      dbEvents = Number(db.prepare('SELECT COUNT(*) AS c FROM events').get().c)
      const row = db.prepare("SELECT value FROM meta WHERE key = 'lastSeq'").get()
      lastSeq = row ? Number(row.value) : -1
    } finally {
      db.close()
    }
  } catch (error) {
    dbProblem = error instanceof Error ? error.message : String(error)
  }
}
add(
  '事件数（jsonl 行 / 库 events）',
  jsonlLines >= 0 ? jsonlLines : 'jsonl 读不到',
  dbProblem ? `库读不了：${dbProblem}` : dbEvents,
  jsonlLines >= 0 && dbEvents >= 0 ? jsonlLines === dbEvents : null,
)
add(
  'meta.lastSeq = events',
  dbEvents >= 0 ? dbEvents : '库读不到',
  lastSeq,
  dbEvents >= 0 ? lastSeq === dbEvents : null,
)

// ── 4. 重启后的日志 ─────────────────────────────────────────────
if (env.SKIP_LOG === '1') {
  add('日志 sqlite 报错', '0 行', '--skip-log 跳过', null)
} else {
  let since = env.SINCE?.trim() || ''
  if (!since) {
    try {
      since = execFileSync('systemctl', ['--user', 'show', env.SERVICE, '-p', 'ActiveEnterTimestamp', '--value'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim()
    } catch {
      since = ''
    }
  }
  if (!since) {
    add('日志 sqlite 报错', '0 行', '拿不到服务启动时间，跳过', null)
  } else {
    try {
      const log = execFileSync(
        'journalctl',
        ['--user', '-u', env.SERVICE, '--since', since, '--no-pager'],
        { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
      )
      const hits = log
        .split(/\r?\n/)
        .filter((line) => /sqlite.*(error|fail|报错|失败)|SQLITE_|database is locked|no such table|disk I\/O error/i.test(line))
      add('日志 sqlite 报错', '0 行', `${hits.length} 行${hits[0] ? `：${hits[0].slice(0, 120)}` : ''}`, hits.length === 0)
    } catch (error) {
      add('日志 sqlite 报错', '0 行', `journalctl 读不了：${error instanceof Error ? error.message : String(error)}`, null)
    }
  }
}

// 写操作不代做：这一步要让主会话真的派一张小票并关掉。
add('派票并关票（写入）', '主会话手工', '只读脚本不代做', null)

// ── 输出 ────────────────────────────────────────────────────────
const widths = [0, 0, 0, 0]
for (const row of rows) {
  widths[0] = Math.max(widths[0], row.item.length)
  widths[1] = Math.max(widths[1], row.expected.length)
  widths[2] = Math.max(widths[2], row.actual.length)
  widths[3] = Math.max(widths[3], 4)
}
const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ')
console.log(line(['项目', '期望', '实际', '结果']))
console.log(widths.map((width) => '-'.repeat(width)).join('  '))
for (const row of rows) console.log(line([row.item, row.expected, row.actual, resultOf(row.ok)]))

const failed = rows.filter((row) => row.ok === false)
const skipped = rows.filter((row) => row.ok === null)
console.log('')
console.log(`结果：${rows.length - failed.length - skipped.length} PASS / ${failed.length} FAIL / ${skipped.length} SKIP`)
process.exitCode = failed.length > 0 ? 1 : 0
NODE
