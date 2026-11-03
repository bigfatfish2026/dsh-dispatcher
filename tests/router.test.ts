import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER_TOOLS, DEFAULT_WORKER_DENY_TOOLS } from '../src/config'
import { escapePath, bindRouter, bindWorkerDeny, installRouter, missingRouterTools } from '../src/router'
import type { RouterAgent } from '../src/router'
import type { PromptAssemblyHook } from '../src/prompt'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-router-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

/** A fake agent: registry, an effect that runs at once, and the filter it got. */
function fakeAgent(options: { origin?: string; registered: string[] }) {
  const filters: string[][] = []
  const denies: string[][] = []
  const messages: string[] = []
  const notes: string[] = []
  const hooks: PromptAssemblyHook[] = []
  const lifted: number[] = []
  const hookStops: number[] = []
  // Built as its own object so the prompt hook can be recorded: `RouterAgent`
  // only declares the two members `installRouter` itself needs.
  const ctx = {
    effect(callback: () => () => void) {
      return callback()
    },
    tools: {
      restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }) {
        const index = filters.length
        if (filter.allow !== undefined) filters.push([...filter.allow])
        if (filter.deny !== undefined) denies.push([...filter.deny])
        return () => {
          lifted.push(index)
        }
      },
      get: (name: string) => (options.registered.includes(name) ? { name } : undefined),
    },
    on(_event: 'system-prompt/assemble', listener: PromptAssemblyHook) {
      const index = hooks.length
      hooks.push(listener)
      return () => {
        hookStops.push(index)
      }
    },
  }
  const agent: RouterAgent = { session: { header: options.origin ? { origin: options.origin } : {} }, ctx }
  return {
    agent,
    filters,
    denies,
    hooks,
    lifted,
    hookStops,
    messages,
    notes,
    log: (message: string) => { messages.push(message) },
    info: (message: string) => { notes.push(message) },
  }
}

describe('escapePath', () => {
  it('expands a leading tilde only', () => {
    expect(escapePath('~/x/y')).toMatch(/^\/.*\/x\/y$/)
    expect(escapePath('/abs/~x')).toBe('/abs/~x')
  })
})

describe('missingRouterTools', () => {
  it('reports the names no tool answers to', () => {
    const tools = { get: (name: string) => (name === 'a' ? {} : undefined) }
    expect(missingRouterTools(['a', 'b'], tools as never)).toEqual(['b'])
  })
})

