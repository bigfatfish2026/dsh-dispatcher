/**
 * 挂起那一刻要留一条事实：主会话下一回合在 runtime context 里就该看见，
 * 不是等鱼来报，也不能靠 `progress_note` / `followup` 往会话里塞消息。
 *
 * 这里查三件事——挂起当场有；收工以后没了；冲突排队被放行后也没了。
 */
import { describe, expect, it } from 'vitest'
import { createNotifier } from '../src/tickets/notify'
import type { ProbePort, ProbeRegistry } from '../src/tickets/probe'
import { createSweepFacts } from '../src/tickets/sweep-facts'
import { INTENT, flush, makeDesk } from './helpers/desk-harness'
import type { Harness } from './helpers/desk-harness'

const DIR = 'dir:/tmp/facts-ws'

function fakeProbe(): ProbePort & ProbeRegistry {
  return {
    expect: () => undefined,
    drop: () => undefined,
    release: () => true,
    releaseTicket: () => true,
  }
}

function setup() {
  const facts = createSweepFacts()
  const h: Harness = makeDesk({
    config: { defaultPreset: 't1', sweepMs: 0 },
    notifier: createNotifier({ facts }),
    probe: fakeProbe(),
  })
  h.desk.attach()
  return { h, facts }
}

async function probeOpen(h: Harness, goal: string): Promise<string> {
  const receipt = await h.desk.open({ goal, brief: goal }, h.main)
  const workerId = h.log.get(receipt.id)!.workerId!
  await h.desk.declare(workerId, { summary: goal }, { writes: [DIR] })
  return receipt.id
}

async function idle(h: Harness, worker: string): Promise<void> {
  h.host.emit('agent/status', { status: 'idle', agent: { id: worker } })
  await flush()
}

describe('挂起留一条事实', () => {
  it('人工挂起：当场写事实，收工后撤掉', async () => {
    const { h, facts } = setup()
    const { id } = await h.desk.open(INTENT, h.main)

    await h.desk.block(id, '等维护者拍板')
    const text = facts.text()
    expect(text).toContain(`票 ${id}`)
    expect(text).toContain('等维护者拍板')
    expect(text).toContain('挂起')
    // 中文一行，别把内部枚举名漏给主会话。
    expect(text).not.toContain('blocked')

    await h.desk.close(id)
    await flush()
    expect(facts.text()).not.toContain(id)
  })

  it('冲突挂起：写明撞了谁、等谁关；被放行后那条撤掉', async () => {
    const { h, facts } = setup()
    const blocker = await probeOpen(h, '占住目录')
    const waiting = await probeOpen(h, '抢目录')

    await idle(h, 'worker-2')
    expect(h.log.get(waiting)!.phase).toBe('queued')
    expect(facts.text()).toContain(`票 ${waiting} 因 ${DIR} 与 ${blocker}「占住目录」 冲突挂起，等它关闭后放行。`)
    expect(facts.text()).not.toContain('blocked')

    await h.desk.close(blocker)
    await flush()
    expect(h.log.get(waiting)!.phase).not.toBe('queued')
    expect(facts.text()).not.toContain(waiting)
  })

  it('排队票被关掉：那条事实跟着撤，不会留个死票号', async () => {
    const { h, facts } = setup()
    await probeOpen(h, '占住目录')
    const waiting = await probeOpen(h, '抢目录')
    await idle(h, 'worker-2')
    expect(facts.text()).toContain(waiting)

    await h.desk.close(waiting)
    await flush()
    expect(facts.text()).not.toContain(waiting)
  })
})
