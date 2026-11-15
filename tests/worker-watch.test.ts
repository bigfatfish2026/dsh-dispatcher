/**
 * 子会话的状态订阅：订上、被挡住转、放行、收工、会话没了。
 *
 * 纯单元：活表是假的，只记账「谁被 cancel 了、收到了哪句话」。真的票台接线在
 * `tests/watch-wiring.test.ts`，这里只管这一层自己的四条规矩。
 */
import { WRITE_TOOLS } from '../src/protocol'
import { describe, expect, it } from 'vitest'
import { fakeClock } from '../src/tickets/clock'
import {
  blockedText,
  closedText,
  createWorkerWatch,
  releasedText,
} from '../src/tickets/watch'
import type { WatchAgent } from '../src/tickets/watch'

interface Recorder {
  id: string
  cancels: Array<{ cause: unknown; options?: unknown }>
  steers: string[]
  followups: string[]
  agent: WatchAgent
}

function recorder(id: string, opts: { steer?: boolean } = {}): Recorder {
  const record: Recorder = {
    id,
    cancels: [],
    steers: [],
    followups: [],
    agent: {
      id,
      status: 'running',
      cancel(cause, options) {
        record.cancels.push({ cause, options })
      },
      followup(message) {
        const text = (message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
        record.followups.push(text)
      },
    },
  }
  if (opts.steer !== false) {
    record.agent.steer = (message) => {
      const text = (message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
      record.steers.push(text)
    }
  }
  return record
}

function makeWatch(agents: Recorder[] = []) {
  const warnings: string[] = []
  const infos: string[] = []
  const live = new Map(agents.map((entry) => [entry.id, entry.agent]))
  const watch = createWorkerWatch({
    agents: () => ({ get: (id: string) => live.get(id) }),
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
    clock: fakeClock(new Date('2026-11-14T08:00:00.000Z')),
    newId: () => 'msg-watch-1',
  })
  return { watch, warnings, infos, live }
}

const WAIT = [{ ticketId: 't-blocker', resources: ['dir:/tmp/ws'] }]

describe('订阅', () => {
  it('订上时日志写清哪个子会话订了哪张票，重复订阅不多一条', () => {
    const { watch, infos } = makeWatch([recorder('worker-1')])
    expect(watch.subscribe('t-1', 'worker-1')).toBe(true)
    expect(watch.subscribe('t-1', 'worker-1')).toBe(false)
    expect(infos).toHaveLength(1)
    expect(infos[0]).toContain('worker-1')
    expect(infos[0]).toContain('t-1')
    expect(watch.subscriptions()).toEqual([
      { ticketId: 't-1', workerId: 'worker-1', parked: false, since: '2026-11-14T08:00:00.000Z' },
    ])
  })

  it('票换了 worker：新的一只接手，旧的一只不再收通知', async () => {
    const old = recorder('worker-old')
    const fresh = recorder('worker-new')
    const { watch, live } = makeWatch([old, fresh])
    watch.subscribe('t-1', 'worker-old')
    expect(watch.subscribe('t-1', 'worker-new')).toBe(true)
    live.delete('worker-old')
    await watch.blocked({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT })
    expect(old.followups).toEqual([])
    expect(old.cancels).toEqual([])
    expect(fresh.followups).toHaveLength(1)
    expect(fresh.cancels).toHaveLength(1)
  })
})

describe('blocked：真停手', () => {
  it('打断当前轮（keepInbox）、推一句带票号与冲突资源的短话、写类工具立刻被拒', async () => {
    const worker = recorder('worker-1')
    const { watch } = makeWatch([worker])
    watch.subscribe('t-1', 'worker-1')

    await watch.blocked({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT })

    // 打断不是「嘴上说」：cancel 带 keepInbox，排队里的活不丢。
    expect(worker.cancels).toEqual([
      {
        cause: { kind: 'hook', reason: '票 t-1 blocked：停手等放行' },
        options: { keepInbox: true },
      },
    ])
    // 被挡那一条走唤醒型的 followup：紧跟 cancel 之后，steering 可能被丢掉。
    expect(worker.followups).toHaveLength(1)
    expect(worker.steers).toEqual([])
    const text = worker.followups[0]!
    expect(text).toContain('t-1')
    expect(text).toContain('blocked')
    expect(text).toContain('t-blocker')
    expect(text).toContain('dir:/tmp/ws')
    expect(text).toContain('停手')
    // 短句：一条消息一行，别把 JSON 塞进上下文。
    expect(text.split('\n')).toHaveLength(1)
    expect(text).not.toContain('{')

    // 硬拦：写类工具在票被挡住期间直接拒，看票/报活不受影响。
    for (const tool of WRITE_TOOLS) {
      expect(watch.writeBlockReason('worker-1', tool)).toContain('t-1')
    }
    expect(watch.writeBlockReason('worker-1', 'dispatch_report')).toBeUndefined()
    expect(watch.writeBlockReason('worker-1', 'dispatch_read')).toBeUndefined()
    // 别的 worker 不受牵连。
    expect(watch.writeBlockReason('worker-2', 'bash')).toBeUndefined()
  })

  it('人工挂起：没有对手就写「等使用方决定的理由」', async () => {
    const worker = recorder('worker-1')
    const { watch } = makeWatch([worker])
    watch.subscribe('t-1', 'worker-1')
    await watch.blocked({ ticketId: 't-1', brief: '拆票台', reason: '等使用方挑目录' })
    expect(worker.followups[0]).toContain('等使用方决定（等使用方挑目录）')
    expect(worker.followups[0]).not.toContain('被 挡住')
  })

  it('宿主没有 steer：放行也退回 followup，别把通知丢了', async () => {
    const worker = recorder('worker-1', { steer: false })
    const { watch } = makeWatch([worker])
    watch.subscribe('t-1', 'worker-1')
    await watch.blocked({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT })
    await watch.released({ ticketId: 't-1', brief: '拆票台' })
    expect(worker.followups).toHaveLength(2)
    expect(worker.followups[1]).toContain('released')
  })

  it('没订过的子会话不推：票和人对不上时什么都不做', async () => {
    const worker = recorder('worker-1')
    const { watch } = makeWatch([worker])
    expect(await watch.blocked({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT })).toBe(false)
    expect(worker.cancels).toEqual([])
    expect(worker.followups).toEqual([])
    expect(worker.steers).toEqual([])
  })
})

describe('released', () => {
  it('放行：解开按住、推「接着干」，写类工具恢复', async () => {
    const worker = recorder('worker-1')
    const { watch } = makeWatch([worker])
    watch.subscribe('t-1', 'worker-1')
    await watch.blocked({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT })
    expect(watch.writeBlockReason('worker-1', 'bash')).toBeDefined()

    const sentOk = await watch.released({
      ticketId: 't-1',
      brief: '拆票台',
      releasedBy: ['t-blocker'],
    })

    expect(sentOk).toBe(true)
    expect(worker.followups).toHaveLength(1)
    expect(worker.steers).toHaveLength(1)
    const text = worker.steers[0]!
    expect(text).toContain('t-1')
    expect(text).toContain('released')
    expect(text).toContain('t-blocker')
    expect(text).toContain('接着干')
    expect(watch.writeBlockReason('worker-1', 'bash')).toBeUndefined()
    // 打断只发生一次：放行不该再 cancel 一次。
    expect(worker.cancels).toHaveLength(1)
  })

  it('没被按住的票放行不唠叨：不推消息、返回 false', async () => {
    const worker = recorder('worker-1')
    const { watch } = makeWatch([worker])
    watch.subscribe('t-1', 'worker-1')
    expect(await watch.released({ ticketId: 't-1', brief: '拆票台', releasedBy: ['t-0'] })).toBe(false)
    expect(worker.steers).toEqual([])
  })
})

describe('closed / dropped', () => {
  it('收工：推一句结束通知，然后退订（之后的被挡不再找它）', async () => {
    const worker = recorder('worker-1')
    const { watch } = makeWatch([worker])
    watch.subscribe('t-1', 'worker-1')
    const ok = await watch.closed({ ticketId: 't-1', brief: '拆票台', outcome: 'done' })
    expect(ok).toBe(true)
    expect(worker.steers[0]).toContain('closed')
    expect(worker.steers[0]).toContain('别再动手')
    expect(watch.subscriptions()).toEqual([])
    expect(await watch.blocked({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT })).toBe(false)
    expect(worker.cancels).toEqual([])
  })

  it('放弃：说清是 dropped，别让它当成干完了', async () => {
    const worker = recorder('worker-1')
    const { watch } = makeWatch([worker])
    watch.subscribe('t-1', 'worker-1')
    await watch.closed({ ticketId: 't-1', brief: '拆票台', outcome: 'dropped' })
    expect(worker.steers[0]).toContain('dropped')
    expect(worker.steers[0]).toContain('放弃')
  })
})

describe('通知失败不影响票台', () => {
  it('会话没了：只 warn 一行、返回 false、不抛', async () => {
    const { watch, warnings } = makeWatch([])
    watch.subscribe('t-1', 'worker-gone')
    const ok = await watch.blocked({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT })
    expect(ok).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('t-1')
    expect(warnings[0]).toContain('worker-gone')
    // 通知没送到这件事本身也留了痕。
    expect(watch.notices()).toMatchObject([{ kind: 'blocked', delivered: false }])
  })

  it('投递抛错：同样只 warn，不往上冒', async () => {
    const worker = recorder('worker-1')
    const { watch, warnings } = makeWatch([worker])
    watch.subscribe('t-1', 'worker-1')
    await watch.blocked({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT })
    worker.agent.steer = () => {
      throw new Error('inbox 关了')
    }
    await expect(
      watch.released({ ticketId: 't-1', brief: '拆票台' }),
    ).resolves.toBe(false)
    expect(warnings[0]).toContain('inbox 关了')
  })
})

describe('文案', () => {
  it('四条通知各一句，都带票号与状态，都不超过一行', () => {
    const lines = [
      blockedText({ ticketId: 't-1', brief: '拆票台', waitOn: WAIT }),
      releasedText({ ticketId: 't-1', brief: '拆票台', releasedBy: ['t-blocker'] }),
      closedText({ ticketId: 't-1', brief: '拆票台', outcome: 'done' }),
      closedText({ ticketId: 't-1', brief: '拆票台', outcome: 'dropped' }),
    ]
    for (const line of lines) {
      expect(line.startsWith('[票台] 票 t-1「拆票台」')).toBe(true)
      expect(line.split('\n')).toHaveLength(1)
    }
    expect(lines[0]).toContain('blocked')
    expect(lines[1]).toContain('released')
    expect(lines[2]).toContain('closed')
    expect(lines[3]).toContain('dropped')
  })
})
