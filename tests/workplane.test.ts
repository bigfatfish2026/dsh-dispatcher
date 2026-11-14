import { describe, expect, it } from 'vitest'
import { createWorkerPlane } from '../src/installers/workplane'

function ctx(): { effect: (cb: () => () => void, label?: string) => void; on: () => void } {
  return { effect: () => {}, on: () => {} }
}

function agent(origin: string | undefined, tools: Record<string, unknown>): { session: { id: string; header?: { origin?: string } }; ctx: Record<string, unknown> } {
  return { session: { id: 'worker-1', ...(origin ? { header: { origin } } : {}) }, ctx: { tools, effect: () => {} } }
}

describe('WorkerPlane 守卫装不上的路径', () => {
  it('guard 抛错：只 warn，不把派活带崩', () => {
    const warnings: string[] = []
    const plane = createWorkerPlane(ctx() as never, { warn: (m) => warnings.push(m), info: () => {} })
    const target = agent('subagent', {
      guard: () => {
        throw new Error('guard boom')
      },
    })
    expect(() => plane.installGuard(target)).not.toThrow()
    expect(warnings.join('\n')).toContain('停手守卫没装上')
    expect(warnings.join('\n')).toContain('guard boom')
  })

  it('guard 回了非函数 / 宿主没给 guard / 不是 worker：都安静跳过', () => {
    const warnings: string[] = []
    const plane = createWorkerPlane(ctx() as never, { warn: (m) => warnings.push(m), info: () => {} })
    expect(() => plane.installGuard(agent('subagent', { guard: () => undefined }))).not.toThrow()
    expect(() => plane.installGuard(agent('subagent', {}))).not.toThrow()
    expect(() => plane.installGuard(agent(undefined, { guard: () => () => {} }))).not.toThrow()
    expect(warnings).toEqual([])
  })
})
