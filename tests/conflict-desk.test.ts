/**
 * 冲突判定接进票台：探路票收工那一刻判，撞了排队，收工放行。
 *
 * 六个场景全在 desk 层跑，一只真子会话都不开：假子会话只记账「派了几只、
 * 派的是哪张票、prompt 第几轮」。判定用的是票上的 intent.writes/reads，
 * 和 `tests/conflict.test.ts` 的纯判定分开测。
 */
import { describe, expect, it } from 'vitest'
import { intentPlanLines } from '../src/index'
import type { OwnerNotifier } from '../src/tickets/notify'
import type { ProbePort, ProbeRegistry } from '../src/tickets/probe'
import { MemoryBackend, flush, makeDesk } from './helpers/desk-harness'
import type { Harness } from './helpers/desk-harness'

const DIR = 'dir:/tmp/conflict-ws'

/** 探路窗口假件：desk 只拆不建，这里记账「拆了哪只」就够。 */
function fakeProbe(): ProbePort & ProbeRegistry & { released: string[] } {
  const released: string[] = []
  return {
    released,
    expect: () => undefined,
    drop: () => undefined,
    release: (workerId) => {
      released.push(workerId)
      return true
    },
    releaseTicket: () => true,
  }
}

/** 每张票都带探路窗口：没窗口的票收工不进判定，那是另一条老路。 */
function desk(): Harness {
  const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe: fakeProbe() })
  h.desk.attach()
  return h
}

/**
 * 开一张探路票，再让探路子会话把 writes/reads 声明上来。
 *
 * 此前 open 不收 intent，意图只能走 `dispatch_declare`；冲突判定读的
 * 仍是票上折出来的那一栏。
 */
async function openProbe(
  h: Harness,
  goal: string,
  writes: string[],
  reads: string[] = [],
): Promise<string> {
  const receipt = await h.desk.open({ goal, brief: goal }, h.main)
  const workerId = h.log.get(receipt.id)!.workerId!
  await h.desk.declare(workerId, { summary: goal }, { writes, ...(reads.length ? { reads } : {}) })
  // 不推假时钟：同一毫秒开票也该稳定按开票先后走，靠的是票上的排队序号 seq
  // （`published` 里那一条），不是 createdAt。
  return receipt.id
}

/** 让某只探路子会话 idle 下来：宿主信号 → desk 串行链 → 判定。 */
async function idle(h: Harness, worker: string): Promise<void> {
  h.host.emit('agent/status', { status: 'idle', agent: { id: worker } })
  await flush()
}

/** 最后一次派活的 prompt：看它派的是哪张票、第几轮。 */
function lastPrompt(h: Harness): string {
  const spec = h.subagents.spawned.at(-1)!
  return spec.prompt.map((block) => block.text).join('\n')
}

