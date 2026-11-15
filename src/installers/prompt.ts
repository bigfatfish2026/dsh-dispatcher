/**
 * 提示词注入：交接规矩、巡检事实快照、等待守卫。
 *
 * 三件事都挂在宿主 prompt/agent 钩子上，和票台本身无关；从 apply() 里整段搬出来
 * 之后，apply 只剩「按顺序装」。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import { isWorkerSession, noWaitReason } from '../no-wait'
import type { SweepFacts } from '../tickets/sweep-facts'

interface PromptHeader {
  origin?: string
}

interface PromptAgent {
  session?: { header?: PromptHeader }
  ctx?: {
    effect?: (callback: () => () => void, label?: string) => unknown
    tools?: {
      guard?: (guard: (execution: { name: string; arguments: unknown }) => string | undefined) => () => void
    }
  }
}

export interface PromptGuardDeps {
  sweepFacts: Pick<SweepFacts, 'text'>
  info: (message: string) => void
  agents?: () => { list(): PromptAgent[] } | undefined
}

export function installPromptGuard(ctx: Context, config: Config, deps: PromptGuardDeps): void {
  // ── 派活规矩：只给主会话，子会话有自己的任务书 ────────────────────
  const handoffText = config.handoffPolicy ? (config.handoffPolicyText ?? '').trim() : ''
  if (handoffText) {
    let announced = false
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const header = (context as { agent?: { session?: { header?: PromptHeader } } })?.agent?.session?.header
      if (header?.origin === 'subagent') return assembled
      if (!announced) {
        announced = true
        deps.info(`[dispatcher] hand-off policy injected into the main session prompt (${handoffText.length} chars)`)
      }
      return {
        ...assembled,
        sections: [...assembled.sections, { name: 'dispatcher:handoff', order: 95, text: handoffText }],
      }
    })
  }

  // ── 巡检事实：走动态上下文快照，不往主会话里塞 user 消息 ────────
  // 宿主每次都把上下文重新渲染成一条 runtime-context 快照；文本没变就不落盘，
  // 变了才追加一条新的。模型看见的是「环境状态」，不是谁下的命令——这就是
  // 巡检提醒不再被主会话当成维护者说话的根。worker 不需要票台近况，跳过。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const header = (context as { agent?: { session?: { header?: PromptHeader } } })?.agent?.session?.header
    if (header?.origin === 'subagent') return assembled
    const text = deps.sweepFacts.text()
    if (!text) return assembled
    // interpolate: false —— 票的 brief 是自由文本，别让 {{…}} 被当成提示词变量。
    const contexts = Array.isArray(assembled.contexts) ? assembled.contexts : []
    return {
      ...assembled,
      contexts: [...contexts, { name: 'dispatcher:sweep', text, interpolate: false }],
    }
  })

  // ── 等待守卫：主会话不许把回话卡在长命令上 ──────────────────────
  // 提示词里写了「别自己耗着」也可能被忽略；这一层是真拦住。装在各会话的 ctx
  // 上，所以有两个拥有者：会话先没了走 agent.ctx 的 effect，插件先没了走插件的
  // teardown。release 幂等，撤两次没事。
  if (config.noWaitGuard) {
    const limits = { maxCommandMs: config.maxCommandMs, maxWaitMs: config.maxWaitMs }
    const guarded = new WeakSet<object>()
    const guardReleases = new Set<() => void>()
    let announced = false
    const install = (agent: PromptAgent): void => {
      if (isWorkerSession(agent.session?.header?.origin) || guarded.has(agent)) return
      // 必须从 tools 服务上调用：`guard()` 内部要用 this.guards，拆成裸函数会丢 this。
      const tools = agent.ctx?.tools
      if (typeof tools?.guard !== 'function') return
      guarded.add(agent)
      let stopGuard: (() => void) | undefined = tools.guard((execution) =>
        noWaitReason(execution.name, (execution.arguments ?? {}) as Record<string, unknown>, limits),
      )
      const release = (): void => {
        const stop = stopGuard
        stopGuard = undefined
        guardReleases.delete(release)
        stop?.()
      }
      guardReleases.add(release)
      agent.ctx?.effect?.(() => release, 'dsh-dispatcher.no-wait')
      if (!announced) {
        announced = true
        deps.info('[dispatcher] waiting guard installed on the main session')
      }
    }
    for (const agent of deps.agents?.()?.list() ?? []) install(agent)
    ctx.on('agent/created', ({ agent }) => {
      install(agent as never)
      return undefined
    })
    ctx.effect(() => () => {
      for (const release of [...guardReleases]) release()
    }, 'dsh-dispatcher.no-wait-teardown')
  }
}
