import { describe, expect, it } from 'vitest'
import { INTENT, flush, makeDesk } from './helpers/desk-harness'

/**
 * 巡检只发信号，不动票：不投报告、不清账、不重开。报告送达只有两条路——
 * 主会话自己 `dispatch_read`，或者鱼回来时 desk 当场投。收工票上的报告就静静
 * 躺着，等人按 id 去取。
 */

function recorder() {
  const calls = {
    idle: [] as Array<{ ticketId: string; reason: string }>,
    noReport: [] as string[],
    reportArrived: [] as string[],
  }
  return {
    calls,
    notifier: {
      async idle(input: { ticketId: string; reason: string }) {
        calls.idle.push({ ticketId: input.ticketId, reason: input.reason })
        return true
      },
      async noReport(input: { ticketId: string }) {
        calls.noReport.push(input.ticketId)
        return true
      },
      async reportArrived(input: { ticketId: string }) {
        calls.reportArrived.push(input.ticketId)
        return true
      },
    },
  }
}

describe('巡检不投报告', () => {
  it('未结票上的报告一直在队里，巡检也不替人读', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier })
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()
    await h.desk.report(id, '做到一半')
    expect(rec.calls.reportArrived).toEqual([id])
    h.clock.advance(31 * 60_000)

    await h.desk.maintain()

    expect(h.desk.get(id)!.pendingReports).toBe(1)
    // 报告到达那条提醒只在交报告时发一次，巡检不补发。
    expect(rec.calls.reportArrived).toEqual([id])
  })

  it('收工票上的报告原样留着，不惊动任何人', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier })
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()
    await h.desk.report(id, '交付清单')
    const arrived = rec.calls.reportArrived.length
    await h.desk.close(id, { outcome: 'done', actor: h.main })
    h.clock.advance(60 * 60_000)

    await h.desk.maintain()

    expect(h.desk.get(id)!.pendingReports).toBe(1)
    expect(rec.calls.reportArrived).toHaveLength(arrived)
  })

  it('巡检对 done 票零写入', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.close(id, { outcome: 'done', actor: h.main })
    const lines = h.lines()

    h.clock.advance(24 * 60 * 60_000)
    await h.desk.maintain()

    expect(h.lines()).toBe(lines)
    expect(h.desk.get(id)!.status).toBe('done')
  })
})

describe('只有僵尸票才叫人', () => {
  it('waiting 过 20 分钟推一条摘要，不带正文，同一轮只推一次', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier })
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.report(id, '正文不该出现在提醒里')
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()

    h.clock.advance(21 * 60_000)
    await h.desk.maintain()
    await h.desk.maintain()

    expect(rec.calls.idle).toEqual([{ ticketId: id, reason: 'waiting-20m' }])
    expect(h.desk.get(id)!.pendingReports).toBe(1)
  })

  it('blocked 过 60 分钟推一次 blocked-60m', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier })
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.block(id, '等主人拍板', h.main)

    h.clock.advance(61 * 60_000)
    await h.desk.maintain()
    await h.desk.maintain()

    expect(rec.calls.idle).toEqual([{ ticketId: id, reason: 'blocked-60m' }])
  })

  it('刚开的票不叫：时间没到就是没到', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier })
    await h.desk.open(INTENT, h.main)

    h.clock.advance(5 * 60_000)
    await h.desk.maintain()

    expect(rec.calls.idle).toHaveLength(0)
  })
})
