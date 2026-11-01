/**
 * The second half of the router whitelist: the prompt.
 *
 * `tools.restrict` only takes tools out of the schema list. Every tool plugin
 * also registers a prompt section telling the model how to use it, and those
 * sections are assembled independently of the tool registry — so a main session
 * with `browser` and `bilibili` frozen out still reads "Use the browser tools
 * …" and calls them anyway. This module drops the sections whose tools are all
 * hidden, and nothing else.
 *
 * Section names come from the host: every first-party tool contribution is
 * named `tool:<group>` (`tool:bash`, `tool:goal`, `tool:session-query`), and the
 * third-party ones follow the same shape (`tool:bilibili`, `tool:browser`).
 * Anything that is not a `tool:` section is somebody else's prose — persona,
 * plan policy, the hand-off rules this plugin appends — and is never touched.
 */

/** The slice of one assembled prompt section this module needs. */
export interface PromptSection {
  name: string
  order?: number
  text: string
}

/** One tool schema in {@link PromptAssembly.tools}. */
export interface PromptToolSchema {
  name: string
}

/** The slice of an assembled system prompt this module needs. */
export interface PromptAssembly {
  sections: PromptSection[]
  tools?: readonly PromptToolSchema[]
}

export type PromptAssemblyNext = () => Promise<PromptAssembly>

export type PromptAssemblyHook = (
  assembly: PromptAssembly,
  context: unknown,
  next: PromptAssemblyNext,
) => Promise<PromptAssembly>

/** Prefix the host gives every tool-guidance section. */
const TOOL_SECTION_PREFIX = 'tool:'

/**
 * Tool names are snake_case; a word with at least one underscore is taken as a
 * tool name on sight. Single words are only taken when they are already in the
 * vocabulary, or every "the" and "result" would count as a tool.
 */
const MULTI_SEGMENT = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g
const WORD = /[A-Za-z][A-Za-z0-9]*/g

/**
 * The tool group a section explains, or `undefined` for any other section.
 *
 * `tool:session-query` becomes `session_query`: the host hyphenates a group
 * name that has no tool of its own, while the tools inside it stay snake_case.
 */
export function toolSectionGroup(name: string): string | undefined {
  if (!name.startsWith(TOOL_SECTION_PREFIX)) return undefined
  return name.slice(TOOL_SECTION_PREFIX.length).replace(/-/g, '_')
}

/**
 * Tool names a section's prose mentions.
 *
 * `vocabulary` is what makes a bare word count: the allow list, the visible
 * schemas and the section group names themselves. That is how `tool:bash`
 * ("investigate failures … with bash") is recognised as being about `bash`
 * even when the word carries no underscore.
 */
export function mentionedToolNames(text: string, vocabulary: ReadonlySet<string>): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(MULTI_SEGMENT)) found.add(match[0])
  for (const match of text.matchAll(WORD)) {
    const lower = match[0].toLowerCase()
    if (vocabulary.has(lower)) found.add(lower)
  }
  return [...found]
}

/**
 * Whether one section only explains tools this session can no longer see.
 *
 * Two ways to stay. The group name itself is still a visible tool (`tool:bash`
 * while `bash` is whitelisted), or the prose names a tool that is still visible
 * — `tool:goal` keeps its place because `create_goal` is there. Nothing is
 * inferred from a shared prefix: `read_image` being visible must not keep the
 * `tool:read` section alive, and `read` is a different tool.
 */
export function prunesToolSection(
  section: PromptSection,
  visible: ReadonlySet<string>,
  vocabulary: ReadonlySet<string>,
): boolean {
  const group = toolSectionGroup(section.name)
  if (group === undefined) return false
  if (visible.has(group)) return false
  const mentioned = mentionedToolNames(section.text, vocabulary)
  return !mentioned.some((name) => visible.has(name))
}

/** What one prune pass did, so the caller can say it once. */
export interface PruneResult {
  assembly: PromptAssembly
  removed: string[]
}

