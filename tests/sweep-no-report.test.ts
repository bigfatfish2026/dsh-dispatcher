import { describe, expect, it } from 'vitest'
import { INTENT, flush, makeDesk } from './helpers/desk-harness'

/**
 * 「干完没交报告」不再等巡检：`subagent/end` 当场判，一轮的报告计数为 0 就
 * 发一条缺报告信号（autoReport 开着且鱼留了最后一句时，那句话自动当报告落票）。
 */

function recorder() {
  const noReport: Array<{ ticketId: string; stopReason: string }> = []
  return {
    noReport,
    notifier: {
      async idle() {
        return true
      },
      async reportArrived() {
        return true
      },
      async noReport(input: { ticketId: string; stopReason: string }) {
        noReport.push({ ticketId: input.ticketId, stopReason: input.stopReason })
        return true
      },
    },
  }
}

describe('一轮干完没交报告', () => {
  it('当场推一条缺报告信号，只推一次', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier, config: { autoReport: false } })
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()

    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()

    expect(rec.noReport).toEqual([{ ticketId: id, stopReason: 'completed' }])
    expect(h.desk.get(id)!.status).toBe('waiting')
  })

  it('autoReport 开着且鱼留了最后一句：自动补成一条报告，不推缺报告信号', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier, config: { autoReport: true } })
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()

    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed', lastAssistantMessage: '干完了，测试全绿' })
    await flush()

    expect(rec.noReport).toHaveLength(0)
    expect(h.desk.get(id)!.pendingReports).toBe(1)
  })

  it('这一轮已经交过报告：不补、不推', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier, config: { autoReport: false } })
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.report(id, '交付清单')
    h.desk.attach()

    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()

    expect(rec.noReport).toHaveLength(0)
    expect(h.desk.get(id)!.pendingReports).toBe(1)
  })

  it('noReportSignal 关掉就彻底安静', async () => {
    const rec = recorder()
    const h = makeDesk({ notifier: rec.notifier, config: { autoReport: false, noReportSignal: false } })
    await h.desk.open(INTENT, h.main)
    h.desk.attach()

    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()

    expect(rec.noReport).toHaveLength(0)
  })
})
