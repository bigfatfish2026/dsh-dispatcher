import { describe, expect, it } from 'vitest'
import type { TicketBroadcast } from '../src/store'
import { INTENT, flush, makeDesk } from './helpers/desk-harness'
import { mountPlugin } from './helpers/plugin-harness'

/**
 * 票台的写路径只在一个地方，宿主事件只是「信号」：subagent/end、agent/status、
 * agent/disposed 进来，票台自己决定落哪条事件。这里测的是这条线的接线。
 */

describe('票事件广播', () => {
  it('send 落一条 queued 就广播一条，带 id 和 at', async () => {
    const host = mountPlugin()
    const seen: Array<Record<string, unknown>> = []
    const bus = host.ctx as { on(event: string, listener: (payload: unknown) => void): unknown }
    bus.on('dispatcher/ticket', (event) => {
      seen.push(event as Record<string, unknown>)
    })
    const opened = (await host.call('dispatch_open', { goal: 'g', brief: 'b' })) as { id: string }
    await host.settled()

    const before = seen.length
    await host.call('dispatch_send', { id: opened.id, text: '继续' })
    await host.settled()

    const fresh = seen.slice(before)
    // 广播用的是老标签（queued 在线上叫 input），监听的插件不用改。
    expect(fresh[0]!.kind).toBe('input')
    expect(fresh[0]).toMatchObject({ id: opened.id })
    expect(typeof fresh[0]!.at).toBe('string')
  })
})

describe('收工的票不再收话', () => {
  it('done 票 send 直接报错，一条都不写', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.close(id, { outcome: 'done', actor: h.main })
    const lines = h.lines()

    await expect(h.desk.send(id, '还有个尾巴', h.main)).rejects.toThrow(/已收工，要接着干就开新票/)
    expect(h.lines()).toBe(lines)
    expect(h.desk.get(id)!.pendingInputs).toBe(0)
  })

  it('dropped 票也一样：停止就是停止', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.close(id, { outcome: 'dropped', actor: h.main })
    const lines = h.lines()

    await expect(h.desk.send(id, '再想想', h.main)).rejects.toThrow(/已收工/)
    expect(h.lines()).toBe(lines)
  })
})

describe('宿主事件', () => {
  it('send 当场就投：不等 idle，排队数直接归零', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    await h.desk.send(id, '这条该马上到', h.main)

    expect(h.subagents.sent).toHaveLength(1)
    expect(h.subagents.sent[0]!.text).toContain('这条该马上到')
    expect(h.desk.get(id)!.pendingInputs).toBe(0)
  })

  it('投不出去就留在队里，idle 来了再补投', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.agents.markGone('session-main')
    await h.desk.send(id, '先排着', h.main)
    expect(h.desk.get(id)!.pendingInputs).toBe(1)
    expect(h.subagents.sent).toHaveLength(0)

    h.agents.markAlive('session-main')
    h.desk.attach()
    h.host.emit('agent/status', { agent: { id: 'worker-1' }, status: 'idle' })
    await flush()

    expect(h.subagents.sent).toHaveLength(1)
    expect(h.desk.get(id)!.pendingInputs).toBe(0)
  })

  it('agent/status 不是 idle 时不动票', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.agents.markGone('session-main')
    await h.desk.send(id, '排队', h.main)
    h.desk.attach()

    h.host.emit('agent/status', { agent: { id: 'worker-1' }, status: 'running' })
    await flush()

    expect(h.subagents.sent).toHaveLength(0)
    expect(h.desk.get(id)!.pendingInputs).toBe(1)
  })

  it('agent/disposed 把票落到 waiting，workerAlive=false', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.clock.advance(h.config.freshMinutes * 60_000)
    h.desk.attach()

    h.host.emit('agent/disposed', { agent: { id: 'worker-1' } })
    await flush()

    const view = h.desk.get(id)!
    expect(view.status).toBe('waiting')
    expect(view.workerAlive).toBe(false)
  })
})

describe('subagent/end', () => {
  it('正常结束落 waiting，报告还在票上等人读', async () => {
    const h = makeDesk()
    const { id } = await h.desk.open(INTENT, h.main)
    h.desk.attach()

    h.host.emit('subagent/end', { id: 'worker-1', stopReason: 'completed' })
    await flush()

    const view = h.desk.get(id)!
    expect(view.status).toBe('waiting')
    expect(view.workerAlive).toBe(false)
  })
})

