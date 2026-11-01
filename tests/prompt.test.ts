import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER_TOOLS } from '../src/config'
import { installPromptFilter, mentionedToolNames, pruneToolSections, prunesToolSection, toolSectionGroup } from '../src/prompt'
import type { PromptAssembly, PromptAssemblyHook } from '../src/prompt'

/** A main session after the whitelist: only these schemas are left. */
const VISIBLE = new Set([
  'dispatch_open',
  'dispatch_list',
  'dispatch_send',
  'create_goal',
  'get_goal',
  'update_goal',
  'memory_recall',
  'yuyu_face',
  'present',
  'chat_recall',
])

/**
 * The sections that actually matter here: the ones the host and the tool
 * plugins register, cut down to the lines that name their tools.
 */
function mainSessionAssembly(): PromptAssembly {
  return {
    tools: [...VISIBLE].map((name) => ({ name })),
    sections: [
      { name: 'harness:identity', order: -1000, text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona-prefix', order: 0, text: '你是用户的私人助手，说话简短。' },
      { name: 'dispatcher:handoff', order: 95, text: '【派活规矩 · dispatcher】主会话的活是及时回话，长活交给 worker。' },
      {
        name: 'tool:bash',
        order: 1000,
        text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
      },
      {
        name: 'tool:bilibili',
        order: 111,
        text: 'Use bilibili_search to find videos; follow up with bilibili_video, bilibili_subtitles or bilibili_playurl.',
      },
      {
        name: 'tool:browser',
        order: 160,
        text: 'Use the browser tools (browser_navigate, browser_snapshot, browser_click) to inspect web pages.',
      },
      {
        name: 'tool:jobs',
        order: 1600,
        text: 'Long commands belong in a job; call job_output instead of waiting.',
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
    ],
  }
}

const names = (assembly: PromptAssembly): string[] => assembly.sections.map((section) => section.name)

describe('toolSectionGroup', () => {
  it('reads the group name out of a tool section', () => {
    expect(toolSectionGroup('tool:bash')).toBe('bash')
    expect(toolSectionGroup('tool:bilibili')).toBe('bilibili')
    expect(toolSectionGroup('tool:session-query')).toBe('session_query')
  })

  it('leaves every other section alone', () => {
    expect(toolSectionGroup('harness:identity')).toBeUndefined()
    expect(toolSectionGroup('deployment:persona-prefix')).toBeUndefined()
    expect(toolSectionGroup('dispatcher:handoff')).toBeUndefined()
    expect(toolSectionGroup('ui:deliverable-file-references')).toBeUndefined()
    expect(toolSectionGroup('tools:ptc-only')).toBeUndefined()
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
})

describe('prunesToolSection', () => {
  const vocabulary = new Set([...VISIBLE, 'bash', 'browser', 'bilibili', 'jobs', 'goal', 'session_query', 'dispatch', 'present'])

  it('drops a section whose only tool is hidden', () => {
    const section = { name: 'tool:bash', text: 'investigate failures with bash' }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(true)
  })

  it('keeps a section that names a tool still visible', () => {
    const section = { name: 'tool:goal', text: 'create_goal opens a long objective' }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(false)
  })


  it('keeps a section whose group name is itself a visible tool', () => {
    const section = { name: 'tool:present', text: 'Declare existing files as final deliverables.' }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(false)
  })

  it('does not keep a section because another tool shares its prefix', () => {
    // `read_image` is whitelisted and `read` is not; the group is `read`, and
    // a prefix match would wrongly spare the section.
    const section = {
      name: 'tool:read',
      text: 'Use the read tool — not shell commands like cat — to inspect text files.',
    }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(true)
  })

  it('keeps the read section once read itself is whitelisted', () => {
    // The other half of the same rule: `read` is on the default list now, so
    // its own section stays — and it stays on `read`, not on `read_image`.
    const visible = new Set([...VISIBLE, 'read'])
    const section = {
      name: 'tool:read',
      text: 'Use the read tool — not shell commands like cat — to inspect text files.',
    }
    expect(prunesToolSection(section, visible, new Set([...vocabulary, 'read']))).toBe(false)
  })

  it('never touches a section that is not a tool section', () => {
    const section = { name: 'deployment:persona-prefix', text: 'browser_navigate is mentioned here and it does not matter' }
    expect(prunesToolSection(section, VISIBLE, vocabulary)).toBe(false)
  })
})

describe('pruneToolSections', () => {
  it('drops exactly the sections whose tools are all hidden', () => {
    const { assembly, removed } = pruneToolSections(mainSessionAssembly(), DEFAULT_ROUTER_TOOLS)
    expect(removed).toEqual(['tool:bash', 'tool:bilibili', 'tool:browser', 'tool:jobs'])
    expect(names(assembly)).toEqual([
      'harness:identity',
      'deployment:persona-prefix',
      'dispatcher:handoff',
      'tool:goal',
      'tool:session-query',
      'tool:present',
      'tool:dispatch',
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
      ],
    }
    const pruned = pruneToolSections(assembly, DEFAULT_ROUTER_TOOLS)
    expect(pruned.removed).toEqual([])
    expect(names(pruned.assembly)).toEqual([
      'harness:identity',
      'deployment:persona-suffix',
      'dispatcher:handoff',
      'plan:policy',
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
    expect(names(out)).not.toContain('tool:bilibili')
    expect(names(out)).not.toContain('tool:browser')
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
    expect(messages[0]).toContain('tool:bilibili')
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
})
