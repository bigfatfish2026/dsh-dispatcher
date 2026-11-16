import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config'
import { apply } from '../src/index'
import { composeWorkerPrompt, presetPromptSuffix } from '../src/tickets/worker-prompt'

/**
 * 小鱼提示词两段后缀：共用 `workerPrompt` + 按档 `promptSuffix`。
 *
 * 落点是 `system-prompt/assemble` 的 section，所以这里跑的是真钩子：`apply`
 * 装完之后逐层过一遍，看子会话的装配结果里有没有那一段、内容对不对、顺序对
 * 不对。主会话不该看见它。
 */

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-worker-prompt-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

type PromptAssembly = {
  sections: Array<{ name: string; order?: number; text: string }>
  contexts?: Array<{ name: string; text: string }>
  tools?: unknown[]
}

type AssemblyHook = (
  assembly: PromptAssembly,
  context: unknown,
  next: () => Promise<PromptAssembly>,
) => Promise<PromptAssembly>

/** 只回答 apply 在提示词这条路上要问的几个问题。 */
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

/** 跑一轮装配，返回小鱼提示词那一段的正文（没注入就是 undefined）。 */
async function workerSection(
  config: Record<string, unknown>,
  header: Record<string, unknown>,
): Promise<string | undefined> {
  const parsed = Config({ stateFile: join(tempDir(), 'tickets.jsonl'), ...config } as never)
  const host = promptHost()
  apply(host.ctx as never, parsed)
  expect(host.hooks.length).toBeGreaterThan(0)

  let assembled: PromptAssembly = {
    sections: [{ name: 'persona', text: 'base' }],
    contexts: [],
    tools: [],
  }
  for (const hook of host.hooks) {
    const current = assembled
    assembled = await hook(current, { agent: { session: { header } } }, async () => current)
  }
  return assembled.sections.find((section) => section.name === 'dispatcher:worker-prompt')?.text
}

describe('worker prompt suffix', () => {
  it('injects the shared block into a worker session', async () => {
    const text = await workerSection({ workerPrompt: '【小鱼底线】共用这段' }, { origin: 'subagent' })
    expect(text).toBe('【小鱼底线】共用这段')
  })

  it('puts the shared block first and the preset suffix second, one blank line apart', async () => {
    const text = await workerSection(
      {
        workerPrompt: '共用段',
        presets: [{ name: 't1', promptSuffix: 't1 自己的段' }],
      },
      { origin: 'subagent', agentPreset: 't1' },
    )
    expect(text).toBe('共用段\n\nt1 自己的段')
    expect(text!.indexOf('共用段')).toBeLessThan(text!.indexOf('t1 自己的段'))
  })

  it('injects nothing when both blocks are empty', async () => {
    const text = await workerSection(
      { workerPrompt: '', presets: [{ name: 't1', promptSuffix: '' }] },
      { origin: 'subagent', agentPreset: 't1' },
    )
    expect(text).toBeUndefined()
  })

  it('still accepts a preset written as a bare string', async () => {
    // 字符串写法 = 这档存在、不追加；老配置不改也能加载。
    const parsed = Config({ presets: ['t0', 't1'] } as never)
    expect(parsed.presets).toEqual(['t0', 't1'])
    expect(presetPromptSuffix(parsed.presets, 't1')).toBe('')
    expect(await workerSection({ presets: ['t1'] }, { origin: 'subagent', agentPreset: 't1' })).toBeUndefined()
  })

  it('mixes string and object entries in one list', async () => {
    const parsed = Config({
      presets: ['t0', { name: 't5', promptSuffix: 't5 媒体' }],
    } as never)
    expect(presetPromptSuffix(parsed.presets, 't0')).toBe('')
    expect(presetPromptSuffix(parsed.presets, 't5')).toBe('t5 媒体')
    expect(
      await workerSection(
        { workerPrompt: '共用', presets: ['t0', { name: 't5', promptSuffix: 't5 媒体' }] },
        { origin: 'subagent', agentPreset: 't5' },
      ),
    ).toBe('共用\n\nt5 媒体')
  })

  it('leaves the main session untouched', async () => {
    const text = await workerSection({ workerPrompt: '只给小鱼' }, {})
    expect(text).toBeUndefined()
  })

  it('keeps the shared block when the preset has no entry', async () => {
    const text = await workerSection(
      { workerPrompt: '共用', presets: [{ name: 't2', promptSuffix: 't2 的段' }] },
      { origin: 'subagent', agentPreset: 't1' },
    )
    expect(text).toBe('共用')
  })
})

describe('composeWorkerPrompt', () => {
  it('joins both blocks with one blank line', () => {
    expect(composeWorkerPrompt('第一段\n', '\n第二段  \n')).toBe('第一段\n\n第二段')
  })

  it('trims a block scalar and drops the separator when one side is empty', () => {
    expect(composeWorkerPrompt('  第一段\n', '')).toBe('第一段')
    expect(composeWorkerPrompt('  \n ', '第二段')).toBe('第二段')
    expect(composeWorkerPrompt(undefined, undefined)).toBe('')
  })
})
