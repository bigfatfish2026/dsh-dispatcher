import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TicketStore } from '../src/store'
import { fold } from '../src/store/reducer'
import { foldLegacy } from './fixtures/legacy-fold-8fd5ea0'
import type {
  LegacyTicketEvent,
  LegacyTicketSnapshot,
  TicketEntry,
  TicketEvent,
  TicketSnapshot,
} from '../src/store'

/**
 * 等价性护栏，分两层——这是 2026-11-04 拆事件模型时定的口径。
 *
 * **第一层：老字段零容忍。** fixture 是 2026-11-04 线上日志的原样拷贝（3015 行
 * / 448 张票）。对照组是 `fixtures/legacy-fold-8fd5ea0.ts`：冻结在拆分前那一刻
 * 的 applyEvent（逐字抄自 HEAD 8fd5ea0）。拆分之后 TicketStore 自己也走新
 * reducer，拿它跟 reducer 比就成了自己比自己，所以必须有这份不动的副本。
 * 老字段的任何一个值、条目顺序、键，差一点都算错。
 *
 * **第二层：新字段单独断言。** `statusSince` / `epoch` / `epochReports` 这些是
 * P2 才加进快照的，老日志里没有对应信息。它们按「老日志能推出什么」来验：
 * epoch 恒 0、epochReports 等于报告条数、归属类字段一律 undefined、
 * statusSince 等于最后一次状态行的 at。这一层允许将来演进，第一层不允许——
 * 把两层混在一起，改新字段就得去动老字段的零容忍，护栏迟早被磨没。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'tickets-20261104.jsonl')

/** 固定 fixture 的两个锚点：行数、票数。改 fixture 就得同时改这里。 */
const FIXTURE_LINES = 3015
const FIXTURE_TICKETS = 448

/** 8fd5ea0 就有的字段：逐字段比，值和键都不许变。 */
const SCALAR_FIELDS = [
  'id',
  'goal',
  'brief',
  'status',
  'dir',
  'note',
  'owner',
  'ownerId',
  'createdAt',
  'updatedAt',
  'closedAt',
] as const

/** P2 加进快照的字段：老日志上只验默认值，不和 8fd5ea0 比。 */
const NEW_FIELDS = [
  'statusSince',
  'workerId',
  'device',
  'workerAlive',
  'preset',
  'presetSource',
  'presetWhy',
  'requestId',
  'publisher',
  'epoch',
  'epochReports',
  'epochStartedAt',
] as const

/** 读 fixture 的每一行，跳过空行——和 JsonlTicketStore.load() 一样的口径。 */
function readFixture(): TicketEvent[] {
  const events: TicketEvent[] = []
  for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
    if (!line.trim()) continue
    events.push(JSON.parse(line) as TicketEvent)
  }
  return events
}

function keysOf(value: object): string[] {
  return Object.keys(value).sort()
}

function compareEntry(where: string, legacy: TicketEntry, folded: TicketEntry): void {
  expect(keysOf(folded), `${where} 的键集合`).toEqual(keysOf(legacy))
  expect(folded.id, `${where}.id`).toBe(legacy.id)
  expect(folded.at, `${where}.at`).toBe(legacy.at)
  expect(folded.text, `${where}.text`).toBe(legacy.text)
  expect(folded.delivered, `${where}.delivered`).toBe(legacy.delivered)
  expect(folded.deliveredAt, `${where}.deliveredAt`).toBe(legacy.deliveredAt)
}

function compareOldFields(legacy: LegacyTicketSnapshot, folded: TicketSnapshot): number {
  const where = `票 ${legacy.id}`
  // 老字段一个都不许丢：新快照可以多键，但不能把 8fd5ea0 的键弄没了。
  const foldedKeys = new Set(keysOf(folded))
  for (const key of keysOf(legacy)) {
    expect(foldedKeys.has(key), `${where} 少了老字段 ${key}`).toBe(true)
  }
  for (const field of SCALAR_FIELDS) {
    expect(folded[field], `${where}.${field}`).toBe(legacy[field])
  }
  expect(folded.inputs.length, `${where}.inputs 条数`).toBe(legacy.inputs.length)
  expect(folded.reports.length, `${where}.reports 条数`).toBe(legacy.reports.length)
  legacy.inputs.forEach((entry, index) => {
    compareEntry(`${where}.inputs[${index}]`, entry, folded.inputs[index]!)
  })
  legacy.reports.forEach((entry, index) => {
    compareEntry(`${where}.reports[${index}]`, entry, folded.reports[index]!)
  })
  return 1 + SCALAR_FIELDS.length + legacy.inputs.length * 5 + legacy.reports.length * 5
}

/** 老日志能推出的 statusSince：最后一次带 status 的行，没有就是建票时刻。 */
function expectedStatusSince(events: readonly TicketEvent[], id: string): string {
  let since = ''
  for (const event of events) {
    if (event.id !== id) continue
    if (!since) since = event.at
    if ((event as LegacyTicketEvent).status) since = event.at
  }
  return since
}

