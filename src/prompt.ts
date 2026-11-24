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
 * A section is judged by the family of tool names it stands for, not by the
 * words its prose happens to contain. The table in `src/config.ts`
 * (`promptSectionFamilies`) says, per section name, which tools that section
 * explains — because a section name is not always a tool prefix or suffix:
 * `tool:bili-notify` also explains `bili_mentions`, `tool:jobs` explains
 * `job_output`, and `tool:workflow` explains `subagent`. A `tool:<group>`
 * section the table does not name falls back to the group itself plus every
 * name that starts with `group_` or ends with `_group`; that is what makes
 * `tool:browser` the section for `browser_navigate`, without making `browser`
 * itself a registered tool. MCP guidance has its own shapes —
 * `mcp:<server>` for one server's tools, all named `mcp__<server>__*`, and the
 * single `mcp-resource-servers` section for the three shared resource tools —
 * and is judged the same way. Anything that is not one of those sections is
 * somebody else's prose: persona, plan policy, the hand-off rules this plugin
 * appends, and is never touched.
 *
 * What "still has a tool" means is the session's **tool surface**, not
 * `assembly.tools`: that list is every schema the host collected before any
 * restriction ran (dsh-system-prompt assemble, `orderTools(collected, …)`),
 * and a restriction only filters what a scope *inherits* — a scope's own
 * registrations always stay. Asking `assembly.tools` therefore keeps every
 * section whose tools are registered anywhere, which is all of them. The
 * caller computes the surface (`visibleSurface` in `src/router.ts`): each
 * globally registered name, resolved through `tools.get(name, agentCtx)` so
 * this scope's restrictions answer it, plus that scope's own names.
 *
 * The prose is only a fallback: a section survives if a name inside it is on
 * the surface, but a bare word counts only when the section names no
 * snake_case tool at all. That is what stopped `tool:browser` from being kept
 * alive by the word "read" in "After navigating, read browser_snapshot before
 * deciding".
 */

/** The slice of one assembled prompt section this module needs. */
interface PromptSection {
  name: string
  order?: number
  text: string
}

/** One tool schema in {@link PromptAssembly.tools}. */
interface PromptToolSchema {
  name: string
}

/** The slice of an assembled system prompt this module needs. */
export interface PromptAssembly {
  sections: PromptSection[]
  tools?: readonly PromptToolSchema[]
}

type PromptAssemblyNext = () => Promise<PromptAssembly>

export type PromptAssemblyHook = (
  assembly: PromptAssembly,
  context: unknown,
  next: PromptAssemblyNext,
) => Promise<PromptAssembly>

/** Prefix the host gives every tool-guidance section. */
const TOOL_SECTION_PREFIX = 'tool:'

/**
 * One row of the section-name → tool-family table.
 *
 * Imported as a type only: the table's shape lives in `src/config.ts`, the
 * rules that read it live here, so neither file has to import the other.
 */
export interface PromptSectionFamily {
  /** The section name exactly as `ctx.systemPrompt.section()` registered it. */
  section: string
  /** Tool names it explains: exact, `prefix*`, `*suffix`, or `*infix*`. */
  tools: string[]
}

/**
 * The MCP naming: the client registers one section per server as
 * `mcp:<server>` and names that server's tools `mcp__<server>__<rawName>`, while
 * the resource plugin owns one shared section for the three tools it registers
 * outside any server's namespace.
 */
const MCP_SERVER_PREFIX = 'mcp:'
const MCP_TOOL_PREFIX = 'mcp__'
const MCP_RESOURCE_SECTION = 'mcp-resource-servers'
/**
 * The three shared resource tools, used only when a table does not name the
 * `mcp-resource-servers` section: without that row the section would fall back
 * to the `mcp_resource_servers` group, which matches nothing.
 */
const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
])

/**
 * Tool names are snake_case; a word with at least one underscore is taken as a
 * tool name on sight. Single words are only taken when they are already in the
 * vocabulary, or every "the" and "result" would count as a tool.
 */
const MULTI_SEGMENT = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g
const WORD = /[A-Za-z][A-Za-z0-9]*/g

/** The test a section's tools have to pass to keep that section in the prompt. */
type ToolFamily = (toolName: string) => boolean

/**
 * Whether one configured pattern covers a tool name.
 *
 * One `*` is allowed and may sit anywhere — `browser*`, `*_goal`, `*mcp_resource*`
 * — because that is all the table needs to say the three shapes plugin authors
 * use (prefix, suffix, infix). Without a `*` the name has to match whole.
 */
