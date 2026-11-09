/**
 * `internal/service` 监听（方案 a）：schedule 就绪就重挂规则，不等下一拍巡检。
 *
 * 四条：
 *   · 就绪事件一到就注册规则、切 tick，不用等 desk 的下一拍；
 *   · reconcile 抛错被监听器吞掉，只 warn 不 rethrow（这条最要紧：events 的
 *     emit 不兜错，冒出去会弄挂 timer 的 apply）；
 *   · 销毁再就绪（热重载）能重挂回来；
 *   · serviceEventSeen 为假时 watchdog 收成 10 分钟档，顺手查规则还在不在。
 */
import { describe, expect, it } from 'vitest'
import { attachServiceWatch, createSweepDriver } from '../src/tickets/sweep-driver'
import type { SweepEventsService, SweepScheduleService } from '../src/tickets/sweep-driver'
import { flush, makeDesk } from './helpers/desk-harness'
import { fakeEvents, fakeSchedule } from './helpers/sweep-services'

const TICK = {
  name: 'dispatcher.sweep.tick',
  firedAt: '2026-11-09T12:00:10.000Z',
  periodKey: 'dispatcher.sweep.every10s.1762690000',
}

/** 假 `ctx.on`：记监听器、能派发、能摘。 */
function fakeOn() {
  const entries: Array<{ event: string; listener: (name: string, value: unknown) => void; off: boolean }> = []
  return {
    entries,
    on(event: string, listener: (name: string, value: unknown) => void): () => void {
      const entry = { event, listener, off: false }
      entries.push(entry)
      return () => {
        entry.off = true
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
    },
    emit(event: string, name: string, value?: unknown) {
      for (const entry of [...entries]) {
        if (!entry.off && entry.event === event) entry.listener(name, value)
      }
    },
    count: (event: string) => entries.filter((entry) => entry.event === event).length,
  }
}

/**
 * driver + 假服务 + 记间隔的假时钟。
 *
 * `ctx` 不挂监听时（`watch: false`）serviceEventSeen 那套不该影响 watchdog。
 */
function setup(options: { every?: number; schedule?: boolean; watch?: boolean } = {}) {
  const every = options.every ?? 10_000
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
    schedule: options.schedule === false ? undefined : schedule.service,
  }
  const intervalMs: number[] = []
  const clock = {
    ...h.clock,
    setInterval: (callback: () => void, ms: number) => {
      intervalMs.push(ms)
      return h.clock.setInterval(callback, ms)
    },
  }
  const infos: string[] = []
  const driver = createSweepDriver({
    desk: h.desk,
    events: () => refs.events,
    schedule: () => refs.schedule,
    every,
    clock,
    info: (message) => infos.push(message),
    warn: (message) => h.warnings.push(message),
  })
  const ctx = fakeOn()
  const off = options.watch === false ? undefined : attachServiceWatch(ctx.on, driver, { warn: (message) => h.warnings.push(message) })
  h.desk.onPulse(() => driver.reconcile())
  driver.reconcile()
  return { h, events, schedule, refs, infos, driver, ctx, off, calls: () => calls, intervalMs }
}

