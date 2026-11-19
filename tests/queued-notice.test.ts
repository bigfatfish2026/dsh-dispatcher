/**
 * 冲突排队通知：只在票从非 `queued` 折成 `queued` 的那一刻给开票方发一条
 * followup；巡检每 10 秒重扫、releaseBlocked 重写 waitOn、自动放行都不再推。
 *
 * 走真 notifier（假 wake 记账 + 真事实表），只过滤「已进冲突排队」那一种文案，
 * 免得其它提醒混进计数。
 */
import { describe, expect, it } from 'vitest'
import { SWEEP_PREFIX, createNotifier } from '../src/tickets/notify'
import type { ProbePort, ProbeRegistry } from '../src/tickets/probe'
import { createSweepFacts } from '../src/tickets/sweep-facts'
import { MemoryBackend, flush, makeDesk } from './helpers/desk-harness'
import type { Harness } from './helpers/desk-harness'

const DIR = 'dir:/tmp/queued-notice'
const NOW = new Date('2026-11-19T09:00:00.000Z')

/** 探路窗口假件：desk 只拆不建，记账就够。 */
function fakeProbe(): ProbePort & ProbeRegistry {
  return {
    expect: () => undefined,
    drop: () => undefined,
    release: () => true,
    releaseTicket: () => true,
  }
}

/** 台子：真 notifier + 假 wake，记下每一句推给主会话的话。 */
function wired(backend?: MemoryBackend) {
  const facts = createSweepFacts()
  const wakes: { text: string; to?: string }[] = []
  const notifier = createNotifier({
    facts,
    wake: (text, to) => {
      wakes.push({ text, to })
      return true
    },
  })
  const h = makeDesk({
    now: NOW,
    ...(backend ? { backend } : {}),
    config: { defaultPreset: 't1', sweepMs: 0 },
    probe: fakeProbe(),
    notifier,
  })
  h.desk.attach()
  return { h, facts, wakes, queued: () => wakes.filter((entry) => entry.text.includes('已进冲突排队')) }
}

async function openProbe(h: Harness, goal: string, writes: string[], origin?: 'ego'): Promise<string> {
  const receipt = await h.desk.open({ goal, brief: goal, ...(origin ? { origin } : {}) }, h.main)
  const workerId = h.log.get(receipt.id)!.workerId!
  await h.desk.declare(workerId, { summary: goal }, { writes })
  return receipt.id
}

async function idle(h: Harness, worker: string): Promise<void> {
  h.host.emit('agent/status', { status: 'idle', agent: { id: worker } })
  await flush()
}

/** 开一张占住目录的执行票 + 一张撞上来的排队票（secondOrigin 可指定 ego 票）。 */
async function pair(secondOrigin?: 'ego') {
  const wiredDesk = wired()
  const { h } = wiredDesk
  const first = await openProbe(h, '占住目录', [DIR])
  await idle(h, 'worker-1')
  h.agents.markAlive(h.log.get(first)!.workerId!)
  const second = await openProbe(h, '抢目录', [DIR], secondOrigin)
  await idle(h, h.log.get(second)!.workerId!)
  expect(h.log.get(second)!.phase).toBe('queued')
  return { ...wiredDesk, first, second }
}