describe('installRouter', () => {
  it('installs the whitelist on a main session, exactly as configured', () => {
    const { agent, filters } = fakeAgent({ registered: [...DEFAULT_ROUTER_TOOLS] })
    const outcome = installRouter(
      agent,
      { allow: DEFAULT_ROUTER_TOOLS, escapeFile: join(tempDir(), 'no-restrict') },
      new WeakSet(),
    )
    expect(outcome).toBe('installed')
    expect(filters).toEqual([[...DEFAULT_ROUTER_TOOLS]])
  })

  it('never touches a worker session', () => {
    const { agent, filters, hooks } = fakeAgent({ origin: 'subagent', registered: [...DEFAULT_ROUTER_TOOLS] })
    const outcome = installRouter(
      agent,
      { allow: DEFAULT_ROUTER_TOOLS, escapeFile: join(tempDir(), 'no-restrict') },
      new WeakSet(),
    )
    expect(outcome).toBe('worker')
    expect(filters).toEqual([])
    expect(hooks).toEqual([])
  })

  it('installs the prompt prune pass alongside the whitelist', () => {
    const { agent, hooks } = fakeAgent({ registered: [...DEFAULT_ROUTER_TOOLS] })
    const outcome = installRouter(
      agent,
      { allow: DEFAULT_ROUTER_TOOLS, escapeFile: join(tempDir(), 'no-restrict') },
      new WeakSet(),
    )
    expect(outcome).toBe('installed')
    expect(hooks).toHaveLength(1)
  })

  it('backs off while the escape file exists', () => {
    const dir = tempDir()
    const escapeFile = join(dir, 'no-restrict')
    writeFileSync(escapeFile, '')
    const { agent, filters, hooks, messages, log } = fakeAgent({ registered: [...DEFAULT_ROUTER_TOOLS] })
    const outcome = installRouter(agent, { allow: DEFAULT_ROUTER_TOOLS, escapeFile, log }, new WeakSet())
    expect(outcome).toBe('escape')
    expect(filters).toEqual([])
    expect(hooks).toEqual([])
    expect(messages.join('\n')).toContain('skipped')
  })

  it('drops names nothing answers to instead of failing the restrict call', () => {
    const { agent, filters, messages, log } = fakeAgent({ registered: ['dispatch_open', 'subagent'] })
    const outcome = installRouter(
      agent,
      { allow: ['dispatch_open', 'subagent', 'ghost_tool'], escapeFile: join(tempDir(), 'no-restrict'), log },
      new WeakSet(),
    )
    expect(outcome).toBe('installed')
    expect(filters).toEqual([['dispatch_open', 'subagent']])
    expect(messages.join('\n')).toContain('ghost_tool')
  })

  // A name the registry does not know yet is dropped from *this* install only.
  // It is not a verdict on the name: once the tool registers, a fresh install
  // gets it back. Losing it for the life of the session is what went wrong on a
  // hot reload, where the plugin's own tools land after this check.
  it('does not treat an unregistered name as permanently dropped', () => {
    const options = { allow: ['dispatch_open', 'subagent'], escapeFile: join(tempDir(), 'no-restrict') }
    const early = fakeAgent({ registered: ['subagent'] })
    expect(installRouter(early.agent, options, new WeakSet())).toBe('installed')
    expect(early.filters).toEqual([['subagent']])

    const late = fakeAgent({ registered: ['dispatch_open', 'subagent'] })
    expect(installRouter(late.agent, options, new WeakSet())).toBe('installed')
    expect(late.filters).toEqual([['dispatch_open', 'subagent']])
  })

  it('installs nothing when every name is wrong', () => {
    const { agent, filters, messages, log } = fakeAgent({ registered: [] })
    const outcome = installRouter(
      agent,
      { allow: ['ghost_tool'], escapeFile: join(tempDir(), 'no-restrict'), log },
      new WeakSet(),
    )
    expect(outcome).toBe('empty')
    expect(filters).toEqual([])
  })

  it('handles one agent once', () => {
    const { agent, filters } = fakeAgent({ registered: [...DEFAULT_ROUTER_TOOLS] })
    const seen = new WeakSet<object>()
    const options = { allow: DEFAULT_ROUTER_TOOLS, escapeFile: join(tempDir(), 'no-restrict') }
    expect(installRouter(agent, options, seen)).toBe('installed')
    expect(installRouter(agent, options, seen)).toBe('already')
    expect(filters).toHaveLength(1)
  })
})

