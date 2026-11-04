import { describe, expect, it } from 'vitest'
import { flush, INTENT, makeDesk } from './helpers/desk-harness'

const minutes = (count: number) => count * 60_000

/** 手动巡检的用例把自动定时器关掉：sweepMs 0，advance 不会顺手点着它。 */
const MANUAL = { config: { defaultPreset: 't1', sweepMs: 0 } }

function idleSignals(h: ReturnType<typeof makeDesk>) {
  return h.bus.filter((entry) => entry.channel === 'dispatcher/ticket-idle')
}

describe('巡检信号', () => {
  it('waiting 满 20 分钟提醒一次；再扫一遍不重复打扰', async () => {
    const h = makeDesk(MANUAL)
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    expect(h.log.get(id)!.status).toBe('waiting')
    const before = h.lines()

    h.clock.advance(minutes(20))
    const first = await h.desk.maintain()
    expect(first.signals).toBe(1)
    expect(idleSignals(h)[0]?.payload).toMatchObject({ id, reason: 'waiting-20m', sinceMinutes: 20 })

    const second = await h.desk.maintain()
    expect(second.signals).toBe(0)
    // 巡检只发信号：一条日志都不许写。
    expect(h.lines()).toBe(before)
    expect(h.log.get(id)!.status).toBe('waiting')
  })

  it('还没到点不发；差一分钟也不发', async () => {
    const h = makeDesk(MANUAL)
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    h.clock.advance(minutes(19))
    expect((await h.desk.maintain()).signals).toBe(0)
    expect(idleSignals(h)).toHaveLength(0)
  })

  it('blocked 满 60 分钟才提醒，理由是 blocked-60m', async () => {
    const h = makeDesk(MANUAL)
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.block(id, '等主人拍板')
    h.clock.advance(minutes(59))
    expect((await h.desk.maintain()).signals).toBe(0)
    h.clock.advance(minutes(1))
    expect((await h.desk.maintain()).signals).toBe(1)
    expect(idleSignals(h)[0]?.payload).toMatchObject({ id, reason: 'blocked-60m' })
  })

  it('running 提醒默认关着：跑两小时也不响', async () => {
    const h = makeDesk(MANUAL)
    const { id } = await h.desk.open(INTENT, h.main)
    h.clock.advance(minutes(120))
    expect((await h.desk.maintain()).signals).toBe(0)
    expect(idleSignals(h)).toHaveLength(0)
    expect(h.log.get(id)!.status).toBe('running')
  })

  it('runningReminderMinutes > 0 才会响', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0, runningReminderMinutes: 30 },
    })
    const { id } = await h.desk.open(INTENT, h.main)
    h.clock.advance(minutes(29))
    expect((await h.desk.maintain()).signals).toBe(0)
    h.clock.advance(minutes(1))
    expect((await h.desk.maintain()).signals).toBe(1)
    expect(idleSignals(h)[0]?.payload).toMatchObject({ id, reason: 'running-90m' })
  })

  it('状态轮换以后可以再提醒一次：指纹带 statusSince', async () => {
    const h = makeDesk(MANUAL)
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    h.clock.advance(minutes(20))
    expect((await h.desk.maintain()).signals).toBe(1)

    // 又派了一轮：waiting → running → 再 idle → waiting（新的 statusSince）。
    await h.desk.send(id, '再来一轮')
    h.agents.markAlive('worker-1')
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()
    expect(h.log.get(id)!.status).toBe('waiting')
    h.clock.advance(minutes(20))
    expect((await h.desk.maintain()).signals).toBe(1)
    expect(idleSignals(h)).toHaveLength(2)
  })

  it('attach 之后按默认 sweepMs 自己跑：10 秒一拍，不用谁手动调', async () => {
    // 这一条要的就是自动定时器：别的用例关掉它，这里用默认的 10 秒。
    // waitingMinutes 调成 0，第一拍就该发信号，好数拍子。
    const h = makeDesk({ config: { defaultPreset: 't1', waitingMinutes: 0 } })
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    expect(h.log.get(id)!.status).toBe('waiting')
    // 差 5 秒不算一拍。
    h.clock.advance(5_000)
    await flush()
    expect(idleSignals(h)).toHaveLength(0)
    h.clock.advance(5_000)
    await flush()
    expect(idleSignals(h)).toHaveLength(1)
  })

  it('关台之后不再巡检', async () => {
    const h = makeDesk(MANUAL)
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    await h.desk.dispose()
    h.clock.advance(minutes(60))
    await flush()
    expect(idleSignals(h)).toHaveLength(0)
  })
})
