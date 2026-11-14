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
interface RouterTools {
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
interface RouterRegistry {
  get(name: string): unknown
  names?(): readonly string[]
}

interface RouterOptions {
  /** Global tool names the main session keeps. */
  allow: readonly string[]
  /** Tool names a worker subagent must not see; the main session ignores it. */
  deny?: readonly string[]
  /**
   * Prune the tool-guidance sections out of a worker subagent's prompt.
   *
   * A worker's tool set is decided by its preset, so a section that spells the
   * tools out statically can only be right by accident; the plugins' own tool
   * descriptions already say how to use them. Default on: pass `false` to leave
   * every worker prompt exactly as the plugins assembled it.
   */
  pruneWorkerPrompt?: boolean
  /** An existing file here skips the whitelist entirely. `~` is expanded. */
  escapeFile: string
  /** Where the warnings go; omitted means quietly. */
  log?(message: string): void
  /** Where the "the whitelist grew" notes go; omitted means quietly. */
  info?(message: string): void
  /** The unfiltered registry view; without it the agent's own view is used. */
  registry?: RouterRegistry
}

type RouterOutcome =
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
  /** A later pass added names the first one could not find, or re-checked a list that is still short. */
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

/**
 * One pass's answer to "does a tool with this name exist?", read as of now.
 *
 * Three sources, and the asymmetry between them is the whole point:
 *
 * - `agent.ctx.tools.get` answers for one scope. It sees this agent's own
 *   registrations and every global tool the restriction still admits — and a
 *   name this module hid reads as **absent** there. So a "yes" is evidence, a
 *   "no" is not.
 * - `options.registry` is the plugin context's view. No scoped restriction
 *   reaches it (restrictions live on the scope chain, and the global view has
 *   no chain), so it is the authoritative source for global tools. What it
 *   cannot see is a tool a preset registered through `agent.ctx.tools.register`
 *   — that one lives on the agent's own layer and never enters the global one.
 * - `options.registry.names()` is the same global view listed out. It costs a
 *   schema projection (a deep clone per tool), so it is read lazily — only when
 *   `get` has already said no to a name — and once per pass at most.
 *
 * OR-ing all three is therefore the only combination that neither drops a live
 * global tool during a registration race nor forgets one it installed itself.
 * A name that only this module's own list remembers is handled by the caller,
 * not here: see `current.includes` in each binding.
 */
function registryLookup(
  agent: RouterAgent,
  options: RouterOptions,
): { confirmed: (name: string) => boolean; names: () => readonly string[] } {
  let listed: readonly string[] | undefined
  const names = (): readonly string[] => (listed ??= options.registry?.names?.() ?? [])
  const confirmed = (name: string): boolean =>
    Boolean(agent.ctx.tools.get(name)) || Boolean(options.registry?.get(name)) || names().includes(name)
  return { confirmed, names }
}

/**
 * Install one list, pruning the names `restrict` refuses as unknown.
 *
 * A name can be in the list on the strength of {@link RouterBinding} memory
 * alone — this module installed it, and the restricted scope now reads it as
 * absent. If that tool is really gone, `restrict` refuses the whole list and
 * `sync` would sit on `error` forever with the old restriction in force. So
 * the second attempt drops exactly the names the *authoritative* lookup cannot
 * confirm, and gives up (reporting the refusal) if that changes nothing: a
 * list where every name is confirmed by the registry but still refused is not
 * a name problem.
 */
function restrictPruned(
  agent: RouterAgent,
  filter: 'allow' | 'deny',
  names: readonly string[],
  confirmed: (name: string) => boolean,
): { stop?: () => void; kept: string[]; refused?: string } {
  let kept = [...names]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stop = agent.ctx.tools.restrict(filter === 'allow' ? { allow: kept } : { deny: kept })
      return { stop, kept }
    } catch (error) {
      const refused = error instanceof Error ? error.message : String(error)
      if (attempt > 0) return { kept, refused }
      const pruned = kept.filter(confirmed)
      if (pruned.length === 0 || pruned.length === kept.length) return { kept, refused }
      kept = pruned
    }
  }
  /* v8 ignore next -- the loop returns on both paths. */
  return { kept, refused: 'tools.restrict() refused the list' }
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

type RestrictionPrompt = 'allow' | 'dropAll' | 'none'

/** 一份限制的“政策参数”：名单从哪儿来、prompt 怎么处理、要不要全量覆盖检查。 */
interface RestrictionMode {
  effectLabel: string
  filter: 'allow' | 'deny'
  list: readonly string[]
  prompt: RestrictionPrompt
  /** deny 专用：名单盖住全部注册工具时拒绝，别把 worker 剥光。 */
  fullCoverageGuard?: boolean
  /** allow 专用：registry 没动的重复 pass 不再重装。 */
  trackMissing?: boolean
}

