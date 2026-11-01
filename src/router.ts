import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isWorkerSession } from './no-wait'
import { bindPromptFilter } from './prompt'
import type { PromptFilterBinding } from './prompt'

/**
 * The whitelist half of the dispatcher: a main session that can talk and hand
 * work out, and nothing else, plus the one list a worker does not get.
 *
 * The plugin cannot make a worker do the heavy lifting by itself — the model
 * still decides. What it can do is take the heavy tools away from the session
 * that answers the person, so "delegate it" stops competing with "just run it
 * here" and a long job cannot stall a reply. Workers keep every tool except the
 * ones the operator has ruled out for them: writing memory is the main
 * session's job, so the write-side memory tools are removed from a worker's
 * schema (see {@link RouterOptions.deny}).
 *
 * The whitelist is installed more than once on purpose. Plugins register their
 * tools in load order, and `dsh-dispatcher` is not the last one: a name in the
 * allow list that has no tool yet is left out of this pass, and the binding is
 * told to try again when the registry changes. The first install must never be
 * the final word.
 */

/** The slice of `ctx.tools` this module needs. */
export interface RouterTools {
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
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

/**
 * An unfiltered view of the registry, for the self-test.
 *
 * `agent.ctx.tools.get` answers for one scope, and a scope that is already
 * restricted reads its own hidden tools as absent — so a second pass asking it
 * "is this name registered?" would get `no` for everything the first pass
 * installed and shrink the whitelist on every change. The caller passes the
 * global view here (the plugin context, not the agent's) and the two answers
 * are combined: visible through either one means the tool exists.
 *
 * `names` is the same view listed out, and only the worker deny list uses it,
 * for one safety check: a deny list that covers every registered tool would
 * leave a worker with nothing to work with, which is a configuration mistake
 * rather than a rule, so it is refused. Without it the check is skipped.
 */
export interface RouterRegistry {
  get(name: string): unknown
  names?(): readonly string[]
}

export interface RouterOptions {
  /** Global tool names the main session keeps. */
  allow: readonly string[]
  /** Tool names a worker subagent must not see; the main session ignores it. */
  deny?: readonly string[]
  /** An existing file here skips the whitelist entirely. `~` is expanded. */
  escapeFile: string
  /** Where the warnings go; omitted means quietly. */
  log?(message: string): void
  /** Where the "the whitelist grew" notes go; omitted means quietly. */
  info?(message: string): void
  /** The unfiltered registry view; without it the agent's own view is used. */
  registry?: RouterRegistry
}

export type RouterOutcome =
  /** The restriction is installed. */
  | 'installed'
  /** A worker subagent with no deny list: nothing to take away. */
  | 'worker'
  /** The escape file exists; nothing was changed. */
  | 'escape'
  /** An empty allow (or deny) list would fail the restrict call, so nothing was changed. */
  | 'empty'
  /** This agent was already handled. */
  | 'already'
  /** A later pass added names the first one could not find. */
  | 'updated'
  /** The registry has nothing new for this whitelist. */
  | 'unchanged'
  /** `tools.restrict` refused the list; the previous pass is still in force. */
  | 'error'
  /** A worker subagent got its deny list: the named tools are hidden from it. */
  | 'denied'

/**
 * One agent's whitelist, reinstallable.
 *
 * `sync` is idempotent: it reads the registry, compares the resulting list with
 * what is installed, and does nothing when they match. That is what makes it
 * safe to call from a `tools/change` listener — installing a restriction is
 * itself a change, so a sync that always reinstalled would feed itself forever.
 */
export interface RouterBinding {
  /** Install again if the allow list can now say more (or less) than it does. */
  sync(): RouterOutcome
  /** Drop the restriction and the prompt pass; safe to call twice. */
  dispose(): void
  /**
   * The names currently handed to `tools.restrict`: the whitelist for a main
   * session, the deny list for a worker.
   */
  installed(): readonly string[]
  /** What the first pass decided. */
  outcome(): RouterOutcome
}

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

/** Whether two allow lists name the same tools, order aside. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name))
}

/** A binding that never does anything, for the agents this module exempts. */
function inertBinding(outcome: RouterOutcome): RouterBinding {
  return {
    sync: () => outcome,
    dispose: () => {},
    installed: () => [],
    outcome: () => outcome,
  }
}

/**
 * Bind one worker subagent's deny list and install it once.
 *
 * Why a deny list instead of the reverse whitelist (`allow` = everything
 * registered minus the denied names) the ticket first suggested: `restrict`
 * validates an allow list against the scope's *restrictable* names, and the only
 * public enumeration, `tools.schemas()`, answers for the global layer alone.
 * A worker also inherits tools a preset registered on the agent plane, and those
 * names are not in that projection — so an allow list built from it would hide
 * every one of them and leave the worker with a handful of tools. A deny list
 * names exactly the rule ("these seven are the main session's business") and
 * cannot over-remove anything, which is also why the failure mode of a bad
 * config here is a missing restriction rather than a crippled worker.
 *
 * The real refusal still lives in the memory plugin: this only trims the schema
 * so the model never reads a tool it may not call.
 */
export function bindWorkerDeny(agent: RouterAgent, options: RouterOptions): RouterBinding {
  const wanted = [...new Set(options.deny ?? [])]
  if (wanted.length === 0) return inertBinding('worker')

  let current: readonly string[] = []
  let first: RouterOutcome | undefined
  let stopRestrict: (() => void) | undefined
  let armed = false
  let disposed = false
  let syncing = false

  /**
   * Names the registry can answer for right now.
   *
   * The installed list counts as known too: once a deny is in force this scope
   * reads the hidden names as absent, and a plain `get` check would then drop
   * them from the next pass and hand the worker its memory tools back.
   */
  const known = (name: string): boolean =>
    Boolean(agent.ctx.tools.get(name)) || Boolean(options.registry?.get(name)) || current.includes(name)

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stopRestrict?.()
    stopRestrict = undefined
    current = []
  }

