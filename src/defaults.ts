/**
 * 纯常量：配置默认值只在这里写一遍。
 *
 * `config.ts` 的 Schemastery 默认值、`cli.ts` 没读到 profile 配置时的兜底，
 * 都从这里取。这个文件不 import schemastery / cordis，所以 CLI 单独打包时
 * 不会把整个配置框架拖进去。
 */

/** 票日志默认位置；相对路径按 DSH_HOME 解析。 */
export const DEFAULT_STATE_FILE = 'dispatcher/tickets.jsonl'

/** 默认后端。2026-11-04 这轮仍保持 jsonl，切换由 profile 配置决定。 */
export const DEFAULT_STORE_BACKEND = 'jsonl'

/** `store.file` 默认空串 = 跟着 stateFile 换后缀（tickets.jsonl → tickets.db）。 */
export const DEFAULT_STORE_FILE = ''