describe('sweep 由 internal/service 事件驱动', () => {
  it('schedule 就绪事件一到就重挂规则、切 tick，不等下一拍巡检', () => {
    const { schedule, refs, driver, ctx } = setup({ schedule: false })
    expect(schedule.registerCalls).toBe(0)
    expect(driver.mode()).toBe('interval')

    refs.schedule = schedule.service
    ctx.emit('internal/service', 'schedule', schedule.service)

    expect(schedule.rules.has('dispatcher.sweep')).toBe(true)
    expect(schedule.registerCalls).toBe(1)
    expect(schedule.rules.get('dispatcher.sweep')).toEqual({
      id: 'dispatcher.sweep',
      every: 10_000,
      topic: 'dispatcher.sweep.tick',
      catchUp: 'skip',
    })
    expect(driver.mode()).toBe('tick')
    expect(driver.status().registered).toBe(true)
    expect(driver.status().serviceEventSeen).toBe(true)
  })

  it('监听器里 reconcile 抛错：被吞掉、只 warn，不 rethrow', () => {
    const ctx = fakeOn()
    const warns: string[] = []
    const driver = {
      noteServiceEvent: () => true,
      reconcile() {
        throw new Error('boom from reconcile')
      },
    }
    attachServiceWatch(ctx.on, driver, { warn: (message) => warns.push(message) })

    // 宿主 emit 不兜错：这里 rethrow 就等价于把 timer 的 apply 弄挂。
    expect(() => ctx.emit('internal/service', 'schedule', {})).not.toThrow()
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('boom from reconcile')
    expect(warns[0]).toContain('internal/service')
  })

  it('别的服务事件不碰 driver；摘监听后不再响应', () => {
    const ctx = fakeOn()
    const calls: unknown[][] = []
    const driver = {
      noteServiceEvent(name: string, value: unknown) {
        calls.push(['note', name, value])
        return name === 'schedule' && Boolean(value)
      },
      reconcile() {
        calls.push(['reconcile'])
      },
    }
    const off = attachServiceWatch(ctx.on, driver, { warn: () => {} })
    ctx.emit('internal/service', 'events', {})
    expect(calls).toEqual([])
    ctx.emit('internal/service', 'schedule', undefined)
    expect(calls).toEqual([['note', 'schedule', undefined]])
    off()
    expect(ctx.count('internal/service')).toBe(0)
    ctx.emit('internal/service', 'schedule', {})
    expect(calls).toEqual([['note', 'schedule', undefined]])
  })

  it('schedule 销毁再就绪（热重载）：规则在新实例上重挂回来', () => {
    const { schedule, refs, driver, ctx } = setup()
    expect(schedule.rules.has('dispatcher.sweep')).toBe(true)

    // 旧实例销毁：只清缓存标记，别起自己的定时器（服务马上再来，纯噪音）。
    ctx.emit('internal/service', 'schedule', undefined)
    expect(driver.status().registered).toBe(false)
    expect(driver.mode()).toBe('tick')

    const second = fakeSchedule()
    refs.schedule = second.service
    ctx.emit('internal/service', 'schedule', second.service)
    expect(second.rules.has('dispatcher.sweep')).toBe(true)
    expect(second.registerCalls).toBe(1)
    expect(driver.status().registered).toBe(true)
  })

  it('serviceEventSeen 为假：watchdog 收成 10 分钟档，并顺手把丢掉的规则重挂', async () => {
    // 巡检周期拉长到 20 分钟：慢档 watchdog 是 every（20 分钟）、3 拍判死 1 小时；
    // 快档该收成 10 分钟，这里才看得出差别。
    const { h, schedule, driver, intervalMs } = setup({ every: 20 * 60_000 })
    expect(driver.mode()).toBe('tick')
    expect(driver.status().watchAttached).toBe(true)
    expect(driver.status().serviceEventSeen).toBe(false)
    expect(intervalMs.at(-1)).toBe(10 * 60_000)

    // 规则被撤（服务没换实例）：下一次睁眼要补上，而不是当场判死。
    schedule.rules.delete('dispatcher.sweep')
    h.clock.advance(10 * 60_000)
    await flush()
    expect(schedule.rules.has('dispatcher.sweep')).toBe(true)
    expect(driver.status().registered).toBe(true)
    expect(driver.mode()).toBe('tick')

    // 再一个 10 分钟仍没 tick：判死、退回自己的定时器。没挂监听的老测试
    // 还是 3 拍判死，这条只覆盖「监听挂了但事件没来」。
    h.clock.advance(10 * 60_000)
    await flush()
    expect(driver.mode()).toBe('interval')
    expect(h.warnings.some((message) => message.includes('断流'))).toBe(true)
  })

  it('收到过 service 事件：watchdog 回慢档，3 个周期才判死', () => {
    const { h, schedule, driver, intervalMs } = setup({ every: 20 * 60_000 })
    // 直接派一条就绪：标记翻真，watchdog 重起成慢档。
    ;(driver as unknown as { noteServiceEvent: (name: string, value: unknown) => boolean }).noteServiceEvent(
      'schedule',
      schedule.service,
    )
    expect(driver.status().serviceEventSeen).toBe(true)
    expect(intervalMs.at(-1)).toBe(20 * 60_000)
    h.clock.advance(2 * 20 * 60_000)
    expect(driver.mode()).toBe('tick')
    h.clock.advance(20 * 60_000)
    expect(driver.mode()).toBe('interval')
  })
})

describe('真 Cordis 4 的事件派发（实测口径）', () => {
  it('插件 fiber 上的 ctx.on 能收到同 root 同 isolate 的 internal/service，不需要 global', async () => {
    // 装载完成（apply 跑完）后提供 schedule：监听器必须已经挂上。
    const { Context } = (await import('@deepseek-ai/cordis')) as unknown as {
      Context: new () => {
        plugin(plugin: { name: string; apply(ctx: any): void }): Promise<unknown>
        provide(name: string, value: unknown): () => void
        on(event: string, listener: (...args: any[]) => void, options?: { global?: boolean }): () => void
      }
    }
    const root = new Context()
    const seen: string[] = []
    await root.plugin({
      name: 'probe',
      apply(ctx) {
        attachServiceWatch(
          (event, listener) => ctx.on(event, listener),
          {
            noteServiceEvent(name: string, value: unknown) {
              seen.push(`${name}:${value === undefined ? 'gone' : 'ready'}`)
              return name === 'schedule' && Boolean(value)
            },
            reconcile() {
              seen.push('reconcile')
            },
          },
          { warn: () => {} },
        )
      },
    })
    const dispose = root.provide('schedule', fakeSchedule().service)
    expect(seen).toEqual(['schedule:ready', 'reconcile'])
    dispose()
    expect(seen).toEqual(['schedule:ready', 'reconcile', 'schedule:gone'])
  })
})
