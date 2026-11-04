import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HANDOFF_POLICY, DEFAULT_ROUTER_TOOLS, DEFAULT_WORKER_DENY_TOOLS } from '../src/config'
import type { Config } from '../src/config'
import { apply } from '../src/index'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-reload-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = tempDir()
  return {
    stateFile: join(dir, 'tickets.jsonl'),
    defaultPreset: 't1',
    presetStrategy: 'static',
    classifyModel: 'deepseek/deepseek-flash',
    classifyEffort: 'off',
    classifyTimeoutMs: 8000,
    provider: 'spawn',
    maxDepth: 2,
    maxOpen: 4,
    briefMaxColumns: 20,
    sweepMs: 0,
    waitingMinutes: 20,
    blockedMinutes: 60,
    runningReminderMinutes: 0,
    freshMinutes: 2,
    autoReport: true,
    noReportSignal: true,
    repeatWindowMinutes: 10,
    handoffPolicy: false,
    handoffPolicyText: DEFAULT_HANDOFF_POLICY,
    noWaitGuard: true,
    maxCommandMs: 30000,
    maxWaitMs: 5000,
    routerRestrict: true,
    routerEscapeFile: join(dir, 'no-restrict'),
    snapshotFile: '',
    snapshotEnabled: false,
    snapshotRecentClosed: 20,
    routerTools: [...DEFAULT_ROUTER_TOOLS],
    extraRouterTools: [],
    workerToolDeny: true,
    workerDenyTools: [...DEFAULT_WORKER_DENY_TOOLS],
    workerPromptPrune: true,
    notifyScript: '',
    notifyTimeoutMs: 5000,
    ...overrides,
  }
}

interface FakeAgent {
  session: { header: { origin?: string } }
  ctx: unknown
}

/**
 * A host that keeps each side's disposers apart, the way cordis does: one plugin
 * fiber with its own `ctx.effect` list, and the agent scopes that outlive it.
 *
 * `events` records the order of `restrict`, `lift` (a restriction removed),
 * `guard`, `guard-lift` and `prompt-remove`, so a reload can be checked step by
 * step instead of only by its final state.
 */
function fakeHost() {
  const registry = new Set<string>(DEFAULT_ROUTER_TOOLS)
  const agentDisposers: Array<() => void> = []
  const restricts: string[][] = []
  const events: string[] = []
  const prompts: unknown[] = []
  const changeListeners: Array<() => unknown> = []
  const createdListeners: Array<(payload: { agent: FakeAgent }) => unknown> = []
  const warnings: string[] = []
  let guards = 0

  const fireChange = (): void => {
    for (const listener of [...changeListeners]) listener()
  }

  const makeAgent = () => {
    const disposers: Array<() => void> = []
    const agent: FakeAgent = {
      session: { header: {} },
      ctx: {
        effect(callback: () => () => void) {
          disposers.push(callback())
          return undefined
        },
        // The scoped prompt hook, which the dispatcher installs and then has to
        // be able to take down again.
        on(event: string, listener: unknown) {
          if (event !== 'system-prompt/assemble') return () => {}
          prompts.push(listener)
          return () => {
            events.push('prompt-remove')
            const index = prompts.indexOf(listener)
            if (index >= 0) prompts.splice(index, 1)
          }
        },
        tools: {
          restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }) {
            const names = [...(filter.allow ?? filter.deny ?? [])]
            restricts.push(names)
            events.push('restrict')
            // Removing a restriction is a registry change too, like the real host.
            const stop = () => {
              events.push('lift')
              fireChange()
            }
            // The host fires `tools/change` on every restriction install.
            fireChange()
            return stop
          },
          get: (name: string) => (registry.has(name) ? { name } : undefined),
          guard() {
            guards += 1
            events.push('guard')
            return () => {
              events.push('guard-lift')
            }
          },
        },
      },
    }
    return { agent, disposers }
  }

  const agents = [makeAgent(), makeAgent()]

  /** Load one copy of the plugin over the same host, like a reload does. */
  const mount = () => {
    const disposers: Array<() => void> = []
    const listeners: Array<{ list: unknown[]; listener: unknown }> = []
    const bind = (list: unknown[], listener: unknown) => {
      list.push(listener)
      listeners.push({ list, listener })
      return () => {
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    }
    const ctx = {
      agents: { list: () => agents.map((entry) => entry.agent), get: () => undefined },
      effect(callback: () => () => void) {
        disposers.push(callback())
        return undefined
      },
      on(event: string, listener: unknown) {
        if (event === 'tools/change') return bind(changeListeners, listener)
        if (event === 'agent/created') return bind(createdListeners, listener)
        return () => {}
      },
      tools: {
        register(definition: { name: string }) {
          registry.add(definition.name)
          fireChange()
          return () => {}
        },
        get: (name: string) => (registry.has(name) ? { name } : undefined),
      },
      logger: {
        info: () => {},
        warn: (message: string) => {
          warnings.push(message)
        },
      },
    }
    return {
      ctx,
      /** What the host does when the plugin fiber goes away. */
      dispose() {
        for (const dispose of [...disposers].reverse()) dispose()
        for (const { list, listener } of listeners) {
          const index = list.indexOf(listener)
          if (index >= 0) list.splice(index, 1)
        }
      },
    }
  }

  return {
    mount,
    fireChange,
    events,
    restricts,
    prompts,
    warnings,
    agentDisposers,
    guardCount: () => guards,
    disposeAgents() {
      for (const entry of agents) for (const dispose of [...entry.disposers].reverse()) dispose()
    },
  }
}

