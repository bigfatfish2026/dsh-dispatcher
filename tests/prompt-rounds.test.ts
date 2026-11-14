import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/tickets/publish'
import { flush, INTENT, TEST_PRESETS, fakePresets, makeDesk } from './helpers/desk-harness'

/**
 * 派活任务书按轮次分三套：探路轮只读、执行轮照旧、降级轮直接干。
 *
 * 这三套是子会话唯一能读到的「这一轮能干什么」，所以断言的是给子会话看的话：
 * 探路轮必须自己说清只读和 dispatch_declare（不然它进只读窗口只会撞拒，
 * 还不知道要声明）；执行轮必须带上原任务原文；降级轮必须认一句探路超时。
 * 原任务一个字都不许截，所以 goal 用一条长的、带标点的。
 */
const TICKET = 't-mwdshirf-962x'
const GOAL =
  '补一个大洞：只读探路窗口和 dispatch_declare 都装好了，但派给探路子会话的任务书还是原来那份，子会话进了只读轮会被工具拒。这一批只改派活时那段任务书文本。'

const base = { ticketId: TICKET, goal: GOAL, brief: '派活任务书按轮次分三套' }

describe('buildPrompt：三套任务书', () => {
  it('探路轮说清只读和 dispatch_declare，让人交完就停', () => {
    const prompt = buildPrompt({ ...base, epoch: 1, round: 'probe' })

    // 这一轮能干、不能干，都得自己说在前面。
    expect(prompt).toContain('只读')
    expect(prompt).toContain('write / edit / bash')
    expect(prompt).toContain('dispatch_declare')
    expect(prompt).toContain('plan')
    expect(prompt).toContain('intent')
    expect(prompt).toContain('reversibility')
    expect(prompt).toContain('报完就直接交活')

    // 票号和原任务全文一个字不少。
    expect(prompt).toContain(TICKET)
    expect(prompt).toContain(GOAL)
  })

  it('探路轮没有一句让子会话去改文件的话', () => {
    const prompt = buildPrompt({ ...base, epoch: 1, round: 'probe' })

    // 「别试着改文件」是拦人的，不算派活；真正要拦的是「动手改 / 直接改」这类说法。
    expect(prompt).not.toMatch(/动手改|开始改|直接改|把.{0,12}改掉|修好|改完/)
    expect(prompt).not.toContain('只动声明里写过的资源')
    // 探路轮只交声明，不提收尾自报。
    expect(prompt).not.toContain('dispatch_touch')
  })

  it('执行轮带原任务原文和探路声明过的资源，末尾提醒别越界', () => {
    const prompt = buildPrompt({
      ...base,
      epoch: 2,
      round: 'task',
      declared: {
        writes: ['file:src/tickets/publish.ts', 'dir:tests'],
        reads: ['dir:src/tickets'],
        reversibility: 'auto',
      },
    })

    expect(prompt).toContain(GOAL)
    expect(prompt).toContain(TICKET)
    expect(prompt).toContain('你探路时声明了这些资源')
    expect(prompt).toContain('file:src/tickets/publish.ts')
    expect(prompt).toContain('dir:tests')
    expect(prompt).toContain('dir:src/tickets')
    // 原任务的规矩照旧，不能为了换轮次丢话。
    expect(prompt).toContain('交活只走 dispatch_report')
    expect(prompt).toContain('只动声明里写过的资源，声明之外的东西一律别碰。')
    // 收尾自报在最后一句：执行轮干完要报实际碰过的文件，关票时对账。
    expect(prompt.trimEnd().endsWith('干完顺手用 dispatch_touch 报一下你实际碰过哪些文件。')).toBe(true)
  })

  it('执行轮没有声明时明说，不装成有', () => {
    const prompt = buildPrompt({ ...base, epoch: 2, round: 'task' })

    expect(prompt).toContain('探路时没交资源声明')
    expect(prompt).toContain(GOAL)
  })

  it('降级轮认一句探路超时，直接干并补声明', () => {
    const prompt = buildPrompt({
      ...base,
      epoch: 2,
      round: 'degraded',
      declared: { writes: [] },
    })

    expect(prompt).toContain('探路超时')
    expect(prompt).toContain('直接干')
    expect(prompt).toContain('dispatch_declare')
    expect(prompt).toContain(GOAL)
    expect(prompt).toContain(TICKET)
    // 降级轮也是执行轮：收尾照样要报实际碰过的文件。
    expect(prompt).toContain('dispatch_touch')
    // 降级票没有可信声明，别拿空声明去划边界。
    expect(prompt).not.toContain('你探路时声明了这些资源')
  })

  it('不传轮次就当执行轮', () => {
    const prompt = buildPrompt({ ...base, epoch: 1 })

    expect(prompt).toContain(GOAL)
    expect(prompt).toContain('探路时没交资源声明')
    expect(prompt).toContain('只动声明里写过的资源')
    expect(prompt).toContain('dispatch_touch')
    expect(prompt).not.toContain('探路超时')
    expect(prompt).not.toContain('这一轮是只读轮')
  })
})

