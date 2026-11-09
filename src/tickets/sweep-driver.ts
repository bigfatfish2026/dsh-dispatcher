/**
 * 巡检的驱动源：dsh-timer 的 tick 优先，拿不到就自己数秒。
 *
 * 背景（草案第三刀 3b）：发布侧 `dispatcher.sweep.tick` 已经由 dsh-timer 的
 * `schedule` 规则发出来了，这一刀把 dispatcher 自己的 `setInterval` 换掉——
 * 但**发布和订阅必须同一刀**：只上发布不上订阅，sweep 白多一条事件；只上订阅
 * 不上发布，sweep 直接停摆。所以这里的每一处失败都得回退到自己的定时器，而
 * 且要留一行日志说清当前是谁在驱动。
 *
 * 三条降级路径，都不能让巡检停：
 *
 * - `schedule` 服务不在（dsh-timer 没挂、或还没 apply）：保留自己的 interval，
 *   每次巡检再探一次——它中途出现就切过去。
 * - 注册被拒（EV-006：topic 没在 events 注册表里；BAD_RULE：`every` 小于 5000
 *   或 id 已被别的实例占了）：保留自己的 interval，冷却一段时间再试，别每拍
 *   刷一行 warn。
 * - tick 中途断流（dsh-timer 停了、events 没了、规则被撤了）：watchdog 按
 *   「三个周期没收到 tick」判死，恢复自己的 interval 并 warn。宁可多跑一拍
 *   自己的定时器，也不能静默假装还在巡检。
 *
 * 两把锁：
 *
 * - 拍子不并发：`desk.pulse()` 里那道闸是唯一的闸，interval 和订阅共用。
 * - 换源幂等：订阅只有一份（`subscription`）、规则只注册一次（`ruleRegistered`）、
 *   换源先停旧再起新（`desk.driveSweep`），重复 reconcile 不会变成两路同时驱动。
 */
import type { Clock } from './clock'

/** dsh-timer 发 tick 用的事件名，也是本文件订阅/注册的名字。 */
export const SWEEP_TOPIC = 'dispatcher.sweep.tick'
/** 规则 id：`schedule.register` 里全局唯一，注销时按它撤。 */
export const SWEEP_RULE_ID = 'dispatcher.sweep'
/** 订阅者 id：dsh-events 的投递游标按它记，重复订阅也只会有一份。 */
export const SWEEP_SUBSCRIBER_ID = 'dsh-dispatcher.sweep'

/** socket 形状：dsh-timer 发的是 `{ name, firedAt, periodKey }`，三个都是字符串。 */
export interface SweepTickPayload {
  name: string
  firedAt: string
  periodKey: string
}

/**
 * 事件类型注册项。volatile：tick 是「到点了」的信号，不是业务数据，不该在
 * 事件表里留行，也不需要重放。
 */
export const SWEEP_EVENT_DEF = Object.freeze({
  name: SWEEP_TOPIC,
  version: 1,
  durability: 'volatile' as const,
  payloadSchema: (payload: unknown): boolean => {
    const tick = payload as Partial<SweepTickPayload> | undefined
    return (
      typeof tick?.name === 'string' &&
      typeof tick.firedAt === 'string' &&
      typeof tick.periodKey === 'string'
    )
  },
})

/** dispatcher 眼里 dsh-events 服务的最小面：注册类型、订阅、查重。 */
export interface SweepEventsService {
  defineEvent(def: typeof SWEEP_EVENT_DEF): unknown
  subscribe(
    pattern: string,
    handler: (event: { payload?: unknown }) => unknown,
    options?: { subscriberId?: string; replay?: { mode: 'none' } },
  ): { stop?: () => void } | undefined
  registry?: { get(name: string, version?: number): unknown }
}

