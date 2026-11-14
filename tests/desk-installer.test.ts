import { describe, expect, it } from 'vitest'
import { createPresetCatalog, createWake } from '../src/installers/desk'

describe('createPresetCatalog：注册表兜底与缓存', () => {
  const TOOLS_YAML = "- name: 'dsh-preset-toolset'\n  config:\n    allow:\n      - read\n"

  it('list 抛错：warn 并返回空；正常行过滤空 id、保留 name/description', async () => {
    const warnings: string[] = []
    const broken = createPresetCatalog(
      () => ({
        list: async () => {
          throw new Error('boom')
        },
      }),
      (m) => warnings.push(m),
    )
    await expect(broken.list()).resolves.toEqual([])
    expect(warnings.join('\n')).toContain('读不到档位注册表')

    const catalog = createPresetCatalog(
      () => ({
        list: async () => [
          { id: 't1', name: '快', description: '能跑' },
          { id: '', name: '空' },
          { id: 't2' },
        ],
      }),
      () => {},
    )
    await expect(catalog.list()).resolves.toEqual([{ id: 't1', name: '快', description: '能跑' }, { id: 't2' }])
  })

  it('defaultId：字符串且非空才返回', () => {
    expect(createPresetCatalog(() => ({ defaultId: 't1' }), () => {}).defaultId?.()).toBe('t1')
    expect(createPresetCatalog(() => ({ defaultId: '' }), () => {}).defaultId?.()).toBeUndefined()
    expect(createPresetCatalog(() => undefined, () => {}).defaultId?.()).toBeUndefined()
  })

  it('tools：没有 readDocument 只 warn 一次；空声明抛；正常解析并按 id 缓存', async () => {
    const warnings: string[] = []
    const noDoc = createPresetCatalog(() => ({}), (m) => warnings.push(m))
    await expect(noDoc.tools('t1')).resolves.toBeUndefined()
    await expect(noDoc.tools('t1')).resolves.toBeUndefined()
    expect(warnings.filter((m) => m.includes('readDocument'))).toHaveLength(1)

    let reads = 0
    const catalog = createPresetCatalog(
      () => ({
        readDocument: async (id: string) => {
          reads += 1
          return { content: id === 'empty' ? '   ' : TOOLS_YAML }
        },
      }),
      () => {},
    )
    await expect(catalog.tools('empty')).rejects.toThrow('声明是空的')
    const tools = await catalog.tools('t1')
    expect([...(tools?.names ?? [])]).toEqual(['read'])
    await catalog.tools('t1')
    expect(reads).toBe(2)
  })
})

describe('createWake：指名优先，退回落第一个能 followup 的主会话', () => {
  function agent(id: string, origin: string | undefined, messages: string[]): never {
    return {
      session: { id, ...(origin ? { header: { origin } } : {}) },
      followup: async (message: { content?: Array<{ text?: string }> }) => {
        messages.push(message.content?.[0]?.text ?? '')
      },
    } as never
  }

  it('指名的在就只送它；指名的不可用就回落第一个主会话', async () => {
    const messages: string[] = []
    const main = agent('session-main', undefined, messages)
    const worker = agent('worker-1', 'subagent', messages)
    const wake = createWake(() => ({ list: () => [worker, main] }))
    await expect(wake('hello', 'session-main')).resolves.toBe(true)
    expect(messages).toEqual(['hello'])

    await expect(wake('again', 'worker-1')).resolves.toBe(true)
    expect(messages).toEqual(['hello', 'again'])
  })

  it('没有可用主会话：返回 false，worker 不被叫', async () => {
    const messages: string[] = []
    const wake = createWake(() => ({ list: () => [agent('worker-1', 'subagent', messages)] }))
    await expect(wake('hello')).resolves.toBe(false)
    expect(messages).toEqual([])
  })
})
