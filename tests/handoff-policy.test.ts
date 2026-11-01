import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, DEFAULT_HANDOFF_POLICY } from '../src/config'
import { HANDOFF_POLICY, apply } from '../src/index'

/**
 * The hand-off text is config now, so these tests pin the two halves of that:
 * the schema default is the shipped wording (with 小鱼, no bare "worker"), and
 * whatever the operator writes in cordis.yml is what the model actually reads.
 */

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-handoff-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

type AssemblyHook = (
  assembly: { sections: Array<{ name: string; order?: number; text: string }>; tools?: unknown[] },
  context: unknown,
  next: () => Promise<{ sections: Array<{ name: string; order?: number; text: string }>; tools?: unknown[] }>,
) => Promise<{ sections: Array<{ name: string; order?: number; text: string }>; tools?: unknown[] }>

/** A host that only has to answer the questions `apply` asks on the prompt path. */
function promptHost() {
  const hooks: AssemblyHook[] = []
  const ctx = {
    agents: { list: () => [], get: () => undefined },
    effect: (callback: () => () => void) => callback(),
    on(event: string, listener: unknown) {
      if (event === 'system-prompt/assemble') hooks.push(listener as AssemblyHook)
      return () => {}
    },
    tools: { register: () => () => {}, get: () => undefined },
    logger: { info() {}, warn() {} },
  }
  return { ctx, hooks }
}

/** Run one turn through the installed hook and return the appended section. */
async function injectedSection(config: Record<string, unknown>): Promise<string | undefined> {
  const parsed = Config({ stateFile: join(tempDir(), 'tickets.jsonl'), ...config } as never)
  const host = promptHost()
  apply(host.ctx as never, parsed)
  // An empty block installs no hook at all, which is the point of the test.
  if (host.hooks.length === 0) return undefined
  expect(host.hooks).toHaveLength(1)

  const base = { sections: [{ name: 'persona', text: 'base' }], tools: [] }
  const assembled = await host.hooks[0](base, { agent: { session: { header: {} } } }, async () => base)
  return assembled.sections.find((section) => section.name === 'dispatcher:handoff')?.text
}

describe('handoff policy text comes from config', () => {
  it('defaults to the shipped wording, with 小鱼 and no bare worker', () => {
    const config = Config({} as never)
    expect(config.handoffPolicyText).toBe(DEFAULT_HANDOFF_POLICY)
    expect(DEFAULT_HANDOFF_POLICY).toContain('小鱼')
    expect(DEFAULT_HANDOFF_POLICY).not.toMatch(/worker/i)
    // The alias index.ts kept for callers is the same string, not a copy.
    expect(HANDOFF_POLICY).toBe(DEFAULT_HANDOFF_POLICY)
  })

  it('injects the default wording when nothing is configured', async () => {
    expect(await injectedSection({ handoffPolicy: true })).toBe(DEFAULT_HANDOFF_POLICY)
  })

  it('injects whatever the config says instead of the built-in text', async () => {
    const custom = '【派活规矩】这句是 yml 里改的，代码里没有。'
    const text = await injectedSection({ handoffPolicy: true, handoffPolicyText: custom })
    expect(text).toBe(custom)
    expect(text).not.toContain('小鱼')
  })

  it('trims the block scalar a yml multi-line string comes wrapped in', async () => {
    const custom = '  第一行\n第二行\n'
    expect(await injectedSection({ handoffPolicy: true, handoffPolicyText: custom })).toBe('第一行\n第二行')
  })

  it('injects nothing when the text is empty or blank', async () => {
    expect(await injectedSection({ handoffPolicy: true, handoffPolicyText: '' })).toBeUndefined()
    expect(await injectedSection({ handoffPolicy: true, handoffPolicyText: '   \n ' })).toBeUndefined()
  })

  it('injects nothing when handoffPolicy is off, whatever the text says', async () => {
    const host = promptHost()
    apply(
      host.ctx as never,
      Config({ stateFile: join(tempDir(), 'tickets.jsonl'), handoffPolicy: false } as never),
    )
    expect(host.hooks).toHaveLength(0)
  })
})
