/**
 * 票日志与只读出口的安装：backend、TicketLog、TicketReadout、service、快照、
 * 串行队列、dsh-events 发布器的惰性探测。
 *
 * 从 apply() 整段搬出来；apply 只拿回 log / readout / serialize 三样。
 */
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import { createTicketBackend, resolveStateFile } from '../store'
import { createTicketEventPublisher } from '../store/bus'
import type { TicketEventPublisher, TicketEventsService } from '../store/bus'
import { TicketLog } from '../store/log'
import { TICKETS_SERVICE, TicketReadout } from '../tickets/readout'
import { TicketSnapshotFile } from '../tickets/snapshot'
import type { Serialize } from '../tickets/desk'

export interface StoreInstallerDeps {
  warn: (message: string) => void
  info: (message: string) => void
  /** `ctx.get` 的服务探测；没有就返回 undefined。 */
  service<T>(ctx: Context, name: string): T | undefined
  /** 队列把手交给 apply：测试靠它等票事件排空。 */
  setQueue?: (drain: () => Promise<void>) => void
}

export interface StoreInstallerResult {
  log: TicketLog
  readout: TicketReadout
  serialize: Serialize
}

export function installStore(ctx: Context, config: Config, deps: StoreInstallerDeps): StoreInstallerResult {
  const { warn, info } = deps
  // 票日志：唯一写者。第三个参数把每一条追加广播成 `dispatcher/ticket`，票台
  // 不靠它改状态（状态只在自己的事件处理里折），宿主和别的插件可以监听。
  //
  // 第四道口是 dsh-events：服务在、后端也支持「外部落库 + 只补投影」时，
  // 事件走 publish、类型在这里注册；服务不在就整条退回直写，行为跟以前一样。
  // 这是硬要求：dsh-events 没挂载时票台必须完全照旧。
  const backend = createTicketBackend(
    {
      backend: config.store?.backend,
      stateFile: resolveStateFile(config.stateFile),
      dbFile: config.store?.file ? resolveStateFile(config.store.file) : undefined,
    },
    warn,
  )
  // 惰性探测：dsh-events 可能比 dispatcher 晚 apply（loader 并发，行序不保证），
  // 所以 apply 时探到的「没有」不能定终身。每次 commit 再问一次：拿到服务就换
  // 发布器，服务没了就清缓存回直写。
  let cachedEvents: TicketEventsService | undefined
  let cachedPublisher: TicketEventPublisher | undefined
  let reportedNoBackend = false
  const resolvePublisher = (): TicketEventPublisher | undefined => {
    const current = deps.service<TicketEventsService>(ctx, 'events')
    if (!current) {
      cachedEvents = undefined
      cachedPublisher = undefined
      return undefined
    }
    // 服务对象没换就复用上次结论（包括「注册失败」），别每次 commit 都重试。
    if (current === cachedEvents) return cachedPublisher
    cachedEvents = current
    if (typeof current.publish !== 'function' || typeof current.defineEvent !== 'function') {
      cachedPublisher = undefined
      return undefined
    }
    if (typeof backend.adoptPublished !== 'function') {
      cachedPublisher = undefined
      if (!reportedNoBackend) {
        reportedNoBackend = true
        info(`[dispatcher] events 服务在，但 ${backend.location} 不支持外部落库：票事件走直写`)
      }
      return undefined
    }
    cachedPublisher = createTicketEventPublisher(current, warn)
    info(
      cachedPublisher
        ? '[dispatcher] 票事件 -> dsh-events（publish，类型已注册）'
        : '[dispatcher] events 类型没注册上：票事件走直写',
    )
    return cachedPublisher
  }

  // apply 时先探一次，只为了把启动日志写清楚；结果不当作永久结论。
  const publisher = resolvePublisher()
  if (!publisher) {
    info('[dispatcher] 没有 events 服务：票事件走直写（commit 时继续探测）')
  }

  const log = new TicketLog(
    backend,
    warn,
    (event) => {
      ;(ctx as unknown as { emit?: (name: string, payload: unknown) => void }).emit?.('dispatcher/ticket', event)
    },
    publisher,
    resolvePublisher,
  )

  // ── 统一只读出口 ────────────────────────────────────────────────
  // `/tickets` 指令（进程内）与桌宠（读文件/子进程）看的是同一份读数：CLI、
  // `dispatcher/tickets` 这个 service、桌面快照文件都从 TicketReadout 出，而
  // TicketReadout 只认 store 折好的快照。以后日志换 redis，消费者的形状不变。
  const readout = new TicketReadout(log, {
    briefMaxColumns: config.briefMaxColumns,
    waitingMinutes: config.waitingMinutes,
    blockedMinutes: config.blockedMinutes,
  })
  const provider = (ctx as unknown as { provide?: (name: string, value: unknown) => unknown }).provide
  if (typeof provider === 'function') {
    try {
      provider.call(ctx, TICKETS_SERVICE, readout)
    } catch (error) {
      // 热重载时同名服务可能还没被上一份 fiber 释放：降级成只有 CLI/文件可用。
      warn(`[dispatcher] ${TICKETS_SERVICE} 服务没挂上：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 桌面快照：每次 commit 之后同步重写，内容没变就不落盘。空 snapshotFile 跟着
  // 日志走（同目录的 tickets.snapshot.json），所以默认就是 $DSH_HOME/dispatcher/。
  const snapshotFile = (config.snapshotFile ?? '').trim()
  const snapshotPath = snapshotFile
    ? resolveStateFile(snapshotFile)
    : join(dirname(resolveStateFile(config.stateFile)), 'tickets.snapshot.json')
  if (config.snapshotEnabled ?? true) {
    const snapshots = new TicketSnapshotFile(
      readout,
      { file: snapshotPath, recentClosed: config.snapshotRecentClosed ?? 20 },
      warn,
    )
    snapshots.write()
    const stop = log.onCommitted(() => {
      snapshots.write()
    })
    ctx.effect(() => () => {
      stop()
    }, 'dsh-dispatcher.snapshot')
    info(`[dispatcher] 只读快照 -> ${snapshotPath}`)
  }

  // 全插件只有这一条队列：票台的每一次写都排在它上面，工具调用之间不会互相插队。
  let ticketQueue: Promise<void> = Promise.resolve()
  const serialize: Serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const run = ticketQueue.then(work)
    ticketQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  deps.setQueue?.(() => ticketQueue)

  return { log, readout, serialize }
}