/** dispatcher 眼里 dsh-timer 调度服务的最小面。 */
export interface SweepScheduleService {
  register(rule: { id: string; every: number; topic: string; catchUp: 'skip' }): unknown
  unregister(id: string): unknown
  /** 规则表（后路探针用）：`list()` / `listRules()` 哪个有就用哪个，都没有就当规则还在。 */
  list?(): unknown
  listRules?(): unknown
}

/** 被驱动的票台：只需要「打一拍」和「换源」两个口。 */
export interface SweepDeskPort {
  pulse(source: 'interval' | 'tick'): boolean
  driveSweep(source: 'interval' | 'tick'): void
}

export interface SweepDriverOptions {
  desk: SweepDeskPort
  /** 惰性探测：每次 reconcile 现取，服务中途出现/消失都看得见。 */
  events: () => SweepEventsService | undefined
  schedule: () => SweepScheduleService | undefined
  /** 现有巡检周期（`sweepMs`）；0 = 巡检整体关掉。 */
  every: number
  clock: Clock
  info?: (message: string) => void
  warn?: (message: string) => void
}

export interface SweepDriver {
  /** 探一次服务，该换源就换。幂等，可以每拍都调。 */
  reconcile(): void
  /** 收到一拍 tick：记时间、打一拍。 */
  tick(payload: unknown): void
  /** 收摊：退订、撤规则、停 watchdog。 */
  dispose(): void
  mode(): 'interval' | 'tick'
  status(): {
    mode: 'interval' | 'tick'
    subscribed: boolean
    registered: boolean
    lastTickAt: number
    serviceEventSeen: boolean
    watchAttached: boolean
  }
  /** `attachServiceWatch` 挂监听时调：watchdog 才知道该不该收快档。 */
  markServiceWatch(): void
  /** `internal/service` 事件入口；就绪返回 true，调用方接着 reconcile。 */
  noteServiceEvent(name: string, value: unknown): boolean
}

/** tick 断流判定：这么多拍没来就认死。 */
const STALL_FACTOR = 3
/**
 * 降级后路的快档：监听挂着、`internal/service` 事件却一次没来过时，watchdog
 * 收成 10 分钟一睁（阈值也按它），别傻等 3 个周期。
 */
const QUICK_WATCHDOG_MS = 10 * 60 * 1000
/** 失败后的冷却：别每 10 秒重试一次把日志刷满（最短 1 分钟）。 */
const RETRY_FACTOR = 30
const MIN_RETRY_MS = 60_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && code ? code : 'ERR'
}

