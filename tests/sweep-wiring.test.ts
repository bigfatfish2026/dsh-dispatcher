/**
 * apply 里的巡检接线：服务从 `ctx.get` 探，接不上的每一路都留一行日志。
 *
 * 这里只测「接线对不对」——拍子节奏和降级后的行为在 `sweep-driver.test.ts`
 * 用假时钟测，不在这儿真等 10 秒。
 */
import { describe, expect, it } from 'vitest'
import { sweepDriverSlot } from '../src/index'
import { mountPlugin } from './helpers/plugin-harness'
import { fakeEvents, fakeSchedule } from './helpers/sweep-services'

describe('sweep 驱动源的装配', () => {
  it('events 和 schedule 都在：注册规则、订阅 tick，日志说清谁在驱动', () => {
    const events = fakeEvents()
    const schedule = fakeSchedule(events)
    const host = mountPlugin({
      config: { sweepMs: 10_000 },
      services: { events: events.service, schedule: schedule.service },
    })
    try {
      expect(schedule.rules.get('dispatcher.sweep')).toMatchObject({
        every: 10_000,
        topic: 'dispatcher.sweep.tick',
        catchUp: 'skip',
      })
      expect(events.subscriptions.map((sub) => sub.pattern)).toEqual(['dispatcher.sweep.tick'])
      const log = host.infos.join('\n')
      expect(log).toContain('已订阅 dispatcher.sweep.tick')
      expect(log).toContain('由 dispatcher.sweep.tick 驱动')
      expect(sweepDriverSlot.get(host.ctx)?.mode()).toBe('tick')
    } finally {
      host.dispose()
    }
  })

  it('schedule 晚到：先用自己的定时器，服务出现后下一次探测切过去', () => {
    const events = fakeEvents()
    const schedule = fakeSchedule(events)
    const host = mountPlugin({
      config: { sweepMs: 10_000 },
      services: { events: events.service },
    })
    try {
      expect(host.warnings.join('\n')).toContain('没有 schedule 服务')
      const driver = sweepDriverSlot.get(host.ctx)!
      expect(driver.mode()).toBe('interval')

      host.services.schedule = schedule.service
      driver.reconcile()
      expect(driver.mode()).toBe('tick')
      expect(schedule.registerCalls).toBe(1)
      expect(schedule.rules.has('dispatcher.sweep')).toBe(true)
    } finally {
      host.dispose()
    }
  })

  it('sweepMs 0：巡检整体关掉，不注册也不订阅', () => {
    const events = fakeEvents()
    const schedule = fakeSchedule(events)
    const host = mountPlugin({
      config: { sweepMs: 0 },
      services: { events: events.service, schedule: schedule.service },
    })
    try {
      expect(events.subscribeCalls).toBe(0)
      expect(schedule.registerCalls).toBe(0)
    } finally {
      host.dispose()
    }
  })
})
