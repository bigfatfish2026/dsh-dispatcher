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
import { flush, makeDesk } from './helpers/desk-harness'
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
 * 2026-11-14 起 open 不收 intent，意图只能走 `dispatch_declare`；冲突判定读的
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
  return spec.request.prompt.map((block) => block.text).join('\n')
}

describe('探路收工那刻判定', () => {
  it('强冲突：票转 blocked、waitOn 记清撞谁撞什么，这一轮不派活', async () => {
    const h = desk()
    const first = await openProbe(h, '改目录甲', [DIR])
    const second = await openProbe(h, '也改目录甲', [DIR])
    expect(h.subagents.spawned.map((spec) => spec.label)).toHaveLength(2)

    await idle(h, 'worker-2')

    const blocked = h.log.get(second)!
    expect(blocked.phase).toBe('blocked')
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

  it('第二张 declare 撞车：当场通知开票方；前一张收工放行时再通知一次', async () => {
    const blockedCalls: Array<Parameters<OwnerNotifier['blocked']>[0]> = []
    const releasedCalls: Array<Parameters<OwnerNotifier['released']>[0]> = []
    const notifier: OwnerNotifier = {
      reportArrived: async () => true,
      idle: async () => true,
      noReport: async () => true,
      blocked: async (input) => {
        blockedCalls.push(input)
        return true
      },
      resumed: async () => true,
      released: async (input) => {
        releasedCalls.push(input)
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
    expect(queued.phase).toBe('blocked')
    expect(queued.waitOn).toEqual([{ ticketId: first, resources: [DIR] }])
    // 开票方当场收到：被挡的票、被谁挡的（id + brief）、撞在哪些路径上。
    expect(blockedCalls).toHaveLength(1)
    expect(blockedCalls[0]).toMatchObject({
      ticketId: second,
      brief: '抢目录',
      wake: true,
      waitOn: [{ ticketId: first, resources: [DIR], brief: '占住目录' }],
    })

    await h.desk.close(first)
    await flush()

    expect(h.log.get(second)!.phase).not.toBe('blocked')
    // 放行也吱一声：谁放行的、轮到谁了。
    expect(releasedCalls).toHaveLength(1)
    expect(releasedCalls[0]).toMatchObject({
      ticketId: second,
      brief: '抢目录',
      releasedBy: [first],
    })
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

  it('降级票仍按目录兜底算写：声明没等到，别当成不冲突', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0, probeTimeoutMinutes: 2 },
      probe: fakeProbe(),
    })
    h.desk.attach()
    const blocker = await openProbe(h, '改目录甲', [DIR])
    // 挡路那张先真的跑起来：探路收工、派执行轮，它已经是 running 的写入方。
    await idle(h, 'worker-1')
    expect(h.log.get(blocker)!.phase).toBe('running')
    const receipt = await h.desk.open(
      { goal: '只交了半截的降级票', brief: '降级票', dir: '/tmp/conflict-ws' },
      h.main,
    )
    const planner = receipt.id
    h.clock.advance(3 * 60_000)
    // 降级当拍就判：撞上占着这片目录的票就排队，不等探路子会话 idle。
    await h.desk.maintain()
    const degraded = h.log.get(planner)!
    expect(degraded.degraded).toBe(true)

    const blocked = h.log.get(planner)!
    expect(blocked.phase).toBe('blocked')
    expect(blocked.waitOn).toEqual([{ ticketId: blocker, resources: [DIR] }])
    // 判输了不派：两只探路 + 一张执行轮，planner 没有执行轮。
    expect(h.subagents.spawned).toHaveLength(3)
  })
})

describe('收工放行', () => {
  it('关掉挡路的票：探路那只还活着就把执行轮投回同一个会话，不再起新的一只', async () => {
    const h = desk()
    const blocker = await openProbe(h, '先改目录甲', [DIR])
    const waiter = await openProbe(h, '后改目录甲', [DIR])
    await idle(h, 'worker-2')
    expect(h.log.get(waiter)!.phase).toBe('blocked')
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
    expect(h.log.get(waiter)!.phase).toBe('blocked')

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
    expect(h.log.get(second)!.phase).toBe('blocked')
    expect(h.log.get(third)!.phase).toBe('blocked')
    const before = h.subagents.spawned.length

    // 关掉第一张：只放行第二张，第三张还得排在后面等。
    await h.desk.close(first, { actor: h.main })
    expect(h.log.get(second)!.phase).toBe('running')
    expect(h.log.get(third)!.phase).toBe('blocked')
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
      expect(h.log.get(second)!.phase).toBe('blocked')
      expect(h.log.get(third)!.phase).toBe('blocked')

      // 放行一次只走一张，顺序就是开票顺序：先关第一张，只有第二张能动。
      await h.desk.close(first, { actor: h.main })
      expect(h.subagents.spawned.at(-1)!.label).toContain(second)
      expect(h.log.get(second)!.phase).toBe('running')
      expect(h.log.get(third)!.phase).toBe('blocked')
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
  /** 记下 notifier 被叫了哪些：blocked / released 各自一条一条攒。 */
  function capture(): {
    notifier: OwnerNotifier
    blockedCalls: Array<Parameters<OwnerNotifier['blocked']>[0]>
    releasedCalls: Array<Parameters<OwnerNotifier['released']>[0]>
  } {
    const blockedCalls: Array<Parameters<OwnerNotifier['blocked']>[0]> = []
    const releasedCalls: Array<Parameters<OwnerNotifier['released']>[0]> = []
    const notifier: OwnerNotifier = {
      reportArrived: async () => true,
      idle: async () => true,
      noReport: async () => true,
      blocked: async (input) => {
        blockedCalls.push(input)
        return true
      },
      resumed: async () => true,
      released: async (input) => {
        releasedCalls.push(input)
        return true
      },
    }
    return { notifier, blockedCalls, releasedCalls }
  }

  /** 只开票不声明：让测试自己摆 declare 的先后。 */
  async function openBare(h: Harness, goal: string): Promise<string> {
    const receipt = await h.desk.open({ goal, brief: goal }, h.main)
    return receipt.id
  }

  it('A 先 declare、B 后 declare：A 的探路子会话后收工也先跑，B 排队 waitOn A', async () => {
    const { notifier, blockedCalls, releasedCalls } = capture()
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
    expect(queued.phase).toBe('blocked')
    expect(queued.waitOn).toEqual([{ ticketId: a, resources: [DIR] }])
    // 已经跑起来的 A 不被后到的 B 改判：phase 还是 running，也没多派一轮。
    expect(h.log.get(a)!.phase).toBe('running')
    expect(h.subagents.spawned).toHaveLength(spawnedAfterA)
    // 通知到开票方：被挡那一刻一条，放行再一条，都指名 publisher。
    expect(blockedCalls).toHaveLength(1)
    expect(blockedCalls[0]).toMatchObject({
      ticketId: b,
      brief: 'B 后声明',
      publisher: 'session-main',
      wake: true,
      waitOn: [{ ticketId: a, brief: 'A 先声明', resources: [DIR] }],
    })

    await h.desk.close(a, { actor: h.main })
    expect(h.log.get(b)!.phase).toBe('running')
    expect(h.log.get(b)!.waitOn).toBeUndefined()
    expect(releasedCalls).toHaveLength(1)
    expect(releasedCalls[0]).toMatchObject({ ticketId: b, publisher: 'session-main', releasedBy: [a] })
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
    expect(queued.phase).toBe('blocked')
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
    expect(h.log.get(b)!.phase).toBe('blocked')
    expect(h.log.get(b)!.waitOn).toEqual([{ ticketId: a, resources: [DIR] }])
  })
})
