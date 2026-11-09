import type { TicketEvent, TicketSnapshot } from '../store'
import { DEFAULT_STORE_BACKEND } from '../defaults'
import { JsonlTicketStore } from './jsonl'
import { SqliteTicketStore } from './sqlite'

/**
 * 票日志的后端契约。换 redis / sqlite 时按这五条验收，一条不过就别接：
 *
 * 1. 追加线性化、单写者。一次 append 要么整条可见、要么完全不可见，不许出现
 *    半条（jsonl 用 O_APPEND 一次 writeSync 保证）。同一进程内事件的顺序就是
 *    写下的顺序；宿主只跑一个 dispatcher 实例，多进程同时写同一份日志不是这个
 *    后端要支持的事，接 redis 时也别顺手把它当成多写者方案。
 * 2. 事件不可变。只追加，不改、不删。标已读是追加一条 `delivered` 事件，不是
 *    把旧行的 `delivered` 改成 true；清理已关票的报告同理，还是追加。
 * 3. fold 必须可重放。同样的 load() 结果按同样顺序折，必须得到同样的票。后端
 *    不许在 load() 里做任何「顺手更正」——票的语义只归 store.ts 的 fold。
 * 4. 崩溃后可恢复。进程在任意位置被杀，重新 load() 要能折出崩溃前已经确认的
 *    票；jsonl 的坏行跳过是这条的兜底，redis/sqlite 用事务与持久化保证同一条。
 * 5. changed() 只是优化。返回 true 最多让门面多折一遍，绝不允许改变 load() 的
 *    结果；返回 false 则是一次承诺：自上次 load()/append() 以来没有新东西。
 *
 * 方法只有这四个原语，业务语义一律留在门面（TicketStore）上：开票、改状态、
 * 排 input、追加报告、标已读、清已关票的报告，全都是 `append()` 一条不可变事件。
 * 这样接一个新后端只要实现「读全量 + 原子追加 + 变更探测」，不用把业务再写一遍。
 */
export interface TicketBackend {
  /**
   * 这份日志的身份，给日志行和诊断用：`/home/julia/.dsh/dispatcher/tickets.jsonl`
   * 或者 `redis://127.0.0.1:6379/3`。人看得懂就行。
   */
  readonly location: string

  /**
   * 自本进程上次 load()/append() 以来，日志有没有被别的东西动过（别的进程追加、
   * 有人手改、被截断）。每次 list()/get() 都会问一次，所以必须便宜；答不上来
   * 就返回 true，代价只是多折一遍。
   */
  changed(): boolean

  /**
   * 从头重放全部事件，老的在前。必须容错：崩溃留下的半截行、不是事件的行
   * （null、数字、缺 id/at）一律跳过，通过构造函数里的 log 报一声，绝不抛。
   * 只读，不许改日志。
   */
  load(): TicketEvent[]

  /**
   * 追加一条事件。这是唯一的写入口：后来的状态、排队的消息、报告、已读记账
   * 全是新事件，不改旧行。
   *
   * `adoptPublished` 在时，事件也可能是 dsh-events 已经落好库的：本后端只补
   * 投影，不再 INSERT。没有这个方法的后端（jsonl）只能走 `append`，publisher
   * 路径对它是关着的。
   */
  append(event: TicketEvent): void

  /**
   * 事件已由外部（dsh-events）写进同一个库，这里只把折好的投影落下来。
   *
   * 不做事件 INSERT、不分配 seq；`seq` 是 publish 返回的那条事件的 seq。
   * 没有这个能力的后端不实现它——调用方据此判断能不能走 publish。
   */
  adoptPublished?(snapshot: TicketSnapshot, seq: number): void
}

/** 后端名字。jsonl 是默认实现，sqlite 已接；redis 仍只是占位。 */
export type TicketBackendName = 'jsonl' | 'redis' | 'sqlite'

/** 选后端要的两样东西：`store.backend` 和已经解析好的日志路径。 */
export interface TicketBackendConfig {
  /** `store.backend`；没配等于 'jsonl'。 */
  backend?: string
  /** 日志路径，已按 `resolveStateFile()` 解析过（相对路径落在 DSH_HOME 下）。 */
  stateFile: string
  /**
   * sqlite 后端的库文件；没配就按 `stateFile` 换个后缀（tickets.jsonl →
   * tickets.db），所以默认落在同一个 dispatcher 目录里。
   */
  dbFile?: string
}

/**
 * sqlite 库文件放哪：显式给了就用，否则把日志路径的后缀换掉。
 *
 * 只换最后一段的扩展名，目录原样保留——`~/.dsh/dispatcher/tickets.jsonl`
 * 推导出 `~/.dsh/dispatcher/tickets.db`。`.jsonl` 之外的日志名（比如
 * `tickets.log`）追加 `.db`，绝不让 SQLite 去打开日志文件本身。
 */
export function resolveDbFile(stateFile: string, dbFile?: string): string {
  if (dbFile && dbFile.trim()) return dbFile
  if (/\.jsonl$/i.test(stateFile)) return stateFile.replace(/\.jsonl$/i, '.db')
  if (/\.(db|sqlite|sqlite3)$/i.test(stateFile)) return stateFile
  return `${stateFile}.db`
}

/**
 * 按 `store.backend` 选一个实现。默认 jsonl（不配就是老行为）；sqlite 已经
 * 接上，写库失败会当场抛，不会静默退回 jsonl；redis 还只是名字，选了就抛
 * 「未实现」——配置写错了要当场知道。
 */
export function createTicketBackend(
  config: TicketBackendConfig,
  log?: (message: string) => void,
): TicketBackend {
  const name = (config.backend ?? '').trim() || DEFAULT_STORE_BACKEND
  switch (name) {
    case 'jsonl':
      return new JsonlTicketStore(config.stateFile, log)
    case 'sqlite':
      return new SqliteTicketStore(resolveDbFile(config.stateFile, config.dbFile), log)
    case 'redis':
      throw new Error(
        `store.backend: 'redis' 还没实现，现在有 'jsonl'（默认）和 'sqlite'。接一个新后端就照 src/store/backend.ts 顶上那五条契约写一个 TicketBackend，再在 createTicketBackend 里加一行。`,
      )
    default:
      throw new Error(`store.backend 不认识的值：'${name}'（可选 jsonl / redis / sqlite）`)
  }
}