// The bug this pins down: the whitelist used to be decided once, at install
// time. A tool plugin that registered later — another plugin sits after
// dsh-dispatcher in the load order — was dropped from the allow list and never
// came back, so the main session could call yuyu_face but not sibling_send_file.
describe('bindRouter', () => {
  const ALLOW = ['dispatch_open', 'dispatch_list', 'sibling_send_file', 'ghost_tool']

  function bind(registered: string[]) {
    const fake = fakeAgent({ registered })
    const binding = bindRouter(fake.agent, {
      allow: ALLOW,
      escapeFile: join(tempDir(), 'no-restrict'),
      log: fake.log,
      info: fake.info,
    })
    return { ...fake, binding }
  }

  it('grows the whitelist when a late plugin registers its tool', () => {
    const registered = ['dispatch_open', 'dispatch_list']
    const { binding, filters, messages, notes } = bind(registered)
    expect(binding.outcome()).toBe('installed')
    expect(filters).toEqual([['dispatch_open', 'dispatch_list']])
    expect(messages.join('\n')).toContain('ghost_tool')

    registered.push('sibling_send_file')
    expect(binding.sync()).toBe('updated')
    expect(filters).toHaveLength(2)
    expect(filters[1]).toEqual(['dispatch_open', 'dispatch_list', 'sibling_send_file'])
    // The name nothing answers to is still never handed to `restrict`.
    expect(filters[1]).not.toContain('ghost_tool')
    expect(notes.join('\n')).toContain('sibling_send_file')
    expect(messages.join('\n')).toContain('ghost_tool')
    expect(binding.installed()).toEqual(['dispatch_open', 'dispatch_list', 'sibling_send_file'])
  })

  it('lifts the previous restriction before the wider one goes on', () => {
    const registered = ['dispatch_open']
    const { binding, filters, lifted } = bind(registered)
    expect(lifted).toEqual([])

    registered.push('dispatch_list')
    binding.sync()
    // Restrictions intersect, so keeping the old one would keep the old answer.
    expect(lifted).toEqual([0])
    expect(filters[1]).toEqual(['dispatch_open', 'dispatch_list'])
  })

  it('does nothing when the registry has nothing new', () => {
    const { binding, filters, lifted } = bind(['dispatch_open', 'dispatch_list'])
    expect(binding.sync()).toBe('unchanged')
    expect(binding.sync()).toBe('unchanged')
    expect(filters).toHaveLength(1)
    expect(lifted).toEqual([])
  })

  it('reinstalls the prompt pass with the restriction', () => {
    const registered = ['dispatch_open']
    const { binding, hooks, hookStops } = bind(registered)
    expect(hooks).toHaveLength(1)
    registered.push('sibling_send_file')
    binding.sync()
    expect(hooks).toHaveLength(2)
    // The first pass is gone, so the pruner is not installed twice.
    expect(hookStops).toEqual([0])
  })

  it('leaves a worker session alone, on every pass', () => {
    const { agent, filters, hooks } = fakeAgent({ origin: 'subagent', registered: ['dispatch_open'] })
    const binding = bindRouter(agent, {
      allow: ALLOW,
      escapeFile: join(tempDir(), 'no-restrict'),
      log: () => {},
    })
    expect(binding.outcome()).toBe('worker')
    expect(binding.sync()).toBe('worker')
    expect(filters).toEqual([])
    expect(hooks).toEqual([])
  })

  it('drops nothing it should keep when the own-view is filtered', () => {
    // What the real host does: after the restriction, the agent's own view
    // reads the hidden names as absent. The global registry still answers.
    const registered = ['dispatch_open', 'dispatch_list']
    const { agent, filters } = fakeAgent({ registered })
    let restricted = false
    const realGet = agent.ctx.tools.get
    agent.ctx.tools.get = (name: string) => (restricted && !['dispatch_open'].includes(name) ? undefined : realGet(name))
    const binding = bindRouter(agent, {
      allow: ALLOW,
      escapeFile: join(tempDir(), 'no-restrict'),
      registry: { get: (name: string) => (registered.includes(name) ? { name } : undefined) },
      log: () => {},
    })
    restricted = true
    registered.push('sibling_send_file')
    expect(binding.sync()).toBe('updated')
    expect(filters[1]).toEqual(['dispatch_open', 'dispatch_list', 'sibling_send_file'])
  })

  it('keeps the previous whitelist when restrict refuses the new list', () => {
    const registered = ['dispatch_open']
    const { agent, binding, filters, lifted } = bind(registered)
    let refusals = 0
    const realRestrict = agent.ctx.tools.restrict
    agent.ctx.tools.restrict = (filter: { allow: readonly string[] }) => {
      if (filter.allow.includes('sibling_send_file')) {
        refusals += 1
        throw new Error('tools.restrict() names unknown global tool "sibling_send_file"')
      }
      return realRestrict(filter)
    }
    registered.push('sibling_send_file')
    expect(binding.sync()).toBe('error')
    expect(refusals).toBe(1)
    // Nothing was lifted, so the main session kept what it had.
    expect(lifted).toEqual([])
    expect(filters).toHaveLength(1)
  })

  // The 2026-11-01 incident. A pass ran while dsh-memory's tools were
  // momentarily unregistered (plugin reload ordering), judged those names
  // missing and installed a short whitelist. From then on the agent's own view
  // could not see them either — the restriction *we* had just installed hid
  // them — so every later pass re-derived the same short list, and the
  // "same names as installed" short-circuit answered `unchanged` forever.
  describe('the whitelist must not shrink because it can no longer see itself', () => {
    const LIST = ['dispatch_open', 'memory_recall']
    const escapeFile = (): string => join(tempDir(), 'no-restrict')

    // a) 已装名单里的名字一律算已知：即便 agent 视图被自己的 restriction
    // 过滤空、全局视图也不为它作答，名单也不能因此缩水。
    it('keeps an installed name both views read as absent', () => {
      const { agent, filters } = fakeAgent({ registered: [...LIST] })
      const binding = bindRouter(agent, { allow: LIST, escapeFile: escapeFile(), log: () => {} })
      expect(binding.installed()).toEqual(LIST)
      expect(filters).toEqual([LIST])

      agent.ctx.tools.get = () => undefined
      expect(binding.sync()).toBe('unchanged')
      // 'unchanged' and not 'empty': the list still counts itself.
      expect(binding.installed()).toEqual(LIST)
      expect(filters).toHaveLength(1)
    })

    // b) 第一次 sync 时缺的名字，等它注册之后必须补得回来。
    it('adds the missing name back once the plugin registers it', () => {
      const registered = ['dispatch_open']
      const { agent, filters } = fakeAgent({ registered })
      let restricted = false
      const realGet = agent.ctx.tools.get
      agent.ctx.tools.get = (name: string) => (restricted ? undefined : realGet(name))
      const binding = bindRouter(agent, {
        allow: LIST,
        escapeFile: escapeFile(),
        registry: {
          get: (name: string) => (registered.includes(name) ? { name } : undefined),
          names: () => [...registered],
        },
        log: () => {},
      })
      expect(binding.installed()).toEqual(['dispatch_open'])
      expect(filters).toEqual([['dispatch_open']])
      restricted = true

      // 注册表没动：重复 pass 不许重装。
      expect(binding.sync()).toBe('unchanged')
      expect(filters).toHaveLength(1)

      registered.push('memory_recall')
      expect(binding.sync()).toBe('updated')
      expect(binding.installed()).toEqual(LIST)
      expect(filters.at(-1)).toEqual(LIST)

      // 补回来之后就安静下来，不再每个事件重装一遍。
      expect(binding.sync()).toBe('unchanged')
      expect(filters).toHaveLength(2)
    })

    // c) 名单真没变化就 unchanged，哪怕还缺名字：装名单本身会触发
    // tools/change，见一个事件重装一次会自己喂自己。
    it('does not reinstall while the same names stay unregistered', () => {
      const { binding, filters, lifted } = bind(['dispatch_open'])
      expect(binding.sync()).toBe('unchanged')
      expect(binding.sync()).toBe('unchanged')
      expect(binding.sync()).toBe('unchanged')
      expect(filters).toHaveLength(1)
      expect(lifted).toEqual([])
    })

    // 真卸载掉的名字不能把 binding 卡死在 error：restrict 会整份拒绝，
    // 于是这一轮把那个名字剔掉、装剩下的。
    it('prunes a name the host no longer knows instead of failing the pass', () => {
      const hostKnown = ['dispatch_open', 'memory_recall']
      const { agent, filters } = fakeAgent({ registered: [...hostKnown] })
      agent.ctx.tools.restrict = (filter: { allow?: readonly string[] }) => {
        const unknown = (filter.allow ?? []).filter((name) => !hostKnown.includes(name))
        if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
        filters.push([...(filter.allow ?? [])])
        return () => {}
      }
      const binding = bindRouter(agent, {
        allow: [...LIST, 'sibling_send_file'],
        escapeFile: escapeFile(),
        registry: { get: (name: string) => (hostKnown.includes(name) ? { name } : undefined) },
        log: () => {},
      })
      expect(binding.installed()).toEqual(LIST)
      // 装好之后本模块的 restriction 让 agent 自己的视图什么都读不到。
      agent.ctx.tools.get = () => undefined

      // 一次插件重载：memory_recall 没了，sibling_send_file 来了。current 里还
      // 记着 memory_recall（自己的视图被挡着，看不出来），restrict 会整份
      // 拒绝——这一轮得把死名字剔掉，把活着的那份装上去。
      hostKnown.splice(1, 1, 'sibling_send_file')
      expect(binding.sync()).toBe('updated')
      expect(binding.installed()).toEqual(['dispatch_open', 'sibling_send_file'])

      // 名单这会儿跟 current 一样了，但 allow 里还缺 memory_recall：上一轮
      // 的「缺的是谁」跟这一轮不同，所以不许拿「名单没变」当结论收工，得
      // 再核一遍（这一轮重装同一份）。核过之后签名稳定，下一轮才回到
      // unchanged——否则每来一个 tools/change 就重装一次，自己喂自己。
      const afterPrune = filters.length
      expect(binding.sync()).toBe('updated')
      expect(filters).toHaveLength(afterPrune + 1)
      expect(binding.sync()).toBe('unchanged')
      expect(filters).toHaveLength(afterPrune + 1)
    })
  })
})

