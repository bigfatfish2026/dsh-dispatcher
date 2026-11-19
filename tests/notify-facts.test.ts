import { describe, expect, it } from 'vitest'
import { fakeClock } from '../src/tickets/clock'
import { SWEEP_PREFIX, createNotifier } from '../src/tickets/notify'
import { SWEEP_HEADER, createSweepFacts } from '../src/tickets/sweep-facts'

/**
 * 巡检提醒的分工：报告到达、跑太久、干完没交报告只记事实，给主会话下一轮当
 * 环境状态看；票停在 waiting 没人接（满阈值）和「等使用方决定」才真的叫醒人。
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

  it('跑太久只记事实', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.idle({ ticketId: 't-run', brief: '跑太久', reason: 'running-90m', sinceMinutes: 90 })

    expect(wakes).toHaveLength(0)
    expect(facts.text()).toContain('t-run')
    expect(facts.text()).toContain('还没停')
  })

  it('waiting 满阈值改走 followup：叫醒一句，事实表一条不记', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.idle({ ticketId: 't-wait', brief: '等收工', reason: 'waiting-12m', sinceMinutes: 12 })

    // 走的是 send/followup，不是 facts.remember。
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.startsWith(SWEEP_PREFIX)).toBe(true)
    expect(wakes[0]).toContain('t-wait')
    expect(wakes[0]).toContain('等收工')
    expect(wakes[0]).toContain('12 分钟')
    expect(wakes[0]).toContain('巡检')
    expect(wakes[0]).toContain('不是使用方在说话')
    expect(wakes[0]).toContain('dispatch_read t-wait')
    expect(wakes[0]).toContain('dispatch_close t-wait')
    expect(facts.text()).toBe('')
    expect(facts.size()).toBe(0)
  })

  it('干完没交报告也只记事实', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.noReport({ ticketId: 't-quiet', brief: '没报告', epoch: 1, stopReason: 'completed' })

    expect(wakes).toHaveLength(0)
    expect(facts.text()).toContain('t-quiet')
    expect(facts.text()).toContain('一份报告也没交')
  })

  it('快照文本是陈述句，不带工具名也不冒充使用方', async () => {
    const { facts, notifier } = setup()
    await notifier.reportArrived({ ticketId: 't-abc', brief: '改巡检', epoch: 1, pendingReports: 1 })

    const text = facts.text()
    expect(text.startsWith(SWEEP_HEADER)).toBe(true)
    expect(text).toContain('不是使用方在说话')
    expect(text).not.toContain('dispatch_read')
    expect(text).not.toContain('dispatch_close')
  })
})

describe('只有等使用方决定才叫醒', () => {
  it('blocked 超阈值仍会 followup，并且说清不是使用方', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.idle({ ticketId: 't-stuck', brief: '卡住了', reason: 'blocked-60m', sinceMinutes: 61 })

    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.startsWith(SWEEP_PREFIX)).toBe(true)
    expect(wakes[0]).toContain('不是使用方在说话')
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

describe('冲突排队：事实一条，叫醒只有 queued 那一句', () => {
  it('blocked：事实里写清对手 id + brief + 路径，一句话都不 wake', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.blocked({
      ticketId: 't-wait',
      brief: '抢目录',
      waitOn: [{ ticketId: 't-block', brief: '占住目录', resources: ['dir:/a/b'] }],
    })

    expect(facts.text()).toContain('票 t-wait 因 dir:/a/b 与 t-block「占住目录」 冲突挂起')
    expect(wakes).toHaveLength(0)
  })

  it('人工挂起：只记事实', async () => {
    const { facts, wakes, notifier } = setup()

    await notifier.blocked({ ticketId: 't-manual', brief: '等拍板', reason: '等使用方拍板' })

    expect(facts.text()).toContain('等使用方拍板')
    expect(wakes).toHaveLength(0)
  })

  it('queued：进排队那刻推一句，指名开票方，带票号/标题/对手/资源/三个入口', async () => {
    const facts = createSweepFacts({ clock: fakeClock() })
    const calls: { text: string; to?: string }[] = []
    const notifier = createNotifier({
      facts,
      wake: (text, to) => {
        calls.push({ text, to })
        return true
      },
    })

    await notifier.queued!({
      ticketId: 't-wait',
      brief: '抢目录',
      publisher: 'session-main',
      waitOn: [{ ticketId: 't-block', brief: '占住目录', resources: ['dir:/a/b'] }],
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toBe('session-main')
    const text = calls[0]!.text
    expect(text.startsWith(SWEEP_PREFIX)).toBe(true)
    expect(text).toContain('t-wait「抢目录」')
    expect(text).toContain('t-block「占住目录」')
    expect(text).toContain('dir:/a/b')
    expect(text).toContain('自动放行')
    expect(text).toContain('dispatch_list')
    expect(text).toContain('dispatch_send t-wait')
    expect(text).toContain('dispatch_close t-wait')
    expect(text).toContain('不是使用方在说话')
    // 叫醒不写事实：排队事实由 blocked 那条负责，同一件事不说两遍。
    expect(facts.text()).toBe('')
  })

  it('resumed：只摘挂起事实，不再推第二句', async () => {
    const { facts, wakes, notifier } = setup()
    await notifier.blocked({
      ticketId: 't-wait',
      brief: '抢目录',
      waitOn: [{ ticketId: 't-block', brief: '占住目录', resources: ['dir:/a/b'] }],
    })
    expect(facts.size()).toBe(1)

    await notifier.resumed('t-wait')

    expect(facts.text()).toBe('')
    expect(wakes).toHaveLength(0)
  })
})

describe('文本稳定，缓存不抖', () => {
  it('同一批提醒连续渲染两次一字不差，同一个五分钟窗口里也不动', async () => {
    const { clock, facts, notifier } = setup()
    await notifier.idle({ ticketId: 't-run', brief: '跑太久', reason: 'running-90m', sinceMinutes: 90 })

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
    await notifier.idle({ ticketId: 't-abc', brief: '改巡检', reason: 'running-90m', sinceMinutes: 90 })
    expect(facts.size()).toBe(2)

    facts.forget('t-abc', ['report'])
    expect(facts.text()).not.toContain('还没读')
    expect(facts.text()).toContain('还没停')

    facts.forget('t-abc')
    expect(facts.text()).toBe('')
    expect(facts.size()).toBe(0)
  })
})
