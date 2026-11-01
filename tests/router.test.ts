import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER_TOOLS } from '../src/config'
import { escapePath, installRouter, missingRouterTools } from '../src/router'
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
  const messages: string[] = []
  const hooks: PromptAssemblyHook[] = []
  // Built as its own object so the prompt hook can be recorded: `RouterAgent`
  // only declares the two members `installRouter` itself needs.
  const ctx = {
    effect(callback: () => () => void) {
      return callback()
    },
    tools: {
      restrict(filter: { allow: readonly string[] }) {
        filters.push([...filter.allow])
        return () => {}
      },
      get: (name: string) => (options.registered.includes(name) ? { name } : undefined),
    },
    on(_event: 'system-prompt/assemble', listener: PromptAssemblyHook) {
      hooks.push(listener)
      return () => {}
    },
  }
  const agent: RouterAgent = { session: { header: options.origin ? { origin: options.origin } : {} }, ctx }
  return { agent, filters, hooks, messages, log: (message: string) => { messages.push(message) } }
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
