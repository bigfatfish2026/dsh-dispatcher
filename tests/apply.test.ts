import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER_TOOLS } from '../src/config'
import type { Config } from '../src/config'
import { apply } from '../src/index'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-apply-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

const DISPATCH_TOOLS = DEFAULT_ROUTER_TOOLS.filter((name) => name.startsWith('dispatch_'))
/** Everything the whitelist names that another plugin registers, not this one. */
const FOREIGN_TOOLS = DEFAULT_ROUTER_TOOLS.filter((name) => !name.startsWith('dispatch_'))

function testConfig(): Config {
  const dir = tempDir()
  return {
    stateFile: join(dir, 'tickets.jsonl'),
    staleMinutes: 30,
    maxOpen: 4,
    handoffPolicy: true,
    sweepMinutes: 0,
    notifyOwner: true,
    quietSweep: false,
    ownerSessionId: '',
    qqPrefsPath: join(dir, 'prefs.json'),
    ownerOpenId: '',
    noWaitGuard: true,
    maxCommandMs: 30000,
    maxWaitMs: 5000,
    routerRestrict: true,
    routerEscapeFile: join(dir, 'no-restrict'),
    routerTools: [...DEFAULT_ROUTER_TOOLS],
  }
}

interface FakeAgent {
  session: { header: { origin?: string } }
  ctx: {
    effect(callback: () => () => void, label?: string): unknown
    tools: {
      restrict(filter: { allow: readonly string[] }): () => void
      get(name: string): unknown
      guard(): () => void
    }
  }
}

/**
 * A host that behaves like a reload: the registry starts with every *other*
 * plugin's tools and none of this one's, agents exist, and a name is only
 * visible through `tools.get` once `tools.register` has been called for it.
 */
function fakeHost(options: { registered?: string[]; existingAgents?: number } = {}) {
  const registry = new Set<string>(options.registered ?? [])
  const events: string[] = []
  const restricted: string[][] = []
  const warnings: string[] = []
  const createdListeners: Array<(payload: { agent: FakeAgent }) => unknown> = []

  const makeAgent = (): FakeAgent => ({
    session: { header: {} },
    ctx: {
      effect: (callback) => callback(),
      tools: {
        restrict(filter) {
          events.push('restrict')
          restricted.push([...filter.allow])
          return () => {}
        },
        get: (name: string) => (registry.has(name) ? { name } : undefined),
        guard: () => () => {},
      },
    },
  })

  const agents = Array.from({ length: options.existingAgents ?? 1 }, makeAgent)
  const ctx = {
    agents: { list: () => agents, get: () => undefined },
    effect: (callback: () => () => void) => callback(),
    on(event: string, listener: (payload: { agent: FakeAgent }) => unknown) {
      if (event === 'agent/created') createdListeners.push(listener)
      return () => {}
    },
    tools: {
      register(definition: { name: string }) {
        registry.add(definition.name)
        events.push(`register:${definition.name}`)
        return () => {}
      },
    },
    logger: {
      info: () => {},
      warn: (message: string) => {
        warnings.push(message)
      },
    },
  }

  return { ctx, registry, events, restricted, warnings, createdListeners, makeAgent }
}

describe('apply', () => {
  // The bug this pins down: on a hot reload the old registrations are already
  // gone and the new ones have not landed yet, so installing the whitelist
  // before `ctx.tools.register` made the self-test drop all seven dispatch_*
  // names from the allow list. The main session then answered "unknown tool".
  it('registers its own tools before it installs the whitelist', () => {
    const host = fakeHost({ registered: [...FOREIGN_TOOLS] })
    apply(host.ctx as never, testConfig())

    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
    for (const name of DISPATCH_TOOLS) expect(host.restricted[0]).toContain(name)
    expect(host.warnings.join('\n')).not.toMatch(/no registered global tool/)

    let lastRegister = -1
    host.events.forEach((event, index) => {
      if (event.startsWith('register:')) lastRegister = index
    })
    expect(lastRegister).toBeGreaterThanOrEqual(0)
    expect(host.events.indexOf('restrict')).toBeGreaterThan(lastRegister)
  })

  it('covers a session created after load with the same full list', () => {
    const host = fakeHost({ registered: [...FOREIGN_TOOLS], existingAgents: 0 })
    apply(host.ctx as never, testConfig())

    // Nothing existed at load time, so the whitelist waits for agent/created.
    expect(host.restricted).toEqual([])
    // The no-wait guard listens on the same event; only one of them restricts.
    expect(host.createdListeners.length).toBeGreaterThan(0)
    for (const listener of host.createdListeners) listener({ agent: host.makeAgent() })
    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
  })
})