describe('queued 通知：进排队那一刻一条', () => {
  it('票号、标题、挡路的票与资源、自动放行和三个入口都在；指名开票方', async () => {
    const { h, facts, queued, second, first } = await pair()

    const calls = queued()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toBe('session-main')
    const text = calls[0]!.text
    expect(text.startsWith(SWEEP_PREFIX)).toBe(true)
    expect(text).toContain(`票 ${second}「抢目录」`)
    expect(text).toContain(`${first}「占住目录」`)
    expect(text).toContain(DIR)
    expect(text).toContain('自动放行')
    expect(text).toContain('dispatch_list')
    expect(text).toContain(`dispatch_send ${second}`)
    expect(text).toContain(`dispatch_close ${second}`)
    expect(text).toContain('不是使用方在说话')
    // 事实照旧记，runtime context 下一轮还能看见在等谁。
    expect(facts.text()).toContain(second)
    expect(h.log.get(second)!.phase).toBe('queued')
  })

  it('巡检连扫 3 拍不重复：同一张票只留一条', async () => {
    const { h, queued } = await pair()
    expect(queued()).toHaveLength(1)

    for (let beat = 0; beat < 3; beat += 1) {
      h.clock.advance(10_000)
      await h.desk.maintain()
    }

    expect(queued()).toHaveLength(1)
  })

  it('自动放行不发通知：放行后还是那一条，也没有「已放行」的话', async () => {
    const { h, facts, wakes, queued, first, second } = await pair()
    expect(queued()).toHaveLength(1)

    await h.desk.close(first)
    await flush()

    expect(h.log.get(second)!.phase).toBe('running')
    expect(queued()).toHaveLength(1)
    expect(wakes.some((entry) => entry.text.includes('已放行'))).toBe(false)
    // 挂起事实跟着放行撤掉，别一直挂着。
    expect(facts.text()).not.toContain(second)
  })

  it('离开排队后再次排进来：可以再发一条', async () => {
    const { h, queued, second } = await pair()
    expect(queued()).toHaveLength(1)

    // 重新声明会把 phase 从 queued 折回 planned（排队作废），下一拍再判又撞上。
    const workerId = h.log.get(second)!.workerId!
    await h.desk.declare(workerId, { summary: '再来一次' }, { writes: [DIR] })
    expect(h.log.get(second)!.phase).toBe('planned')

    await h.desk.maintain()
    expect(h.log.get(second)!.phase).toBe('queued')
    expect(queued()).toHaveLength(2)
  })

  it('origin=ego 的票进 queued 也发一条，连扫三拍不重复', async () => {
    const { h, queued, second } = await pair('ego')
    expect(h.log.get(second)!.origin).toBe('ego')
    expect(queued()).toHaveLength(1)

    for (let beat = 0; beat < 3; beat += 1) {
      h.clock.advance(10_000)
      await h.desk.maintain()
    }

    expect(queued()).toHaveLength(1)
  })
})

/**
 * 重启不补发：老日志里已经是 queued 的票，新进程第一拍巡检不会把它当成
 * 「刚进排队」。dedupe 靠的是 admit 只在 phase 非 queued 时落 conflict-checked
 * 这条结构，不另存内存表。
 */
describe('重启后不重复', () => {
  const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()

  function seed(id: string, minutesAgo: number): Array<Record<string, unknown>> {
    return [
      {
        kind: 'published',
        id,
        at: at(minutesAgo),
        goal: `活 ${id}`,
        brief: `活 ${id}`,
        publisher: 'session-main',
        preset: 't1',
        presetSource: 'fallback',
        requestId: `req-${id}`,
      },
      { kind: 'spawned', id, at: at(minutesAgo), cause: 'tool', workerId: `worker-${id}`, preset: 't1' },
      {
        kind: 'declared',
        id,
        at: at(minutesAgo),
        cause: 'tool',
        plan: { summary: `方案 ${id}` },
        intent: { writes: [DIR] },
        workerId: `worker-${id}`,
      },
    ]
  }

  it('日志里已经是 queued：巡检三拍一条都不发', async () => {
    const backend = new MemoryBackend()
    for (const event of [
      ...seed('t-block', 20),
      { kind: 'conflict-checked', id: 't-block', at: at(19), cause: 'reaction', level: 'none', waitOn: [] },
      ...seed('t-wait', 10),
      {
        kind: 'conflict-checked',
        id: 't-wait',
        at: at(9),
        cause: 'reaction',
        level: 'strong',
        waitOn: [{ ticketId: 't-block', resources: [DIR] }],
      },
    ]) {
      backend.append(event as never)
    }

    const { h, queued } = wired(backend)
    h.agents.markAlive('worker-t-block')
    expect(h.log.get('t-wait')!.phase).toBe('queued')

    for (let beat = 0; beat < 3; beat += 1) {
      h.clock.advance(10_000)
      await h.desk.maintain()
    }

    expect(h.log.get('t-wait')!.phase).toBe('queued')
    expect(queued()).toHaveLength(0)
  })
})