describe('探路收工那刻判定', () => {
  it('强冲突：票转 blocked、waitOn 记清撞谁撞什么，这一轮不派活', async () => {
    const h = desk()
    const first = await openProbe(h, '改目录甲', [DIR])
    const second = await openProbe(h, '也改目录甲', [DIR])
    expect(h.subagents.spawned.map((spec) => spec.label)).toHaveLength(2)

    await idle(h, 'worker-2')

    const blocked = h.log.get(second)!
    expect(blocked.phase).toBe('queued')
    expect(blocked.waitOn).toEqual([{ ticketId: first, resources: [DIR] }])
    // status 一个字节都不许动：还是探路子会话派出去时的 running。
    expect(blocked.status).toBe('running')
    expect(blocked.workerId).toBe('worker-2')
    expect(blocked.closedAt).toBeUndefined()
    // 这一轮只有两只探路子会话，没有执行轮。
    expect(h.subagents.spawned).toHaveLength(2)
    expect(h.backend.kinds()).toContain('conflict-checked')

    // 票面上看得见「在等谁、等什么」。
    const view = h.desk.list().find((row) => row.id === second)!
    expect(intentPlanLines(view)).toContain(`    waiting on ${first} (${DIR})`)
  })

  it('第二张 declare 撞车：进排队那刻通知开票方一次；放行不再推', async () => {
    const blockedCalls: Array<Parameters<OwnerNotifier['blocked']>[0]> = []
    const queuedCalls: Array<Parameters<NonNullable<OwnerNotifier['queued']>>[0]> = []
    const notifier: OwnerNotifier = {
      reportArrived: async () => true,
      idle: async () => true,
      noReport: async () => true,
      blocked: async (input) => {
        blockedCalls.push(input)
        return true
      },
      resumed: async () => true,
      queued: async (input) => {
        queuedCalls.push(input)
        return true
      },
    }
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      probe: fakeProbe(),
      notifier,
    })
    h.desk.attach()

    const first = await openProbe(h, '占住目录', [DIR])
    // 第一张先判、先跑起来：探路轮收工后派执行轮。
    await idle(h, 'worker-1')
    expect(h.log.get(first)!.phase).toBe('running')
    expect(h.log.get(first)!.waitOn).toBeUndefined()

    const second = await openProbe(h, '抢目录', [DIR])
    await idle(h, h.log.get(second)!.workerId!)

    const queued = h.log.get(second)!
    expect(queued.phase).toBe('queued')
    expect(queued.waitOn).toEqual([{ ticketId: first, resources: [DIR] }])
    // 事实照记：被挡的票、被谁挡的（id + brief）、撞在哪些路径上。
    expect(blockedCalls).toHaveLength(1)
    expect(blockedCalls[0]).toMatchObject({
      ticketId: second,
      brief: '抢目录',
      waitOn: [{ ticketId: first, resources: [DIR], brief: '占住目录' }],
    })
    // 恰好一条 followup：进排队那一刻发，内容给主会话看。
    expect(queuedCalls).toHaveLength(1)
    expect(queuedCalls[0]).toMatchObject({
      ticketId: second,
      brief: '抢目录',
      waitOn: [{ ticketId: first, resources: [DIR], brief: '占住目录' }],
    })

    await h.desk.close(first)
    await flush()

    expect(h.log.get(second)!.phase).not.toBe('queued')
    // 放行是自动的，不再打扰开票方：还是那一条，没有第二句。
    expect(queuedCalls).toHaveLength(1)
  })

  it('弱冲突：照常派活，票面上留一行提示票号', async () => {
    const h = desk()
    const reader = await openProbe(h, '只读目录甲', [], [DIR])
    const writer = await openProbe(h, '改目录甲', [DIR])

    await idle(h, 'worker-2')

    const ticket = h.log.get(writer)!
    expect(ticket.phase).toBe('running')
    expect(ticket.waitOn).toBeUndefined()
    expect(ticket.weakWith).toEqual([reader])
    // 弱冲突不拦：真的派了执行轮，派的是同一张票、第 2 轮。
    expect(h.subagents.spawned).toHaveLength(3)
    expect(h.subagents.spawned.at(-1)!.label).toContain(writer)
    expect(lastPrompt(h)).toContain('第 2 轮')
    expect(lastPrompt(h)).toContain('改目录甲')

    const view = h.desk.list().find((row) => row.id === writer)!
    expect(intentPlanLines(view)).toContain(`    weak conflict：${reader}（放行）`)
  })

  it('不冲突：照常派活，票面上什么都不多写', async () => {
    const h = desk()
    await openProbe(h, '改目录甲', [DIR])
    const other = await openProbe(h, '改目录乙', ['dir:/tmp/conflict-other'])

    await idle(h, 'worker-2')

    const ticket = h.log.get(other)!
    expect(ticket.phase).toBe('running')
    expect(ticket.waitOn).toBeUndefined()
    expect(ticket.weakWith).toBeUndefined()
    expect(h.subagents.spawned).toHaveLength(3)
  })
  it('writes 空着的正常票是纯读：不拿 plan.files 的父目录顶成写，跟写同一片目录的票不撞', async () => {
    const h = desk()
    const writer = await openProbe(h, '改目录甲', [DIR])
    const reader = await openProbe(h, '只读一份文档', [], ['file:/tmp/conflict-ws/readme.md'])
    await h.desk.declare(
      h.log.get(reader)!.workerId!,
      { summary: '读一份文档', files: [{ path: '/tmp/conflict-ws/readme.md' }] },
      { writes: [], reads: ['file:/tmp/conflict-ws/readme.md'] },
    )
    expect(h.log.get(reader)!.phase).toBe('planned')

    await idle(h, h.log.get(reader)!.workerId!)

    const ticket = h.log.get(reader)!
    // 纯读票不排队：以前这里拿 plan.files 的父目录顶成 dir:/tmp/conflict-ws，跟 writer 撞死。
    expect(ticket.phase).toBe('running')
    expect(ticket.waitOn).toBeUndefined()
    // 只读与别人会写的目录相交只算弱提示，放行。
    expect(ticket.weakWith).toEqual([writer])
    expect(h.subagents.spawned).toHaveLength(3)
  })

  it('降级票没交 plan：不拿票面 dir 整片当写，不排队、照派执行轮', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0, probeTimeoutMinutes: 2 },
      probe: fakeProbe(),
    })
    h.desk.attach()
    const blocker = await openProbe(h, '改目录甲', [DIR])
    // 挡路那张先真的跑起来：探路收工、派执行轮，它已经是 running 的写入方。
    await idle(h, 'worker-1')
    expect(h.log.get(blocker)!.phase).toBe('running')
    // 执行轮是真派出去的子会话：活表里要有它，否则巡检的 A2 死 worker 兜底会先把它收了。
    h.agents.markAlive(h.log.get(blocker)!.workerId!)
    const receipt = await h.desk.open(
      { goal: '只交了半截的降级票', brief: '降级票', dir: '/tmp/conflict-ws' },
      h.main,
    )
    const planner = receipt.id
    h.clock.advance(3 * 60_000)
    // 降级当拍就判：plan 空着就什么写都不占，不拿票面 dir 整片兜底（那就是
    // dir:<home> 锁死整棵树那条路）。
    await h.desk.maintain()
    const degraded = h.log.get(planner)!
    expect(degraded.degraded).toBe(true)
    expect(degraded.phase).toBe('running')
    expect(degraded.waitOn).toBeUndefined()
    // 两只探路 + 挡路那张的执行轮 + 降级票自己的执行轮。
    expect(h.subagents.spawned).toHaveLength(4)
  })
})

