/**
 * 纯常量：配置默认值只在这里写一遍。
 *
 * `config.ts` 的 Schemastery 默认值、`cli.ts` 没读到 profile 配置时的兜底、
 * `readout.ts` 的兜底、`tickets/desk.ts` 的 `DESK_DEFAULTS`，都从这里取。
 * 这个文件不 import schemastery / cordis，也不 import 业务模块，所以 CLI 单独
 * 打包时不会把整个配置框架拖进去。
 *
 * 边界：这里只放**可被 cordis 配置覆盖**的默认值；协议常量（事件名、工具名、
 * status/phase、写类工具）在 `protocol.ts`，不许配置覆盖。
 */

/** 票日志默认位置；相对路径按 DSH_HOME 解析。 */
export const DEFAULT_STATE_FILE = 'dispatcher/tickets.jsonl'

/** 默认后端。当前仍保持 jsonl，切换由 profile 配置决定。 */
export const DEFAULT_STORE_BACKEND = 'jsonl'

/** `store.file` 默认空串 = 跟着 stateFile 换后缀（tickets.jsonl → tickets.db）。 */
export const DEFAULT_STORE_FILE = ''

/** 票面 brief 的默认列宽：一个汉字占两列，34 列 = 17 个汉字（小屏实测）。 */
export const BRIEF_MAX_COLUMNS = 34

/** 巡检三档：waiting 20 分钟、blocked 60 分钟提醒一次；running 默认不催。 */
export const WAITING_MINUTES = 20
export const BLOCKED_MINUTES = 60
export const RUNNING_REMINDER_MINUTES = 0

/** 探路窗口：planning 停留超过这么多分钟就降级。 */
export const PROBE_TIMEOUT_MINUTES = 2
/**
 * 排队长短等的分界：超过这么多分钟就放掉原 worker，放行时新起一只。
 *
 * 取值依据 历史票实测：票自身耗时 P50 6.4 分钟、P90 16.7 分钟；
 * 5 分钟会把 59/68 的等待票一进队就判长等，短等保留上下文那条就废了。
 */
export const LONG_WAIT_MINUTES = 15
export const PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MINUTES * 60_000

/** 名额：同时执行 / 冲突排队，两本账分开数。 */
export const MAX_EXEC = 8
export const MAX_QUEUED = 4

/** worker 消失的宽限：正常重启不该把票收掉。 */
export const FRESH_MINUTES = 2

/** 同会话同目标同目录在这个窗口内重复开票，回原票。 */
export const REPEAT_WINDOW_MINUTES = 10

/** 巡检周期与分类器超时（毫秒）。 */
export const SWEEP_MS = 10_000
export const CLASSIFY_TIMEOUT_MS = 8_000

/**
 * 命令判定的短超时与默认模型。
 *
 * 这个判定只为一句话 yes/no，比选档更不该等：晚到 4 秒还没回话，按关键词表先
 * 派出去更划算。模型跟选档同一个 flash 档，不另开重模型的钱。
 */
export const COMMAND_HINT_TIMEOUT_MS = 4_000
export const COMMAND_HINT_MODEL = 'deepseek/deepseek-flash'
export const COMMAND_HINT_EFFORT = 'off'

/** 撤回审计：往回扫 3 天，两次审计最小间隔 1 小时。 */
export const REVERT_AUDIT_DAYS = 3
export const REVERT_AUDIT_MS = 60 * 60 * 1000

/**
 * 收工对账的「合理产物」白名单：明显不是业务产物的写入不算越界。
 *
 * 取值依据（票 t-mwn0xmdc-o8r8 翻票库实测）：历史上 152 张票带 `outOfScope`，
 * 一类是备份与临时产物（`backups/`、`/tmp`、`*.bak-时间戳`），另一类是构建产物
 * （`lib/`、`node_modules/`、`.git/` 内部文件）。这些路径不是任何人要保护的业务
 * 源码，报出来只会让每张票都补一句「这些我声明了」。
 *
 * 两种写法：
 * - 以 `/` 开头 = 绝对目录前缀（`/tmp/` 只匹配 /tmp 本身和它下面的东西，
 *   `/tmpfoo` 不匹配）；
 * - 不带 `/` = 任意层级的目录段（`backups/` 匹配 `/a/backups/x`，不匹配
 *   `/a/mybackups/x`），或者文件名（`.DS_Store`）；
 * - 带 `*` = 文件名通配符（`*.bak` 匹配 `/a/x.yml.bak`）。
 *
 * 配置项 `outOfScopeAllow` 整体覆盖这张表，`outOfScopeAllowEnabled=false` 关掉
 * 这一层判定。
 */
export const DEFAULT_OUT_OF_SCOPE_ALLOW: readonly string[] = [
  // 备份与临时目录。
  '/tmp/',
  '/var/tmp/',
  'tmp/',
  'backups/',
  // 日志与构建产物。
  'logs/',
  'node_modules/',
  '.git/',
  '__pycache__/',
  '.cache/',
  // 备份文件与编辑器残留。
  '*.bak',
  '*.bak.*',
  '*.bak-*',
  '*.orig',
  '*.orig.*',
  '*.orig-*',
  '*.rej',
  '*.rej.*',
  '*.v*bak',
  '*.swp',
  '*~',
  '.DS_Store',
]
