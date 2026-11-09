/**
 * 巡检驱动源（草案第三刀 3b）：tick 优先，降级路径必须真的能用。
 *
 * 四条降级路径各有用例：schedule 在且注册成功、schedule 不在、注册被拒
 * （EV-006）、服务中途消失/断流。另外锁两条：拍子不并发、换源幂等。
 */
import { describe, expect, it } from 'vitest'
import { createSweepDriver } from '../src/tickets/sweep-driver'
import type { SweepEventsService, SweepScheduleService } from '../src/tickets/sweep-driver'
import { flush, makeDesk } from './helpers/desk-harness'
import { fakeEvents, fakeSchedule } from './helpers/sweep-services'

const TICK = {
  name: 'dispatcher.sweep.tick',
  firedAt: '2026-11-04T08:00:10.000Z',
  periodKey: 'dispatcher.sweep.every10s.1762240000',
}

/** 真票台 + 假服务 + 假时钟；`calls()` 数的是 serialize 入队次数（没人开票时就是巡检拍数）。 */
function setup(options: { sweepMs?: number; withSchedule?: boolean } = {}) {
  const every = options.sweepMs ?? 10_000
  let calls = 0
  const h = makeDesk({
    config: { defaultPreset: 't1', sweepMs: every },
    serialize: (work) => {
      calls += 1
      return work()
    },
  })
  h.desk.attach()

  const events = fakeEvents()
  const schedule = fakeSchedule(events)
  const refs: { events?: SweepEventsService; schedule?: SweepScheduleService } = {
    events: events.service,
    schedule: options.withSchedule === false ? undefined : schedule.service,
  }
  const infos: string[] = []
  const driver = createSweepDriver({
    desk: h.desk,
    events: () => refs.events,
    schedule: () => refs.schedule,
    every,
    clock: h.clock,
    info: (message) => infos.push(message),
    warn: (message) => h.warnings.push(message),
  })
  h.desk.onPulse(() => driver.reconcile())
  driver.reconcile()
  return { h, events, schedule, refs, infos, driver, calls: () => calls }
}

