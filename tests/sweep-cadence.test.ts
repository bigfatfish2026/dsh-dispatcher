import { describe, expect, it } from 'vitest'
import { Config, LEGACY_SWEEP_WARNING, legacySweepWarning, resolveSweepMs } from '../src/config'
import { apply } from '../src/index'
import { TicketLog } from '../src/store/log'
import type { Serialize } from '../src/tickets/desk'
import { flush, INTENT, makeDesk, MemoryBackend } from './helpers/desk-harness'
import { fakePluginHost, testConfig } from './helpers/plugin-harness'

describe('巡检间隔 sweepMs', () => {
  it('schema：默认 10000，最小 500，低于 500 被挡', () => {
    expect(Config({} as never).sweepMs).toBe(10_000)
    // 老键没有默认值：没配就该是 undefined，由 resolveSweepMs 回落到 sweepMs。
    expect(Config({} as never).sweepMinutes).toBeUndefined()
    expect(() => Config({ sweepMs: 400 } as never)).toThrow(/sweepMs/)
    expect(Config({ sweepMs: 500 } as never).sweepMs).toBe(500)
  })

  it('假时钟推进 10 秒敲一拍，5 秒不敲', async () => {
    let calls = 0
    const serialize: Serialize = (work) => {
      calls += 1
      return work()
    }
    const h = makeDesk({ config: { defaultPreset: 't1' }, serialize })
    await h.desk.open(INTENT, h.main)
    h.desk.attach()
    calls = 0

    h.clock.advance(5_000)
    await flush()
    expect(calls).toBe(0)

    h.clock.advance(5_000)
    await flush()
    expect(calls).toBe(1)

    h.clock.advance(10_000)
    await flush()
    expect(calls).toBe(2)
  })

  it('队列被占住时不堆空转：推进 3 拍只进 1 次 maintain', async () => {
    let calls = 0
    let held = false
    let release!: () => void
    const serialize: Serialize = <T,>(work: () => Promise<T>): Promise<T> => {
      calls += 1
      if (!held) return work()
      return new Promise<T>((resolve) => {
        release = () => resolve(work())
      })
    }
    const h = makeDesk({ config: { defaultPreset: 't1' }, serialize })
    await h.desk.open(INTENT, h.main)
    h.desk.attach()
    // 从这一拍起把队列按住：票已经开好，卡的是巡检。
    held = true
    calls = 0

    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(10_000)
      await flush()
    }
    expect(calls).toBe(1)

    // 放手：这一拍跑完，闸才重新打开，下一拍再进一次。
    held = false
    release()
    await flush()
    h.clock.advance(10_000)
    await flush()
    expect(calls).toBe(2)
  })

  it('sweepMs 0 不起定时器', async () => {
    let calls = 0
    const serialize: Serialize = (work) => {
      calls += 1
      return work()
    }
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, serialize })
    h.desk.attach()
    calls = 0
    h.clock.advance(60_000)
    await flush()
    expect(calls).toBe(0)
  })
})

describe('sweepMinutes 兼容', () => {
  it('显式配置时按分钟折算，0 仍是关定时器', () => {
    expect(resolveSweepMs({ sweepMs: 10_000, sweepMinutes: 2 })).toBe(120_000)
    expect(resolveSweepMs({ sweepMs: 10_000, sweepMinutes: 0 })).toBe(0)
    expect(resolveSweepMs({ sweepMs: 7_000 })).toBe(7_000)
  })

  it('没配老键就不 warn，配了就 warn 那句', () => {
    expect(legacySweepWarning({})).toBeUndefined()
    expect(legacySweepWarning({ sweepMinutes: 0 })).toContain(LEGACY_SWEEP_WARNING)
  })

  it('装配时老键出现一次就 warn 一行', () => {
    const host = fakePluginHost()
    apply(host.ctx as never, testConfig({ sweepMinutes: 2 }))
    const log = host.warnings.join('\n')
    expect(log).toContain('sweepMinutes 已过时，改用 sweepMs')
    expect(log).toContain('sweepMinutes=2')
  })
})

describe('票列表顺序', () => {
  it('按 createdAt 升序，同一时刻按 id 兜底，不靠 ICU', () => {
    const backend = new MemoryBackend()
    backend.append({ id: 't-b', at: '2026-11-04T08:00:00.000Z', goal: 'b', status: 'open' })
    backend.append({ id: 't-a', at: '2026-11-04T08:00:00.000Z', goal: 'a', status: 'open' })
    backend.append({ id: 't-0', at: '2026-11-04T07:59:00.000Z', goal: '早', status: 'open' })
    const log = new TicketLog(backend)
    expect(log.list().map((ticket) => ticket.id)).toEqual(['t-0', 't-a', 't-b'])
  })
})