export function createSweepDriver(options: SweepDriverOptions): SweepDriver {
  const { desk, events, schedule, every, clock } = options
  const info = options.info ?? ((): void => {})
  const warn = options.warn ?? ((): void => {})
  const stallMs = Math.max(every * STALL_FACTOR, every + 1_000)
  const retryMs = Math.max(every * RETRY_FACTOR, MIN_RETRY_MS)

  let mode: 'interval' | 'tick' = 'interval'
  let subscription: { stop?: () => void } | undefined
  let ruleRegistered = false
  let lastTickAt = 0
  let retryAt = 0
  /** 上次看到的 schedule 服务实例：换实例等于规则全丢，得在新实例上重挂。 */
  let scheduleSeen: unknown
  /** 「schedule 不在」只播报一次，服务出现过再消失时重新播报。 */
  let absentAnnounced = false
  /** 「events 不在」同理：不刷屏，服务出现过再消失时重新播报。 */
  let eventsAnnounced = false
  let watchdog: unknown
  let stopped = false
  /** 降级标记：`internal/service` 里收到过 schedule 事件没有。假的时候 watchdog 收快档。 */
  let serviceEventSeen = false
  /** 监听挂没挂：没挂的时候（单独用 driver）不该按「a 方案失效」收紧 watchdog。 */
  let watchAttached = false

  function now(): number {
    return clock.now().getTime()
  }

  function dropSubscription(): boolean {
    const sub = subscription
    if (!sub) return false
    subscription = undefined
    try {
      sub.stop?.()
    } catch (error) {
      warn(`[dispatcher] 退订 ${SWEEP_TOPIC} 失败：${messageOf(error)}`)
    }
    return true
  }

  function dropRule(): void {
    if (!ruleRegistered) return
    ruleRegistered = false
    const service = schedule()
    if (!service) return
    try {
      service.unregister(SWEEP_RULE_ID)
    } catch (error) {
      warn(`[dispatcher] 注销规则 ${SWEEP_RULE_ID} 失败：${messageOf(error)}`)
    }
  }

  function stopWatchdog(): void {
    if (watchdog === undefined) return
    clock.clearInterval(watchdog)
    watchdog = undefined
  }

  function startWatchdog(): void {
    stopWatchdog()
    const quick = watchAttached && !serviceEventSeen
    const quickStallMs = Math.min(QUICK_WATCHDOG_MS, stallMs)
    watchdog = clock.setInterval(() => {
      if (stopped || mode !== 'tick') return
      const idle = now() - lastTickAt
      if (quick) {
        // a 方案的后路：监听挂了但事件没来过，顺手查规则还在不在，丢了就地重挂。
        // 重挂成功说明服务还在、tick 还会来，把表重新起算，别当场判死。
        let rearmed = false
        try {
          rearmed = probeRule()
        } catch (error) {
          warn(`[dispatcher] 巡检探规则抛错：${messageOf(error)}`)
        }
        if (rearmed) {
          lastTickAt = now()
          return
        }
        if (idle < quickStallMs) return
      } else if (idle < stallMs) {
        return
      }
      // 断流不是「少跑一拍」而是「再也不会跑」：必须当场把驱动源换回来。
      fallback(`[dispatcher] ${SWEEP_TOPIC} 断流：${Math.round(idle / 1_000)} 秒没收到 tick`)
    }, quick ? Math.min(QUICK_WATCHDOG_MS, every) : every)
  }

  /**
   * 后路探针：`schedule.list()`/`listRules()` 哪个能用用哪个，查自己的规则还在不在。
   * 没有列表接口就当它在（不多事）；查不到才清 `ruleRegistered` 让 reconcile 重挂。
   */
  function probeRule(): boolean {
    if (mode !== 'tick' || stopped) return false
    const service = schedule()
    if (!service) return false
    const read = typeof service.list === 'function' ? service.list : service.listRules
    if (typeof read !== 'function') return false
    let rules: unknown
    try {
      rules = read.call(service)
    } catch (error) {
      warn(`[dispatcher] 列规则失败（${codeOf(error)}）：${messageOf(error)}`)
      return false
    }
    if (!Array.isArray(rules)) return false
    if (rules.some((rule) => (rule as { id?: unknown } | undefined)?.id === SWEEP_RULE_ID)) return false
    ruleRegistered = false
    reconcile()
    return ruleRegistered
  }

  function switchToTick(): void {
    mode = 'tick'
    lastTickAt = now()
    desk.driveSweep('tick')
    startWatchdog()
    info(
      `[dispatcher] sweep 由 ${SWEEP_TOPIC} 驱动（规则 ${SWEEP_RULE_ID}，每 ${every}ms，catchUp=skip），自己的定时器已停`,
    )
  }

  /** 降级：退回自己的定时器，并说明原因。只在 tick 模式下有意义。 */
  function fallback(reason: string): void {
    if (mode !== 'tick' || stopped) return
    stopWatchdog()
    dropSubscription()
    dropRule()
    mode = 'interval'
    retryAt = now() + retryMs
    desk.driveSweep('interval')
    if (every > 0) warn(`${reason}，sweep 恢复自己的 ${every}ms 定时器`)
  }

  function ensureSubscription(service: SweepEventsService): boolean {
    if (subscription) return true
    try {
      service.defineEvent(SWEEP_EVENT_DEF)
    } catch (error) {
      // 重复注册（热重载、上一份 fiber 已注册过）不算失败：注册表里查得到就行。
      if (service.registry?.get?.(SWEEP_TOPIC) === undefined) {
        warn(
          `[dispatcher] 注册事件类型 ${SWEEP_TOPIC} 失败（${codeOf(error)}）：${messageOf(error)}，sweep 仍由自己的 ${every}ms 定时器驱动`,
        )
        return false
      }
    }
    try {
      const sub = service.subscribe(
        SWEEP_TOPIC,
        (event) => {
          handleTick(event?.payload)
          return undefined
        },
        { subscriberId: SWEEP_SUBSCRIBER_ID, replay: { mode: 'none' } },
      )
      if (!sub || typeof sub.stop !== 'function') {
        warn(`[dispatcher] 订阅 ${SWEEP_TOPIC} 没拿到 stop()，sweep 仍由自己的 ${every}ms 定时器驱动`)
        return false
      }
      subscription = sub
      info(`[dispatcher] 已订阅 ${SWEEP_TOPIC}（volatile，不落事件表）`)
      return true
    } catch (error) {
      warn(
        `[dispatcher] 订阅 ${SWEEP_TOPIC} 失败：${messageOf(error)}，sweep 仍由自己的 ${every}ms 定时器驱动`,
      )
      return false
    }
  }

  function registerRule(service: SweepScheduleService, announce: (rule: unknown) => void): boolean {
    try {
      const receipt = service.register({
        id: SWEEP_RULE_ID,
        every,
        topic: SWEEP_TOPIC,
        catchUp: 'skip',
      })
      ruleRegistered = true
      announce(receipt)
      return true
    } catch (error) {
      ruleRegistered = false
      retryAt = now() + retryMs
      warn(
        `[dispatcher] 注册规则 ${SWEEP_RULE_ID} 失败（${codeOf(error)}）：${messageOf(error)}，sweep 仍由自己的 ${every}ms 定时器驱动`,
      )
      return false
    }
  }

  function handleTick(payload: unknown): void {
    if (stopped) return
    // 先记时间：闸掉的那一拍也算「流还活着」，否则 watchdog 会误判断流。
    lastTickAt = now()
    desk.pulse('tick')
    reconcile()
  }

  function reconcile(): void {
    if (stopped) return
    if (every <= 0) {
      // 配置把巡检整个关了：不订阅、不起定时器，跟以前 sweepMs 0 的行为一致。
      fallback('sweep 已关（sweepMs 0）')
      dropSubscription()
      return
    }

    const eventsService = events()
    if (!eventsService) {
      const had = dropSubscription()
      if (mode === 'tick') {
        fallback('[dispatcher] events 服务不在了')
      } else if (!eventsAnnounced) {
        eventsAnnounced = true
        info(
          `[dispatcher] 没有 events 服务，sweep 由自己的 ${every}ms 定时器驱动（tick 订阅等它出现再挂）`,
        )
      } else if (had) {
        warn(`[dispatcher] events 服务不在了，sweep 仍由自己的 ${every}ms 定时器驱动`)
      }
      return
    }
    eventsAnnounced = false

    if (!ensureSubscription(eventsService)) return

    const scheduleService = schedule()
    if (!scheduleService) {
      if (mode === 'tick') {
        fallback('[dispatcher] schedule 服务不在了')
      } else if (!absentAnnounced) {
        absentAnnounced = true
        warn(
          `[dispatcher] 没有 schedule 服务（dsh-timer 未挂），sweep 由自己的 ${every}ms 定时器驱动，等服务出现再切换`,
        )
      }
      return
    }

    if (scheduleService !== scheduleSeen) {
      // 新实例（装上、重启、热重载）：旧规则跟着旧实例没了，得重挂。
      if (scheduleSeen !== undefined) info('[dispatcher] schedule 服务换了实例，规则在新实例上重挂')
      scheduleSeen = scheduleService
      ruleRegistered = false
      retryAt = 0
      absentAnnounced = false
    }

    if (mode === 'tick' && ruleRegistered) return

    if (now() < retryAt) return

    if (mode === 'tick') {
      // 已经在 tick 模式但规则丢了（比如被谁 unregister 掉）：重挂，不换源。
      registerRule(scheduleService, () => info(`[dispatcher] 规则 ${SWEEP_RULE_ID} 已重挂`))
      return
    }

    registerRule(scheduleService, () => switchToTick())
  }

  /** 监听已挂（attachServiceWatch 调）：没收到事件时 watchdog 才收快档。 */
  function markServiceWatch(): void {
    if (watchAttached) return
    watchAttached = true
    // 监听挂上之前 watchdog 可能已经按慢档起了：立刻按快档重起，别等一个周期。
    if (watchdog !== undefined) startWatchdog()
  }

  /**
   * `internal/service` 事件入口：schedule 就绪/销毁。
   *
   * 就绪（value 非空）返回 true，调用方接着 reconcile——路径和「每拍巡检探到
   * 服务」完全一样，换实例重挂的判定也复用 scheduleSeen。
   *
   * 销毁（value 为空）只清缓存标记：别在这里 reconcile，那会走 fallback 起
   * 自己的定时器，服务马上要再来，纯属噪音；等真断流由 watchdog 判死。
   */
  function noteServiceEvent(name: string, value: unknown): boolean {
    if (name !== 'schedule') return false
    const firstSeen = !serviceEventSeen
    serviceEventSeen = true
    // 标记翻真后 watchdog 该回慢档：重起一次，别让它还按快档空转。
    if (firstSeen && watchdog !== undefined) startWatchdog()
    if (value) return true
    scheduleSeen = undefined
    ruleRegistered = false
    absentAnnounced = false
    return false
  }

  return {
    reconcile,
    markServiceWatch,
    noteServiceEvent,
    tick(payload: unknown): void {
      handleTick(payload)
    },
    dispose(): void {
      if (stopped) return
      stopped = true
      stopWatchdog()
      dropSubscription()
      dropRule()
      mode = 'interval'
    },
    mode: () => mode,
    status: () => ({
      mode,
      subscribed: subscription !== undefined,
      registered: ruleRegistered,
      lastTickAt,
      serviceEventSeen,
      watchAttached,
    }),
  }
}

