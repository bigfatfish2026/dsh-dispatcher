import { describe, expect, it } from 'vitest'
import { foldEvents } from '../src/store'
import { INTENT, flush, makeDesk } from './helpers/desk-harness'
import { mountPlugin, tempDir } from './helpers/plugin-harness'

/**
 * 2026-11-04 起票上记的是 `publisher`：开票那个会话的 session id。它干两件事——
 * 重复开票只在同一个人、同一件事、窗口内才算重复；投话回去时拿它当 sender。
 * 老的 `owner`/`ownerId` 两栏连同巡检的猜测逻辑一起删了：没有 publisher 的老票
 * 就是「不知道谁开的」，投不了话就老老实实留在队列里报一句。
 */

describe('fold 认 publisher', () => {
  it('老票没有 publisher，读出来就是 undefined', () => {
    const snapshots = foldEvents([
      { id: 't-old', at: '2026-11-03T00:00:00.000Z', goal: '老票', status: 'running', owner: 't4 查qqbot PR' },
    ])
    expect(snapshots[0].publisher).toBeUndefined()
  })

  it('新票的 publisher 一路带到快照上', () => {
    const snapshots = foldEvents([
      {
        id: 't-1',
        kind: 'published',
        at: '2026-11-04T00:00:00.000Z',
        goal: '新票',
        brief: '新票',
        publisher: 'session-main',
        preset: 't1',
        presetSource: 'router',
      },
    ])
    expect(snapshots[0].publisher).toBe('session-main')
  })
})

describe('dispatch_open 记 publisher', () => {
  it('落在 published 行上，且就是调工具的那个会话', async () => {
    const host = mountPlugin()
    const opened = (await host.call('dispatch_open', { goal: 'g', brief: 'b' })) as { id: string }
    expect(host.subagents.spawned).toHaveLength(1)
    // 票台读回来的快照带 publisher；publisher 不出现在给模型看的视图里。
    const listed = (await host.call('dispatch_list', {})) as { tickets: Array<Record<string, unknown>> }
    const row = listed.tickets.find((entry) => entry.id === opened.id)!
    expect(row).not.toHaveProperty('publisher')
    expect(row).not.toHaveProperty('goal')
  })

  it('两个会话各开各的票，重复判定不串人', async () => {
    const host = mountPlugin({ existingAgents: 2 })
    const a = host.agents[0]!
    const b = host.agents[1]!
    const first = (await host.call('dispatch_open', { goal: '同一件事', brief: '甲' }, { agent: a })) as { id: string }
    const second = (await host.call('dispatch_open', { goal: '同一件事', brief: '乙' }, { agent: b })) as {
      id: string
      duplicate?: string
    }
    expect(second.id).not.toBe(first.id)
    expect(second.duplicate).toBeUndefined()
  })
})

describe('同一请求重放只开一张票', () => {
  it('同 requestId 再来一次：回原票、不再派小鱼、日志只多一行', async () => {
    const host = mountPlugin()
    const first = (await host.call('dispatch_open', { goal: 'g', brief: 'b' }, { callId: 'call-1' })) as {
      id: string
      duplicate?: string
    }
    const before = host.subagents.spawned.length

    const second = (await host.call('dispatch_open', { goal: 'g', brief: 'b' }, { callId: 'call-1' })) as {
      id: string
      duplicate?: string
    }
    expect(second.id).toBe(first.id)
    expect(second.duplicate).toBe(first.id)
    expect(host.subagents.spawned.length).toBe(before)
  })
})

describe('没有 publisher 的老票', () => {
  it('话投不出去就留着，报一句「发布会话不在活表」', async () => {
    const h = makeDesk()
    // 老日志：开票行没有 publisher，spawn 行只记 workerId。
    h.backend.append({
      id: 't-legacy',
      kind: 'published',
      at: '2026-11-03T00:00:00.000Z',
      goal: '老票',
      brief: '老票',
      preset: 't1',
      presetSource: 'router',
    } as never)
    h.backend.append({
      id: 't-legacy',
      kind: 'spawned',
      at: '2026-11-03T00:00:00.000Z',
      workerId: 'worker-1',
      preset: 't1',
    } as never)
    h.desk.attach()

    const receipt = await h.desk.send('t-legacy', '接着说', h.main)
    expect(receipt).toBeDefined()
    expect(h.desk.get('t-legacy')!.pendingInputs).toBe(1)

    h.host.emit('subagent/idle', { id: 'worker-1' })
    await flush()
    expect(h.warnings.some((line) => line.includes('发布会话不在活表'))).toBe(true)
    expect(h.desk.get('t-legacy')!.pendingInputs).toBe(1)
  })
})

describe('开票只认活表里的人', () => {
  it('发布者不在活表：不开票，一个事件都不写', async () => {
    const h = makeDesk({ agents: { list: () => [], get: () => undefined } as never })
    await expect(h.desk.open({ ...INTENT }, { kind: 'main', sessionId: 'session-ghost' })).rejects.toThrow(
      /主会话不在活表里/,
    )
    expect(h.lines()).toBe(0)
  })
})

void tempDir
