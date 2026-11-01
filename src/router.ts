import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isWorkerSession } from './no-wait'
import { installPromptFilter } from './prompt'

/**
 * The whitelist half of the dispatcher: a main session that can talk and hand
 * work out, and nothing else.
 *
 * The plugin cannot make a worker do the heavy lifting by itself — the model
 * still decides. What it can do is take the heavy tools away from the session
 * that answers the person, so "delegate it" stops competing with "just run it
 * here" and a long job cannot stall a reply. Workers keep every tool.
 */

/** The slice of `ctx.tools` this module needs. */
export interface RouterTools {
  restrict(filter: { allow: readonly string[] }): () => void
  get(name: string): unknown
}

/** The slice of an agent this module needs. */
export interface RouterAgent {
  session: { header: { origin?: string } }
  ctx: {
    effect(callback: () => () => void, label?: string): unknown
    tools: RouterTools
  }
}

export interface RouterOptions {
  /** Global tool names the main session keeps. */
  allow: readonly string[]
  /** An existing file here skips the whitelist entirely. `~` is expanded. */
  escapeFile: string
  /** Where the warnings go; omitted means quietly. */
  log?(message: string): void
}

export type RouterOutcome =
  /** The restriction is installed. */
  | 'installed'
  /** A worker subagent: never restricted. */
  | 'worker'
  /** The escape file exists; nothing was changed. */
  | 'escape'
  /** An empty allow list would fail the restrict call, so nothing was changed. */
  | 'empty'
  /** This agent was already handled. */
  | 'already'

/** Expand a leading `~` the way the rest of the plugin does. */
export function escapePath(file: string): string {
  return file.replace(/^~(?=$|\/)/, homedir())
}

/**
 * Names in `allow` that no registered global tool answers to.
 *
 * `tools.restrict` throws on an unknown name, and a throw here would leave the
 * main session with everything rather than the whitelist. So the names are
 * checked against the registry first, and the bad ones are reported instead of
 * being handed to the filter.
 */
export function missingRouterTools(allow: readonly string[], tools: RouterTools): string[] {
  return allow.filter((name) => !tools.get(name))
}

/**
 * Install the whitelist on one agent, at most once.
 *
 * `seen` is the caller's set, not a module-level one: it has to live as long as
 * the plugin context so a reload starts from a clean slate.
 */
export function installRouter(
  agent: RouterAgent,
  options: RouterOptions,
  seen: WeakSet<object>,
): RouterOutcome {
  if (isWorkerSession(agent.session.header.origin)) return 'worker'
  if (seen.has(agent)) return 'already'
  seen.add(agent)

  const escape = escapePath(options.escapeFile)
  if (existsSync(escape)) {
    options.log?.(`[dispatcher] router whitelist skipped: ${escape} exists`)
    return 'escape'
  }

  const missing = missingRouterTools(options.allow, agent.ctx.tools)
  if (missing.length > 0) {
    options.log?.(
      `[dispatcher] routerTools names no registered global tool answers to: ${missing.join(', ')} — dropped from the whitelist`,
    )
  }
  const allow = missing.length > 0 ? options.allow.filter((name) => !missing.includes(name)) : options.allow
  if (allow.length === 0) {
    options.log?.('[dispatcher] router whitelist is empty after the self-test; nothing installed')
    return 'empty'
  }

  // The check above has to happen here rather than in a try/catch around the
  // install: `ctx.effect` hands an exception from the callback to cordis' error
  // handling, so a bad name would come back as "no whitelist" with nothing said
  // here. `tools.restrict` itself refuses unknown names, so passing a checked
  // list is the only way the filter is known to be on.
  agent.ctx.effect(
    () => agent.ctx.tools.restrict({ allow: [...allow] }),
    'dsh-dispatcher.router-tools',
  )

  // Hiding the tools is only half of it: every tool plugin also registers a
  // prompt section saying how to use it, and that section is assembled from the
  // registry, not from the schema list. Left alone, the main session reads
  // "Use browser_navigate …" for a tool it no longer has. The pass is installed
  // here so it can never outlive the restriction that justifies it.
  installPromptFilter(agent.ctx, { allow, log: options.log })

  return 'installed'
}