describe('收工放行', () => {
  it('关掉挡路的票：探路那只还活着就把执行轮投回同一个会话，不再起新的一只', async () => {
    const h = desk()
    const blocker = await openProbe(h, '先改目录甲', [DIR])
    const waiter = await openProbe(h, '后改目录甲', [DIR])
    await idle(h, 'worker-2')
    expect(h.log.get(waiter)!.phase).toBe('queued')
    expect(h.subagents.spawned).toHaveLength(2)

    // 探路子会话交完声明只是 idle，会话还在活表里——放行该复用这只。
    h.agents.markAlive('worker-2')
    await h.desk.close(blocker, { actor: h.main })

    const released = h.log.get(waiter)!
    expect(released.phase).toBe('running')
    expect(released.waitOn).toBeUndefined()
    expect(released.workerId).toBe('worker-2')
    expect(released.epoch).toBe(2)
    // 一只新的都没起，话投回了原来那只。
    expect(h.subagents.spawned).toHaveLength(2)
    expect(h.subagents.sent).toHaveLength(1)
    expect(h.subagents.sent[0]!.target).toBe('worker-2')
    expect(h.subagents.sent[0]!.text).toContain(waiter)
    expect(h.subagents.sent[0]!.text).toContain('后改目录甲')
    expect(h.subagents.sent[0]!.text).toContain('第 2 轮')
    expect(h.backend.kinds()).toContain('resumed')
  })

  it('探路那只真没了（活表里查不到）才起新的一只，任务书进第 2 轮', async () => {
    const h = desk()
    const blocker = await openProbe(h, '先改目录甲', [DIR])
    const waiter = await openProbe(h, '后改目录甲', [DIR])
    await idle(h, 'worker-2')
    expect(h.log.get(waiter)!.phase).toBe('queued')

    // ended / 重启 sweep 之后就查不到了，只能重起。
    h.agents.markGone('worker-2')
    await h.desk.close(blocker, { actor: h.main })

    const released = h.log.get(waiter)!
    expect(released.phase).toBe('running')
    expect(released.workerId).toBe('worker-3')
    expect(h.subagents.spawned).toHaveLength(3)
    expect(h.subagents.sent).toHaveLength(0)
    expect(lastPrompt(h)).toContain(waiter)
    expect(lastPrompt(h)).toContain('后改目录甲')
    expect(lastPrompt(h)).toContain('第 2 轮')
  })

  it('三张票抢一个 dir：放行按开票顺序来，后排先走不了', async () => {
    const h = desk()
    // 第一张先跑起来（先收工判定、先派执行轮），后面的票才有"前面的"可等。
    const first = await openProbe(h, '第一张', [DIR])
    await idle(h, h.log.get(first)!.workerId!)
    expect(h.log.get(first)!.phase).toBe('running')
    const second = await openProbe(h, '第二张', [DIR])
    const third = await openProbe(h, '第三张', [DIR])
    // 探路子会话是谁由派活顺序定（第一张的执行轮也占了一个号），别写死。
    await idle(h, h.log.get(second)!.workerId!)
    await idle(h, h.log.get(third)!.workerId!)
    expect(h.log.get(second)!.phase).toBe('queued')
    expect(h.log.get(third)!.phase).toBe('queued')
    const before = h.subagents.spawned.length

    // 关掉第一张：只放行第二张，第三张还得排在后面等。
    await h.desk.close(first, { actor: h.main })
    expect(h.log.get(second)!.phase).toBe('running')
    expect(h.log.get(third)!.phase).toBe('queued')
    expect(h.log.get(third)!.waitOn).toEqual([{ ticketId: second, resources: [DIR] }])
    expect(h.subagents.spawned).toHaveLength(before + 1)
    expect(lastPrompt(h)).toContain(second)
    expect(lastPrompt(h)).toContain('第二张')

    // 再关第二张：第三天（第三张）才轮到。
    await h.desk.close(second, { actor: h.main })
    expect(h.log.get(third)!.phase).toBe('running')
    expect(h.log.get(third)!.waitOn).toBeUndefined()
    expect(h.subagents.spawned).toHaveLength(before + 2)
    expect(lastPrompt(h)).toContain(third)
    expect(lastPrompt(h)).toContain('第三张')
  })
})

