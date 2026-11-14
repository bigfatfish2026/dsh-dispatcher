/**
 * 子会话订阅接进票台：订在哪个环节、被挡真的停手、放行接得上、收工说得清。
 *
 * 这一层跑真的 `TicketDesk`，只把活表换成记账的假件：看它在哪一步调
 * `subscribe`、哪一步按住了子会话、哪一步松开。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { WatchAgent } from '../src/tickets/watch'
import { createWorkerWatch } from '../src/tickets/watch'
import type { ProbePort, ProbeRegistry } from '../src/tickets/probe'
import { flush, fakeAgents, makeDesk } from './helpers/desk-harness'
import type { Harness } from './helpers/desk-harness'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'

afterEach(cleanTempDirs)

const DIR = 'dir:/tmp/watch-ws'

interface Recorder {
  id: string
  cancels: Array<{ cause: unknown; options?: unknown }>
  messages: string[]
}

/** 一只记账的子会话：收到什么、被 cancel 了几次。 */
function recorder(id: string): Recorder {
  const record: Recorder = { id, cancels: [], messages: [] }
  return record
}

function watchAgents(records: Recorder[]): {
  lookup: { get(id: string): unknown }
  live: Map<string, WatchAgent>
} {
  const live = new Map<string, WatchAgent>()
  for (const record of records) {
    live.set(record.id, {
      id: record.id,
      status: 'running',
      cancel(cause, options) {
        record.cancels.push({ cause, ...(options ? { options } : {}) })
      },
      // 被挡走 followup（唤醒型），放行/收工走 steer；两种都记进同一串消息。
      followup(message) {
        const text = (message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
        record.messages.push(text)
      },
      steer(message) {
        const text = (message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
        record.messages.push(text)
      },
    })
  }
  return { lookup: { get: (id) => live.get(id) }, live }
}

/** 探路窗口假件：票要进冲突判定，得有窗口。 */
function fakeProbe(): ProbePort & ProbeRegistry {
  return {
    expect: () => undefined,
    drop: () => undefined,
    release: () => true,
    releaseTicket: () => true,
  }
}

function wire(records: Recorder[], options: { agents?: string[] } = {}) {
  const { lookup } = watchAgents(records)
  const infos: string[] = []
  const warnings: string[] = []
  const watch = createWorkerWatch({
    agents: () => lookup,
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
  })
  const h = makeDesk({
    config: { defaultPreset: 't1', sweepMs: 0 },
    agents: fakeAgents('session-main', ...(options.agents ?? [])),
    watch,
    // 所有票都先探路：窗口那份假实现一直要接。
    probe: fakeProbe(),
  })
  h.desk.attach()
  return { h, watch, infos, warnings }
}

async function idle(h: Harness, worker: string): Promise<void> {
  h.host.emit('agent/status', { status: 'idle', agent: { id: worker } })
  await flush()
}

describe('订阅挂在 spawned 那一刀', () => {
  it('子会话一 spawn 就订上自己那张票，日志写清谁订了谁', async () => {
    const worker = recorder('worker-1')
    const { h, watch, infos } = wire([worker])
    const receipt = await h.desk.open({ goal: '拆票台', brief: '拆票台' }, h.main)
    await flush()

    expect(watch.subscriptions()).toEqual([
      { ticketId: receipt.id, workerId: 'worker-1', parked: false, since: expect.any(String) },
    ])
    expect(infos.some((line) => line.includes('worker-1') && line.includes(receipt.id))).toBe(true)
    // 派活本身不受影响：一个字节的票台行为都没变。
    expect(h.log.get(receipt.id)!.status).toBe('running')
  })
})

describe('人工挂起', () => {
  it('被挡住：真打断 + 一句停手 + 写类工具当场拒；主会话发话继续后松开', async () => {
    const worker = recorder('worker-1')
    const { h, watch } = wire([worker])
    const { id } = await h.desk.open({ goal: '拆票台', brief: '拆票台' }, h.main)
    await flush()

    await h.desk.block(id, '等维护者挑目录', h.main)
    await flush()

    expect(worker.cancels).toEqual([
      {
        cause: { kind: 'hook', reason: `票 ${id} blocked：停手等放行` },
        options: { keepInbox: true },
      },
    ])
    const notice = worker.messages.at(-1)!
    expect(notice).toContain(id)
    expect(notice).toContain('blocked')
    expect(notice).toContain('等维护者决定（等维护者挑目录）')
    expect(watch.writeBlockReason('worker-1', 'write')).toContain(id)
    // 看票、报活不拦：子会话还得能把「我被挡了」说回来。
    expect(watch.writeBlockReason('worker-1', 'dispatch_report')).toBeUndefined()

    // 主会话自己发了话：票回 running，守卫跟着松开，这一路不再多推一句。
    await h.desk.send(id, '目录换成 /tmp/ws2，接着干', h.main)
    await flush()
    expect(h.log.get(id)!.status).toBe('running')
    expect(watch.writeBlockReason('worker-1', 'bash')).toBeUndefined()
    expect(watch.subscriptions()[0]!.parked).toBe(false)
  })

  it('关票：推一句结束通知，然后退订', async () => {
    const worker = recorder('worker-1')
    const { h, watch } = wire([worker])
    const { id } = await h.desk.open({ goal: '拆票台', brief: '拆票台' }, h.main)
    await flush()
    await h.desk.close(id, { outcome: 'done' })
    await flush()

    const notice = worker.messages.at(-1)!
    expect(notice).toContain(id)
    expect(notice).toContain('closed')
    expect(notice).toContain('别再动手')
    expect(watch.subscriptions()).toEqual([])
  })

  it('放弃的票说 dropped，别让子会话当成干完了', async () => {
    const worker = recorder('worker-1')
    const { h } = wire([worker])
    const { id } = await h.desk.open({ goal: '拆票台', brief: '拆票台' }, h.main)
    await flush()
    await h.desk.close(id, { outcome: 'dropped' })
    await flush()
    expect(worker.messages.at(-1)).toContain('dropped')
    expect(worker.messages.at(-1)).toContain('放弃')
  })
})

describe('被挡那轮的收尾', () => {
  it('打断收下来的那一轮不补报告：别把掐断的半句话当成干完了', async () => {
    const worker = recorder('worker-1')
    const { h } = wire([worker])
    const { id } = await h.desk.open({ goal: '拆票台', brief: '拆票台' }, h.main)
    await flush()
    await h.desk.block(id, '等维护者拍板', h.main)
    await flush()

    // 被打断的那一轮照实收尾：票进 waiting，但不许自动补一条「报告」。
    h.host.emit('subagent/end', {
      id: 'worker-1',
      stopReason: 'interrupted',
      lastAssistantMessage: '干到一半，写到第 3 个文件',
    })
    await flush()

    expect(h.log.get(id)!.reports).toEqual([])
    expect(h.log.get(id)!.status).toBe('waiting')
  })
})

describe('冲突排队', () => {
  it('被挡的票收到「谁挡的、撞在哪」；挡路的收工后收到「已放行」', async () => {
    const first = recorder('worker-1')
    const second = recorder('worker-2')
    const { h, watch, warnings } = wire([first, second], {
      // 两只都活着：第一张的探路轮收工后复用 worker-1 跑执行轮，第二张才拿到
      // worker-2——这样「被挡住的那只」正好是 second 记的那只。
      agents: ['worker-1', 'worker-2'],
    })

    const a = await h.desk.open({ goal: '占住目录', brief: '占住目录' }, h.main)
    await h.desk.declare(h.log.get(a.id)!.workerId!, { summary: '占住目录' }, { writes: [DIR] })
    await idle(h, 'worker-1')
    expect(h.log.get(a.id)!.phase).toBe('running')

    const b = await h.desk.open({ goal: '抢目录', brief: '抢目录' }, h.main)
    await h.desk.declare(h.log.get(b.id)!.workerId!, { summary: '抢目录' }, { writes: [DIR] })
    await idle(h, 'worker-2')

    const queued = h.log.get(b.id)!
    expect(queued.phase).toBe('queued')
    // 被挡的那只：真打断 + 一句话说清被谁挡、撞在哪个资源上。
    expect(second.cancels).toHaveLength(1)
    const blockedNotice = second.messages.at(-1)!
    expect(blockedNotice).toContain(b.id)
    expect(blockedNotice).toContain(a.id)
    expect(blockedNotice).toContain(DIR)
    expect(blockedNotice).toContain('停手')
    // 第一只在干活，不该收到「你被挡了」。
    expect(first.cancels).toEqual([])
    expect(warnings).toEqual([])

    // 挡路的收工：排队那张判完、任务书送出去，再补一句「已放行」。
    await h.desk.close(a.id)
    await flush()

    expect(h.log.get(b.id)!.phase).not.toBe('queued')
    const releasedNotice = second.messages.at(-1)!
    expect(releasedNotice).toContain(b.id)
    expect(releasedNotice).toContain('released')
    expect(releasedNotice).toContain(a.id)
    expect(releasedNotice).toContain('接着干')
    // 放行之后守卫松开，子会话能真干活；被停下的那一轮由新任务书接上。
    expect(watch.writeBlockReason('worker-2', 'write')).toBeUndefined()
    expect(h.subagents.sent.some((message) => message.target === 'worker-2')).toBe(true)
  })
})

describe('通知失败不影响票台', () => {
  it('子会话会话没了：挂起照样落票、只 warn 一行，不抛', async () => {
    const { h, watch, warnings } = wire([], { agents: [] })
    const { id } = await h.desk.open({ goal: '拆票台', brief: '拆票台' }, h.main)
    // 订阅还在（spawn 那一刻订的），但活表里查不到那只子会话了。
    expect(watch.subscriptions()).toHaveLength(1)

    await expect(h.desk.block(id, '等维护者决定', h.main)).resolves.toMatchObject({ status: 'blocked' })
    await flush()

    expect(h.log.get(id)!.status).toBe('blocked')
    expect(warnings.filter((line) => line.includes(id))).toHaveLength(1)
    expect(warnings.some((line) => line.includes('worker-1') && line.includes('没送到'))).toBe(true)
  })

  it('会话没了还关票：票照常收工，通知失败只留一行', async () => {
    const { h, warnings } = wire([], { agents: [] })
    const { id } = await h.desk.open({ goal: '拆票台', brief: '拆票台' }, h.main)
    await expect(h.desk.close(id, { outcome: 'done' })).resolves.toMatchObject({
      status: 'done',
      closed: true,
    })
    await flush()
    expect(warnings.some((line) => line.includes(id) && line.includes('没送到'))).toBe(true)
  })
})

describe('插件层：守卫装在 worker 会话上', () => {
  it('被挡期间 write / edit / bash 当场拒，报活与看票照旧放行', async () => {
    const host = mountPlugin({ config: { sweepMs: 0, snapshotEnabled: false } })
    const worker = host.makeAgent('subagent', 'worker-1')
    // 活表里也要有它：`ctx.agents.get` 找的是这一摞，不是刚 new 出来的那个对象。
    host.agents.push(worker)
    host.emit('agent/created', { agent: worker })

    const receipt = (await host.call('dispatch_open', {
      goal: '拆票台',
      brief: '拆票台',
    })) as { id: string }
    await host.settled()

    // 守卫只装在子会话会话上（主会话那条是等待守卫，跟票无关）。
    expect(worker.guards).toHaveLength(1)
    const guard = worker.guards[0]!
    expect(guard({ name: 'bash', arguments: {} })).toBeUndefined()

    await host.call('dispatch_block', { id: receipt.id, reason: '等维护者拍板' })
    await host.settled()

    for (const name of ['write', 'edit', 'bash']) {
      const reason = guard({ name, arguments: {} })
      expect(reason).toContain(receipt.id)
      expect(reason).toContain('blocked')
    }
    expect(guard({ name: 'dispatch_report', arguments: {} })).toBeUndefined()
    // 通知也到了同一只子会话手上。
    expect(worker.messages.at(-1)).toContain('blocked')
  })
})