export function matchesToolPattern(tool: string, pattern: string): boolean {
  const star = pattern.indexOf('*')
  if (star < 0) return tool === pattern
  const head = pattern.slice(0, star)
  const tail = pattern.slice(star + 1)
  if (!tool.startsWith(head) || tool.length < head.length + tail.length) return false
  return tool.endsWith(tail)
}

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
 * The family of tool names one section stands for, or `undefined` when the
 * section is not a tool section at all and must be left alone.
 *
 * A group name is not necessarily a tool: `browser` and `goal` are sections the
 * plugins put the tools under, not schemas of their own, so the family has to
 * reach the members. Two directions are needed because plugin authors put the
 * group on either end of the name — `browser_navigate` prefixes it,
 * `create_goal` suffixes it — and the exact name is kept so a section named
 * after a real tool (`tool:bash`, `tool:present`) still matches it.
 *
 * `families` is the configured table and is consulted first: it is the only
 * way to say that `tool:bili-notify` also explains `bili_mentions`, or that
 * `tool:workflow` explains `subagent`. Leave it out and every `tool:` section
 * is judged by its group alone, which is what the tests of the old rule pin.
 */
export function sectionToolFamily(
  name: string,
  families: readonly PromptSectionFamily[] = [],
): ToolFamily | undefined {
  const row = families.find((entry) => entry.section === name)
  if (row !== undefined) {
    if (row.tools.length === 0) return undefined
    return (tool) => row.tools.some((pattern) => matchesToolPattern(tool, pattern))
  }
  if (name === MCP_RESOURCE_SECTION) {
    return (tool) => MCP_RESOURCE_TOOLS.has(tool)
  }
  if (name.startsWith(MCP_SERVER_PREFIX)) {
    const server = name.slice(MCP_SERVER_PREFIX.length)
    if (server === '') return undefined
    const prefix = `${MCP_TOOL_PREFIX}${server}__`
    return (tool) => tool.startsWith(prefix)
  }
  const group = toolSectionGroup(name)
  if (group === undefined || group === '') return undefined
  return (tool) =>
    tool === group || tool.startsWith(`${group}_`) || tool.endsWith(`_${group}`)
}

/**
 * Tool names a section's prose mentions.
 *
 * One rule holds the whole thing together: snake_case wins. If the text already
 * spells out a tool name, only those names count — a section that says
 * `bili_notify_unread` and also says "read the notifications" is about
 * `bili_notify_unread`, not about `read`. The bare-word pass exists only for
 * sections that name nothing (`tool:bash`: "investigate failures … with bash"),
 * and `vocabulary` — the allow list, the visible schemas and the section group
 * names — is what makes a word like `bash` count without an underscore, or
 * every "the" and "result" would be a tool.
 */
export function mentionedToolNames(text: string, vocabulary: ReadonlySet<string>): string[] {
  const named = [...new Set([...text.matchAll(MULTI_SEGMENT)].map((match) => match[0]))]
  if (named.length > 0) return named
  const found = new Set<string>()
  for (const match of text.matchAll(WORD)) {
    const lower = match[0].toLowerCase()
    if (vocabulary.has(lower)) found.add(lower)
  }
  return [...found]
}

/**
 * Whether one section only explains tools this session can no longer call.
 *
 * Two ways to stay. A member of the section's tool family is still on the
 * session's tool surface — `tool:goal` keeps its place because `create_goal`
 * is there, `tool:browser` goes because no `browser_*` is — or the prose names
 * a tool the surface still has (see {@link mentionedToolNames}). Nothing is
 * inferred from the allow list: a name this session cannot actually call must
 * not keep a section alive, or the model reads guidance for a tool the schema
 * list does not have.
 *
 * `surface` is the session's tool surface, not `assembly.tools`; see the
 * module comment for why the distinction is the whole fix.
 */
export function prunesToolSection(
  section: PromptSection,
  surface: ReadonlySet<string>,
  vocabulary: ReadonlySet<string>,
  families: readonly PromptSectionFamily[] = [],
): boolean {
  const family = sectionToolFamily(section.name, families)
  if (family === undefined) return false
  for (const tool of surface) {
    if (family(tool)) return false
  }
  const mentioned = mentionedToolNames(section.text, vocabulary)
  return !mentioned.some((name) => surface.has(name))
}

/** What one prune pass did, so the caller can say it once. */
interface PruneResult {
  assembly: PromptAssembly
  removed: string[]
}

/** How one prune pass decides which sections go. */
interface PruneOptions {
  /**
   * Drop every tool-guidance section, whatever the session can still call.
   *
   * A worker subagent's tool set comes from its preset, so a prompt that spells
   * the tools out statically can never match the schema it ships with — and the
   * tool's own description already says what it does. With no way to be right,
   * the whole family is dead weight in every worker session, so it all goes.
   * The family is still {@link sectionToolFamily}'s: persona, plan policy and
   * the hand-off rules are never touched.
   */
  dropAllToolSections?: boolean
  /** The section-name → tool-family table; see {@link PromptSectionFamily}. */
  families?: readonly PromptSectionFamily[]
  /**
   * The session's tool surface. When given it is the only visibility source:
   * `assembly.tools` is the pre-restriction list (see the module comment) and
   * would keep every section alive. When omitted the pass falls back to
   * `assembly.tools`, which is what the pure-function tests pin.
   */
  surface?: ReadonlySet<string>
}