interface RestrictionState {
  agent: RouterAgent
  options: RouterOptions
  mode: RestrictionMode
  current: readonly string[]
  stopRestrict?: () => void
  promptBinding?: PromptFilterBinding
  promptTried: boolean
  first?: RouterOutcome
  lastMissing: string
  arm(): void
}

/**
 * 两份限制共用的骨架：状态、幂等 sync、dispose/arm、对外的 RouterBinding。
 *
 * 白名单和 worker deny 名单的差别只在“名单从哪来、prompt 怎么剪、要不要全量
 * 覆盖检查”，这些放进 RestrictionMode；真正的一次安装策略由 apply 给。
 */
function createRestrictInstaller(
  agent: RouterAgent,
  options: RouterOptions,
  mode: RestrictionMode,
  apply: (state: RestrictionState) => RouterOutcome,
): RouterBinding {
  let disposed = false
  let syncing = false
  let armed = false
  const state: RestrictionState = {
    agent,
    options,
    mode,
    current: [],
    promptTried: false,
    lastMissing: '',
    arm: () => {
      if (armed || disposed) return
      armed = true
      agent.ctx.effect(() => () => dispose(), mode.effectLabel)
    },
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    state.stopRestrict?.()
    state.stopRestrict = undefined
    state.promptBinding?.dispose()
    state.promptBinding = undefined
    state.current = []
  }
  const sync = (): RouterOutcome => {
    if (disposed || syncing) return state.first ?? 'unchanged'
    syncing = true
    try {
      return apply(state)
    } finally {
      syncing = false
    }
  }
  sync()
  return {
    sync,
    dispose,
    installed: () => [...state.current],
    outcome: () => state.first ?? 'unchanged',
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
 *
 * Two independent passes ride on this binding. The deny list trims the schema;
 * the prompt pass ({@link RouterOptions.pruneWorkerPrompt}) drops every
 * tool-guidance section, because a worker's tool set comes from its preset and a
 * statically written section can never be trusted to match it. The prompt pass
 * is one-shot — its verdict does not depend on which names were denied — so it
 * is installed once and only disposed with the scope.
 */
export function bindWorkerDeny(agent: RouterAgent, options: RouterOptions): RouterBinding {
  const wanted = [...new Set(options.deny ?? [])]
  const prunePrompt = options.pruneWorkerPrompt !== false
  if (wanted.length === 0 && !prunePrompt) return inertBinding('worker')

  return createRestrictInstaller(
    agent,
    options,
    {
      effectLabel: 'dsh-dispatcher.worker-deny',
      filter: 'deny',
      list: wanted,
      prompt: prunePrompt ? 'dropAll' : 'none',
      fullCoverageGuard: true,
    },
    (state) => {
      const { options, mode } = state
      const known = (confirmed: (name: string) => boolean, name: string): boolean =>
        confirmed(name) || state.current.includes(name)
      if (mode.prompt === 'dropAll' && !state.promptTried) {
        state.promptTried = true
        state.promptBinding = bindPromptFilter(agent.ctx, {
          allow: [],
          dropAllToolSections: true,
          effectLabel: 'dsh-dispatcher.worker-prompt',
          log: options.log,
        })
      }
      state.arm()
      if (wanted.length === 0) {
        state.first ??= 'worker'
        return 'worker'
      }
      const lookup = registryLookup(agent, options)
      const confirmed = lookup.confirmed
      const names = wanted.filter((name) => known(confirmed, name))
      const missing = wanted.filter((name) => !names.includes(name))
      if (names.length === 0) {
        options.log?.(
          '[dispatcher] worker deny list names no registered tool; nothing installed (memory writes stay guarded by the memory plugin)',
        )
        state.first ??= 'empty'
        return 'empty'
      }
      if (mode.fullCoverageGuard) {
        const registered = lookup.names()
        if (registered.length > 0 && registered.every((name) => names.includes(name))) {
          options.log?.(
            `[dispatcher] worker deny list covers all ${registered.length} registered tools; refusing to leave a worker with nothing`,
          )
          state.first ??= 'empty'
          return 'empty'
        }
      }
      if (sameNames(names, state.current)) {
        state.first ??= 'denied'
        return 'unchanged'
      }
      const previous = state.current
      const attempt = restrictPruned(agent, 'deny', names, confirmed)
      if (attempt.stop === undefined) {
        options.log?.(
          `[dispatcher] worker deny list refused: ${attempt.refused ?? 'unknown reason'} — keeping the previous one`,
        )
        state.first ??= 'error'
        return 'error'
      }
      const installed = attempt.kept
      const dropped = names.filter((name) => !installed.includes(name))
      if (dropped.length > 0) {
        options.log?.(
          `[dispatcher] worker deny list dropped ${dropped.length} name(s) the registry no longer answers to: ${dropped.join(', ')}`,
        )
      }
      const removed = state.stopRestrict
      state.stopRestrict = attempt.stop
      state.current = [...installed]
      removed?.()
      state.arm()
      if (state.first === undefined) {
        state.first = 'denied'
        options.info?.(
          `[dispatcher] worker subagents no longer see ${installed.length} tool(s): ${installed.join(', ')}`,
        )
        if (missing.length > 0) {
          options.log?.(
            `[dispatcher] workerDenyTools names no registered global tool answers to: ${missing.join(', ')} — left out until they register`,
          )
        }
        return 'denied'
      }
      const added = installed.filter((name) => !previous.includes(name))
      if (added.length > 0) {
        options.info?.(`[dispatcher] worker deny list grew by ${added.length}: ${added.join(', ')}`)
      }
      if (missing.length > 0) {
        options.log?.(`[dispatcher] workerDenyTools still unregistered: ${missing.join(', ')}`)
      }
      return 'updated'
    },
  )
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
  // The escape file is the emergency exit for the whole plugin, worker deny included.
  const escape = escapePath(options.escapeFile)
  if (existsSync(escape)) {
    options.log?.(`[dispatcher] router whitelist skipped: ${escape} exists`)
    return inertBinding('escape')
  }
  if (isWorkerSession(agent.session.header.origin)) return bindWorkerDeny(agent, options)

  return createRestrictInstaller(
    agent,
    options,
    {
      effectLabel: 'dsh-dispatcher.router-tools',
      filter: 'allow',
      list: options.allow,
      prompt: 'allow',
      trackMissing: true,
    },
    (state) => {
      const { options, mode } = state
      const allow = [...new Set(mode.list)]
      const usable = (confirmed: (name: string) => boolean): string[] => {
        const names: string[] = []
        for (const name of allow) {
          if (names.includes(name)) continue
          if (confirmed(name) || state.current.includes(name)) names.push(name)
        }
        return names
      }
      const { confirmed } = registryLookup(agent, options)
      const names = usable(confirmed)
      const missing = allow.filter((name) => !names.includes(name))
      const missingKey = [...missing].sort().join('\n')
      if (names.length === 0) {
        options.log?.('[dispatcher] router whitelist is empty after the self-test; nothing installed')
        state.first ??= 'empty'
        return 'empty'
      }
      const stale = missing.length > 0 && missingKey !== state.lastMissing
      if (sameNames(names, state.current) && !stale) {
        state.first ??= 'installed'
        return 'unchanged'
      }
      const known = state.current.length > 0
      const attempt = restrictPruned(agent, 'allow', names, confirmed)
      if (attempt.stop === undefined) {
        options.log?.(
          `[dispatcher] router whitelist reinstall refused: ${attempt.refused ?? 'unknown reason'} — keeping the previous one`,
        )
        state.first ??= 'error'
        return 'error'
      }
      const installed = attempt.kept
      const prunedNames = names.filter((name) => !installed.includes(name))
      if (prunedNames.length > 0) {
        options.log?.(
          `[dispatcher] router whitelist dropped ${prunedNames.length} name(s) the registry no longer answers to: ${prunedNames.join(', ')}`,
        )
      }
      const added = installed.filter((name) => !state.current.includes(name))
      const removed = state.current.filter((name) => !installed.includes(name))
      const nextPrompt = bindPromptFilter(agent.ctx, { allow: installed, log: options.log })
      const previousStop = state.stopRestrict
      const previousPrompt = state.promptBinding
      state.stopRestrict = attempt.stop
      state.promptBinding = nextPrompt
      state.current = [...installed]
      state.lastMissing = missingKey
      previousStop?.()
      previousPrompt?.dispose()
      state.arm()
      if (!known) {
        state.first = 'installed'
        if (missing.length > 0) {
          options.log?.(
            `[dispatcher] routerTools names no registered global tool answers to: ${missing.join(', ')} — dropped from the whitelist until they register`,
          )
        }
        return 'installed'
      }
      state.first ??= 'installed'
      if (added.length > 0) {
        options.info?.(
          `[dispatcher] router whitelist grew by ${added.length}: ${added.join(', ')} (now ${installed.length} tools)`,
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
    },
  )
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
