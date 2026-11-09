/**
 * realClock 的定时器句柄：巡检拍子必须 unref，不能单独把宿主钉住。
 * 假时钟（fakeClock）走另一条路，不受影响。
 */
import { describe, expect, it } from 'vitest'
import { realClock } from '../src/tickets/clock'

describe('realClock', () => {
  it('setInterval 返回的句柄已经 unref，hasRef() 为 false', () => {
    const handle = realClock.setInterval(() => {}, 60_000) as { hasRef(): boolean }
    try {
      expect(handle.hasRef()).toBe(false)
    } finally {
      realClock.clearInterval(handle)
    }
  })
})
