/**
 * 排队序号 seq：票的先后只认它。
 *
 * 老毛病：排序只比 createdAt，同一毫秒开的两张票退化成按 id 字典序，排队放行
 * 的 FIFO 跟着抖。这组测试钉四件事：
 *
 * - 开票发单调 seq，落在 `published` 行里（重放拿得回来）；
 * - 同一毫秒开的票，`list()` 顺序就是开票顺序；
 * - 重启（新开 store / desk 接老日志）seq 接着最大值数，不从 1 重来、不重号；
 * - 没有 seq 的老票仍按 createdAt、再按 id 排，448 张线上票照常读。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore } from '../src/store'
import { TicketLog } from '../src/store/log'
import type { TicketEvent } from '../src/store'
import { MemoryBackend, makeDesk } from './helpers/desk-harness'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** 老后端的事件原样喂进一个新后端：这就是「重启后接老日志」。 */
function replay(from: MemoryBackend): MemoryBackend {
  const next = new MemoryBackend()
  for (const event of from.events_) next.append(event)
  return next
}

/** 日志里每一条「建票行」的 seq。两种形状都算：带 kind 的 published，和
 * `TicketLog.open()` 写的老形状（有 goal、没有 kind）。 */
function creationSeqs(backend: MemoryBackend): Array<number | undefined> {
  return backend.events_
    .filter((event) => {
      const kind = (event as { kind?: string }).kind
      if (typeof kind === 'string') return kind === 'published'
      return (event as { goal?: string }).goal !== undefined
    })
    .map((event) => (event as { seq?: number }).seq)
}

describe('开票发 seq', () => {
  it('按开票先后单调递增，并且写进 published 行', () => {
    const backend = new MemoryBackend()
    const log = new TicketLog(backend)
    const opened = ['甲', '乙', '丙'].map((goal) => log.open(goal).id)

    expect(log.list().map((ticket) => ticket.id)).toEqual(opened)
    expect(log.list().map((ticket) => ticket.seq)).toEqual([1, 2, 3])
    // 事件里有，才谈得上「日志里能重放」。
    expect(creationSeqs(backend)).toEqual([1, 2, 3])
    // 顺序只看 seq：把 id 重排一遍也还是开票顺序。
    expect(log.list().map((ticket) => ticket.seq)).toEqual([1, 2, 3])
  })

  it('同一毫秒开的票也按开票先后排，不再退化成 id 字典序', () => {
    const backend = new MemoryBackend()
    const log = new TicketLog(backend)
    const opened = Array.from({ length: 12 }, (_, index) => log.open(`第 ${index + 1} 张`).id)
    const rows = log.list()

    expect(rows.map((ticket) => ticket.id)).toEqual(opened)
    expect(rows.map((ticket) => ticket.seq)).toEqual(opened.map((_, index) => index + 1))
  })
})

describe('重启接着数', () => {
  it('新 store 接老日志：seq 从现有最大值 +1 起，不重号', () => {
    dir = mkdtempSync(join(tmpdir(), 'dispatcher-seq-'))
    const file = join(dir, 'tickets.jsonl')
    const first = new TicketStore(file)
    const a = first.open('甲')
    const b = first.open('乙')
    expect([a.seq, b.seq]).toEqual([1, 2])

    // 新实例 = 重启：先读日志折回 [1, 2]，再开一张该是 3。
    const restarted = new TicketStore(file)
    expect(restarted.list().map((ticket) => ticket.seq)).toEqual([1, 2])
    const c = restarted.open('丙')
    expect(c.seq).toBe(3)

    const all = new TicketStore(file).list()
    expect(all.map((ticket) => ticket.id)).toEqual([a.id, b.id, c.id])
    expect(all.map((ticket) => ticket.seq)).toEqual([1, 2, 3])
  })

  it('新建 desk 接老日志：seq 接着数，三张票不重号', async () => {
    const first = makeDesk()
    first.desk.attach()
    const a = await first.desk.open({ goal: '甲', brief: '甲' }, first.main)
    const b = await first.desk.open({ goal: '乙', brief: '乙' }, first.main)
    expect([first.log.get(a.id)!.seq, first.log.get(b.id)!.seq]).toEqual([1, 2])

    const second = makeDesk({ backend: replay(first.backend) })
    second.desk.attach()
    expect(second.log.list().map((ticket) => ticket.seq)).toEqual([1, 2])
    const c = await second.desk.open({ goal: '丙', brief: '丙' }, second.main)

    expect(second.log.get(c.id)!.seq).toBe(3)
    const all = second.log.list()
    expect(all.map((ticket) => ticket.id)).toEqual([a.id, b.id, c.id])
    expect(new Set(all.map((ticket) => ticket.seq)).size).toBe(3)
  })
})

describe('老票没有 seq', () => {
  it('仍按 createdAt 升序、同一时刻按 id 兜底', () => {
    const backend = new MemoryBackend()
    // 2026-11-04 之前的老行：没有 kind，也没有 seq。
    const legacy: TicketEvent[] = [
      { id: 't-b', at: '2026-10-01T00:00:00.000Z', goal: '乙', status: 'open' },
      { id: 't-0', at: '2026-09-30T00:00:00.000Z', goal: '更早', status: 'open' },
      { id: 't-a', at: '2026-10-01T00:00:00.000Z', goal: '甲', status: 'open' },
    ]
    for (const event of legacy) backend.append(event)

    const log = new TicketLog(backend)
    const rows = log.list()
    expect(rows.map((ticket) => ticket.id)).toEqual(['t-0', 't-a', 't-b'])
    expect(rows.map((ticket) => ticket.seq)).toEqual([undefined, undefined, undefined])
  })

  it('老日志里接着开新票：老票仍按 createdAt / id 排，新票接在后面', () => {
    dir = mkdtempSync(join(tmpdir(), 'dispatcher-seq-legacy-'))
    const file = join(dir, 'tickets.jsonl')
    // 手写两条 2026-10 的老行（没有 kind、没有 seq），就是线上 448 张票的样子。
    const legacy: TicketEvent[] = [
      { id: 't-b', at: '2026-10-01T00:00:00.000Z', goal: '乙', status: 'open' },
      { id: 't-a', at: '2026-10-01T00:00:00.000Z', goal: '甲', status: 'open' },
    ]
    writeFileSync(file, `${legacy.map((event) => JSON.stringify(event)).join('\n')}\n`)

    const log = new TicketStore(file)
    expect(log.list().map((ticket) => ticket.id)).toEqual(['t-a', 't-b'])
    expect(log.list().map((ticket) => ticket.seq)).toEqual([undefined, undefined])

    const fresh = log.open('新票')
    // 老票没有 seq，不参与取最大值：第一张新票就是 1；排序上它接在老票后面
    // （createdAt 比 2026-10 晚）。
    expect(fresh.seq).toBe(1)
    expect(log.list().map((ticket) => ticket.id)).toEqual(['t-a', 't-b', fresh.id])
    expect(log.list().map((ticket) => ticket.seq)).toEqual([undefined, undefined, 1])
  })
})