  const arm = (): void => {
    if (armed || disposed) return
    armed = true
    agent.ctx.effect(() => () => dispose(), 'dsh-dispatcher.worker-deny')
  }

  const sync = (): RouterOutcome => {
    if (disposed) return first ?? 'unchanged'
    if (syncing) return first ?? 'unchanged'
    syncing = true
    try {
      const names = wanted.filter(known)
      const missing = wanted.filter((name) => !names.includes(name))

      if (names.length === 0) {
        options.log?.(
          '[dispatcher] worker deny list names no registered tool; nothing installed (memory writes stay guarded by the memory plugin)',
        )
        first ??= 'empty'
        return 'empty'
      }

      // A deny list that covers the whole registry is a typo, not a rule: the
      // worker would come up with no tools at all and every ticket would fail
      // with "unknown tool". Refuse it while the previous pass stays in force.
      const registered = options.registry?.names?.() ?? []
      if (registered.length > 0 && registered.every((name) => names.includes(name))) {
        options.log?.(
          `[dispatcher] worker deny list covers all ${registered.length} registered tools; refusing to leave a worker with nothing`,
        )
        first ??= 'empty'
        return 'empty'
      }

      if (sameNames(names, current)) {
        first ??= 'denied'
        return 'unchanged'
      }

      const previous = current
      let nextStop: () => void
      try {
        nextStop = agent.ctx.tools.restrict({ deny: [...names] })
      } catch (error) {
        options.log?.(
          `[dispatcher] worker deny list refused: ${error instanceof Error ? error.message : String(error)} — keeping the previous one`,
        )
        first ??= 'error'
        return 'error'
      }
      const removed = stopRestrict
      stopRestrict = nextStop
      current = [...names]
      removed?.()
      arm()

      if (first === undefined) {
        first = 'denied'
        options.info?.(
          `[dispatcher] worker subagents no longer see ${names.length} tool(s): ${names.join(', ')}`,
        )
        if (missing.length > 0) {
          options.log?.(
            `[dispatcher] workerDenyTools names no registered global tool answers to: ${missing.join(', ')} — left out until they register`,
          )
        }
        return 'denied'
      }

      const added = names.filter((name) => !previous.includes(name))
      if (added.length > 0) {
        options.info?.(`[dispatcher] worker deny list grew by ${added.length}: ${added.join(', ')}`)
      }
      if (missing.length > 0) {
        options.log?.(`[dispatcher] workerDenyTools still unregistered: ${missing.join(', ')}`)
      }
      return 'updated'
    } finally {
      syncing = false
    }
  }

  sync()

  return {
    sync,
    dispose,
    installed: () => [...current],
    outcome: () => first ?? 'unchanged',
  }
}

/**
 * Bind the whitelist to one agent and install it once.
 *
 * The returned binding keeps the disposers (`tools.restrict` and, for a main
 * session, the prompt pass) so a later `sync` can lift the previous one before
 * installing the next. Restrictions intersect, so installing a wider list on top
 * of the old one would keep the old list's answer — lifting first is not an
 * optimisation.
 */