describe('排队序号', () => {
  it('同一毫秒开三张票：连跑 10 次，放行顺序都是第一张、第二张、第三张', async () => {
    // 每一轮都开一只新票台，时钟一秒都不推：三张票的 createdAt 完全相同，
    // 先后只能靠 published 里的 seq。跑 10 次是为了让「碰巧 id 字典序排对」
    // 这种运气（每轮 1/6）不可能连中十次。
    for (let round = 1; round <= 10; round += 1) {
      const h = desk()
      const first = await openProbe(h, '第一张', [DIR])
      await idle(h, h.log.get(first)!.workerId!)
      const second = await openProbe(h, '第二张', [DIR])
      const third = await openProbe(h, '第三张', [DIR])

      // 三张票同一毫秒开的：这个前提塌了这条测试就没意义，先钉住。
      expect(h.log.get(first)!.createdAt).toBe(h.log.get(third)!.createdAt)
      expect([first, second, third].map((id) => h.log.get(id)!.seq)).toEqual([1, 2, 3])

      await idle(h, h.log.get(second)!.workerId!)
      await idle(h, h.log.get(third)!.workerId!)
      expect(h.log.get(second)!.phase).toBe('queued')
      expect(h.log.get(third)!.phase).toBe('queued')

      // 放行一次只走一张，顺序就是开票顺序：先关第一张，只有第二张能动。
      await h.desk.close(first, { actor: h.main })
      expect(h.subagents.spawned.at(-1)!.label).toContain(second)
      expect(h.log.get(second)!.phase).toBe('running')
      expect(h.log.get(third)!.phase).toBe('queued')
      expect(h.log.get(third)!.waitOn).toEqual([{ ticketId: second, resources: [DIR] }])

      // 再关第二张，第三张才轮到。
      await h.desk.close(second, { actor: h.main })
      expect(h.subagents.spawned.at(-1)!.label).toContain(third)
      expect(h.log.get(third)!.phase).toBe('running')
      expect(h.log.get(third)!.waitOn).toBeUndefined()
    }
  }, 30_000)
})