/**
 * Drop the tool sections whose tools are all hidden.
 *
 * Visibility is read from `assembly.tools`, which the tool registry already
 * filled through this scope's restrictions — the same set the model is about
 * to receive. Nothing here re-derives it from the allow list, so a name that is
 * whitelisted but not registered does not keep a section alive.
 */
export function pruneToolSections(assembly: PromptAssembly, allow: readonly string[]): PruneResult {
  const visible = new Set<string>((assembly.tools ?? []).map((tool) => tool.name))
  const vocabulary = new Set<string>([...allow, ...visible])
  for (const section of assembly.sections) {
    const group = toolSectionGroup(section.name)
    if (group !== undefined) vocabulary.add(group)
  }

  const removed: string[] = []
  const sections = assembly.sections.filter((section) => {
    const text = typeof section.text === 'string' ? section.text : ''
    if (!prunesToolSection({ ...section, text }, visible, vocabulary)) return true
    removed.push(section.name)
    return false
  })
  if (removed.length === 0) return { assembly, removed }
  return { assembly: { ...assembly, sections }, removed }
}

/** The narrow slice of a scoped agent context this module installs into. */
export interface PromptScope {
  effect(callback: () => () => void, label?: string): unknown
  /**
   * The host's scoped event bus. Typed as `unknown` on purpose: cordis' `on` is
   * generic over its event map, and narrowing it to this one event would make
   * the real `agent.ctx` unassignable. The function is checked at runtime.
   */
  on?: unknown
}

export interface PromptFilterOptions {
  /** The whitelist, used only to widen the vocabulary. */
  allow: readonly string[]
  log?(message: string): void
}

/** What one installed prune pass can be undone by. */
export interface PromptFilterBinding {
  /** Drop the listener; safe to call twice, including after the scope disposed it. */
  dispose(): void
}

/**
 * Install the prune pass on one agent's own prompt scope.
 *
 * It is a scoped listener on purpose: `system-prompt/assemble` is a scoped
 * waterfall, so a listener registered through `agent.ctx` only ever sees that
 * agent's assembly. That is what keeps worker subagents untouched even though
 * their prompts go through the same event.
 *
 * The returned binding is what makes the pass reinstallable: the router grows
 * the whitelist when a late plugin registers its tools, and the prune pass has
 * to move with it instead of keeping the first (smaller) allow list forever.
 *
 * @returns the installed pass, or `undefined` when the host has no scoped hook.
 */
export function bindPromptFilter(
  scope: PromptScope,
  options: PromptFilterOptions,
): PromptFilterBinding | undefined {
  const on = scope.on
  if (typeof on !== 'function') {
    options.log?.(
      '[dispatcher] no scoped system-prompt/assemble hook in this host: tool guidance for hidden tools stays in the prompt',
    )
    return undefined
  }

  const register = on as (
    event: 'system-prompt/assemble',
    listener: PromptAssemblyHook,
  ) => () => void
  let announced = false
  let stop: (() => void) | undefined
  scope.effect(
    () => {
      stop = register('system-prompt/assemble', async (assembly, _context, next) => {
        const assembled = await next()
        const { assembly: pruned, removed } = pruneToolSections(assembled, options.allow)
        if (removed.length > 0 && !announced) {
          announced = true
          options.log?.(`[dispatcher] pruned prompt sections for hidden tools: ${removed.join(', ')}`)
        }
        return pruned
      })
      return () => {
        stop?.()
        stop = undefined
      }
    },
    'dsh-dispatcher.router-prompt',
  )

  return {
    dispose() {
      stop?.()
      stop = undefined
    },
  }
}

/**
 * Install the prune pass once, without a handle on it.
 *
 * Kept for callers that only ever install once; the reinstallable path is
 * {@link bindPromptFilter}.
 *
 * @returns whether the host offers a scoped hook to install into.
 */
export function installPromptFilter(scope: PromptScope, options: PromptFilterOptions): boolean {
  return bindPromptFilter(scope, options) !== undefined
}
