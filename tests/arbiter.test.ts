import { describe, expect, it } from 'vitest'
import { foldEvents } from '../src/store'
import type { TicketEvent, TicketSnapshot } from '../src/store'
import { TicketLog } from '../src/store/log'
import { byClaimOrder, ConflictArbiter } from '../src/tickets/arbiter'
import { fakeClock } from '../src/tickets/clock'
import { MemoryBackend } from './helpers/desk-harness'

const T = (second: number): string => `2026-11-14T12:00:${String(second).padStart(2, '0')}.000Z`

function published(id: string, second: number): TicketEvent[] {
  return [
    {
      kind: 'published',
      id,
      at: T(second),
      goal: `活 ${id}`,
      brief: `活 ${id}`,
      publisher: 'session-main',
      preset: 't1',
      presetSource: 'fallback',
      seq: second,
    },
  ]
}

function tree(events: TicketEvent[]): { arbiter: ConflictArbiter; commits: TicketEvent[]; snap: (id: string) => TicketSnapshot } {
  const backend = new MemoryBackend()
  for (const event of events) backend.append(event)
  const log = new TicketLog(backend)
  const commits: TicketEvent[] = []
  const arbiter = new ConflictArbiter({
    log,
    clock: fakeClock(new Date(T(59))),
    warn: () => {},
    commit: (event) => {
      commits.push(event)
      log.commit(event)
    },
  })
  const snap = (id: string): TicketSnapshot => {
    const ticket = log.get(id)
    if (!ticket) throw new Error(`no ${id}`)
    return ticket
  }
  return { arbiter, commits, snap }
}

function declared(id: string, second: number, writes: string[], planFiles?: Array<{ path: string }>): TicketEvent {
  return {
    kind: 'declared',
    id,
    at: T(second),
    cause: 'tool',
    plan: { files: planFiles ?? [] },
    intent: { writes },
    workerId: `worker-${id}`,
  }
}

describe('ConflictArbiter：排队先后', () => {
  it('交过声明的排在没交声明的前面；同毫秒退回排队序号', () => {
    const a = { id: 'a', createdAt: T(0), declaredAt: T(5), seq: 9 } as TicketSnapshot
    const b = { id: 'b', createdAt: T(1), declaredAt: undefined, seq: 1 } as TicketSnapshot
    const c = { id: 'c', createdAt: T(2), declaredAt: T(5), seq: 3 } as TicketSnapshot
    expect(byClaimOrder(a, b)).toBe(-1)
    expect(byClaimOrder(b, a)).toBe(1)
    expect(byClaimOrder(a, c)).toBeGreaterThan(0)
    expect(byClaimOrder(c, a)).toBeLessThan(0)
    expect(byClaimOrder(b, { ...b, seq: 2 } as TicketSnapshot)).toBe(-1)
  })
})

describe('ConflictArbiter：side 的降级兜底', () => {
  it('degraded 且没声明 writes：只拿 plan.files 的父目录当写，不拿票的 dir 整片兜底', () => {
    const snapshots = foldEvents([
      {
        kind: 'published',
        id: 't-deg',
        at: T(0),
        goal: '降级票',
        brief: '降级票',
        publisher: 'session-main',
        preset: 't1',
        presetSource: 'fallback',
        dir: '/tmp/fallback-dir',
      },
      { kind: 'declared', id: 't-deg', at: T(1), cause: 'timer', plan: { files: [{ path: '/tmp/a/b.ts' }] }, intent: {}, degraded: true },
    ])
    const backend = new MemoryBackend()
    const arbiter = new ConflictArbiter({
      log: new TicketLog(backend),
      clock: fakeClock(new Date(T(9))),
      warn: () => {},
      commit: () => {},
    })
    expect(arbiter.side(snapshots[0]!)).toEqual({ writes: ['dir:/tmp/a'], reads: [] })

    // 连 plan 都没有：不猜「可能写整片目录」，什么也不占。降级票凭空产出
    // dir:<票 dir> 就是那条把整棵树锁死的路。
    const bare = foldEvents([
      { kind: 'published', id: 't-bare', at: T(0), goal: 'x', brief: 'x', publisher: 'session-main', preset: 't1', presetSource: 'fallback', dir: '/tmp/fallback-dir' },
      { kind: 'declared', id: 't-bare', at: T(1), cause: 'timer', plan: {}, intent: {}, degraded: true },
    ])
    expect(arbiter.side(bare[0]!)).toEqual({ writes: [], reads: [] })
  })
})

describe('ConflictArbiter：判定与落票', () => {
  function conflicts(): { arbiter: ConflictArbiter; commits: TicketEvent[]; snap: (id: string) => TicketSnapshot } {
    return tree([
      ...published('t-a', 1),
      declared('t-a', 2, ['dir:/tmp/shared']),
      ...published('t-b', 3),
      declared('t-b', 4, ['dir:/tmp/shared']),
    ])
  }

  it('后声明的一边 strong 排队；waitOn 指向先声明的', () => {
    const { arbiter, snap } = conflicts()
    expect(arbiter.judge(snap('t-b'))).toMatchObject({ level: 'strong', waitOn: [{ ticketId: 't-a', resources: ['dir:/tmp/shared'] }] })
  })

  it('checkAndRecord 第一次写 conflict-checked；排队名单没变时不重复写', () => {
    const { arbiter, commits, snap } = conflicts()
    const first = arbiter.checkAndRecord(snap('t-b'), { onlyIfChanged: true })
    expect(first).toMatchObject({ level: 'strong', recorded: true })
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ kind: 'conflict-checked', level: 'strong', waitOn: [{ ticketId: 't-a' }] })

    const again = arbiter.checkAndRecord(snap('t-b'), { onlyIfChanged: true })
    expect(again).toMatchObject({ level: 'strong', recorded: false })
    expect(commits).toHaveLength(1)
  })

  it('对手不在了：判定 none，照常落一条 conflict-checked（waitOn 空）', () => {
    const { arbiter, commits, snap } = tree([
      ...published('t-a', 1),
      declared('t-a', 2, ['dir:/tmp/shared']),
      ...published('t-b', 3),
      declared('t-b', 4, ['dir:/tmp/shared']),
      { kind: 'closed', id: 't-a', at: T(5), cause: 'tool', outcome: 'done' },
    ])
    const verdict = arbiter.checkAndRecord(snap('t-b'), { onlyIfChanged: true })
    expect(verdict).toMatchObject({ level: 'none', recorded: true })
    expect(commits[0]).toMatchObject({ kind: 'conflict-checked', level: 'none', waitOn: [] })
  })
})