export function bindRouter(agent: RouterAgent, options: RouterOptions): RouterBinding {
  // The escape file is the emergency exit for the whole plugin, worker deny
  // included: while it exists nothing is trimmed anywhere.
  const escape = escapePath(options.escapeFile)
  if (existsSync(escape)) {
    options.log?.(`[dispatcher] router whitelist skipped: ${escape} exists`)
    return inertBinding('escape')
  }

  if (isWorkerSession(agent.session.header.origin)) return bindWorkerDeny(agent, options)

  let current: readonly string[] = []
  let first: RouterOutcome | undefined
  let stopRestrict: (() => void) | undefined
  let promptBinding: PromptFilterBinding | undefined
  let armed = false
  let disposed = false
  let syncing = false

  /**
   * Names the registry can answer for right now.
   *
   * Both views are asked because neither is complete on its own: the agent's
   * view is filtered by the restriction this module installed (a name it
   * installed still answers, one it did not is invisible), and the global view
   * cannot see tools a preset registered on the agent plane.
   */
  const usable = (allow: readonly string[]): string[] => {
    const names: string[] = []
    for (const name of allow) {
      if (names.includes(name)) continue
      let known = Boolean(agent.ctx.tools.get(name))
      if (!known) known = Boolean(options.registry?.get(name))
      if (known) names.push(name)
    }
    return names
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stopRestrict?.()
    stopRestrict = undefined
    promptBinding?.dispose()
    promptBinding = undefined
    current = []
  }

  /** Hand the restriction's lifetime to the agent context, once. */
  const arm = (): void => {
    if (armed || disposed) return
    armed = true
    agent.ctx.effect(() => () => dispose(), 'dsh-dispatcher.router-tools')
  }

  const sync = (): RouterOutcome => {
    if (disposed) return first ?? 'unchanged'
    if (syncing) return first ?? 'unchanged'
    syncing = true
    try {
      const allow = [...new Set(options.allow)]
      const names = usable(allow)
      const missing = allow.filter((name) => !names.includes(name))

      if (names.length === 0) {
        options.log?.('[dispatcher] router whitelist is empty after the self-test; nothing installed')
        first ??= 'empty'
        return 'empty'
      }
      if (sameNames(names, current)) {
        first ??= 'installed'
        return 'unchanged'
      }

      const known = current.length > 0
      const added = names.filter((name) => !current.includes(name))
      const removed = current.filter((name) => !names.includes(name))

      // Install the new pair before lifting the old one. `tools.restrict`
      // refuses unknown names, and if it refuses here the old whitelist is
      // still on instead of the main session suddenly seeing everything.
      let nextStop: () => void
      try {
        nextStop = agent.ctx.tools.restrict({ allow: [...names] })
      } catch (error) {
        options.log?.(
          `[dispatcher] router whitelist reinstall refused: ${error instanceof Error ? error.message : String(error)} — keeping the previous one`,
        )
        first ??= 'error'
        return 'error'
      }
      const nextPrompt = bindPromptFilter(agent.ctx, { allow: names, log: options.log })
      const previousStop = stopRestrict
      const previousPrompt = promptBinding
      stopRestrict = nextStop
      promptBinding = nextPrompt
      current = [...names]
      previousStop?.()
      previousPrompt?.dispose()
      arm()

      if (!known) {
        first = 'installed'
        if (missing.length > 0) {
          options.log?.(
            `[dispatcher] routerTools names no registered global tool answers to: ${missing.join(', ')} — dropped from the whitelist until they register`,
          )
        }
        return 'installed'
      }

      first ??= 'installed'
      if (added.length > 0) {
        options.info?.(
          `[dispatcher] router whitelist grew by ${added.length}: ${added.join(', ')} (now ${names.length} tools)`,
        )
      }
      if (removed.length > 0) {
        options.log?.(
          `[dispatcher] router whitelist dropped ${removed.length} name(s) no longer registered: ${removed.join(', ')}`,
        )
      }
      if (missing.length > 0) {
        options.log?.(
          `[dispatcher] routerTools still no registered global tool answers to: ${missing.join(', ')} — left out of the whitelist`,
        )
      }
      return 'updated'
    } finally {
      syncing = false
    }
  }

  sync()

  return {
    sync,
    dispose,
    installed: () => [...current],
    outcome: () => first ?? 'unchanged',
  }
}

/**
 * Install the whitelist (or, for a worker, the deny list) on one agent, at most
 * once, and hand back the outcome.
 *
 * Kept for callers that only need the first pass; anything that keeps the agent
 * around for later registry changes should hold {@link bindRouter}'s result and
 * call `sync` on it.
 *
 * `seen` is the caller's set, not a module-level one: it has to live as long as
 * the plugin context so a reload starts from a clean slate.
 */
export function installRouter(
  agent: RouterAgent,
  options: RouterOptions,
  seen: WeakSet<object>,
): RouterOutcome {
  if (seen.has(agent)) return 'already'
  seen.add(agent)
  return bindRouter(agent, options).outcome()
}