/** The per-section verdict one pass uses, so the loop below stays one shape. */
function pruneVerdict(
  assembly: PromptAssembly,
  allow: readonly string[],
  options: PruneOptions,
): (section: PromptSection) => boolean {
  const families = options.families ?? []
  if (options.dropAllToolSections === true) {
    return (section) => sectionToolFamily(section.name, families) !== undefined
  }
  const surface =
    options.surface ?? new Set<string>((assembly.tools ?? []).map((tool) => tool.name))
  const vocabulary = new Set<string>([...allow, ...surface])
  for (const section of assembly.sections) {
    const group = toolSectionGroup(section.name)
    if (group !== undefined) vocabulary.add(group)
  }
  return (section) => prunesToolSection(section, surface, vocabulary, families)
}

/**
 * Drop the tool sections the session cannot back.
 *
 * Visibility is the session's tool surface ({@link PruneOptions.surface}); the
 * fallback to `assembly.tools` is for callers with no scope in hand. Nothing
 * here re-derives it from the allow list, so a name that is whitelisted but
 * not registered does not keep a section alive.
 *
 * `options.dropAllToolSections` skips that question and drops the whole family
 * (see {@link PruneOptions}); everything outside the family stays either way.
 */
export function pruneToolSections(
  assembly: PromptAssembly,
  allow: readonly string[],
  options: PruneOptions = {},
): PruneResult {
  const prune = pruneVerdict(assembly, allow, options)

  const removed: string[] = []
  const sections = assembly.sections.filter((section) => {
    const text = typeof section.text === 'string' ? section.text : ''
    if (!prune({ ...section, text })) return true
    removed.push(section.name)
    return false
  })
  if (removed.length === 0) return { assembly, removed }
  return { assembly: { ...assembly, sections }, removed }
}

/** The narrow slice of a scoped agent context this module installs into. */
interface PromptScope {
  effect(callback: () => () => void, label?: string): unknown
  /**
   * The host's scoped event bus. Typed as `unknown` on purpose: cordis' `on` is
   * generic over its event map, and narrowing it to this one event would make
   * the real `agent.ctx` unassignable. The function is checked at runtime.
   */
  on?: unknown
}

interface PromptFilterOptions {
  /**
   * The session's tool surface, read fresh on every assembly. A function, not a
   * set: the registry changes under a live session (`tools/change`) and a
   * captured set would go stale exactly when a plugin registers late.
   */
  surface(): ReadonlySet<string>
  /** The whitelist, used only to widen the vocabulary. */
  allow: readonly string[]
  /** The section-name → tool-family table; default is the group rule only. */
  families?: readonly PromptSectionFamily[]
  /** Passed through to {@link pruneToolSections}; see {@link PruneOptions}. */
  dropAllToolSections?: boolean
  /**
   * Say which sections went on every assembly, not once per binding. On by
   * default: the pass runs every step, and a once-only line is how this went
   * quiet for weeks.
   */
  logEach?: boolean
  /** The effect label this pass is armed under; main and worker stay apart. */
  effectLabel?: string
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
  const logEach = options.logEach !== false
  let announced = false
  let stop: (() => void) | undefined
  scope.effect(
    () => {
      stop = register('system-prompt/assemble', async (assembly, _context, next) => {
        // 监听器签名固定：这一层只看 next() 返回的装配结果。
        void assembly
        const assembled = await next()
        let surface: ReadonlySet<string>
        try {
          surface = options.surface()
        } catch {
          // 上限算不出来：照旧拿 assembly.tools，宁可多留也不误删。
          surface = new Set<string>((assembled.tools ?? []).map((tool) => tool.name))
        }
        const { assembly: pruned, removed } = pruneToolSections(assembled, options.allow, {
          dropAllToolSections: options.dropAllToolSections === true,
          ...(options.families !== undefined ? { families: options.families } : {}),
          surface,
        })
        if (removed.length > 0 && (logEach || !announced)) {
          announced = true
          const what =
            options.dropAllToolSections === true ? 'tool sections from a worker prompt' : 'sections for hidden tools'
          options.log?.(`[dispatcher] pruned ${removed.length} ${what}: ${removed.join(', ')}`)
        }
        return pruned
      })
      return () => {
        stop?.()
        stop = undefined
      }
    },
    options.effectLabel ?? 'dsh-dispatcher.router-prompt',
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
