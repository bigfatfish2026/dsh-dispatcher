import { describe, expect, it } from 'vitest'
import { createWake } from '../src/installers/desk'

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
