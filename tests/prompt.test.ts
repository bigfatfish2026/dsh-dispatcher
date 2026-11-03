import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER_TOOLS } from '../src/config'
import {
  installPromptFilter,
  mentionedToolNames,
  pruneToolSections,
  prunesToolSection,
  sectionToolFamily,
  toolSectionGroup,
} from '../src/prompt'
import type { PromptAssembly, PromptAssemblyHook } from '../src/prompt'

/**
 * A main session after the whitelist: only these schemas are left. It is the
 * shape the real one has — no `browser_*`, no `bili_*`, no `mcp__*`.
 */
const VISIBLE = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'present',
  'todo_write',
  'dispatch_open',
  'dispatch_list',
  'dispatch_send',
  'create_goal',
  'get_goal',
  'update_goal',
  'memory_recall',
  'chat_recall',
  'web_search',
  'web_fetch',
  'yuyu_face',
])

/**
 * The sections that actually matter here, cut down to the lines that name their
 * tools. The four at the top are the ones the real main session kept reading
 * even though none of their tools were visible.
 */
function mainSessionAssembly(): PromptAssembly {
  return {
    tools: [...VISIBLE].map((name) => ({ name })),
    sections: [
      { name: 'harness:identity', order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona-prefix', order: 0, text: '你是用户的私人助手，说话简短。' },
      { name: 'dispatcher:handoff', order: 95, text: '【派活规矩 · dispatcher】主会话的活是及时回话，长活交给 worker。' },
      { name: 'plan:policy', order: 900, text: 'Do not write files before the plan is approved.' },
      {
        name: 'tool:browser',
        order: 160,
        text: 'Use the browser tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_evaluate, browser_take_screenshot, browser_tabs) to inspect and interact with web pages. After navigating, read browser_snapshot before deciding the next action. Prefer browser tools over scraping via shell when a page is involved.',
      },
      {
        name: 'tool:bili-notify',
        order: 112,
        text: "bili_notify_unread / bili_mentions / bili_replies read the bilibili account's notifications (mentioned-in and replied-to), and bili_comments reads a video's comment section by bvid.",
      },
      {
        name: 'mcp:github',
        order: 500,
        text: '## GitHub\nUse mcp__github__search_code to find code, mcp__github__search_issues for issues, and mcp__github__create_pull_request to open a pull request.',
      },
      {
        name: 'mcp-resource-servers',
        order: 501,
        text: '## MCP resource servers\n\nUse list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: ["ha"].',
      },
      {
        name: 'tool:goal',
        order: 2400,
        text: 'Goals: create_goal for a long objective, get_goal to read it, update_goal to edit it.',
      },
      {
        name: 'tool:session-query',
        order: 2300,
        text: 'chat_recall searches past conversation logs; chat_index rebuilds the index.',
      },
      {
        name: 'tool:present',
        order: 2500,
        text: 'Declare existing files as final deliverables: present the file.',
      },
      {
        name: 'tool:dispatch',
        order: 2600,
        text: 'dispatch_open opens a ticket; dispatch_send queues a message for the worker.',
      },
      {
        name: 'tool:read',
        order: 1050,
        text: 'Use the read tool — not shell commands like cat — to inspect text files.',
      },
    ],
  }
}

const names = (assembly: PromptAssembly): string[] => assembly.sections.map((section) => section.name)

describe('toolSectionGroup', () => {
  it('reads the group name out of a tool section', () => {
    expect(toolSectionGroup('tool:bash')).toBe('bash')
    expect(toolSectionGroup('tool:bilibili')).toBe('bilibili')
    expect(toolSectionGroup('tool:session-query')).toBe('session_query')
    expect(toolSectionGroup('tool:bili-notify')).toBe('bili_notify')
  })

  it('leaves every other section alone', () => {
    expect(toolSectionGroup('harness:identity')).toBeUndefined()
    expect(toolSectionGroup('deployment:persona-prefix')).toBeUndefined()
    expect(toolSectionGroup('dispatcher:handoff')).toBeUndefined()
    expect(toolSectionGroup('mcp:github')).toBeUndefined()
    expect(toolSectionGroup('mcp-resource-servers')).toBeUndefined()
    expect(toolSectionGroup('ui:deliverable-file-references')).toBeUndefined()
    expect(toolSectionGroup('tools:ptc-only')).toBeUndefined()
  })
})

describe('sectionToolFamily', () => {
  it('covers the group name, its prefixed members and its suffixed members', () => {
    const family = sectionToolFamily('tool:browser')!
    expect(family('browser')).toBe(true)
    expect(family('browser_navigate')).toBe(true)
    expect(family('browser_take_screenshot')).toBe(true)
    expect(family('browserify')).toBe(false)
    expect(family('read')).toBe(false)
  })

  it('reaches the suffixed goal tools', () => {
    const family = sectionToolFamily('tool:goal')!
    expect(family('create_goal')).toBe(true)
    expect(family('get_goal')).toBe(true)
    expect(family('update_goal')).toBe(true)
    expect(family('goal')).toBe(true)
    expect(family('goal_state')).toBe(true)
  })

  it('hyphenates the group name the way the tools are named', () => {
    const family = sectionToolFamily('tool:bili-notify')!
    expect(family('bili_notify_unread')).toBe(true)
    expect(family('bili_mentions')).toBe(false)
  })

  it('maps an mcp server section onto that server namespace only', () => {
    const family = sectionToolFamily('mcp:github')!
    expect(family('mcp__github__search_code')).toBe(true)
    expect(family('mcp__github__create_pull_request')).toBe(true)
    expect(family('mcp__ha__HassTurnOn')).toBe(false)
    expect(family('search_code')).toBe(false)
  })

  it('maps the shared resource section onto the three resource tools', () => {
    const family = sectionToolFamily('mcp-resource-servers')!
    expect(family('list_mcp_resources')).toBe(true)
    expect(family('list_mcp_resource_templates')).toBe(true)
    expect(family('read_mcp_resource')).toBe(true)
    expect(family('mcp__ha__list_resources')).toBe(false)
  })

  it('has no family for prose sections', () => {
    expect(sectionToolFamily('harness:identity')).toBeUndefined()
    expect(sectionToolFamily('plan:policy')).toBeUndefined()
    expect(sectionToolFamily('dispatcher:handoff')).toBeUndefined()
  })
})

describe('mentionedToolNames', () => {
  it('takes snake_case words as tool names without asking', () => {
    expect(mentionedToolNames('bilibili_search and browser_navigate', new Set())).toEqual([
      'bilibili_search',
      'browser_navigate',
    ])
  })

  it('takes a bare word only when it is in the vocabulary', () => {
    const vocabulary = new Set(['bash', 'dispatch_open'])
    expect(mentionedToolNames('investigate failures with bash', vocabulary)).toEqual(['bash'])
    expect(mentionedToolNames('investigate failures with the shell', vocabulary)).toEqual([])
  })

  it('ignores bare words once the section spells out a snake_case name', () => {
    // This is the bili-notify section: "read the notifications" used to match
    // the visible `read` tool and keep the whole thing in the prompt.
    const vocabulary = new Set(['read'])
    expect(
      mentionedToolNames("bili_notify_unread read the account's notifications", vocabulary),
    ).toEqual(['bili_notify_unread'])
  })
})

describe('prunesToolSection', () => {
  const vocabulary = new Set([...VISIBLE, 'bili-notify', 'bili_notify', 'browser', 'session_query', 'dispatch'])

  it('drops a section whose family is entirely hidden', () => {
    const section = { name: 'tool:bash', text: 'investigate failures with bash' }
    expect(prunesToolSection(section, new Set(['read']), vocabulary)).toBe(true)
  })

  it('drops the browser section even though its prose says "read"', () => {
    const section = {
      name: 'tool:browser',
      text: 'Use the browser tools (browser_navigate, browser_snapshot) to inspect web pages. After navigating, read browser_snapshot before deciding the next action.',
    }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(true)
  })

  it('drops bili-notify when no bili_* tool is visible', () => {
    const section = {
      name: 'tool:bili-notify',
      text: "bili_notify_unread read the account's notifications; bili_comments reads a comment section.",
    }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(true)
  })

  it('keeps a section whose family has a visible member', () => {
    const section = { name: 'tool:goal', text: 'Goals: create_goal for a long objective, get_goal to read it.' }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(false)
  })

  it('keeps a section whose group name is itself a visible tool', () => {
    const section = { name: 'tool:present', text: 'Declare existing files as final deliverables.' }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(false)
  })

  it('keeps the read section on read itself', () => {
    const section = {
      name: 'tool:read',
      text: 'Use the read tool — not shell commands like cat — to inspect text files.',
    }
    // Kept because `read` is there; nothing else in the family is needed.
    expect(prunesToolSection(section, new Set(['read']), new Set(['read']))).toBe(false)
  })

  it('does not keep the read section on a whitelisted-but-unregistered name', () => {
    // `read` is on the default allow list, and the prose says "read", but the
    // schema list does not have it: only visibility may keep a section alive.
    const section = {
      name: 'tool:read',
      text: 'Use the read tool — not shell commands like cat — to inspect text files.',
    }
    const visibleWithoutRead = new Set(['bash', 'write', 'edit'])
    expect(prunesToolSection(section, visibleWithoutRead, new Set([...vocabulary, 'read']))).toBe(true)
  })

  it('drops mcp:github when no mcp__github__ tool is visible', () => {
    const section = {
      name: 'mcp:github',
      text: 'Use mcp__github__search_code to find code and mcp__github__search_issues for issues.',
    }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(true)
  })

  it('keeps mcp:github once one of its tools is visible', () => {
    const section = {
      name: 'mcp:github',
      text: 'Use mcp__github__search_code to find code.',
    }
    expect(prunesToolSection(section, new Set(['mcp__github__search_code']), vocabulary)).toBe(false)
  })

  it('drops the resource section when the three resource tools are hidden', () => {
    const section = {
      name: 'mcp-resource-servers',
      text: 'Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names: ["ha"].',
    }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(true)
    expect(prunesToolSection(section, new Set([...VISIBLE, 'read_mcp_resource']), vocabulary)).toBe(false)
  })

  it('never touches a section that is not a tool section', () => {
    const section = { name: 'deployment:persona-prefix', text: 'browser_navigate is mentioned here and it does not matter' }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(false)
  })
})

describe('pruneToolSections', () => {
  it('drops exactly the sections no visible tool stands behind', () => {
    const { assembly, removed } = pruneToolSections(mainSessionAssembly(), DEFAULT_ROUTER_TOOLS)
    expect(removed).toEqual(['tool:browser', 'tool:bili-notify', 'mcp:github', 'mcp-resource-servers'])
    expect(names(assembly)).toEqual([
      'harness:identity',
      'deployment:persona-prefix',
      'dispatcher:handoff',
      'plan:policy',
      'tool:goal',
      'tool:session-query',
      'tool:present',
      'tool:dispatch',
      'tool:read',
    ])
  })

  it('keeps a section that still names one visible tool', () => {
    const assembly: PromptAssembly = {
      tools: [{ name: 'chat_recall' }],
      sections: [
        { name: 'tool:session-query', text: 'chat_recall searches logs; chat_index rebuilds the index.' },
      ],
    }
    const pruned = pruneToolSections(assembly, DEFAULT_ROUTER_TOOLS)
    expect(pruned.removed).toEqual([])
    expect(names(pruned.assembly)).toEqual(['tool:session-query'])
  })

  it('falls back to a bare word when the section names no snake_case tool', () => {
    const assembly: PromptAssembly = {
      tools: [{ name: 'bash' }],
      sections: [{ name: 'tool:shell', text: 'Investigate failures with bash before moving on.' }],
    }
    const pruned = pruneToolSections(assembly, DEFAULT_ROUTER_TOOLS)
    expect(pruned.removed).toEqual([])
  })

  it('drops a tool section that names nothing, because its group is gone too', () => {
    const assembly: PromptAssembly = {
      tools: [{ name: 'dispatch_open' }],
      sections: [{ name: 'tool:pty', text: 'Run a command in a terminal that stays open.' }],
    }
    expect(pruneToolSections(assembly, DEFAULT_ROUTER_TOOLS).removed).toEqual(['tool:pty'])
  })

  it('hands back the same assembly when nothing is hidden', () => {
    const assembly: PromptAssembly = {
      tools: [{ name: 'bash' }],
      sections: [
        { name: 'harness:identity', text: 'You are an AI agent.' },
        { name: 'tool:bash', text: 'Check the [exit code: N] marker on every bash result.' },
      ],
    }
    const pruned = pruneToolSections(assembly, DEFAULT_ROUTER_TOOLS)
    expect(pruned.removed).toEqual([])
    expect(pruned.assembly).toBe(assembly)
  })

  it('leaves the persona, the hand-off rules and ordinary instructions alone', () => {
    const assembly: PromptAssembly = {
      tools: [],
      sections: [
        { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
        { name: 'deployment:persona-suffix', text: '说话短一点。' },
        { name: 'dispatcher:handoff', text: '派完立刻 dispatch_open 记票。' },
        { name: 'plan:policy', text: 'Do not write files before the plan is approved.' },
        { name: 'mcp-server-notice', text: 'ignored: no such section shape' },
      ],
    }
    const pruned = pruneToolSections(assembly, DEFAULT_ROUTER_TOOLS)
    expect(pruned.removed).toEqual([])
    expect(names(pruned.assembly)).toEqual([
      'harness:identity',
      'deployment:persona-suffix',
      'dispatcher:handoff',
      'plan:policy',
      'mcp-server-notice',
    ])
  })
})

describe('installPromptFilter', () => {
  function fakeScope(options: { scoped?: boolean } = {}) {
    const messages: string[] = []
    const hooks: PromptAssemblyHook[] = []
    const scope = {
      effect(callback: () => () => void) {
        return callback()
      },
      ...(options.scoped === false
        ? {}
        : {
            on(_event: 'system-prompt/assemble', listener: PromptAssemblyHook) {
              hooks.push(listener)
              return () => {}
            },
          }),
    }
    return { scope, hooks, messages, log: (message: string) => void messages.push(message) }
  }

  it('prunes the assembled prompt through the scoped hook', async () => {
    const { scope, hooks } = fakeScope()
    expect(installPromptFilter(scope, { allow: DEFAULT_ROUTER_TOOLS })).toBe(true)
    expect(hooks).toHaveLength(1)
    const assembly = mainSessionAssembly()
    const out = await hooks[0](assembly, {}, () => Promise.resolve(assembly))
    expect(names(out)).not.toContain('tool:browser')
    expect(names(out)).not.toContain('tool:bili-notify')
    expect(names(out)).not.toContain('mcp:github')
    expect(names(out)).not.toContain('mcp-resource-servers')
    expect(names(out)).toContain('deployment:persona-prefix')
    expect(names(out)).toContain('dispatcher:handoff')
  })

  it('says so, once, which sections it dropped', async () => {
    const { scope, hooks, messages, log } = fakeScope()
    installPromptFilter(scope, { allow: DEFAULT_ROUTER_TOOLS, log })
    const assembly = mainSessionAssembly()
    await hooks[0](assembly, {}, () => Promise.resolve(assembly))
    await hooks[0](assembly, {}, () => Promise.resolve(assembly))
    expect(messages.filter((line) => line.includes('pruned'))).toHaveLength(1)
    expect(messages[0]).toContain('tool:browser')
  })

  it('reports a host without a scoped hook instead of pretending', () => {
    const { scope, messages } = fakeScope({ scoped: false })
    const installed = installPromptFilter(scope, {
      allow: DEFAULT_ROUTER_TOOLS,
      log: (message) => void messages.push(message),
    })
    expect(installed).toBe(false)
    expect(messages[0]).toContain('system-prompt/assemble')
  })

  it('drops every tool section when asked to, and only those', async () => {
    // The worker verdict: it does not ask whether a tool is visible, because a
    // worker's tool set is the preset's business and the prompt can only be
    // wrong about it. Persona, hand-off rules and policy stay.
    const { scope, hooks } = fakeScope()
    installPromptFilter(scope, { allow: [], dropAllToolSections: true })
    const assembly: PromptAssembly = {
      tools: [{ name: 'bash' }, { name: 'browser_navigate' }],
      sections: [
        { name: 'harness:identity', text: 'You are an AI agent.' },
        { name: 'deployment:persona-suffix', text: '说话短一点。' },
        { name: 'dispatcher:handoff', text: '派完立刻 dispatch_open 记票。' },
        { name: 'mcp-server-notice', text: 'not a tool section' },
        { name: 'tool:bash', text: 'Check the exit code.' },
        { name: 'tool:browser', text: 'Use browser_navigate.' },
        { name: 'mcp:github', text: 'Use mcp__github__search_code.' },
        { name: 'mcp-resource-servers', text: 'Use read_mcp_resource.' },
      ],
    }
    const out = await hooks[0](assembly, {}, () => Promise.resolve(assembly))
    expect(names(out)).toEqual([
      'harness:identity',
      'deployment:persona-suffix',
      'dispatcher:handoff',
      'mcp-server-notice',
    ])
  })
})

describe('pruneToolSections with dropAllToolSections', () => {
  it('takes every tool section, even one whose tools are still visible', () => {
    const assembly: PromptAssembly = {
      tools: [{ name: 'bash' }],
      sections: [
        { name: 'harness:identity', text: 'You are an AI agent.' },
        { name: 'tool:bash', text: 'Check the exit code.' },
      ],
    }
    const pruned = pruneToolSections(assembly, [], { dropAllToolSections: true })
    expect(pruned.removed).toEqual(['tool:bash'])
    expect(names(pruned.assembly)).toEqual(['harness:identity'])
  })

  it('hands back the same assembly when there was nothing to drop', () => {
    const assembly: PromptAssembly = {
      tools: [],
      sections: [{ name: 'harness:identity', text: 'You are an AI agent.' }],
    }
    const pruned = pruneToolSections(assembly, [], { dropAllToolSections: true })
    expect(pruned.removed).toEqual([])
    expect(pruned.assembly).toBe(assembly)
  })
})
