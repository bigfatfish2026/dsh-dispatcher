import { describe, expect, it } from 'vitest'
import { fakeAgents, flush, INTENT, makeDesk } from './helpers/desk-harness'

async function opened(options: Parameters<typeof makeDesk>[0] = {}) {
  const h = makeDesk(options)
  const receipt = await h.desk.open(INTENT, h.main)
  return { h, id: receipt.id }
}

describe('报告', () => {
  it('只追加，不动状态；报告正文不进提醒', async () => {
    const { h, id } = await opened()
    const receipt = await h.desk.report(id, '干完了，PR 提了')
    expect(receipt).toMatchObject({ id, epoch: 1, pendingReports: 1 })
    expect(h.log.get(id)!.status).toBe('running')
    expect(h.log.get(id)!.epochReports).toBe(1)
    const reminder = h.bus.find((entry) => entry.channel === 'dispatcher/report-arrived')
    expect(reminder).toBeDefined()
    expect(JSON.stringify(reminder!.payload)).not.toContain('PR 提了')
  })

  it('报告为空：拒绝，不写日志', async () => {
    const { h, id } = await opened()
    const before = h.lines()
    await expect(h.desk.report(id, '   ')).rejects.toThrow(/report/)
    expect(h.lines()).toBe(before)
  })
})

describe('end / idle', () => {
  it('subagent/end：落 waiting、workerAlive=false，报告数冻结在那一刻', async () => {
    const { h, id } = await opened()
    h.desk.attach()
    await h.desk.report(id, '交了')
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('waiting')
    expect(ticket.workerAlive).toBe(false)
    expect(ticket.epochReports).toBe(1)
    // 交过报告就不许补自动报告。
    expect(h.backend.kinds().filter((kind) => kind === 'reported')).toHaveLength(1)
    expect(h.desk.get(id)!.ageMinutes).toBe(0)
  })

  it('end 时这一轮一条报告都没有：拿最后一条输出补一条 auto 报告', async () => {
    const { h, id } = await opened()
    h.desk.attach()
    h.host.emit('subagent/end', {
      id: 'worker-1',
      stopReason: 'end',
      lastAssistantMessage: '我把票台拆了，测试全绿。',
    })
    await flush()
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('waiting')
    expect(ticket.epochReports).toBe(1)
    const reported = h.backend.events_.filter((event) => (event as { kind?: string }).kind === 'reported')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ source: 'auto', report: { text: '我把票台拆了，测试全绿。' } })
    expect(h.bus.some((entry) => entry.channel === 'dispatcher/ticket-no-report')).toBe(false)
  })

  it('没交报告也没有最后输出：发缺报告信号，不编造报告', async () => {
    const { h, id } = await opened()
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'error' })
    await flush()
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('waiting')
    expect(ticket.epochReports).toBe(0)
    const signal = h.bus.find((entry) => entry.channel === 'dispatcher/ticket-no-report')
    expect(signal?.payload).toMatchObject({ id, epoch: 1, stopReason: 'error' })
  })

  it('idle 但队列里还有话：先投递，票留在 running', async () => {
    const { h, id } = await opened()
    h.desk.attach()
    // 先让投递失败一次，攒下一条排队消息。
    h.agents.markGone('session-main')
    expect((await h.desk.send(id, '接着看下 config')).delivered).toBe(false)
    expect(h.log.get(id)!.status).toBe('running')
    h.agents.markAlive('session-main')
    h.agents.markAlive('worker-1')
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('running')
    expect(ticket.epoch).toBe(1)
    expect(h.subagents.sent.map((entry) => entry.text)).toEqual(['接着看下 config'])
    expect(h.backend.kinds()).not.toContain('idled')
  })

  it('idle 且队列空了：落 waiting，但标记人还活着', async () => {
    const { h, id } = await opened()
    h.desk.attach()
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('waiting')
    expect(ticket.workerAlive).toBe(true)
  })

  it('worker 被回收：2 分钟内的抖动不算，过了才落 waiting', async () => {
    const { h, id } = await opened()
    h.desk.attach()
    h.host.emit('agent/disposed', { agent: { id: 'worker-1' } })
    await flush()
    expect(h.log.get(id)!.status).toBe('running')
    h.clock.advance(3 * 60_000)
    h.host.emit('agent/disposed', { agent: { id: 'worker-1' } })
    await flush()
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('waiting')
    expect(ticket.workerAlive).toBe(false)
    expect(h.bus.some((entry) => entry.channel === 'dispatcher/worker-gone')).toBe(true)
  })
})

