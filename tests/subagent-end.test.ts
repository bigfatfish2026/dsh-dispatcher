import { describe, expect, it } from 'vitest'
import { INTENT, flush, makeDesk } from './helpers/desk-harness'

/**
 * `subagent/end` 是「这条鱼没了」唯一的信号。规矩很窄：命中 workerId 的未结
 * 票落 `waiting`，别的什么都不改——done/dropped 是主会话的判决，鱼自己说了不算。
 */

function end(h: ReturnType<typeof makeDesk>, id: string, stopReason = 'completed'): void {
  h.host.emit('subagent/end', { id, stopReason })
}

describe('subagent/end 落票', () => {
  it('running 的票落 waiting，绝不自己判 done', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()

    end(h, 'worker-1')
    await flush()

    const view = h.desk.get(id)!
    expect(view.status).toBe('waiting')
    expect(view.workerAlive).toBe(false)
  })

  it('session- 前缀两边都认', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()

    end(h, 'session-worker-1')
    await flush()
    expect(h.desk.get(id)!.status).toBe('waiting')
  })

  it('不碰别人的票、不碰已经收工的票', async () => {
    const h = makeDesk()
    const mine = await h.desk.open(INTENT, h.main)
    const other = await h.desk.open({ ...INTENT, goal: '另一件', brief: '另一件', requestId: 'req-2' }, h.main)
    await h.desk.close(other.id, { outcome: 'done', actor: h.main })
    h.desk.attach()

    // 第二张票的 worker 是 worker-2；这里只结束 worker-1。
    end(h, 'worker-1')
    await flush()

    expect(h.desk.get(mine.id)!.status).toBe('waiting')
    expect(h.desk.get(other.id)!.status).toBe('done')
  })

  it('一个 worker 名下多张票就一起落', async () => {
    const h = makeDesk()
    const a = await h.desk.open(INTENT, h.main)
    const b = await h.desk.open({ ...INTENT, goal: '第二件', brief: '第二件', requestId: 'req-2' }, h.main)
    // 把第二张也挂到同一个 worker 上：直接发事件，看它认不认票上的 workerId。
    h.desk.attach()

    end(h, 'worker-1')
    await flush()
    expect(h.desk.get(a.id)!.status).toBe('waiting')
    // b 的 worker 是 worker-2，不该被 worker-1 的结束带走。
    expect(h.desk.get(b.id)!.status).toBe('running')
  })

  it('缺 id、未知 id 都是静默，不写任何事件', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()
    const lines = h.lines()

    h.host.emit('subagent/end', { stopReason: 'completed' })
    end(h, 'worker-nope')
    await flush()

    expect(h.lines()).toBe(lines)
    expect(h.desk.get(id)!.status).toBe('running')
  })
})

describe('结束时的证据', () => {
  it('票上有报告就留着，等主会话自己读', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.report(id, '做到一半，卡在权限上')
    h.desk.attach()

    end(h, 'worker-1')
    await flush()

    const view = h.desk.get(id)!
    expect(view.status).toBe('waiting')
    expect(view.pendingReports).toBe(1)
  })

  it('鱼带着错误死：票照样落 waiting，报告里留下它最后的话', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.report(id, '最后一句：编译挂了')
    h.desk.attach()

    end(h, 'worker-1', 'error')
    await flush()

    expect(h.desk.get(id)!.status).toBe('waiting')
    expect(h.desk.get(id)!.pendingReports).toBe(1)
  })

  it('同一轮只落一次：重复的 end 事件不改票', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()

    end(h, 'worker-1')
    await flush()
    const since = h.desk.get(id)!.statusSince
    end(h, 'worker-1')
    await flush()

    // 第二条 ended 事实无害：状态和那一轮的时间戳都不再动。
    expect(h.desk.get(id)!.status).toBe('waiting')
    expect(h.desk.get(id)!.statusSince).toBe(since)
  })
})

describe('workerId 不做 hex 片段猜测', () => {
  it('不同 worker 不串票', async () => {
    const h = makeDesk()
    const a = await h.desk.open(INTENT, h.main)
    h.desk.attach()

    end(h, 'worker-2')
    await flush()
    expect(h.desk.get(a.id)!.status).toBe('running')
  })

  it('人话标签再像也不认：只认 workerId', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()

    end(h, '小鱼甲')
    await flush()
    expect(h.desk.get(id)!.status).toBe('running')
  })
})