/**
 * The second layer under the operator's rule that only the main session writes
 * memory: `dsh-memory` refuses the call at execute time, and this takes the
 * names out of the worker's schema so the model never reads them.
 *
 * The mechanism is a deny list, not a reverse whitelist: `restrict` checks an
 * allow list against the scope's restrictable names, and the public enumeration
 * (`tools.schemas()`) only projects the global layer — a worker also inherits
 * whatever a preset registered on the agent plane, so an allow list built from
 * that projection would hide those and leave the worker crippled.
 */
describe('worker deny list', () => {
  const REGISTERED = [
    'memory_recall',
    'memory_entity',
    'memory_save',
    'memory_archive',
    'memory_merge',
    'memory_reflect',
    'memory_split',
    'memory_consolidate',
    'memory_sleep',
    'chat_recall',
    'bash',
    'dispatch_report',
    'progress_note',
  ]

  function bind(registered: string[], deny: readonly string[] = DEFAULT_WORKER_DENY_TOOLS, names?: string[]) {
    const fake = fakeAgent({ origin: 'subagent', registered })
    const binding = bindWay(fake, deny, names)
    return { ...fake, binding }
  }

  function bindWay(fake: ReturnType<typeof fakeAgent>, deny: readonly string[], names?: string[]) {
    return bindWorkerDeny(fake.agent, {
      allow: DEFAULT_ROUTER_TOOLS,
      deny,
      escapeFile: join(tempDir(), 'no-restrict'),
      log: fake.log,
      info: fake.info,
      registry: {
        get: (name: string) => (fake.agent.ctx.tools.get(name) ? { name } : undefined),
        names: names === undefined ? undefined : () => names,
      },
    })
  }

  it('hides exactly the denied names from a worker and keeps the rest', () => {
    const { binding, denies, filters } = bind(REGISTERED)
    expect(binding.outcome()).toBe('denied')
    // One deny list, no allow list: nothing else is taken away.
    expect(filters).toEqual([])
    expect(denies).toEqual([[...DEFAULT_WORKER_DENY_TOOLS]])
    for (const name of DEFAULT_WORKER_DENY_TOOLS) expect(denies[0]).toContain(name)
    for (const name of ['memory_recall', 'memory_entity', 'chat_recall', 'bash', 'dispatch_report']) {
      expect(denies[0]).not.toContain(name)
    }
    expect(binding.installed()).toEqual([...DEFAULT_WORKER_DENY_TOOLS])
  })

  it('never hands a worker a whitelist instead', () => {
    const { denies, filters } = bind(REGISTERED)
    // The main-session allow list is a different rule and must not reach a worker.
    expect(filters).toEqual([])
    expect(denies[0]).not.toEqual(DEFAULT_ROUTER_TOOLS)
  })

  it('drops deny names nothing registers instead of failing the restrict call', () => {
    const { binding, denies, messages } = bind(['memory_save', 'bash'])
    expect(binding.outcome()).toBe('denied')
    expect(denies).toEqual([['memory_save']])
    expect(messages.join('\n')).toContain('memory_merge')
  })

  it('installs nothing, and does not throw, when no deny name is registered', () => {
    const { binding, denies, messages } = bind(['bash'])
    expect(binding.outcome()).toBe('empty')
    expect(denies).toEqual([])
    expect(messages.join('\n')).toContain('nothing installed')
  })

  // The shape the reverse-whitelist version had to handle: everything registered
  // ends up denied, so the worker would come up with no tools at all. Skipped
  // rather than handed to `restrict` — an empty allow would have thrown there,
  // and an empty worker is not what the config meant.
  it('refuses a deny list that covers the whole registry', () => {
    const all = ['memory_save', 'memory_merge']
    const fake = fakeAgent({ origin: 'subagent', registered: all })
    const binding = bindWay(fake, all, all)
    expect(binding.outcome()).toBe('empty')
    expect(fake.denies).toEqual([])
    expect(fake.messages.join('\n')).toContain('covers all 2 registered tools')
  })

  // Once the deny is in force the worker's own view reads the hidden names as
  // absent; a later pass must not conclude "unknown name" and hand them back.
  it('keeps a denied name on later passes', () => {
    const registered = ['memory_save', 'bash']
    const fake = fakeAgent({ origin: 'subagent', registered })
    const binding = bindWay(fake, ['memory_save'])
    expect(fake.denies).toHaveLength(1)

    let restricted = false
    const realGet = fake.agent.ctx.tools.get
    fake.agent.ctx.tools.get = (name: string) => (restricted ? undefined : realGet(name))
    restricted = true
    expect(binding.sync()).toBe('unchanged')
    expect(fake.denies).toHaveLength(1)
    expect(fake.denies[0]).toEqual(['memory_save'])
  })

  it('also backs off while the escape file exists', () => {
    const dir = tempDir()
    const escapeFile = join(dir, 'no-restrict')
    writeFileSync(escapeFile, '')
    const fake = fakeAgent({ origin: 'subagent', registered: REGISTERED })
    const binding = bindRouter(fake.agent, {
      allow: DEFAULT_ROUTER_TOOLS,
      deny: DEFAULT_WORKER_DENY_TOOLS,
      escapeFile,
      log: fake.log,
    })
    expect(binding.outcome()).toBe('escape')
    expect(fake.denies).toEqual([])
  })

  it('does nothing at all without a deny list', () => {
    const fake = fakeAgent({ origin: 'subagent', registered: REGISTERED })
    const binding = bindWorkerDeny(fake.agent, {
      allow: DEFAULT_ROUTER_TOOLS,
      escapeFile: join(tempDir(), 'no-restrict'),
    })
    expect(binding.outcome()).toBe('worker')
    expect(binding.sync()).toBe('worker')
    expect(fake.denies).toEqual([])
  })

  it('is reached through bindRouter for a worker session', () => {
    const fake = fakeAgent({ origin: 'subagent', registered: REGISTERED })
    const binding = bindRouter(fake.agent, {
      allow: DEFAULT_ROUTER_TOOLS,
      deny: DEFAULT_WORKER_DENY_TOOLS,
      escapeFile: join(tempDir(), 'no-restrict'),
      log: fake.log,
      info: fake.info,
    })
    expect(binding.outcome()).toBe('denied')
    expect(fake.denies).toEqual([[...DEFAULT_WORKER_DENY_TOOLS]])
    expect(fake.filters).toEqual([])
  })
})

