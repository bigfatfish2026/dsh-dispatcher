/**
 * 插件的接线层：把票台（`tickets/desk.ts`）接成模型能调的工具，再把白名单、
 * 提示词和等待守卫装到会话上。
 *
 * 这一层**不写票**。开票、关票、挂起、投递、补报告全在 desk 里，工具只做三件事：
 * 从 `exec` 认出调用方、把参数转过去、把回执收窄成该给模型看的几栏。所以
 * 「工具也能改 status」这种第二条写者从结构上不存在。
 *
 * 也没有第二条队列：`serialize` 就是这个文件里那条 `ticketQueue`，desk 拿着它跑。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, DEFAULT_HANDOFF_POLICY } from './config'
import type { Config as ConfigShape } from './config'
import type { WorkerTicketTools } from './tickets/worker-tools'
import type { SweepDriver } from './tickets/sweep-driver'
import { installTools } from './installers/tools'
import { installDesk } from './installers/desk'
import { installStore } from './installers/store'
import { installRestrict } from './installers/restrict'
import { installPromptGuard } from './installers/prompt'

export const name = 'dsh-dispatcher'
export const inject = ['tools', 'agents']

// Re-export the schema so the loader can validate this plugin's config.
export { Config }

export { DEFAULT_HANDOFF_POLICY as HANDOFF_POLICY }

/**
 * worker 无论配置怎么写都不该拿到的本包工具：开票、发话、读票、关票、挂起、
 * 列表、以及绕过票直接推手机的打点。
 *
 * 子会话手上只留 `dispatch_report` 一个票工具，而且它只往队列里追加一行，碰不到
 * status。`dispatch_block` 也在这里：卡住该用报告说，不该自己把票标成挂起。
 *
 * 拼在 `workerDenyTools` 之后、不进 config 默认值：operator 改写
 * `workerDenyTools` 不该顺手把这几样放回 worker 手里。
 */
export { WORKER_FORBIDDEN_TOOLS } from './installers/restrict'

/** 票事件队列的把手：测试等它排空，生产里没人用。 */
export const ticketEventQueue = new WeakMap<object, () => Promise<void>>()

/** 巡检驱动源的把手：测试点一下「再探一次」，生产里没人读。 */
export const sweepDriverSlot = new WeakMap<object, SweepDriver>()

/** `ctx.get` 拿不到就返回 undefined：票台少一个服务该是降级，不是崩溃。 */
function service<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const found = getter.call(ctx, name)
      if (found !== undefined && found !== null) return found as T
    } catch {
      // 服务没就绪：往下走静态栏。
    }
  }
  const direct = (ctx as unknown as Record<string, unknown>)[name]
  return direct === undefined || direct === null ? undefined : (direct as T)
}

/**
 * 只认 `ctx.get` 的服务探测。
 *
 * `ctx.events` 是 Cordis 自己的事件总线，属性读会被它遮住；`events` 服务必须
 * 走 `ctx.get('events')` 才拿得到（见 dsh-events/plugin.js 的注释）。所以这里
 * 不吃 `service()` 的属性兜底。
 */
function probed<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter !== 'function') return undefined
  try {
    const found = getter.call(ctx, name)
    return found === undefined || found === null ? undefined : (found as T)
  } catch {
    return undefined
  }
}

export { intentPlanLines } from './tools-shared'

export function apply(ctx: Context, config: ConfigShape): void {
  const logger = (ctx as unknown as { logger?: Record<string, ((message: string) => void) | undefined> }).logger
  const warn = (message: string): void => {
    logger?.warn?.(message)
  }
  const info = (message: string): void => {
    logger?.info?.(message)
  }

  const { log, serialize } = installStore(ctx, config, {
    warn,
    info,
    service,
    setQueue: (drain) => ticketEventQueue.set(ctx as object, drain),
  })

  // 工具段的兜底注册要在 agent/created 里用到，先留空，等工具安装器返回再填。
  let workerTicketTools: WorkerTicketTools | undefined
  const { desk, sweepFacts, agentsOf } = installDesk(ctx, config, {
    log,
    serialize,
    service,
    probed,
    warn,
    info,
    getWorkerTools: () => workerTicketTools,
    setSweepDriver: (driver) => sweepDriverSlot.set(ctx as unknown as object, driver),
  })

  // ── 提示词注入：交接规矩、巡检事实、等待守卫 ────────────────────
  installPromptGuard(ctx, config, { sweepFacts, info, agents: agentsOf })

  // ── 十一个工具：router 六个 + worker 三件 + 账本 + 打点 ─────────
  workerTicketTools = installTools(ctx, { config, desk, sweepFacts, warn })

  // ── 主会话白名单 + worker 反向名单 ──────────────────────────────
  // 顺序有讲究：这一段必须跑在所有 `ctx.tools.register` 之后。
  installRestrict(ctx, config, { agents: agentsOf, warn, info })
}
