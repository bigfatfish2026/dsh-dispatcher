/**
 * 报告聚合提醒：窗口内「交完活、变 waiting、报告还没被主会话读过」的票攒成一条。
 *
 * 走真票台、真 notifier（假 wake 记账）、假时钟：票和报告的 `delivered` 都是
 * `dispatch_read` / `subagent/end` 真跑出来的，聚合组件只读不写。
 *
 * 断言按「张票交完活在 waiting」这句筛，票台自己的单票提醒（reportArrived 那条
 * 「交了 N 条报告，还没读」）不算进聚合计数。
 */
import { describe, expect, it } from 'vitest'
import { createNotifier } from '../src/tickets/notify'
import { createReportDigest } from '../src/tickets/report-digest'
import { flush, makeDesk } from './helpers/desk-harness'
import type { Harness } from './helpers/desk-harness'

const NOW = new Date('2026-11-19T10:00:00.000Z')
const WINDOW = 120

/** 台子：真票台 + 真 notifier（假 wake），聚合提醒走 notify.reportDigest。 */
function rig(seconds = WINDOW, maxLines?: number) {
  const h = makeDesk({ now: NOW, config: { defaultPreset: 't1', sweepMs: 0, autoReport: false } })
  // 先挂宿主订阅：`subagent/end` 那条就是把票落 waiting 的手。sweepMs 0 → 不起定时器。
  h.desk.attach()
  const wakes: string[] = []
  const notifier = createNotifier({
    wake: (text) => {
      wakes.push(text)
      return true
    },
  })
  const digest = createReportDigest({
    tickets: () => h.log.list(),
    clock: h.clock,
    seconds,
    briefMaxColumns: 34,
    send: (input) => notifier.reportDigest!(input),
    ...(maxLines === undefined ? {} : { maxLines }),
  })
  return {
    h,
    digest,
    wakes,
    /** 只看聚合那条：票台自己的单票提醒不算。 */
    digests: () => wakes.filter((text) => text.includes('张票交完活在 waiting')),
  }
}

/** 开票 → 交一条报告 → 子会话收工（票落 waiting）。 */
async function handOff(h: Harness, goal: string, report = '干完了'): Promise<string> {
  const { id } = await h.desk.open({ goal, brief: goal }, h.main)
  await h.desk.report(id, report)
  h.host.emit('subagent/end', { id: h.log.get(id)!.workerId!, stopReason: 'completed' })
  await flush()
  expect(h.log.get(id)!.status).toBe('waiting')
  return id
}

describe('报告聚合提醒', () => {
  it('窗口内两张票交活：只发一条，两个票号都在里面', async () => {
    const { h, digest, digests } = rig()
    const a = await handOff(h, '改配置')
    const b = await handOff(h, '跑测试')

    expect(await digest.tick()).toBe(true)

    const calls = digests()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(a)
    expect(calls[0]).toContain(b)
    expect(calls[0]).toContain('2 张票交完活在 waiting')
    expect(calls[0]).toContain('改配置')
    expect(calls[0]).toContain('干完了')
  })

  it('单张票：只发一条，票号、标题、摘要、入口都在', async () => {
    const { h, digest, digests } = rig()
    const id = await handOff(h, '修一个 bug', '根因在 store 折行')

    expect(await digest.tick()).toBe(true)

    const calls = digests()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(id)
    expect(calls[0]).toContain('1 张票交完活在 waiting')
    expect(calls[0]).toContain('根因在 store 折行')
    expect(calls[0]).toContain('dispatch_read')
    expect(calls[0]).toContain('不是使用方在说话')
  })

  it('没有待提醒的票：一条都不发，别定时刷「暂无」', async () => {
    const { h, digest, digests } = rig()

    expect(await digest.tick()).toBe(false)
    expect(digests()).toHaveLength(0)

    // 票在跑、还没交活：也不提醒。
    await h.desk.open({ goal: '还在干', brief: '还在干' }, h.main)
    h.clock.advance(WINDOW * 1000)
    expect(await digest.tick()).toBe(false)
    expect(digests()).toHaveLength(0)
  })

  it('0 或负数关闭：窗口再久也不发', async () => {
    for (const seconds of [0, -5]) {
      const { h, digest, digests } = rig(seconds)
      await handOff(h, '关掉了')
      h.clock.advance(WINDOW * 1000)

      expect(await digest.tick()).toBe(false)
      expect(digests()).toHaveLength(0)
    }
  })

  it('同一批不重复发：报告没读也不追着催', async () => {
    const { h, digest, digests } = rig()
    const id = await handOff(h, '交完就走')

    expect(await digest.tick()).toBe(true)
    h.clock.advance(WINDOW * 1000)
    expect(await digest.tick()).toBe(false)
    h.clock.advance(WINDOW * 1000)
    expect(await digest.tick()).toBe(false)

    expect(digests()).toHaveLength(1)
    expect(digests()[0]).toContain(id)
  })

  it('同一张票再交新报告：还能再提醒一次', async () => {
    const { h, digest, digests } = rig()
    const id = await handOff(h, '有两轮')

    expect(await digest.tick()).toBe(true)
    h.clock.advance(WINDOW * 1000)
    await h.desk.report(id, '第二轮：补完了')
    expect(await digest.tick()).toBe(true)

    const calls = digests()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain(id)
    expect(calls[1]).toContain('第二轮：补完了')
    expect(calls[1]).toContain('2 条报告')
  })

  it('报告被 dispatch_read 读过：不再提醒', async () => {
    const { h, digest, digests } = rig()
    const id = await handOff(h, '读过了')

    await h.desk.read(id)
    h.clock.advance(WINDOW * 1000)
    expect(await digest.tick()).toBe(false)
    expect(digests()).toHaveLength(0)
  })

  it('超过上限只列 5 张，其余写「还有 N 张」', async () => {
    const { h, digest, digests } = rig()
    const ids: string[] = []
    for (let i = 0; i < 6; i += 1) ids.push(await handOff(h, `第 ${i + 1} 张`))

    expect(await digest.tick()).toBe(true)

    const calls = digests()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('6 张票交完活在 waiting')
    expect(calls[0]).toContain('还有 1 张')
    for (const id of ids.slice(0, 5)) expect(calls[0]).toContain(id)
    expect(calls[0]).not.toContain(ids[5]!)
  })
})
