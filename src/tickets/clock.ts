/**
 * 时间与定时器的手把：票台所有「现在几点」「多久之后提醒」都从这里拿。
 *
 * 单独一层是因为巡检那套判断（20 分钟没动、60 分钟挂着、5 分钟扫一遍）必须
 * 能在测试里一秒跑完。测试塞一个假表进来，`advance(21)` 就到了 20 分钟之后，
 * 不用真等，也没有 flaky 的边界。
 */
import { hostname } from 'node:os'

export interface Clock {
  now(): Date
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const realClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

/**
 * 这台机器叫什么：写进 `device`，多台机器共用一个状态目录时才分得清谁派的活。
 * 只取 hostname，不带端口——票是「哪台板子上的」，不是「哪个进程」。
 */
export function hostDevice(): string {
  return hostname()
}

/** 假表：只给测试用。每次 `advance` 都把到期的一次性定时器跑掉，并按间隔推进。 */
export interface FakeClock extends Clock {
  advance(ms: number): void
  pendingTimers(): number
}

export function fakeClock(start: Date = new Date('2026-11-04T08:00:00.000Z')): FakeClock {
  let current = start.getTime()
  let seq = 0
  interface Timer {
    id: number
    due: number
    every?: number
    callback: () => void
  }
  const timers = new Map<number, Timer>()

  function runDue(): void {
    for (;;) {
      const due = [...timers.values()]
        .filter((timer) => timer.due <= current)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0]
      if (!due) return
      if (due.every === undefined) timers.delete(due.id)
      else due.due = current + due.every
      due.callback()
    }
  }

  return {
    now: () => new Date(current),
    setTimeout(callback, ms) {
      seq += 1
      timers.set(seq, { id: seq, due: current + Math.max(0, ms), callback })
      return seq
    },
    clearTimeout(handle) {
      timers.delete(handle as number)
    },
    setInterval(callback, ms) {
      seq += 1
      timers.set(seq, {
        id: seq,
        due: current + Math.max(1, ms),
        every: Math.max(1, ms),
        callback,
      })
      return seq
    },
    clearInterval(handle) {
      timers.delete(handle as number)
    },
    advance(ms) {
      const target = current + Math.max(0, ms)
      // 一步步走到 target：间隔定时器要按次数触发，不能一次跳过去只跑一回。
      for (;;) {
        const next = [...timers.values()]
          .filter((timer) => timer.due <= target)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0]
        if (!next) break
        current = next.due
        runDue()
      }
      current = target
    },
    pendingTimers: () => timers.size,
  }
}
