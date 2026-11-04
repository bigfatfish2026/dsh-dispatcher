import { describe, expect, it } from 'vitest'
import { fakeClock } from '../src/tickets/clock'
import { SWEEP_PREFIX, createNotifier } from '../src/tickets/notify'
import { SWEEP_HEADER, createSweepFacts } from '../src/tickets/sweep-facts'

/**
 * 巡检提醒的新分工：三类（报告到达、干完没收工、干完没交报告）只记事实，
 * 给主会话下一轮当环境状态看；只有「等主人决定」才真的叫醒人。
 */

function setup() {
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
  return { clock, facts, wakes, notifier }
}

describe('巡检事实，不叫醒人', () => {
  it('报告到达只记事实：一次都不 followup，文本里是票号和「还没读」', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.reportArrived({ ticketId: 't-abc', brief: '改巡检', epoch: 1, pendingReports: 2 })

    expect(wakes).toHaveLength(0)
    expect(facts.text()).toContain('t-abc')
    expect(facts.text()).toContain('2 条报告，还没读')
  })

  it('干完没收工/跑太久也只记事实', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.idle({ ticketId: 't-wait', brief: '等收工', reason: 'waiting-20m', sinceMinutes: 20 })
    await notifier.idle({ ticketId: 't-run', brief: '跑太久', reason: 'running-90m', sinceMinutes: 90 })

    expect(wakes).toHaveLength(0)
    expect(facts.text()).toContain('t-wait')
    expect(facts.text()).toContain('t-run')
    expect(facts.text()).toContain('还没收工')
    expect(facts.text()).toContain('还没停')
  })

  it('干完没交报告也只记事实', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.noReport({ ticketId: 't-quiet', brief: '没报告', epoch: 1, stopReason: 'completed' })

    expect(wakes).toHaveLength(0)
    expect(facts.text()).toContain('t-quiet')
    expect(facts.text()).toContain('一份报告也没交')
  })

  it('快照文本是陈述句，不带工具名也不冒充主人', async () => {
    const { facts, notifier } = setup()
    await notifier.reportArrived({ ticketId: 't-abc', brief: '改巡检', epoch: 1, pendingReports: 1 })

    const text = facts.text()
    expect(text.startsWith(SWEEP_HEADER)).toBe(true)
    expect(text).toContain('不是主人在说话')
    expect(text).not.toContain('dispatch_read')
    expect(text).not.toContain('dispatch_close')
  })
})

describe('只有等主人决定才叫醒', () => {
  it('blocked 超阈值仍会 followup，并且说清不是主人', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.idle({ ticketId: 't-stuck', brief: '卡住了', reason: 'blocked-60m', sinceMinutes: 61 })

    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.startsWith(SWEEP_PREFIX)).toBe(true)
    expect(wakes[0]).toContain('不是主人在说话')
    expect(wakes[0]).toContain('t-stuck')
    // 叫醒的那条不进快照，免得同一件事说两遍。
    expect(facts.text()).toBe('')
  })

  it('宿主没有动态上下文时退回唤醒，同样带 [sweep] 前缀', async () => {
    const wakes: string[] = []
    const notifier = createNotifier({
      wake: (text) => {
        wakes.push(text)
        return true
      },
    })

    await notifier.reportArrived({ ticketId: 't-abc', brief: '改巡检', epoch: 1, pendingReports: 1 })

    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.startsWith(SWEEP_PREFIX)).toBe(true)
  })
})

describe('文本稳定，缓存不抖', () => {
  it('同一批提醒连续渲染两次一字不差，同一个五分钟窗口里也不动', async () => {
    const { clock, facts, notifier } = setup()
    await notifier.idle({ ticketId: 't-wait', brief: '等收工', reason: 'waiting-20m', sinceMinutes: 20 })

    const first = facts.text()
    expect(facts.text()).toBe(first)
    clock.advance(4 * 60_000)
    expect(facts.text()).toBe(first)
    // 跨过五分钟才换一档：这是唯一允许的变化。
    clock.advance(60_000)
    expect(facts.text()).not.toBe(first)
  })

  it('同一张票重复记不刷新时间，文本跟着不动', async () => {
    const { clock, facts, notifier } = setup()
    await notifier.reportArrived({ ticketId: 't-abc', brief: '改巡检', epoch: 1, pendingReports: 1 })
    const first = facts.text()

    clock.advance(30 * 60_000)
    await notifier.reportArrived({ ticketId: 't-abc', brief: '改巡检', epoch: 1, pendingReports: 1 })

    expect(facts.text()).toBe(first)
  })
})

describe('读过就撤', () => {
  it('forget 之后条目消失，全摘完文本为空', async () => {
    const { facts, notifier } = setup()
    await notifier.reportArrived({ ticketId: 't-abc', brief: '改巡检', epoch: 1, pendingReports: 1 })
    await notifier.idle({ ticketId: 't-abc', brief: '改巡检', reason: 'waiting-20m', sinceMinutes: 20 })
    expect(facts.size()).toBe(2)

    facts.forget('t-abc', ['report'])
    expect(facts.text()).not.toContain('还没读')
    expect(facts.text()).toContain('还没收工')

    facts.forget('t-abc')
    expect(facts.text()).toBe('')
    expect(facts.size()).toBe(0)
  })
})