describe('等价性护栏 · 第一层：老字段零容忍', () => {
  const events = readFixture()

  it('fixture 是原样的线上日志：行数和票数都对得上', () => {
    expect(readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.trim()).length).toBe(
      FIXTURE_LINES,
    )
    expect(events).toHaveLength(FIXTURE_LINES)
    expect(new Set(events.map((event) => event.id)).size).toBe(FIXTURE_TICKETS)
  })

  it('两张票的集合相同：id 一个不多一个不少', () => {
    const legacy = new TicketStore(FIXTURE).list()
    const folded = fold(events)
    expect(folded.size).toBe(FIXTURE_TICKETS)
    expect(legacy).toHaveLength(folded.size)
    expect(legacy.map((ticket) => ticket.id).sort()).toEqual([...folded.keys()].sort())
  })

  it('顺序也一致：list() 按 createdAt 升序', () => {
    const legacy = new TicketStore(FIXTURE).list()
    const folded = fold(events)
    const expected = [...folded.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((ticket) => ticket.id)
    expect(legacy.map((ticket) => ticket.id)).toEqual(expected)
  })

  it('逐字段相等：拆分前的折叠逻辑 vs 新 reducer，448 张票一条不差', () => {
    const legacy = foldLegacy(events)
    const folded = fold(events)
    expect(legacy.size).toBe(folded.size)
    expect([...folded.keys()].sort()).toEqual([...legacy.keys()].sort())
    let comparisons = 0
    for (const [id, before] of legacy) {
      const after = folded.get(id)
      expect(after, `新 reducer 里缺票 ${id}`).toBeDefined()
      comparisons += compareOldFields(before, after!)
    }
    expect(comparisons).toBeGreaterThan(FIXTURE_TICKETS * 10)
  })

  it('逐字段相等：线上 TicketStore 的投影和纯 fold 也对得上', () => {
    const store = new TicketStore(FIXTURE)
    const folded = fold(events)
    let comparisons = 0
    for (const ticket of store.list()) {
      const other = folded.get(ticket.id)
      expect(other, `新 reducer 里缺票 ${ticket.id}`).toBeDefined()
      comparisons += compareOldFields(ticket, other!)
      // get() 和 list() 必须给出同一张票，别只比一条路。
      comparisons += compareOldFields(store.get(ticket.id)!, other!)
    }
    expect(comparisons).toBeGreaterThan(FIXTURE_TICKETS * 10)
  })

  it('fold 是纯函数：同一份事件折两遍，结果一字节不差', () => {
    const once = fold(events)
    const twice = fold(events.map((event) => ({ ...event })))
    expect(JSON.stringify([...twice.entries()].sort())).toBe(
      JSON.stringify([...once.entries()].sort()),
    )
  })
})

describe('等价性护栏 · 第二层：新字段在老日志上的默认值', () => {
  const events = readFixture()
  const folded = fold(events)

  it('键集合正好是「8fd5ea0 的键 + 新字段」，没有第三种东西混进来', () => {
    const legacy = foldLegacy(events)
    for (const [id, before] of legacy) {
      const after = folded.get(id)!
      const expected = [...keysOf(before), ...NEW_FIELDS].sort()
      expect(keysOf(after), `票 ${id} 的键集合`).toEqual(expected)
    }
  })

  it('归属与派活类字段一律 undefined：老日志里推不出来就不许编', () => {
    for (const ticket of folded.values()) {
      const where = `票 ${ticket.id}`
      expect(ticket.workerId, `${where}.workerId`).toBeUndefined()
      expect(ticket.device, `${where}.device`).toBeUndefined()
      expect(ticket.workerAlive, `${where}.workerAlive`).toBeUndefined()
      expect(ticket.preset, `${where}.preset`).toBeUndefined()
      expect(ticket.presetSource, `${where}.presetSource`).toBeUndefined()
      expect(ticket.presetWhy, `${where}.presetWhy`).toBeUndefined()
      expect(ticket.requestId, `${where}.requestId`).toBeUndefined()
      expect(ticket.publisher, `${where}.publisher`).toBeUndefined()
      expect(ticket.epochStartedAt, `${where}.epochStartedAt`).toBeUndefined()
    }
  })

  it('epoch 恒 0，epochReports 就是老日志里的报告条数', () => {
    for (const ticket of folded.values()) {
      expect(ticket.epoch, `票 ${ticket.id}.epoch`).toBe(0)
      expect(ticket.epochReports, `票 ${ticket.id}.epochReports`).toBe(ticket.reports.length)
    }
  })

  it('statusSince 等于最后一次状态行的 at，没有状态行就是建票时刻', () => {
    for (const ticket of folded.values()) {
      expect(ticket.statusSince, `票 ${ticket.id}.statusSince`).toBe(
        expectedStatusSince(events, ticket.id),
      )
    }
  })

  it('TicketStore 的投影在这些字段上和纯 fold 一致', () => {
    for (const ticket of new TicketStore(FIXTURE).list()) {
      const other = folded.get(ticket.id)!
      expect({
        statusSince: ticket.statusSince,
        epoch: ticket.epoch,
        epochReports: ticket.epochReports,
      }).toEqual({
        statusSince: other.statusSince,
        epoch: other.epoch,
        epochReports: other.epochReports,
      })
    }
  })
})