describe('先来后到按交声明顺序，不按谁先被判定', () => {
  /** 记下 notifier 被叫了哪些：事实 blocked 与叫醒 queued 各自一条一条攒。 */
  function capture(): {
    notifier: OwnerNotifier
    blockedCalls: Array<Parameters<OwnerNotifier['blocked']>[0]>
    queuedCalls: Array<Parameters<NonNullable<OwnerNotifier['queued']>>[0]>
  } {
    const blockedCalls: Array<Parameters<OwnerNotifier['blocked']>[0]> = []
    const queuedCalls: Array<Parameters<NonNullable<OwnerNotifier['queued']>>[0]> = []
    const notifier: OwnerNotifier = {
      reportArrived: async () => true,
      idle: async () => true,
      noReport: async () => true,
      blocked: async (input) => {
        blockedCalls.push(input)
        return true
      },
      resumed: async () => true,
      queued: async (input) => {
        queuedCalls.push(input)
        return true
      },
    }
    return { notifier, blockedCalls, queuedCalls }
  }

  /** 只开票不声明：让测试自己摆 declare 的先后。 */
  async function openBare(h: Harness, goal: string): Promise<string> {
    const receipt = await h.desk.open({ goal, brief: goal }, h.main)
    return receipt.id
  }

  it('A 先 declare、B 后 declare：A 的探路子会话后收工也先跑，B 排队 waitOn A', async () => {
    const { notifier, blockedCalls, queuedCalls } = capture()
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe: fakeProbe(), notifier })
    h.desk.attach()
    const a = await openBare(h, 'A 先声明')
    const b = await openBare(h, 'B 后声明')
    const wa = h.log.get(a)!.workerId!
    const wb = h.log.get(b)!.workerId!
    await h.desk.declare(wa, { summary: 'A 先声明' }, { writes: [DIR] })
    h.clock.advance(1000)
    await h.desk.declare(wb, { summary: 'B 后声明' }, { writes: [DIR] })

    // A 的探路子会话后收工：这一刻判的是 A，但 A 是先交声明的那一侧，不许被 B 挡。
    await idle(h, wa)
    expect(h.log.get(a)!.phase).toBe('running')
    expect(h.log.get(a)!.waitOn).toBeUndefined()

    const spawnedAfterA = h.subagents.spawned.length
    await idle(h, wb)
    const queued = h.log.get(b)!
    expect(queued.phase).toBe('queued')
    expect(queued.waitOn).toEqual([{ ticketId: a, resources: [DIR] }])
    // 已经跑起来的 A 不被后到的 B 改判：phase 还是 running，也没多派一轮。
    expect(h.log.get(a)!.phase).toBe('running')
    expect(h.subagents.spawned).toHaveLength(spawnedAfterA)
    // 通知到开票方：进排队那一刻恰好一条，指名 publisher；放行不再推。
    expect(blockedCalls).toHaveLength(1)
    expect(blockedCalls[0]).toMatchObject({
      ticketId: b,
      brief: 'B 后声明',
      publisher: 'session-main',
      waitOn: [{ ticketId: a, brief: 'A 先声明', resources: [DIR] }],
    })
    expect(queuedCalls).toHaveLength(1)
    expect(queuedCalls[0]).toMatchObject({
      ticketId: b,
      brief: 'B 后声明',
      publisher: 'session-main',
      waitOn: [{ ticketId: a, brief: 'A 先声明', resources: [DIR] }],
    })

    await h.desk.close(a, { actor: h.main })
    expect(h.log.get(b)!.phase).toBe('running')
    expect(h.log.get(b)!.waitOn).toBeUndefined()
    expect(queuedCalls).toHaveLength(1)
  })

  it('反向：B 后开票但先 declare，先到先得跟着 declare 顺序走', async () => {
    const h = desk()
    // A 的票号在前（seq 小），B 的票号在后：只看票号会判反。
    const a = await openBare(h, 'A 后声明')
    const b = await openBare(h, 'B 先声明')
    const wa = h.log.get(a)!.workerId!
    const wb = h.log.get(b)!.workerId!
    await h.desk.declare(wb, { summary: 'B 先声明' }, { writes: [DIR] })
    h.clock.advance(1000)
    await h.desk.declare(wa, { summary: 'A 后声明' }, { writes: [DIR] })

    await idle(h, wb)
    expect(h.log.get(b)!.phase).toBe('running')
    await idle(h, wa)
    const queued = h.log.get(a)!
    expect(queued.phase).toBe('queued')
    expect(queued.waitOn).toEqual([{ ticketId: b, resources: [DIR] }])
  })

  it('声明时刻一模一样时退回排队序号：先开的票先跑', async () => {
    const h = desk()
    const a = await openBare(h, '同一毫秒的 A')
    const b = await openBare(h, '同一毫秒的 B')
    const wa = h.log.get(a)!.workerId!
    const wb = h.log.get(b)!.workerId!
    // 一秒都不推：两边的 declaredAt 完全一样。
    await h.desk.declare(wa, { summary: 'A' }, { writes: [DIR] })
    await h.desk.declare(wb, { summary: 'B' }, { writes: [DIR] })

    await idle(h, wa)
    expect(h.log.get(a)!.phase).toBe('running')
    await idle(h, wb)
    expect(h.log.get(b)!.phase).toBe('queued')
    expect(h.log.get(b)!.waitOn).toEqual([{ ticketId: a, resources: [DIR] }])
  })
})