/**
 * 派活那两处调用点的接线：只测 buildPrompt 当然过，漏传 round 的话线上还是老
 * 任务书、子会话照样撞只读窗口。所以再开两票，看真派出去的那段文本。
 */
describe('派活接线：任务书按轮次真的换了', () => {
  const probePort = {
    expect: () => {},
    drop: () => {},
    release: () => true,
    releaseTicket: () => true,
  }

  it('探路票第一轮派出去的是只读任务书', async () => {
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe: probePort })
    await h.desk.open({ ...INTENT }, h.main)
    const text = h.subagents.spawned[0]!.request.prompt[0]!.text
    expect(text).toContain('这一轮是只读轮')
    expect(text).toContain('dispatch_declare')
    expect(text).toContain(INTENT.goal)
    // 探路轮不许有一句让它动手的话。
    expect(text).not.toMatch(/动手改|开始改|直接改/)
  })

  it('放行后的执行轮带着探路声明，末尾画了边界', async () => {
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 }, probe: probePort })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    await h.desk.declare(
      'worker-1',
      { summary: '改 publish.ts 的任务书', files: [{ path: 'src/tickets/publish.ts', what: '按轮次出三套' }] },
      { writes: ['file:src/tickets/publish.ts'], reads: ['dir:tests'], reversibility: 'auto' },
    )
    h.desk.attach()
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()

    expect(h.log.get(id)!.workerId).toBe('worker-2')
    const text = h.subagents.spawned[1]!.request.prompt[0]!.text
    expect(text).toContain(INTENT.goal)
    expect(text).toContain('你探路时声明了这些资源')
    expect(text).toContain('file:src/tickets/publish.ts')
    expect(text).toContain('dir:tests')
    expect(text).toContain('只动声明里写过的资源，声明之外的东西一律别碰。')
    expect(text).not.toContain('这一轮是只读轮')
  })

  it('探路超时降级后投的那轮走降级任务书', async () => {
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0, probeTimeoutMinutes: 2 }, probe: probePort })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    h.clock.advance(3 * 60_000)
    // 降级当拍就派：探路那只不在活表里，这一轮是重起的一只新子会话。
    await h.desk.maintain()
    const ticket = h.log.get(id)!
    expect(ticket.degraded).toBe(true)
    expect(ticket.phase).toBe('running')
    expect(ticket.workerId).toBe('worker-2')
    expect(h.subagents.spawned).toHaveLength(2)

    const text = h.subagents.spawned[1]!.request.prompt[0]!.text
    expect(text).toContain('探路超时')
    expect(text).toContain('dispatch_declare')
    expect(text).toContain(INTENT.goal)
  })
})

/**
 * 执行轮落在哪：原会话还活着就把第 2 轮投回同一只，不再起新的一只。
 *
 * 会话的档在 spawn 时钉死（`SessionHeader.agentPreset` 是 durable 的，
 * `tools.restrict` 只减不加），followup 换不了工具面——所以探路那一轮就得用
 * 这张票干活的档，探路轮的只读靠探路窗口。这里用假注册表断言两轮的工具名单，
 * 一只真子会话都不起。
 */
