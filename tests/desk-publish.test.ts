import { describe, expect, it } from 'vitest'
import type { Published, Spawned } from '../src/store'
import { fakeClassifier, fakePresets, INTENT, makeDesk, TEST_PRESETS } from './helpers/desk-harness'
import { fakeAgents } from './helpers/desk-harness'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('开票：定档', () => {
  it('没有分类器就用配置的默认档，source 写 fallback', async () => {
    const h = makeDesk()
    const receipt = await h.desk.open(INTENT, h.main)
    expect(receipt.status).toBe('running')
    expect(receipt.preset).toBe('t1')
    expect(receipt.presetSource).toBe('fallback')
    // 回执是给工具看的：不许带内部字段（workerId 是票台自己的账）。
    expect(receipt).not.toHaveProperty('workerId')
    const published = h.backend.events_[0] as Published
    expect(published).toMatchObject({
      kind: 'published',
      goal: '把票台拆出来',
      brief: '拆票台',
      publisher: 'session-main',
      preset: 't1',
      presetSource: 'fallback',
      requestId: 'req-1',
      device: 'board-test',
    })
  })

  it('分类器说哪档就是哪档，理由一起落盘', async () => {
    const h = makeDesk({ classify: fakeClassifier({ preset: 't2', why: '要慢慢查' }) })
    const receipt = await h.desk.open(INTENT, h.main)
    expect(receipt.preset).toBe('t2')
    expect(receipt.presetSource).toBe('llm')
    expect((h.backend.events_[0] as Published).presetWhy).toBe('要慢慢查')
  })

  it('static 策略下一次分类器都不调', async () => {
    const classify = fakeClassifier('t2')
    const h = makeDesk({ classify, config: { defaultPreset: 't1', presetStrategy: 'static' } })
    const receipt = await h.desk.open(INTENT, h.main)
    expect(receipt.preset).toBe('t1')
    expect(classify.calls).toBe(0)
  })

  it('主会话自己挂了档：用它，source 记 router', async () => {
    const classify = fakeClassifier('t2')
    const h = makeDesk({ classify, routerPreset: 't2' })
    const receipt = await h.desk.open(INTENT, h.main)
    expect(receipt.preset).toBe('t2')
    expect(receipt.presetSource).toBe('router')
    expect(classify.calls).toBe(0)
  })

  it('分类器超时就回落默认档，不把开票卡死', async () => {
    const h = makeDesk({
      classify: fakeClassifier('hang'),
      config: { defaultPreset: 't1', classifyTimeoutMs: 8000 },
    })
    const pending = h.desk.open(INTENT, h.main)
    await tick()
    h.clock.advance(8000)
    const receipt = await pending
    expect(receipt.preset).toBe('t1')
    expect(receipt.presetSource).toBe('fallback')
    expect(h.warnings.join()).toContain('超时')
    // 选档慢是选档的事：票照常建、活照常派。
    expect(h.subagents.spawned).toHaveLength(1)
  })

  it('分类器报错也回落默认档', async () => {
    const h = makeDesk({ classify: fakeClassifier(new Error('模型挂了')) })
    const receipt = await h.desk.open(INTENT, h.main)
    expect(receipt.preset).toBe('t1')
    expect(h.warnings.join()).toContain('模型挂了')
  })

  it('分类器给了注册表里没有的档：落默认档并记一声', async () => {
    const h = makeDesk({ classify: fakeClassifier('t9') })
    const receipt = await h.desk.open(INTENT, h.main)
    expect(receipt.preset).toBe('t1')
    expect(h.warnings.join()).toContain('t9')
  })

  it('主会话点名的档不存在：拒绝，一行都不写', async () => {
    const h = makeDesk()
    await expect(h.desk.open({ ...INTENT, preset: 't9' }, h.main)).rejects.toThrow(/没有 t9/)
    expect(h.lines()).toBe(0)
    expect(h.subagents.spawned).toHaveLength(0)
  })

  it('配置和注册表都不给默认档：拒绝，不猜', async () => {
    const h = makeDesk({ config: { defaultPreset: '' }, presets: fakePresets(TEST_PRESETS) })
    await expect(h.desk.open(INTENT, h.main)).rejects.toThrow(/默认档/)
    expect(h.lines()).toBe(0)
  })

  it('注册表是空的：拒绝', async () => {
    const h = makeDesk({ presets: fakePresets([], 't1') })
    await expect(h.desk.open(INTENT, h.main)).rejects.toThrow(/注册表/)
  })

  it('注册表自己的默认档能兜住配置没写的情况', async () => {
    const h = makeDesk({ config: { defaultPreset: '' }, presets: fakePresets(TEST_PRESETS, 't2') })
    const receipt = await h.desk.open(INTENT, h.main)
    expect(receipt.preset).toBe('t2')
  })
})

