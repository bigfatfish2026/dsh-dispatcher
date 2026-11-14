/**
 * 主会话白名单 + worker 反向名单的接线：谁在什么时机装、装完喊哪句。
 *
 * 名单本身与安装策略在 router.ts（bindRouter / RestrictInstaller）；这里只做
 * 「活表里已有的先补一遍、agent/created 再装、tools/change 重 sync、收台拆掉」。
 * 顺序有讲究：必须跑在所有 tools.register 之后。
 */
import type { Context } from '@deepseek-ai/cordis'
import { routerAllowList } from '../config'
import type { Config } from '../config'
import { isWorkerSession } from '../no-wait'
import { TOOL_NAMES } from '../protocol'
import { bindRouter } from '../router'
import type { RouterAgent, RouterBinding } from '../router'

/** worker 无论配置怎么写都不该拿到的本包工具：开票、发话、读票、关票、挂起、列表、打点。 */
export const WORKER_FORBIDDEN_TOOLS = [
  TOOL_NAMES.open,
  TOOL_NAMES.send,
  TOOL_NAMES.read,
  TOOL_NAMES.close,
  TOOL_NAMES.block,
  TOOL_NAMES.list,
  TOOL_NAMES.progressNote,
]

export interface RestrictInstallerDeps {
  agents?: () => { list(): unknown[] } | undefined
  warn: (message: string) => void
  info: (message: string) => void
}

export function installRestrict(ctx: Context, config: Config, deps: RestrictInstallerDeps): void {
  if (!(config.routerRestrict || config.workerToolDeny || config.workerPromptPrune)) return
  const routerSeen = new WeakSet<object>()
  const bindings = new Set<RouterBinding>()
  const bound = new WeakMap<object, RouterBinding>()
  let announced = false
  let workerAnnounced = false
  let tearingDown = false
  const registry = {
    get(name: string): unknown {
      const tools = (ctx as { tools?: { get?: (name: string) => unknown } }).tools
      return tools?.get?.(name)
    },
    names(): readonly string[] {
      const tools = (ctx as { tools?: { schemas?: () => readonly { name: string }[] } }).tools
      try {
        return (tools?.schemas?.() ?? []).map((schema) => schema.name)
      } catch {
        return []
      }
    },
  }
  const options = {
    allow: routerAllowList(config),
    // deny 叠加、越减越少，跟 allow 不打架。拼在配置之后、不进默认值。
    deny: config.workerToolDeny ? [...new Set([...config.workerDenyTools, ...WORKER_FORBIDDEN_TOOLS])] : [],
    pruneWorkerPrompt: config.workerPromptPrune,
    escapeFile: config.routerEscapeFile,
    log: deps.warn,
    info: deps.info,
    registry,
  }
  const install = (agent: RouterAgent): void => {
    const worker = isWorkerSession(agent.session.header.origin)
    if (worker ? !config.workerToolDeny && !config.workerPromptPrune : !config.routerRestrict) return
    let binding = bound.get(agent)
    if (binding === undefined) {
      if (routerSeen.has(agent)) return
      routerSeen.add(agent)
      binding = bindRouter(agent, options)
      bound.set(agent, binding)
      bindings.add(binding)
      const own = binding
      agent.ctx.effect(() => () => {
        own.dispose()
        bindings.delete(own)
      }, 'dsh-dispatcher.router-release')
    } else {
      binding.sync()
    }
    const outcome = binding.outcome()
    if (worker) {
      if ((outcome === 'denied' || outcome === 'updated') && !workerAnnounced) {
        workerAnnounced = true
        deps.info(`[dispatcher] worker subagents hide ${binding.installed().length} tool(s): ${binding.installed().join(', ')}`)
      }
      return
    }
    if ((outcome === 'installed' || outcome === 'updated') && !announced) {
      announced = true
      deps.info(
        `[dispatcher] router whitelist installed on the main session (${binding.installed().length}/${options.allow.length} tools registered)`,
      )
    }
  }
  for (const agent of deps.agents?.()?.list() ?? []) install(agent as RouterAgent)
  ctx.on('agent/created', ({ agent }) => {
    install(agent as never)
    return undefined
  })
  ctx.on('tools/change', () => {
    if (tearingDown) return undefined
    for (const binding of [...bindings]) binding.sync()
    return undefined
  })
  ctx.effect(() => () => {
    tearingDown = true
    for (const binding of [...bindings]) binding.dispose()
    bindings.clear()
  }, 'dsh-dispatcher.router-teardown')
}
