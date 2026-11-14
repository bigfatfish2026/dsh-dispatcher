import { describe, expect, it } from 'vitest'
import { createWorkerPool } from '../src/tickets/workers'
import type { AgentLookup, SubagentActivation, SubagentSeam } from '../src/tickets/workers'

function seam(dispose: () => Promise<void> | void): SubagentSeam {
  return {
    async startActivation(): Promise<SubagentActivation> {
      return { childId: 'worker-1', dispose }
    },
    async sendMessage() {
      return 'msg-1'
    },
  }
}

const START = {
  ticketId: 't-1',
  provider: 'spawn',
  preset: 't1',
  label: 'worker-1',
  prompt: '干活',
  parent: {},
}

describe('createWorkerPool 的尽力而为路径', () => {
  it('没有 agents 活表：alive 返回 undefined，不把「比不了」当成死', () => {
    const pool = createWorkerPool({ subagents: () => seam(() => {}), agents: () => undefined })
    expect(pool.alive('worker-1')).toBeUndefined()
  })

  it('活表拿得到：在就是 true，不在就是 false', () => {
    const table = new Map<string, unknown>([['worker-1', { id: 'worker-1' }]])
    const agents: AgentLookup = { get: (id) => table.get(id) }
    const pool = createWorkerPool({ subagents: () => seam(() => {}), agents: () => agents })
    expect(pool.alive('worker-1')).toBe(true)
    expect(pool.alive('worker-2')).toBe(false)
  })

  it('abort 时 dispose 抛错：只 warn，不往上冒', async () => {
    const warnings: string[] = []
    const pool = createWorkerPool({
      subagents: () => seam(async () => {
        throw new Error('dispose boom')
      }),
      agents: () => undefined,
      warn: (message) => warnings.push(message),
    })
    const registration = await pool.start(START)
    await expect(pool.abort(registration.workerId)).resolves.toBeUndefined()
    expect(warnings.join('\n')).toContain('dispose')
  })

  it('没有 subagents 服务：start 直接报错，不假装派出去', async () => {
    const pool = createWorkerPool({ subagents: () => undefined, agents: () => undefined })
    await expect(pool.start(START)).rejects.toThrow('subagents 服务不可用')
  })
})