describe('开票：发布与补偿', () => {
  it('先 published 再 spawned，两行的 at 都是同一次时钟', async () => {
    const h = makeDesk()
    const receipt = await h.desk.open(INTENT, h.main)
    expect(h.backend.kinds()).toEqual(['published', 'spawned'])
    const at = h.clock.now().toISOString()
    for (const event of h.backend.events_) expect(event.at).toBe(at)
    const spawned = h.backend.events_[1] as Spawned
    expect(spawned.workerId).toBe('worker-1')
    expect(spawned.preset).toBe('t1')
    expect(spawned.device).toBe('board-test')
    expect(spawned.messageId).toBe('msg-1')
    expect(h.log.get(receipt.id)).toMatchObject({
      status: 'running',
      workerId: 'worker-1',
      epoch: 1,
      epochReports: 0,
      workerAlive: true,
      preset: 't1',
    })
  })

  it('派活用的是自己的 controller，不是调用方的 signal', async () => {
    const h = makeDesk()
    const receipt = await h.desk.open(INTENT, h.main)
    const spec = h.subagents.spawned[0]!
    expect(spec.signal).toBeInstanceOf(AbortSignal)
    expect(spec.signal.aborted).toBe(false)
    expect(spec.request.agentPreset).toBe('t1')
    expect(spec.request.prompt[0]!.text).toContain(receipt.id)
    // parent 必须是活着的那个 Agent 本体，不是它的 id。
    expect(spec.request.parent).toBe(h.agents.get('session-main'))
    expect(spec.delivery).toBe('parent')
    // 收票时这个 controller 才 abort：票台自己攥着它。
    await h.desk.close(receipt.id)
    expect(spec.signal.aborted).toBe(true)
  })

  it('spawn 失败：票停在 open，原因写进日志和 note', async () => {
    const h = makeDesk()
    h.subagents.failNext(new Error('provider 挂了'))
    await expect(h.desk.open(INTENT, h.main)).rejects.toThrow(/派活失败/)
    expect(h.backend.kinds()).toEqual(['published', 'spawn-failed'])
    const ticket = h.log.list()[0]!
    expect(ticket.status).toBe('open')
    expect(ticket.note).toContain('provider 挂了')
    expect(ticket.workerId).toBeUndefined()
  })

  it('spawn 成功但记账失败：尽力收回 worker，不假装票派好了', async () => {
    const h = makeDesk()
    h.backend.failOn = (event) => (event as { kind?: string }).kind === 'spawned'
    await expect(h.desk.open(INTENT, h.main)).rejects.toThrow(/记账失败/)
    expect(h.subagents.disposed).toEqual(['worker-1'])
    expect(h.backend.kinds()).toEqual(['published', 'spawn-failed'])
    expect(h.log.list()[0]!.status).toBe('open')
  })

  it('同一次调用重放（requestId 相同）：回执给原票，不 spawn 第二次', async () => {
    const h = makeDesk()
    const first = await h.desk.open(INTENT, h.main)
    const second = await h.desk.open(INTENT, h.main)
    expect(second.id).toBe(first.id)
    expect(second.duplicate).toBe(first.id)
    expect(h.subagents.spawned).toHaveLength(1)
    expect(h.lines()).toBe(2)
  })

  it('同一个人同一件事窗口内又开一张：指向已有票，不重复派', async () => {
    const h = makeDesk()
    const first = await h.desk.open(INTENT, h.main)
    const again = await h.desk.open({ ...INTENT, requestId: 'req-2' }, h.main)
    expect(again.id).toBe(first.id)
    expect(h.subagents.spawned).toHaveLength(1)
    // 出了窗口就能再开：这可能是真的新一轮活。
    h.clock.advance(11 * 60_000)
    const later = await h.desk.open({ ...INTENT, requestId: 'req-3' }, h.main)
    expect(later.id).not.toBe(first.id)
    expect(h.subagents.spawned).toHaveLength(2)
  })

  it('未收工的票到上限：拒绝开新的', async () => {
    const h = makeDesk({ config: { defaultPreset: 't1', maxOpen: 1 } })
    await h.desk.open(INTENT, h.main)
    await expect(
      h.desk.open({ ...INTENT, goal: '另一件事', requestId: 'req-2' }, h.main),
    ).rejects.toThrow(/上限/)
  })

  it('brief 为空或 goal 为空：拒绝，一行都不写', async () => {
    const h = makeDesk()
    await expect(h.desk.open({ ...INTENT, brief: '  ' }, h.main)).rejects.toThrow(/brief/)
    await expect(h.desk.open({ ...INTENT, goal: ' ' }, h.main)).rejects.toThrow(/goal/)
    expect(h.lines()).toBe(0)
  })

  it('主会话不在活表里：拒绝，因为投递没有合法 sender', async () => {
    const h = makeDesk({ agents: fakeAgents('session-other') })
    await expect(h.desk.open(INTENT, h.main)).rejects.toThrow(/活表/)
    expect(h.lines()).toBe(0)
  })

  it('开出来的票在 list() 里带 statusSince 和 epoch，不带内部字段', async () => {
    const h = makeDesk()
    const receipt = await h.desk.open(INTENT, h.main)
    const view = h.desk.get(receipt.id)!
    expect(view.status).toBe('running')
    expect(view.statusSince).toBe(h.clock.now().toISOString())
    expect(view.epoch).toBe(1)
    expect(view.epochReports).toBe(0)
    expect(view.preset).toBe('t1')
    expect(view.stale).toBe(false)
    expect(view).not.toHaveProperty('workerId')
  })
})
