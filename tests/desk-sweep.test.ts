import { describe, expect, it } from 'vitest'
import { fakeClock } from '../src/tickets/clock'
import { WAITING_MINUTES } from '../src/defaults'
import { createNotifier } from '../src/tickets/notify'
import { createSweepFacts } from '../src/tickets/sweep-facts'
import { flush, INTENT, makeDesk } from './helpers/desk-harness'

const minutes = (count: number) => count * 60_000

/** 手动巡检的用例把自动定时器关掉：sweepMs 0，advance 不会顺手点着它。 */
const MANUAL = { config: { defaultPreset: 't1', sweepMs: 0 } }

function idleSignals(h: ReturnType<typeof makeDesk>) {
  return h.bus.filter((entry) => entry.channel === 'dispatcher/ticket-idle')
}

/**
 * 巡检真投递：假 wake 记账 + 真事实表。makeDesk 和 notifier 各拿一只同起点的
 * 假时钟，`advance` 时两只一起走，免得「票面时间」和「事实渲染时间」对不上。
 */
function wiredDesk() {
  const clock = fakeClock()
  const facts = createSweepFacts({ clock })
  const wakes: string[] = []
  const notifier = createNotifier({
    facts,
    clock,
    wake: (text) => {
      wakes.push(text)
      return true
    },
  })
  const h = makeDesk({ ...MANUAL, notifier })
  const advance = (ms: number): void => {
    h.clock.advance(ms)
    clock.advance(ms)
  }
  return { h, facts, wakes, advance }
}

/** 先把票推过探路轮：交声明 + idle，执行任务投回同一只（epoch+1）。 */
async function toTask(h: ReturnType<typeof makeDesk>, id: string): Promise<void> {
  h.desk.attach()
  h.agents.markAlive('worker-1')
  await h.desk.declare('worker-1', { summary: '探完了' }, { writes: ['dir:/tmp/desk-sweep'] })
  h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
  await flush()
  expect(h.log.get(id)!.phase).toBe('running')
}

describe('巡检信号', () => {
  it(`waiting 满 ${WAITING_MINUTES} 分钟提醒一次；再扫一遍不重复打扰`, async () => {
    const h = makeDesk(MANUAL)
    const { id } = await h.desk.open(INTENT, h.main)
    await toTask(h, id)
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    expect(h.log.get(id)!.status).toBe('waiting')
    const before = h.lines()

    h.clock.advance(minutes(WAITING_MINUTES))
    const first = await h.desk.maintain()
    expect(first.signals).toBe(1)
    expect(idleSignals(h)[0]?.payload).toMatchObject({ id, reason: 'waiting-12m', sinceMinutes: WAITING_MINUTES })

    const second = await h.desk.maintain()
    expect(second.signals).toBe(0)
    // 巡检只发信号：一条日志都不许写。
    expect(h.lines()).toBe(before)
    expect(h.log.get(id)!.status).toBe('waiting')
  })

  it('还没到阈值不发；差一分钟也不发', async () => {
    const h = makeDesk(MANUAL)
    await h.desk.open(INTENT, h.main)
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    h.clock.advance(minutes(WAITING_MINUTES - 1))
    expect((await h.desk.maintain()).signals).toBe(0)
    expect(idleSignals(h)).toHaveLength(0)
  })

  it('waiting 差一分钟到阈值一个字都不发：不 followup，也不写事实表', async () => {
    const { h, facts, wakes, advance } = wiredDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await toTask(h, id)
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    expect(h.log.get(id)!.status).toBe('waiting')
    // 先摘掉「干完没交报告」那条事实（另一条路，不关 waiting 巡检的事）。
    facts.forget(id)
    expect(facts.text()).toBe('')

    advance(minutes(WAITING_MINUTES - 1))
    expect((await h.desk.maintain()).signals).toBe(0)
    await flush()
    expect(wakes).toHaveLength(0)
    expect(facts.text()).toBe('')
  })

  it('waiting 满阈值走 followup 叫醒一次；事实表不记，再扫不重复', async () => {
    const { h, facts, wakes, advance } = wiredDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await toTask(h, id)
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    // 先摘掉「干完没交报告」那条事实（另一条路，不关 waiting 巡检的事）。
    facts.forget(id)
    expect(facts.text()).toBe('')

    advance(minutes(WAITING_MINUTES))
    expect((await h.desk.maintain()).signals).toBe(1)
    await flush()
    // 走的是 send/followup，不是 facts.remember。
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toContain(id)
    expect(wakes[0]).toContain('dispatch_read')
    expect(facts.text()).toBe('')

    // 再扫两遍、再等半小时也还是那一句：一张票一轮 waiting 只提醒一次。
    expect((await h.desk.maintain()).signals).toBe(0)
    advance(minutes(30))
    expect((await h.desk.maintain()).signals).toBe(0)
    await flush()
    expect(wakes).toHaveLength(1)
  })

  it('blocked 60 分钟那档照旧：59 分钟不发，满点叫醒', async () => {
    const { h, wakes, advance } = wiredDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.block(id, '等使用方拍板')
    advance(minutes(59))
    expect((await h.desk.maintain()).signals).toBe(0)
    expect(wakes).toHaveLength(0)
    advance(minutes(1))
    expect((await h.desk.maintain()).signals).toBe(1)
    await flush()
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toContain(id)
    expect(wakes[0]).toContain('在等使用方决定')
  })

  it('blocked 满 60 分钟才提醒，理由是 blocked-60m', async () => {
    const h = makeDesk(MANUAL)
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.block(id, '等使用方拍板')
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
    await toTask(h, id)
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    h.clock.advance(minutes(WAITING_MINUTES))
    expect((await h.desk.maintain()).signals).toBe(1)

    // 又派了一轮：waiting → running → 再 idle → waiting（新的 statusSince）。
    await h.desk.send(id, '再来一轮')
    h.agents.markAlive('worker-1')
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()
    expect(h.log.get(id)!.status).toBe('waiting')
    h.clock.advance(minutes(WAITING_MINUTES))
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
    await h.desk.open(INTENT, h.main)
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    await h.desk.dispose()
    h.clock.advance(minutes(60))
    await flush()
    expect(idleSignals(h)).toHaveLength(0)
  })
})
