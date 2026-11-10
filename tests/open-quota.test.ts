/**
 * 名额拆成两本账：执行（`running` 且没排队）和排队（`phase === 'blocked'`）
 * 各数各的，谁满了谁拒——绝不把 8 + 4 加成一个 12。
 *
 * 普通票开出来就 spawn 成 `running`；排队票用探路冲突造（和 conflict-desk 同一套）。
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config'
import { deskConfig } from '../src/tickets/desk'
import type { ProbePort, ProbeRegistry } from '../src/tickets/probe'
import { INTENT, flush, makeDesk } from './helpers/desk-harness'
import type { Harness } from './helpers/desk-harness'

const DIR = 'dir:/tmp/quota-ws'

function fakeProbe(): ProbePort & ProbeRegistry {
  return {
    expect: () => undefined,
    drop: () => undefined,
    release: () => true,
    releaseTicket: () => true,
  }
}

async function openN(h: Harness, n: number, tag: string): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i += 1) {
    const receipt = await h.desk.open(
      { ...INTENT, goal: `${tag}第 ${i + 1} 件`, requestId: `${tag}-${i + 1}` },
      h.main,
    )
    ids.push(receipt.id)
  }
  return ids
}

async function probeOpen(h: Harness, goal: string, dir = DIR): Promise<string> {
  const receipt = await h.desk.open(
    { goal, brief: goal, probe: true, intent: { writes: [dir] } },
    h.main,
  )
  return receipt.id
}

async function idle(h: Harness, worker: string): Promise<void> {
  h.host.emit('agent/status', { status: 'idle', agent: { id: worker } })
  await flush()
}

/** 跑一次开票，要求它被拒，返回拒绝文案。 */
async function rejection(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('这次开票本该被拒')
}

describe('执行名额 maxExec', () => {
  it('8 张在跑时第 9 张被拒：文案说清执行名额、各多少张、上限多少', async () => {
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0 } })
    const ids = await openN(h, 8, '跑活')
    expect(ids).toHaveLength(8)
    expect(h.desk.list().filter((view) => view.status === 'running')).toHaveLength(8)

    const message = await rejection(
      h.desk.open({ ...INTENT, goal: '第九件', requestId: 'req-9' }, h.main),
    )
    expect(message).toContain('执行名额满了')
    expect(message).toContain('正在干 8 张（上限 8）')
    expect(message).toContain('排队 0 张（上限 4）')
  })

  it('排队挂起的票不占执行名额', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0, maxExec: 2 },
      probe: fakeProbe(),
    })
    h.desk.attach()
    await probeOpen(h, '占住目录')
    const waiting = await probeOpen(h, '抢目录')
    await idle(h, 'worker-2')
    expect(h.log.get(waiting)!.phase).toBe('blocked')

    // 执行位只被 blocker 占着（1 张），所以还能再开一张占满 2。
    await h.desk.open({ ...INTENT, goal: '补一件', requestId: 'req-fill' }, h.main)
    const message = await rejection(
      h.desk.open({ ...INTENT, goal: '再来一件', requestId: 'req-over' }, h.main),
    )
    expect(message).toContain('执行名额满了')
    expect(message).toContain('正在干 2 张（上限 2）')
    expect(message).toContain('排队 1 张（上限 4）')
  })

  it('收工让出执行名额：关掉那张，下一张就能开', async () => {
    const h = makeDesk({ config: { defaultPreset: 't1', sweepMs: 0, maxExec: 1 } })
    const [first] = await openN(h, 1, '占位')

    const blocked = await rejection(
      h.desk.open({ ...INTENT, goal: '等着', requestId: 'req-wait' }, h.main),
    )
    expect(blocked).toContain('执行名额满了')

    await h.desk.close(first!)
    const second = await h.desk.open({ ...INTENT, goal: '等着', requestId: 'req-wait' }, h.main)
    expect(second.openCount).toBe(1)
  })
})

describe('排队名额 maxQueued', () => {
  it('排队满 4 张时第 5 张被拒：文案只报排队那本账', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      probe: fakeProbe(),
    })
    h.desk.attach()
    await probeOpen(h, '占住目录')
    const queued: string[] = []
    for (let i = 0; i < 4; i += 1) queued.push(await probeOpen(h, `抢目录第 ${i + 1} 张`))
    for (let i = 0; i < 4; i += 1) await idle(h, `worker-${i + 2}`)
    for (const id of queued) expect(h.log.get(id)!.phase).toBe('blocked')

    const message = await rejection(
      h.desk.open({ ...INTENT, goal: '第五张', requestId: 'req-queued' }, h.main),
    )
    expect(message).toContain('排队名额满了')
    expect(message).toContain('排队 4 张（上限 4）')
    // 正在干的就 blocker 那一张：两本账分开数，不是加起来 5 张、更不是 12。
    expect(message).toContain('正在干 1 张（上限 8）')
  })

  it('执行 4 张 + 排队 3 张不拒：加起来超过 4 也不算排队满', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0 },
      probe: fakeProbe(),
    })
    h.desk.attach()
    await openN(h, 3, '普通活')
    await probeOpen(h, '占住目录')
    for (let i = 0; i < 3; i += 1) await probeOpen(h, `抢目录第 ${i + 1} 张`)
    for (let i = 0; i < 3; i += 1) await idle(h, `worker-${i + 5}`)

    const receipt = await h.desk.open(
      { ...INTENT, goal: '还能开', requestId: 'req-still' },
      h.main,
    )
    expect(h.desk.get(receipt.id)!.status).toBe('running')
  })

  it('收工让出排队名额：关掉排队那张，下一张就能排进来', async () => {
    const h = makeDesk({
      config: { defaultPreset: 't1', sweepMs: 0, maxQueued: 2 },
      probe: fakeProbe(),
    })
    h.desk.attach()
    await probeOpen(h, '占住目录')
    const firstQueued = await probeOpen(h, '抢目录甲')
    await idle(h, 'worker-2')
    const secondQueued = await probeOpen(h, '抢目录乙')
    await idle(h, 'worker-3')
    expect(h.log.get(firstQueued)!.phase).toBe('blocked')
    expect(h.log.get(secondQueued)!.phase).toBe('blocked')

    const full = await rejection(probeOpen(h, '抢目录丙'))
    expect(full).toContain('排队名额满了')

    await h.desk.close(firstQueued)
    await flush()
    // 关掉一张，排队只剩第二张：新的一张排得进来（探路票先落 planning，不挤排队账）。
    const thirdQueued = await probeOpen(h, '抢目录丙')
    expect(thirdQueued).toBeTruthy()
  })
})

describe('老配置兼容', () => {
  it('只给了 maxOpen 的配置仍能加载：执行按默认 8 算，不报错', () => {
    // 老 profile 里只有 maxOpen 这一个键，宿主拿到的是原始对象，校验后才补默认。
    const parsed = Config({ maxOpen: 3 } as unknown as Parameters<typeof Config>[0])
    expect(parsed.maxOpen).toBe(3)
    expect(parsed.maxExec).toBe(8)
    expect(parsed.maxQueued).toBe(4)

    const config = deskConfig({ defaultPreset: 't1', maxOpen: 3 })
    expect(config.maxExec).toBe(8)
    expect(config.maxQueued).toBe(4)
  })
})
