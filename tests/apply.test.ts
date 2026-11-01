import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HANDOFF_POLICY, DEFAULT_ROUTER_TOOLS, DEFAULT_WORKER_DENY_TOOLS } from '../src/config'
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
/** Tools this plugin registers: the dispatch_* family plus progress_note. */
const OWN_TOOLS = [...DISPATCH_TOOLS, 'progress_note']
/** Everything the whitelist names that another plugin registers, not this one. */
const FOREIGN_TOOLS = DEFAULT_ROUTER_TOOLS.filter((name) => !OWN_TOOLS.includes(name))

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = tempDir()
  return {
    stateFile: join(dir, 'tickets.jsonl'),
    staleMinutes: 30,
    maxOpen: 4,
    handoffPolicy: true,
    handoffPolicyText: DEFAULT_HANDOFF_POLICY,
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
    workerToolDeny: true,
    workerDenyTools: [...DEFAULT_WORKER_DENY_TOOLS],
    notifyScript: join(dir, 'notify.sh'),
    notifyTimeoutMs: 5000,
    ...overrides,
  }
}

interface FakeAgent {
  session: { header: { origin?: string } }
  ctx: {
    effect(callback: () => () => void, label?: string): unknown
    tools: {
      restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
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
  const denied: string[][] = []
  const warnings: string[] = []
  const infos: string[] = []
  const lifted: number[] = []
  const createdListeners: Array<(payload: { agent: FakeAgent }) => unknown> = []
  const changeListeners: Array<() => unknown> = []
  // The host emits `tools/change` on every registration and every restriction.
  // Our own reinstall fires it too, so the loop has to stop by itself.
  const fireChange = (): void => {
    for (const listener of changeListeners) listener()
  }

  const makeAgent = (origin?: string): FakeAgent => ({
    session: { header: origin ? { origin } : {} },
    ctx: {
      effect: (callback) => callback(),
      tools: {
        restrict(filter) {
          const index = restricted.length
          events.push('restrict')
          if (filter.allow !== undefined) restricted.push([...filter.allow])
          if (filter.deny !== undefined) denied.push([...filter.deny])
          fireChange()
          return () => {
            lifted.push(index)
          }
        },
        get: (name: string) => (registry.has(name) ? { name } : undefined),
        guard: () => () => {},
      },
    },
  })

  const agents = Array.from({ length: options.existingAgents ?? 1 }, () => makeAgent())
  const ctx = {
    agents: { list: () => agents, get: () => undefined },
    effect: (callback: () => () => void) => callback(),
    on(event: string, listener: unknown) {
      if (event === 'agent/created') createdListeners.push(listener as (payload: { agent: FakeAgent }) => unknown)
      if (event === 'tools/change') changeListeners.push(listener as () => unknown)
      return () => {}
    },
    tools: {
      register(definition: { name: string }) {
        registry.add(definition.name)
        events.push(`register:${definition.name}`)
        fireChange()
        return () => {}
      },
      // The unfiltered global view the router's self-test reads.
      get: (name: string) => (registry.has(name) ? { name } : undefined),
    },
    logger: {
      info: (message: string) => {
        infos.push(message)
      },
      warn: (message: string) => {
        warnings.push(message)
      },
    },
  }

  return { ctx, registry, events, restricted, denied, warnings, infos, lifted, createdListeners, changeListeners, makeAgent }
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
    for (const name of OWN_TOOLS) expect(host.restricted[0]).toContain(name)
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

  // The rule from 2026-11-01: only the main session writes memory. The memory
  // plugin refuses the call at execute time; this is the layer above it, where
  // the names never reach a worker's schema at all.
  it('hides the memory-write tools from a worker and from nobody else', () => {
    const host = fakeHost({ registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 })
    apply(host.ctx as never, testConfig())

    // The main session keeps the full whitelist, memory writes included.
    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
    expect(host.denied).toEqual([])

    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })

    expect(host.denied).toEqual([[...DEFAULT_WORKER_DENY_TOOLS]])
    // A worker never gets an allow list, and never reaches `restrict` twice.
    expect(host.restricted).toHaveLength(1)
    expect(host.infos.join('\n')).toContain('worker subagents hide 7')
  })

  // Two switches, two rules: trimming the main session and taking memory writes
  // away from a worker are not the same decision, so one must not drag the other.
  it('applies the worker deny list even when the main whitelist is off', () => {
    const host = fakeHost({ registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 })
    apply(host.ctx as never, testConfig({ routerRestrict: false }))

    expect(host.restricted).toEqual([])
    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })
    expect(host.denied).toEqual([[...DEFAULT_WORKER_DENY_TOOLS]])
  })

  it('leaves the worker alone when workerToolDeny is off', () => {
    const host = fakeHost({ registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 })
    apply(host.ctx as never, testConfig({ workerToolDeny: false }))

    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })
    expect(host.denied).toEqual([])
    // The main session is still trimmed.
    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
  })

  // The live bug: `external_send_file` is registered by an external plugin, which the loader
  // installs after dsh-dispatcher. The first pass cannot see it, so the main
  // session ends up unable to send a picture. `tools/change` is the host's way
  // of saying "the registry moved, look again".
  it('adds a tool that registers after the whitelist went on', () => {
    const late = 'external_send_file'
    const host = fakeHost({ registered: FOREIGN_TOOLS.filter((name) => name !== late) })
    apply(host.ctx as never, testConfig())

    expect(host.restricted).toHaveLength(1)
    expect(host.restricted[0]).not.toContain(late)
    expect(host.warnings.join('\n')).toContain(late)

    // The late plugin loads and registers.
    host.ctx.tools.register({ name: late })

    expect(host.restricted).toHaveLength(2)
    expect(host.restricted[1]).toEqual([...DEFAULT_ROUTER_TOOLS])
    expect(host.infos.join('\n')).toContain(late)
    // No name outside the registry ever reaches `restrict`.
    expect(host.restricted[1]).not.toContain('ghost_tool')
  })
})