describe('send', () => {
  it('running 里加话：只记 delivered，不新开 epoch', async () => {
    const { h, id } = await opened()
    h.agents.markAlive('worker-1')
    const receipt = await h.desk.send(id, '再看一眼日志')
    expect(receipt).toMatchObject({ id, status: 'running', delivered: true, pendingInputs: 0 })
    expect(h.log.get(id)!.epoch).toBe(1)
    expect(h.backend.kinds().slice(-2)).toEqual(['queued', 'delivered'])
    expect(h.subagents.sent[0]!.target).toBe('worker-1')
  })

  it('waiting 里加话：先 resumed（epoch+1、报告数归零）再 delivered', async () => {
    const { h, id } = await opened()
    await h.desk.report(id, '第一轮的报告')
    h.desk.attach()
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end' })
    await flush()
    expect(h.log.get(id)!.epochReports).toBe(1)
    const receipt = await h.desk.send(id, '再来一轮')
    const ticket = h.log.get(id)!
    expect(receipt.status).toBe('running')
    expect(ticket.epoch).toBe(2)
    expect(ticket.epochReports).toBe(0)
    expect(ticket.workerAlive).toBe(true)
    expect(h.backend.kinds().slice(-2)).toEqual(['resumed', 'delivered'])
  })

  it('blocked 里投不出去：留在 blocked，别假装解封了', async () => {
    const { h, id } = await opened()
    await h.desk.block(id, '等主人拍板')
    h.agents.markGone('session-main')
    const receipt = await h.desk.send(id, '补一句')
    expect(receipt.delivered).toBe(false)
    expect(receipt.status).toBe('blocked')
    expect(h.log.get(id)!.status).toBe('blocked')
  })

  it('收工的票：拒绝，一个字节都不写', async () => {
    const { h, id } = await opened()
    await h.desk.close(id)
    const before = h.lines()
    await expect(h.desk.send(id, '还能加一句吗')).rejects.toThrow(/已收工，要接着干就开新票/)
    expect(h.lines()).toBe(before)
  })
})

describe('close / block', () => {
  it('关票顺手作废没投出去的排队消息', async () => {
    const { h, id } = await opened()
    h.agents.markGone('session-main')
    expect((await h.desk.send(id, '排着的一句')).delivered).toBe(false)
    expect(h.log.get(id)!.inputs).toHaveLength(1)
    const receipt = await h.desk.close(id, { note: '不干了' })
    expect(receipt).toMatchObject({ id, status: 'done', closed: true })
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('done')
    expect(ticket.inputs).toHaveLength(0)
    const closed = h.backend.events_.find((event) => (event as { kind?: string }).kind === 'closed')
    expect(closed).toMatchObject({ kind: 'closed', outcome: 'done', note: '不干了', voidedInputs: 1 })
  })

  it('重复关票：不写第二行', async () => {
    const { h, id } = await opened()
    await h.desk.close(id)
    const before = h.lines()
    const again = await h.desk.close(id)
    expect(again.closed).toBe(false)
    expect(h.lines()).toBe(before)
  })

  it('关票会收回 worker，之后迟到的 end 不会让票复活', async () => {
    const { h, id } = await opened()
    h.desk.attach()
    await h.desk.close(id, { outcome: 'dropped' })
    expect(h.subagents.disposed).toEqual(['worker-1'])
    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'end', lastAssistantMessage: '迟到的话' })
    await flush()
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('dropped')
    expect(ticket.epochReports).toBe(0)
    expect(h.backend.kinds()).not.toContain('reported')
  })

  it('block 挂起；worker 不许改状态', async () => {
    const { h, id } = await opened()
    expect((await h.desk.block(id, '等主人拍板')).status).toBe('blocked')
    expect(h.log.get(id)!.note).toBe('等主人拍板')
    await expect(
      h.desk.block(id, '小鱼想挂', { kind: 'worker', sessionId: 'worker-1' }),
    ).rejects.toThrow(/worker/)
    await expect(
      h.desk.close(id, { actor: { kind: 'worker', sessionId: 'worker-1' } }),
    ).rejects.toThrow(/worker/)
  })
})

describe('读报告', () => {
  it('读一次标已读，再读就空了；includeRead 能翻历史', async () => {
    const { h, id } = await opened()
    await h.desk.report(id, '第一条')
    await h.desk.report(id, '第二条')
    const first = await h.desk.read(id)
    expect(first.tickets).toHaveLength(1)
    expect(first.tickets[0]!.reports.map((line) => line.text)).toEqual(['第一条', '第二条'])
    expect(first.tickets[0]!.reports.every((line) => line.read === false)).toBe(true)
    expect((await h.desk.read(id)).tickets).toHaveLength(0)
    const history = await h.desk.read(id, { includeRead: true })
    expect(history.tickets[0]!.reports.every((line) => line.read === true)).toBe(true)
  })

  it('没有未读报告的票不出现在列表里；点名不存在的票就报错', async () => {
    const { h } = await opened()
    expect((await h.desk.read()).tickets).toHaveLength(0)
    await expect(h.desk.read('t-nope')).rejects.toThrow(/没有票/)
  })
})

describe('并发的两次开票', () => {
  it('串行链保证只 spawn 一次、日志顺序不乱', async () => {
    const h = makeDesk()
    const [first, second] = await Promise.all([
      h.desk.open(INTENT, h.main),
      h.desk.open(INTENT, h.main),
    ])
    expect(second.id).toBe(first.id)
    expect(h.subagents.spawned).toHaveLength(1)
    expect(h.backend.kinds()).toEqual(['published', 'spawned'])
  })

  it('两个不同的人在活表里，各开一张也串得住', async () => {
    const h = makeDesk({ agents: fakeAgents('session-main', 'session-other') })
    const [a, b] = await Promise.all([
      h.desk.open(INTENT, h.main),
      h.desk.open(
        { ...INTENT, goal: '另一件事', requestId: 'req-2' },
        { kind: 'main', sessionId: 'session-other' },
      ),
    ])
    expect(a.id).not.toBe(b.id)
    expect(h.backend.kinds()).toEqual(['published', 'spawned', 'published', 'spawned'])
  })
})
