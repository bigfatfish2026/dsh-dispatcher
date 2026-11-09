/**
 * 票日志的读写层：backend + 内存投影 + 订阅 + 写入。
 *
 * 一行 fs 都没有：事件从 `TicketBackend` 来、往 `TicketBackend` 写（`store/backend.ts`
 * 定契约，`store/jsonl.ts` 是现在唯一的实现）。折叠规则全在 `reducer.ts`，
 * 这里只负责「什么时候折、折完广播什么」。
 */
import { JsonlTicketStore } from './jsonl'
import { applyEvent } from './reducer'
import { kindOf } from './events'
import type { TicketBackend } from './backend'
import type { TicketEventPublisher } from './bus'
import type { EntryKind, TicketBroadcast, TicketEntry, TicketEvent, TicketSnapshot, TicketStatus } from './events'

/** dsh-events 的 EV-002：payload 超限（注册的类型上限）。只认码，不认文案。 */
const EV_SCHEMA = 'EV-002'

export function newTicketId(now: Date = new Date()): string {
  const stamp = now.getTime().toString(36)
  const salt = Math.random().toString(36).slice(2, 6)
  return `t-${stamp}-${salt}`
}

export function newEntryId(now: Date = new Date()): string {
  return `e-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 票的稳定顺序：createdAt 升序，同一时刻按 id 兜底。
 *
 * createdAt 是 `toISOString()` 出来的定长 ISO 串，裸 `<` 比字节和比时间同义；
 * 换掉 `localeCompare` 是因为它走 ICU，457 张票一次排序实测 49µs，
 * 巡检每 10 秒跑一轮不值当。
 */
function byCreatedAt(a: TicketSnapshot, b: TicketSnapshot): number {
  if (a.createdAt < b.createdAt) return -1
  if (a.createdAt > b.createdAt) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

export class TicketLog {
  /** 事件从哪儿来、往哪儿写；所有读写都走它，这个文件里没有一行 fs。 */
  private readonly backend: TicketBackend
  /** Called after every append that is not internal; see `quietly`. */
  private readonly emit?: (event: TicketBroadcast) => void
  /**
   * dsh-events 在时走 publish，不在时是 undefined、走 `backend.append`。
   * 这个字段一设，事件就不再由本进程 INSERT；投影仍由本进程补（见 commit）。
   */
  private readonly publisher?: TicketEventPublisher
  /** 后端自己的日志口；投影补写失败时报一声，不影响票的写。 */
  private readonly log?: (message: string) => void

  /**
   * 内存投影：ticketId → 折好的快照。list()/get() 从这儿读，不再每次整份重读
   * 日志、重新 fold。启动时（第一次 refresh）全量 fold 一次，之后 commit 只折叠
   * 刚写进去的那一行。
   */
  private state = new Map<string, TicketSnapshot>()
  private loaded = false
  /** 内部写入（巡检自己的重开、投递记账）不许再广播，否则事件自激。 */
  private quiet = 0
  /** 每次 commit 落定后的旁路回调（快照文件挂这儿）；失败不许影响票的写。 */
  private readonly committed = new Set<() => void>()

  /**
   * `source` 给路径就按 jsonl 打开（测试和工具都这么用），给一个 TicketBackend
   * 实例就用它。传后端时 `log` 这一栏没用：坏行由后端自己报。
   */
  constructor(
    source: string | TicketBackend,
    log?: (message: string) => void,
    emit?: (event: TicketBroadcast) => void,
    publisher?: TicketEventPublisher,
  ) {
    this.backend = typeof source === 'string' ? new JsonlTicketStore(source, log) : source
    this.emit = emit
    this.publisher = publisher
    this.log = log
  }

  /** 这份日志在哪儿：jsonl 就是文件路径，别的后端是它自己的地址。 */
  get location(): string {
    return this.backend.location
  }

  /**
   * 读之前的兜底：只问后端一次「变了吗」，没变就直接用投影。变了（别的进程
   * 追加、有人手改了文件、日志被截断）才整份重放一次——不是每次都重新折叠。
   */
  private refresh(): void {
    if (this.loaded && !this.backend.changed()) return
    const state = new Map<string, TicketSnapshot>()
    for (const event of this.backend.load()) applyEvent(state, event)
    this.state = state
    this.loaded = true
  }

  list(): TicketSnapshot[] {
    this.refresh()
    return [...this.state.values()].sort(byCreatedAt)
  }

  get(id: string): TicketSnapshot | undefined {
    this.refresh()
    return this.state.get(id)
  }

  /**
   * 每次 `commit` 落定后调一次（投影已折好、广播已发）。只读旁路用：桌面快照
   * 文件据此在票变化后立刻重写。回调抛错在这儿被吞掉——票已经写进日志了，
   * 不能因为一份展示用的文件把 `dispatch_open` 弄失败；由挂回调的人自己记日志。
   */
  onCommitted(listener: () => void): () => void {
    this.committed.add(listener)
    return () => {
      this.committed.delete(listener)
    }
  }

  /**
   * Run `work` without broadcasting what it appends. Sweep and the ticket
   * handlers write to the log themselves (reopen, markDelivered); announcing
   * those would wake the very listener that asked for the write. Nested calls
   * are fine: the counter only reaches zero once, on the outermost return.
   */
  quietly<T>(work: () => T): T {
    this.quiet += 1
    try {
      return work()
    } finally {
      this.quiet -= 1
    }
  }

  /**
   * 唯一写入口：一条事件追加进后端，折进投影，没被 `quietly` 压住就广播。
   *
   * 串行化不在这里：同一时刻的写由调用方（`src/index.ts` 的 `ticketQueue`）
   * 排队，这一层保持同步——`open()` / `update()` 这些方法今天就是同步返回新
   * 快照的，搬进来变成异步会把调用点全改一遍，P1 不许。
   */
  commit(event: TicketEvent): void {
    // 先对齐一次投影：日志要是被外部改过，这一条必须折在最新状态上。
    this.refresh()
    // 原子追加归后端管（jsonl 是一次 O_APPEND 的 writeSync），这里只折刚写的
    // 这一行，不重读整份日志。
    //
    // 有 dsh-events 时事件由它落库（publish），本进程只补投影；没有时照老路
    // 由后端 append。两条路都同步，调用点的回执形状不变。
    if (this.publisher) {
      let seq: number | undefined
      try {
        seq = this.publisher.publish(event)
      } catch (error) {
        if ((error as { code?: unknown }).code !== EV_SCHEMA) throw error
        // 超大事件不能因为总线限制就丢：dsh-events 在落库前校验并拒收，这条
        // 退回原来的直写，票和报告都保住；其它错误照旧往上抛。
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
        this.log?.(
          `[dispatcher] 票 ${event.id} 的事件 ${bytes} 字节超过 dsh-events 上限，这条退回直写：${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        this.backend.append(event)
        applyEvent(this.state, event)
        this.loaded = true
      }
      if (seq !== undefined) {
        applyEvent(this.state, event)
        this.loaded = true
        this.adopt(event, seq)
      }
    } else {
      this.backend.append(event)
      applyEvent(this.state, event)
      this.loaded = true
    }
    if (this.emit && this.quiet === 0) {
      this.emit({ id: event.id, at: event.at, kind: kindOf(event) })
    }
    // 旁路回调放在最后：投影已经折好，回调里读到的是这一条写下的状态。
    for (const listener of [...this.committed]) {
      try {
        listener()
      } catch {
        // 见 onCommitted 的注释：票写成功就是成功，展示层的错不该回滚它。
      }
    }
  }

  /** publisher 路径的投影补写；后端不支持就当场报错，别静默丢投影。 */
  private adopt(event: TicketEvent, seq: number): void {
    const adopt = this.backend.adoptPublished
    if (!adopt) {
      throw new Error(`后端 ${this.backend.location} 没有 adoptPublished，不能走 publish 路径`)
    }
    const snapshot = this.state.get(event.id)
    if (!snapshot) return
    adopt.call(this.backend, snapshot, seq)
  }

  open(goal: string, dir?: string, brief?: string): TicketSnapshot {
    const now = new Date()
    const id = newTicketId(now)
    // An empty brief is not written at all: absent and empty should read the
    // same, and leaving it out keeps the log line as short as it used to be.
    const trimmed = brief?.trim()
    this.commit({ id, at: now.toISOString(), goal, status: 'open', dir, ...(trimmed ? { brief: trimmed } : {}) })
    return this.get(id)!
  }

  update(
    id: string,
    patch: { status?: TicketStatus; note?: string; owner?: string; ownerId?: string; dir?: string },
  ): TicketSnapshot {
    const existing = this.get(id)
    if (!existing) throw new Error(`unknown ticket: ${id}`)
    this.commit({ id, at: new Date().toISOString(), ...patch })
    return this.get(id)!
  }

  /** Queue one more message for the worker; it is delivered later, not now. */
  appendInput(id: string, text: string): { ticket: TicketSnapshot; entry: TicketEntry } {
    if (!this.get(id)) throw new Error(`unknown ticket: ${id}`)
    const now = new Date()
    const entry = newEntryId(now)
    this.commit({ id, at: now.toISOString(), input: { id: entry, text } })
    return { ticket: this.get(id)!, entry: { id: entry, at: now.toISOString(), text, delivered: false } }
  }

  /** Record one report from a worker; the main session reads it later. */
  appendReport(id: string, text: string): { ticket: TicketSnapshot; entry: TicketEntry } {
    if (!this.get(id)) throw new Error(`unknown ticket: ${id}`)
    const now = new Date()
    const entry = newEntryId(now)
    this.commit({ id, at: now.toISOString(), report: { id: entry, text } })
    return { ticket: this.get(id)!, entry: { id: entry, at: now.toISOString(), text, delivered: false } }
  }

  /** Record that one queued entry reached its reader. */
  markDelivered(id: string, kind: EntryKind, entryId: string): TicketSnapshot {
    if (!this.get(id)) throw new Error(`unknown ticket: ${id}`)
    this.commit({ id, at: new Date().toISOString(), delivered: { kind, id: entryId } })
    return this.get(id)!
  }
}