describe('DEFAULT_WORKER_DENY_TOOLS', () => {
  it('is the write side of memory and nothing else', () => {
    expect([...DEFAULT_WORKER_DENY_TOOLS]).toEqual([
      'memory_save',
      'memory_archive',
      'memory_merge',
      'memory_reflect',
      'memory_split',
      'memory_consolidate',
      'memory_sleep',
    ])
    expect(new Set(DEFAULT_WORKER_DENY_TOOLS).size).toBe(DEFAULT_WORKER_DENY_TOOLS.length)
    for (const name of ['memory_recall', 'memory_entity', 'chat_recall']) {
      expect(DEFAULT_WORKER_DENY_TOOLS).not.toContain(name)
    }
  })
})

describe('DEFAULT_ROUTER_TOOLS', () => {
  it('keeps the whitelist free of duplicates', () => {
    expect(new Set(DEFAULT_ROUTER_TOOLS).size).toBe(DEFAULT_ROUTER_TOOLS.length)
  })

  it('never names the run_code transport, which restrict refuses', () => {
    expect(DEFAULT_ROUTER_TOOLS).not.toContain('run_code')
  })

  it('keeps the dispatch tools a main session needs to hand work out', () => {
    for (const name of ['dispatch_open', 'dispatch_list', 'dispatch_send', 'subagent', 'send_message']) {
      expect(DEFAULT_ROUTER_TOOLS).toContain(name)
    }
  })
})
