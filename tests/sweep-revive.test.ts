import { describe, expect, it } from 'vitest'
import { makeDesk } from './helpers/desk-harness'

/**
 * done 只进不出：收工之后再来的话不会把票翻回 open，也不会有「邮件重开」这条
 * 暗门。要接着干就开新票——旧票留着当账。
 */

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 3, 0, 0, seconds)).toISOString()

function closedDesk(status: 'done' | 'dropped', inputAt: string) {
  const h = makeDesk({ now: new Date('2026-11-03T00:10:00.000Z') })
  h.backend.append({
    id: 't-closed',
    kind: 'published',
    at: T(0),
    goal: '收尾的活',
    brief: '收尾的活',
    preset: 't1',
    presetSource: 'static',
  } as never)
  h.backend.append({
    id: 't-closed',
    kind: 'spawned',
    at: T(1),
    workerId: 'worker-1',
    preset: 't1',
  } as never)
  h.backend.append({ id: 't-closed', kind: 'closed', at: T(2), outcome: status, cause: 'tool' } as never)
  h.backend.append({ id: 't-closed', kind: 'queued', at: inputAt, cause: 'tool', input: { id: 'q-1', text: '晚了但还要做' } } as never)
  return h
}

describe('收工票不重开', () => {
  it('关票之后到的 input 不会把票翻回来，status 还是 done', async () => {
    const h = closedDesk('done', T(9))
    const lines = h.lines()
    await h.desk.maintain()
    expect(h.desk.get('t-closed')!.status).toBe('done')
    // 巡检对这张票零写入：连 input 都不碰，更不会重开。
    expect(h.lines()).toBe(lines)
  })

  it('巡检反复跑也不会把 done 翻回 open', async () => {
    const h = closedDesk('done', T(9))
    const lines = h.lines()
    h.clock.advance(24 * 60 * 60_000)
    await h.desk.maintain()
    await h.desk.maintain()
    expect(h.lines()).toBe(lines)
    expect(h.desk.get('t-closed')!.status).toBe('done')
  })

  it('dropped 更不会：人按下的停止没有回头路', async () => {
    const h = closedDesk('dropped', T(9))
    await h.desk.maintain()
    expect(h.desk.get('t-closed')!.status).toBe('dropped')
  })
})