/**
 * A2 漏唤醒兜底：巡检每拍看一遍排队的票，前票不在了/已终态/被重启掐死都当场
 * 放行，不等 close 事件。三条票都是用真事件预置的冷日志，开一只新 desk 接上，
 * 等价于「进程重启后第一次巡检」。
 */
describe('A2 巡检兜底放行', () => {
  const NOW = new Date('2026-11-14T12:00:00.000Z')
  const at = (minutesAgo: number): string => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()

  function ticket(id: string, minutesAgo: number): Array<Record<string, unknown>> {
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

  function blockedOn(waitId: string | null): MemoryBackend {
    const backend = new MemoryBackend()
    const events = [
      ...ticket('t-blocked', 5),
      { kind: 'conflict-checked', id: 't-blocked', at: at(4), cause: 'reaction', level: 'strong', waitOn: waitId ? [{ ticketId: waitId, resources: [DIR] }] : [] },
    ]
    for (const event of events) backend.append(event as never)
    return backend
  }

  function harness(backend: MemoryBackend): Harness {
    const h = makeDesk({ now: NOW, backend, config: { defaultPreset: 't1', sweepMs: 0 }, probe: fakeProbe() })
    return h
  }

  it('waitOn 的票被删了（日志里查不到）：下一拍自己放行', async () => {
    const h = harness(blockedOn('t-gone'))
    expect(h.log.get('t-blocked')!.phase).toBe('queued')
    await h.desk.maintain()
    const ticket = h.log.get('t-blocked')!
    expect(ticket.phase).toBe('running')
    expect(ticket.status).toBe('running')
    expect(h.subagents.spawned.map((spec) => spec.label)).toHaveLength(1)
  })

  it('waitOn 的票被手工 close（终态）：下一拍自己放行', async () => {
    const backend = new MemoryBackend()
    for (const event of [
      ...ticket('t-close', 9),
      { kind: 'closed', id: 't-close', at: at(8), cause: 'tool', outcome: 'done' },
      ...ticket('t-blocked', 5),
      { kind: 'conflict-checked', id: 't-blocked', at: at(4), cause: 'reaction', level: 'strong', waitOn: [{ ticketId: 't-close', resources: [DIR] }] },
    ]) backend.append(event as never)
    const h = harness(backend)
    await h.desk.maintain()
    expect(h.log.get('t-blocked')!.phase).toBe('running')
    expect(h.subagents.spawned).toHaveLength(1)
  })

  it('前票 worker 被重启掐死：先落 waiting，再把后票放行', async () => {
    const backend = new MemoryBackend()
    for (const event of [
      ...ticket('t-dead', 10),
      // 前票已经放行过（phase=running 才算真的在执行轮上跑），worker 随后被重启掐死。
      { kind: 'conflict-checked', id: 't-dead', at: at(9), cause: 'reaction', level: 'none', waitOn: [] },
      ...ticket('t-blocked', 5),
      { kind: 'conflict-checked', id: 't-blocked', at: at(4), cause: 'reaction', level: 'strong', waitOn: [{ ticketId: 't-dead', resources: [DIR] }] },
    ]) backend.append(event as never)
    const h = harness(backend)
    // 活表里只有主会话：worker-t-dead 已经不在，t-dead 又是 running，巡检要先收它。
    expect(h.agents.get('worker-t-dead')).toBeUndefined()
    await h.desk.maintain()
    const dead = h.log.get('t-dead')!
    expect(dead.status).toBe('waiting')
    expect(dead.workerAlive).toBe(false)
    const blocked = h.log.get('t-blocked')!
    expect(blocked.phase).toBe('running')
    expect(blocked.status).toBe('running')
    expect(h.subagents.spawned).toHaveLength(1)
  })
})

/**
 * A1 长短等：排队超过 longWaitMinutes（默认 15）就放掉原 worker，短等保持挂着。
 * 阈值依据见 defaults.ts：历史票时长 P90 16.7 分钟，5 分钟会把绝大多数等待都判长等。
 */
describe('A1 长短等', () => {
  async function queued(): Promise<{ h: Harness; first: string; second: string }> {
    const h = desk()
    const first = await openProbe(h, '先占目录', [DIR])
    await idle(h, 'worker-1')
    // 第一张放行后派了执行轮：活表里要有它，否则 A2 的巡检兜底会先把它收成 waiting。
    h.agents.markAlive(h.log.get(first)!.workerId!)
    const second = await openProbe(h, '排队等目录', [DIR])
    await idle(h, h.log.get(second)!.workerId!)
    expect(h.log.get(second)!.phase).toBe('queued')
    h.agents.markAlive(h.log.get(second)!.workerId!)
    return { h, first, second }
  }

  it('短等：不到阈值不动 worker，票继续排队', async () => {
    const { h, second } = await queued()
    const worker = h.log.get(second)!.workerId!
    h.clock.advance(14 * 60_000)
    await h.desk.maintain()
    expect(h.subagents.disposed).not.toContain(worker)
    const ticket = h.log.get(second)!
    expect(ticket.phase).toBe('queued')
    expect(ticket.status).toBe('running')
    expect(ticket.workerId).toBe(worker)
  })

  it('长等：到点放掉 worker，前票还在时不派；前票关掉后新起一只', async () => {
    const { h, first, second } = await queued()
    const worker = h.log.get(second)!.workerId!
    h.clock.advance(16 * 60_000)
    await h.desk.maintain()

    expect(h.subagents.disposed).toContain(worker)
    const waiting = h.log.get(second)!
    expect(waiting.phase).toBe('queued')
    expect(waiting.status).toBe('waiting')
    expect(h.warnings.join('\n')).toContain('放掉 worker')

    // 前票还占着：下一拍仍然不派，别把排队票提前放出去。
    const spawnedBefore = h.subagents.spawned.length
    await h.desk.maintain()
    expect(h.subagents.spawned).toHaveLength(spawnedBefore)
    expect(h.log.get(second)!.phase).toBe('queued')

    // 前票收工：放行时原 worker 已经不在（真宿主 abort 后活表里也会摘掉），
    // 新起一只，workerId 换人。
    h.agents.markGone(worker)
    await h.desk.close(first, { outcome: 'done', actor: h.main })
    await flush()
    const released = h.log.get(second)!
    expect(released.phase).toBe('running')
    expect(released.workerId).not.toBe(worker)
    expect(h.subagents.spawned).toHaveLength(spawnedBefore + 1)
  })
})

describe('A6 一个词只许一个意思', () => {
  it('等资源写 phase=queued、status 不动；等人写 status=blocked、phase 不动', async () => {
    const h = desk()
    const first = await openProbe(h, '占目录', [DIR])
    const second = await openProbe(h, '等目录', [DIR])
    await idle(h, h.log.get(second)!.workerId!)

    const queued = h.log.get(second)!
    expect(queued.phase).toBe('queued')
    expect(queued.status).toBe('running')

    await h.desk.block(first, '等使用方拍板', h.main)
    const held = h.log.get(first)!
    expect(held.status).toBe('blocked')
    expect(held.phase).toBe('planned')
  })
})

describe('脏资源串在票台上只 warn 不打断', () => {
  it('历史票声明里有 cmd:：warn 带票号与原文，合法资源照常判强、票照常排队', async () => {
    // 新声明已经在 declare 入口拒掉了，这里用冷日志模拟历史脏票（append-only 不改）。
    const NOW = new Date('2026-11-14T12:00:00.000Z')
    const at = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString()
    const backend = new MemoryBackend()
    const base = (id: string, minutes: number, writes: string[]): Array<Record<string, unknown>> => [
      { kind: 'published', id, at: at(minutes), goal: id, brief: id, publisher: 'session-main', preset: 't1', presetSource: 'fallback' },
      { kind: 'spawned', id, at: at(minutes), cause: 'tool', workerId: `worker-${id}`, preset: 't1' },
      { kind: 'declared', id, at: at(minutes), cause: 'tool', plan: { summary: id }, intent: { writes }, workerId: `worker-${id}` },
    ]
    for (const event of [...base('t-block', 6, [DIR]), ...base('t-bad', 5, [DIR, 'cmd:dsh --dump-config'])]) {
      backend.append(event as never)
    }
    const h = makeDesk({ now: NOW, backend, config: { defaultPreset: 't1', sweepMs: 0 }, probe: fakeProbe() })
    await h.desk.maintain()

    expect(h.warnings.join('\n')).toContain('票 t-bad 的资源串不合法')
    expect(h.warnings.join('\n')).toContain('cmd:dsh --dump-config')
    expect(h.log.get('t-bad')!.phase).toBe('queued')
    expect(h.log.get('t-bad')!.waitOn?.[0]?.ticketId).toBe('t-block')
  })
})