/** `internal/service` 监听要的宿主面：`ctx.on` 的最薄抽象，测试里给个假的就行。 */
export type ServiceEventOn = (
  event: string,
  listener: (name: string, value: unknown) => void,
) => (() => void) | void

/**
 * 挂 `internal/service` 监听：schedule 就绪就重挂规则，不用等下一拍巡检。
 *
 * ⚠ 回调整只包 try/catch，这条是硬要求：dsh-events 的 emit 是
 * `dispatch(...).map(cb => cb(...args))`，没有 try/catch，监听器抛错会冒到
 * timer 的 provide/effect，可能把 timer 的 apply 弄挂。catch 里只 warn，绝不 rethrow。
 *
 * 不加 `{ global: true }`：同 root 同 isolate 就能收到（实测）。
 */
export function attachServiceWatch(
  on: ServiceEventOn,
  driver: Pick<SweepDriver, 'noteServiceEvent' | 'reconcile'> & Partial<Pick<SweepDriver, 'markServiceWatch'>>,
  options: { warn?: (message: string) => void } = {},
): () => void {
  const warn = options.warn ?? ((): void => {})
  driver.markServiceWatch?.()
  const off = on('internal/service', (name: string, value: unknown) => {
    try {
      if (name !== 'schedule') return
      if (!driver.noteServiceEvent(name, value)) return
      driver.reconcile()
    } catch (error) {
      warn(`[dispatcher] internal/service 监听处理失败（name=${String(name)}）：${messageOf(error)}`)
    }
  })
  return () => {
    try {
      off?.()
    } catch (error) {
      warn(`[dispatcher] 摘 internal/service 监听失败：${messageOf(error)}`)
    }
  }
}