describe('执行轮接线：原会话还在就 followup', () => {
  const TOOLSETS = {
    t1: {
      mode: 'allow' as const,
      names: new Set(['read', 'write', 'edit', 'bash', 'dispatch_report', 'dispatch_declare', 'dispatch_touch']),
    },
    t2: {
      mode: 'allow' as const,
      names: new Set(['read', 'glob', 'grep', 'dispatch_report', 'dispatch_declare']),
    },
  }

  function countingProbe() {
    const calls: string[] = []
    return {
      calls,
      port: {
        expect: (id: string) => {
          calls.push(`expect:${id}`)
        },
        drop: (id: string) => {
          calls.push(`drop:${id}`)
        },
        release: (id: string) => {
          calls.push(`release:${id}`)
          return true
        },
        releaseTicket: (id: string) => {
          calls.push(`releaseTicket:${id}`)
          return true
        },
      },
    }
  }

  it('放行后把第 2 轮任务书投回探路那只：同一会话、同一档、不再 spawn', async () => {
    const probe = countingProbe()
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      probe: probe.port,
      presets: fakePresets(TEST_PRESETS, 't1', TOOLSETS),
    })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    expect(h.subagents.spawned).toHaveLength(1)
    expect(h.subagents.spawned[0]!.request.prompt[0]!.text).toContain('这一轮是只读轮')

    await h.desk.declare(
      'worker-1',
      { summary: '改 publish.ts 的任务书', files: [{ path: 'src/tickets/publish.ts', what: '按轮次出三套' }] },
      { writes: ['file:src/tickets/publish.ts'], reads: ['dir:tests'], reversibility: 'auto' },
    )
    // 探路那只交完声明只是 idle，会话还在活表里——这正是能复用的那个状态。
    h.agents.markAlive('worker-1')
    h.desk.attach()
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()

    const ticket = h.log.get(id)!
    expect(h.subagents.spawned).toHaveLength(1)
    expect(h.subagents.sent).toHaveLength(1)
    expect(h.subagents.sent[0]!.target).toBe('worker-1')
    expect(ticket.workerId).toBe('worker-1')
    expect(ticket.epoch).toBe(2)
    expect(ticket.status).toBe('running')
    expect(h.backend.kinds().filter((kind) => kind === 'spawned')).toHaveLength(1)
    expect(h.backend.kinds()).toContain('resumed')

    // 投进去的是执行轮任务书：带探路声明、末尾要收尾自报。
    const text = h.subagents.sent[0]!.text
    expect(text).toContain('第 2 轮')
    expect(text).toContain(INTENT.goal)
    expect(text).toContain('你探路时声明了这些资源')
    expect(text).toContain('file:src/tickets/publish.ts')
    expect(text).toContain('只动声明里写过的资源，声明之外的东西一律别碰。')
    expect(text).not.toContain('这一轮是只读轮')

    // 会话档没换，工具名单里照样有 dispatch_touch。
    expect(ticket.preset).toBe('t1')
    expect(TOOLSETS.t1.names.has('dispatch_touch')).toBe(true)
    expect(h.subagents.sent[0]!.target).toBe('worker-1')
    // 探路窗口只在第一轮登记过一次，第二轮不重开。
    expect(probe.calls.filter((call) => call.startsWith('expect'))).toHaveLength(1)
    expect(h.warnings.join('')).not.toContain('dispatch_touch')
  })

  it('降级轮也投回原会话，任务书认探路超时', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0, probeTimeoutMinutes: 2 },
      probe: countingProbe().port,
      presets: fakePresets(TEST_PRESETS, 't1', TOOLSETS),
    })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    // 探路那只还在活表里：降级当拍就把降级轮 steer 回同一个会话，不再新起一只。
    h.agents.markAlive('worker-1')
    h.clock.advance(3 * 60_000)
    await h.desk.maintain()
    expect(h.log.get(id)!.degraded).toBe(true)

    expect(h.subagents.spawned).toHaveLength(1)
    const text = h.subagents.sent[0]!.text
    expect(h.subagents.sent[0]!.target).toBe('worker-1')
    expect(text).toContain('探路超时')
    expect(text).toContain('dispatch_declare')
    expect(text).toContain('dispatch_touch')
    expect(h.log.get(id)!.epoch).toBe(2)
  })

  it('原 worker 真没了（活表里查不到）才 spawn 新的一只', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      probe: countingProbe().port,
      presets: fakePresets(TEST_PRESETS, 't1', TOOLSETS),
    })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    await h.desk.declare(
      'worker-1',
      { summary: '改一处', files: [{ path: 'src/tickets/publish.ts' }] },
      { writes: ['file:src/tickets/publish.ts'], reads: [] },
    )
    // 会话被 ended / 重启 sweep 掉了：活表里没有它，只能重起一只。
    h.agents.markGone('worker-1')
    h.desk.attach()
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()

    expect(h.subagents.spawned).toHaveLength(2)
    expect(h.subagents.sent).toHaveLength(0)
    expect(h.log.get(id)!.workerId).toBe('worker-2')
  })

  it('探路票不吃主会话当前挂的档：routerPreset 是 t2，探路的会话档还是 t1', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      probe: countingProbe().port,
      presets: fakePresets(TEST_PRESETS, 't1', TOOLSETS),
      routerPreset: 't2',
    })
    const { id } = await h.desk.open({ ...INTENT }, h.main)

    // 会话档钉死在 spawn，落成只读档连 write / edit 都收不回来；探路那轮的
    // 只读靠窗口那三件 deny，不吃主会话当前挂的档。
    expect(h.subagents.spawned[0]!.request.agentPreset).toBe('t1')
    expect(h.log.get(id)!.preset).toBe('t1')

    await h.desk.declare('worker-1', { summary: '改一处' }, { writes: [], reads: [] })
    h.agents.markAlive('worker-1')
    h.desk.attach()
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()

    // 没有「非探路票」了：所有票一律不认主会话挂的档，按分类器选。
    expect(h.log.get(id)!.workerId).toBe('worker-1')
    expect(h.log.get(id)!.preset).toBe('t1')

    const plain = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      presets: fakePresets(TEST_PRESETS, 't1', TOOLSETS),
      routerPreset: 't2',
      classify: { async classify() { return 't2' } },
    })
    const receipt = await plain.desk.open(INTENT, plain.main)
    expect(receipt.preset).toBe('t2')
    expect(receipt.presetSource).toBe('llm')
  })

  it('重新 spawn 时分类器给的档没有 bash：驳回去，票挂起等人换档', async () => {
    const answers: unknown[] = ['t1', { preset: 't2', needsCommand: true }]
    const classify = {
      calls: 0,
      async classify() {
        const answer = answers[Math.min(classify.calls, answers.length - 1)]
        classify.calls += 1
        return answer as { preset: string; needsCommand?: boolean }
      },
    }
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      probe: countingProbe().port,
      presets: fakePresets(TEST_PRESETS, 't1', TOOLSETS),
      classify,
    })
    const { id } = await h.desk.open({ ...INTENT }, h.main)
    await h.desk.declare('worker-1', { summary: '改一处' }, { writes: [], reads: [] })
    h.agents.markGone('worker-1')
    h.desk.attach()
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()

    // 驳回就不派：第二只没起来，票落到 waiting + note，等人换档。
    expect(classify.calls).toBe(2)
    expect(h.subagents.spawned).toHaveLength(1)
    const ticket = h.log.get(id)!
    expect(ticket.status).toBe('waiting')
    expect(ticket.phase).toBe('planned')
    expect(ticket.note).toContain('执行命令')
    expect(h.backend.kinds()).toContain('gated')
    expect(h.warnings.join('')).toContain('执行轮选档驳回')
  })

  it('派活把三个票工具按 agent 层递过去：档是只读的也照递，不再指望 allow 名单', async () => {
    const attached: string[] = []
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0, rejectOnMismatch: false },
      probe: countingProbe().port,
      presets: fakePresets(TEST_PRESETS, 't1', TOOLSETS),
      workerTools: {
        attach: (workerId) => {
          attached.push(workerId)
          return true
        },
      },
    })
    const { id } = await h.desk.open({ ...INTENT, preset: 't2' }, h.main)
    expect(h.subagents.spawned[0]!.request.agentPreset).toBe('t2')
    // t2 的 allow 名单里没有 dispatch_touch：工具面靠 agent 层那一道兜住。
    expect(attached).toEqual(['worker-1'])

    await h.desk.declare('worker-1', { summary: '只查不改' }, { writes: [], reads: [] })
    h.agents.markAlive('worker-1')
    h.desk.attach()
    h.host.emit('agent/status', { status: 'idle', agent: { id: 'worker-1' } })
    await flush()

    // 执行轮投回同一个会话，顺手再伸一次手（装过就幂等跳过），不再喊「缺工具」。
    expect(attached).toEqual(['worker-1', 'worker-1'])
    expect(h.log.get(id)!.workerId).toBe('worker-1')
    expect(h.warnings.join('')).not.toContain('dispatch_touch')
  })
})
