/**
 * worker 平面的守卫：探路窗口、被挡停手订阅、写类工具守卫。
 *
 * 这三件都按 agent 会话装，从 apply() 搬出来之后只剩「agent/created 时调谁」，
 * 具体判定仍在 probe.ts / watch.ts 里。
 */
import type { Context } from '@deepseek-ai/cordis'
import { isWorkerSession } from '../no-wait'
import { ProbeWindows } from '../tickets/probe'
import { createWorkerWatch } from '../tickets/watch'

interface WorkerAgent {
  session?: { id?: string; header?: { origin?: string } }
  ctx?: {
    effect?: (callback: () => () => void, label?: string) => unknown
    tools?: {
      guard?: (guard: (execution: { name: string; arguments: unknown }) => string | undefined) => unknown
    }
  }
}

export interface WorkerPlaneDeps {
  agents?: () => { list(): WorkerAgent[]; get?: (id: string) => WorkerAgent | undefined } | undefined
  warn: (message: string) => void
  info: (message: string) => void
}

export interface WorkerPlane {
  probeWindows: ProbeWindows
  workerWatch: ReturnType<typeof createWorkerWatch>
  /** 给一只 worker 会话装「被挡期间不许写」的守卫；同一只只装一次。 */
  installGuard(agent: unknown): void
}

export function createWorkerPlane(ctx: Context, deps: WorkerPlaneDeps): WorkerPlane {
  // ── 探路窗口：只给正在探路的那只子会话减工具 ──────────────────────
  const probeWindows = new ProbeWindows({ warn: deps.warn })

  // ── 子会话的状态订阅：被挡就真停手 ────────────────────────────────
  const workerWatch = createWorkerWatch({
    agents: () => {
      const agents = deps.agents?.()
      return agents ? { get: (id: string) => agents.get?.(id) } : undefined
    },
    warn: deps.warn,
    info: deps.info,
  })
  ctx.effect(() => () => workerWatch.dispose(), 'dsh-dispatcher.worker-watch')

  /** 已经装过守卫的 worker 会话（同一只装一次）。 */
  const guardedWorkers = new WeakSet<object>()
  const workerGuardStops = new Set<() => void>()

  const installGuard = (agent: unknown): void => {
    const scope = agent as WorkerAgent
    if (!isWorkerSession(scope?.session?.header?.origin)) return
    if (guardedWorkers.has(agent as object)) return
    const workerId = scope.session?.id
    const guard = scope.ctx?.tools?.guard
    if (!workerId || typeof guard !== 'function') return
    guardedWorkers.add(agent as object)
    try {
      const stop = guard.call(scope.ctx?.tools, (execution) =>
        workerWatch.writeBlockReason(workerId, execution.name),
      )
      if (typeof stop !== 'function') return
      const release = stop as () => void
      workerGuardStops.add(release)
      scope.ctx?.effect?.(
        () => () => {
          workerGuardStops.delete(release)
          release()
        },
        'dsh-dispatcher.worker-block-guard',
      )
    } catch (error) {
      deps.warn(
        `[dispatcher] 子会话 ${workerId} 的停手守卫没装上：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // 热重载时活表里可能已经有一批 worker：先补一遍，别只等新建那一刀。
  for (const agent of deps.agents?.()?.list() ?? []) installGuard(agent)
  ctx.effect(() => () => {
    probeWindows.releaseAll()
    for (const release of [...workerGuardStops]) release()
  }, 'dsh-dispatcher.probe-windows')

  return { probeWindows, workerWatch, installGuard }
}