describe('plugin reload', () => {
  // The 2026-11-01 incident: a reload replaced the plugin fiber but the old
  // restrict/guard/prompt hooks stayed on the agent scopes, the new whitelist
  // intersected with the old one, and changing the config did nothing.
  it('lifts every restriction it put on an agent scope when the plugin goes away', () => {
    const host = fakeHost()
    const plugin = host.mount()
    apply(plugin.ctx as never, testConfig())

    expect(host.restricts).toHaveLength(2)
    expect(host.guardCount()).toBe(2)
    expect(host.prompts).toHaveLength(2)

    plugin.dispose()

    // Whitelist, guard and prompt pass, once per agent — no leftovers.
    expect(host.events.filter((event) => event === 'lift')).toHaveLength(2)
    expect(host.events.filter((event) => event === 'guard-lift')).toHaveLength(2)
    expect(host.prompts).toHaveLength(0)

    // A registry change after the teardown must not put anything back.
    host.fireChange()
    expect(host.restricts).toHaveLength(2)
    expect(host.guardCount()).toBe(2)

    // The agent scope dying later is the other owner: it must not dispose twice.
    host.disposeAgents()
    expect(host.events.filter((event) => event === 'lift')).toHaveLength(2)
    expect(host.events.filter((event) => event === 'guard-lift')).toHaveLength(2)
  })

  it('installs a fresh whitelist after the old instance was lifted', () => {
    const host = fakeHost()
    const first = host.mount()
    apply(
      first.ctx as never,
      testConfig({ routerTools: ['dispatch_list', 'dispatch_report', 'progress_note'] }),
    )
    expect(host.restricts).toHaveLength(2)
    first.dispose()

    const marks = host.events.length
    const second = host.mount()
    apply(second.ctx as never, testConfig())

    // One install per agent, each after the old stop, and the full default list:
    // the old three-name restriction is gone rather than intersected with.
    const after = host.restricts.slice(2)
    expect(after).toHaveLength(2)
    for (const list of after) expect(list).toEqual([...DEFAULT_ROUTER_TOOLS])
    const lastLift = host.events.lastIndexOf('lift')
    expect(lastLift).toBeGreaterThan(-1)
    expect(lastLift).toBeLessThan(host.events.indexOf('restrict', marks))
  })
})