describe('sweep 由 dispatcher.sweep.tick 驱动', () => {
  it('注册成功：自己的 interval 被清，订阅到来时 maintain 真跑一次', async () => {
    const { h, events, schedule, driver, infos, calls } = setup()

    // 规则参数照现有 sweepMs 走，catchUp 显式 skip。
    expect(schedule.rules.get('dispatcher.sweep')).toEqual({
      id: 'dispatcher.sweep',
      every: 10_000,
      topic: 'dispatcher.sweep.tick',
      catchUp: 'skip',
    })
    expect(driver.mode()).toBe('tick')
    expect(h.desk.sweepDriver).toBe('tick')
    expect(infos.join('\n')).toContain('由 dispatcher.sweep.tick 驱动')
    expect(events.subscriptions).toHaveLength(1)
    // 事件类型注册的是 volatile，payload 三字段校验。
    const def = events.defined.get('dispatcher.sweep.tick') as {
      durability: string
      payloadSchema: (payload: unknown) => boolean
    }
    expect(def.durability).toBe('volatile')
    expect(def.payloadSchema(TICK)).toBe(true)
    expect(def.payloadSchema({ name: 'dispatcher.sweep.tick' })).toBe(false)

    const base = calls()
    h.clock.advance(10_000)
    await flush()
    // 旧定时器真没了：推进一个原周期，一拍都不跑。
    expect(calls()).toBe(base)

    expect(events.emit(TICK)).toBe(1)
    await flush()
    // 订阅这一拍真进了 maintain：serialize 入队一次。
    expect(calls()).toBe(base + 1)
  })

  it('schedule 不在：保留自己的 interval，并且照常一拍一拍跑', async () => {
    const { h, schedule, driver, calls } = setup({ withSchedule: false })

    expect(driver.mode()).toBe('interval')
    expect(h.desk.sweepDriver).toBe('interval')
    expect(schedule.registerCalls).toBe(0)
    expect(h.warnings.join('\n')).toContain('没有 schedule 服务')

    const base = calls()
    h.clock.advance(10_000)
    await flush()
    expect(calls()).toBe(base + 1)
    h.clock.advance(10_000)
    await flush()
    expect(calls()).toBe(base + 2)
  })

  it('注册抛 EV-006：interval 保留、打一行 warn、冷却期内不反复重试', async () => {
    const { h, schedule, refs, driver, calls } = setup({ withSchedule: false })

    // schedule 中途出现，但 topic 校验不过（EV-006）。
    refs.schedule = schedule.service
    schedule.failNext = Object.assign(new Error('topic dispatcher.sweep.tick 未注册'), { code: 'EV-006' })
    driver.reconcile()

    expect(h.warnings.join('\n')).toContain('EV-006')
    expect(h.desk.sweepDriver).toBe('interval')
    expect(driver.mode()).toBe('interval')

    const base = calls()
    h.clock.advance(10_000)
    await flush()
    // 降级成功：自己那一拍照跑。
    expect(calls()).toBe(base + 1)

    const tries = schedule.registerCalls
    driver.reconcile()
    expect(schedule.registerCalls).toBe(tries)
  })

  it('services 中途消失：schedule 没了就恢复自己的 interval 并 warn', async () => {
    const { h, refs, driver, calls } = setup()
    expect(driver.mode()).toBe('tick')

    refs.schedule = undefined
    driver.reconcile()

    expect(driver.mode()).toBe('interval')
    expect(h.desk.sweepDriver).toBe('interval')
    expect(h.warnings.join('\n')).toContain('schedule 服务不在了')

    const base = calls()
    h.clock.advance(10_000)
    await flush()
    expect(calls()).toBe(base + 1)
  })

  it('tick 断流：三拍没来就认死，恢复 interval、撤规则、留一行 warn', async () => {
    const { h, schedule, driver, calls } = setup()
    expect(driver.mode()).toBe('tick')
    const base = calls()

    h.clock.advance(10_000)
    await flush()
    h.clock.advance(10_000)
    await flush()
    expect(calls()).toBe(base) // 两拍之内还当它在

    h.clock.advance(10_000)
    await flush()
    expect(h.warnings.join('\n')).toContain('断流')
    expect(driver.mode()).toBe('interval')
    expect(h.desk.sweepDriver).toBe('interval')
    expect(schedule.unregistered).toContain('dispatcher.sweep')

    h.clock.advance(10_000)
    await flush()
    // 巡检没有停摆：换回来的定时器下一拍就跑了。
    expect(calls()).toBe(base + 1)
  })

  it('sweepMs 0：不订阅、不注册、不起定时器', async () => {
    const { h, events, schedule, driver, calls } = setup({ sweepMs: 0 })

    expect(events.subscribeCalls).toBe(0)
    expect(schedule.registerCalls).toBe(0)
    expect(driver.mode()).toBe('interval')
    h.clock.advance(60_000)
    await flush()
    expect(calls()).toBe(0)
  })
})

describe('两把锁', () => {
  it('换源幂等：重复 reconcile 只注册一次、只订阅一次、只有一路在驱动', async () => {
    const { h, events, schedule, driver, calls } = setup()

    driver.reconcile()
    driver.reconcile()
    expect(events.defineCalls).toBe(1)
    expect(events.subscribeCalls).toBe(1)
    expect(schedule.registerCalls).toBe(1)

    const base = calls()
    h.clock.advance(10_000)
    await flush()
    expect(calls()).toBe(base) // 没有第二路 interval 偷偷在跑

    events.emit(TICK)
    await flush()
    expect(calls()).toBe(base + 1) // 也只有一份订阅，不会一拍两跑
  })

  it('同一时刻只跑一拍：interval 堵在队列里时，tick 直接让路', async () => {
    let gate!: () => void
    let held = false
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 10_000 },
      serialize: <T,>(work: () => Promise<T>): Promise<T> => {
        if (!held) return work()
        return new Promise<T>((resolve) => {
          gate = () => resolve(work())
        })
      },
    })
    h.desk.attach()
    held = true

    expect(h.desk.pulse('interval')).toBe(true)
    // 订阅这一拍撞进来：闸着，返回 false，不往队列里堆。
    expect(h.desk.pulse('tick')).toBe(false)

    held = false
    gate()
    await flush()
    expect(h.desk.pulse('tick')).toBe(true)
  })
})
