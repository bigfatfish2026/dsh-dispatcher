/**
 * 第二刀第二步：dispatcher 事件写入走 dsh-events，退路必须照旧。
 *
 * 这里用一个「假 events 服务」当桥的另一头：注册表、publish、seq 记账都按
 * dsh-events 的形状来，落库写进 dispatcher 的临时 tickets.db（不碰生产库）。
 * 真 dsh-events 的完整语义在它自己的 test/ 里测，这一层测的是接线和退化分支。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { TICKET_EVENT_DEFS, TICKET_EVENT_NAMES, ticketEventName } from '../src/store/bus'
import { SqliteTicketStore } from '../src/store'
import type { TicketEvent } from '../src/store'
import { TicketLog } from '../src/store/log'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'

const dirs: string[] = []
const closers: Array<() => void> = []

afterEach(() => {
  while (closers.length) closers.pop()!()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  cleanTempDirs()
})

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-bus-'))
  dirs.push(dir)
  return join(dir, 'tickets.db')
}

interface Published {
  name: string
  payload: TicketEvent
}

/**
 * 假 dsh-events：只实现 dispatcher 用到的那一小面。publish 写进同一个
 * events 表，`type` 用命名空间名、`payload` 是整条票事件、`ticketId` 取
 * 入参里带的票号——跟真 dsh-events 的 PublishInput 可选 ticketId 一致。
 */
function fakeEvents(dbFile: string, options: { failWith?: { code: string; message: string } } = {}): {
  service: {
    defineEvent(def: { name: string; maxBytes?: number }): unknown
    publish(input: { name: string; payload: unknown; ticketId?: string }): { seq: number; eventId: string }
    registry: { get(name: string): unknown }
  }
  defs: string[]
  limits: Map<string, number>
  published: Published[]
} {
  const defs: string[] = []
  const limits = new Map<string, number>()
  const published: Published[] = []
  let db: DatabaseSync | undefined
  const open = (): DatabaseSync => {
    if (!db) {
      db = new DatabaseSync(dbFile)
      db.exec('PRAGMA busy_timeout=5000')
      closers.push(() => db?.close())
    }
    return db
  }
  return {
    defs,
    limits,
    published,
    service: {
      defineEvent(def) {
        defs.push(def.name)
        limits.set(def.name, def.maxBytes ?? 64 * 1024)
        return def
      },
      publish({ name, payload, ticketId }) {
        if (options.failWith) {
          throw Object.assign(new Error(options.failWith.message), { code: options.failWith.code })
        }
        const limit = limits.get(name) ?? 64 * 1024
        const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8')
        if (bytes > limit) {
          throw Object.assign(new Error(`payload ${bytes} 字节，超过 ${name} 的上限 ${limit} 字节，拒收`), {
            code: 'EV-002',
          })
        }
        const conn = open()
        const row = conn.prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM events').get() as { last: number }
        const seq = Number(row.last) + 1
        const event = payload as TicketEvent
        conn
          .prepare('INSERT INTO events(seq, ticketId, type, payload, ts) VALUES(?, ?, ?, ?, ?)')
          .run(seq, ticketId ?? '', name, JSON.stringify(event), event.at)
        conn.prepare("UPDATE meta SET value = ? WHERE key = 'lastSeq'").run(String(seq))
        published.push({ name, payload: event })
        return { seq, eventId: `ev-${seq}` }
      },
      registry: {
        get: (name: string) => (defs.includes(name) ? { name } : undefined),
      },
    },
  }
}

function rows(dbFile: string): Array<{ seq: number; ticketId: string; type: string; payload: string; ts: string }> {
  const db = new DatabaseSync(dbFile)
  closers.push(() => db.close())
  return db.prepare('SELECT seq, ticketId, type, payload, ts FROM events ORDER BY seq').all() as Array<{
    seq: number
    ticketId: string
    type: string
    payload: string
    ts: string
  }>
}

function mount(dbFile: string, events?: ReturnType<typeof fakeEvents>) {
  return mountPlugin({
    config: { store: { backend: 'sqlite', file: dbFile } },
    ...(events ? { services: { events: events.service } } : {}),
  })
}

describe('事件名映射', () => {
  it('每个 kind 一个带命名空间的名字，注册表里没有重名', () => {
    for (const name of Object.values(TICKET_EVENT_NAMES)) {
      expect(name).toMatch(/^dispatcher\.ticket\.[a-z-]+$/)
    }
    expect(new Set(TICKET_EVENT_DEFS.map((def) => def.name)).size).toBe(TICKET_EVENT_DEFS.length)
    expect(TICKET_EVENT_DEFS.every((def) => def.durability === 'durable')).toBe(true)
    expect(TICKET_EVENT_DEFS.every((def) => def.maxBytes === 1024 * 1024)).toBe(true)

    expect(ticketEventName({ kind: 'queued', id: 't', at: '2026-11-09T00:00:00.000Z' } as TicketEvent)).toBe(
      'dispatcher.ticket.queued',
    )
    expect(ticketEventName({ kind: 'reported', id: 't', at: '2026-11-09T00:00:00.000Z' } as TicketEvent)).toBe(
      'dispatcher.ticket.reported',
    )
    // 没有 kind 的老行：不认识的都归 legacy，payload 原样保留。
    expect(ticketEventName({ id: 't', at: '2026-11-09T00:00:00.000Z' } as TicketEvent)).toBe(
      'dispatcher.ticket.legacy',
    )
  })
})

describe('events 服务在：走 publish，type 是命名空间名', () => {
  it('open/send/report 的每条事件都按映射注册并 publish', async () => {
    const dbFile = tempDb()
    const events = fakeEvents(dbFile)
    const host = mount(dbFile, events)

    // apply 时就把全部票事件类型注册了。
    expect(events.defs.sort()).toEqual(TICKET_EVENT_DEFS.map((def) => def.name).sort())

    const opened = (await host.call('dispatch_open', { goal: '验证事件桥。先开票。', brief: '桥' })) as {
      id: string
    }
    await host.call('dispatch_send', { id: opened.id, text: '继续' })
    await host.settled()

    const names = events.published.map((entry) => entry.name)
    expect(names).toContain('dispatcher.ticket.published')
    expect(names).toContain('dispatcher.ticket.spawned')
    expect(names).toContain('dispatcher.ticket.queued')
    expect(names).toContain('dispatcher.ticket.delivered')

    const stored = rows(dbFile)
    expect(stored.map((row) => row.type)).toEqual(events.published.map((entry) => entry.name))
    for (const row of stored) {
      expect(row.type).toMatch(/^dispatcher\.ticket\./)
      const payload = JSON.parse(row.payload) as TicketEvent
      expect(payload.id).toBe(opened.id)
      expect(typeof (payload as { kind?: unknown }).kind).toBe('string')
    }

    // publish 的 payload 就是整条事件，没有包一层、也没有改字段。
    expect(events.published.find((entry) => entry.name === 'dispatcher.ticket.queued')?.payload).toMatchObject({
      kind: 'queued',
      input: { text: '继续' },
    })
  })

  it('投影跟着 publish 的 seq 更新，票读出来是 running', async () => {
    const dbFile = tempDb()
    const events = fakeEvents(dbFile)
    const host = mount(dbFile, events)
    const opened = (await host.call('dispatch_open', { goal: 'g', brief: 'b' })) as { id: string }
    await host.settled()

    const db = new DatabaseSync(dbFile)
    closers.push(() => db.close())
    const row = db.prepare('SELECT state, seq, brief FROM tickets WHERE id = ?').get(opened.id) as {
      state: string
      seq: number
      brief: string
    }
    expect(row.state).toBe('running')
    expect(row.brief).toBe('b')
    const last = events.published[events.published.length - 1]
    const expectedSeq = rows(dbFile).find((entry) => entry.type === last!.name)!.seq
    expect(row.seq).toBe(expectedSeq)
  })
})

describe('大报告与总线错误', () => {
  it('1 MiB 以内的长报告照常 publish，不退回直写', async () => {
    const dbFile = tempDb()
    const events = fakeEvents(dbFile)
    const host = mount(dbFile, events)
    const opened = (await host.call('dispatch_open', { goal: 'g', brief: 'b' })) as { id: string }
    await host.settled()

    const text = 'x'.repeat(300 * 1024)
    await host.call('dispatch_report', { id: opened.id, text })

    expect(events.limits.get('dispatcher.ticket.reported')).toBe(1024 * 1024)
    const last = rows(dbFile).at(-1)!
    expect(last.type).toBe('dispatcher.ticket.reported')
    expect(JSON.parse(last.payload).report.text).toHaveLength(text.length)
    expect(host.warnings.join('\n')).not.toContain('退回直写')
  })

  it('超 1 MiB 抛 EV-002，这一条退成直写，票投影和报告都不丢', async () => {
    const dbFile = tempDb()
    const events = fakeEvents(dbFile)
    const host = mount(dbFile, events)
    const opened = (await host.call('dispatch_open', { goal: 'g', brief: 'b' })) as { id: string }
    await host.settled()
    const before = rows(dbFile).length

    const text = 'x'.repeat(1024 * 1024 + 100)
    const receipt = (await host.call('dispatch_report', { id: opened.id, text })) as { pendingReports: number }
    expect(receipt.pendingReports).toBe(1)

    const stored = rows(dbFile)
    expect(stored).toHaveLength(before + 1)
    const last = stored.at(-1)!
    expect(last.type).toBe('reported')
    expect(last.ticketId).toBe(opened.id)
    expect(JSON.parse(last.payload).report.text).toHaveLength(text.length)

    const db = new DatabaseSync(dbFile)
    closers.push(() => db.close())
    const projection = db.prepare('SELECT reports FROM tickets WHERE id = ?').get(opened.id) as { reports: string }
    expect(JSON.parse(projection.reports)[0].text).toHaveLength(text.length)

    const warned = host.warnings.join('\n')
    expect(warned).toContain(opened.id)
    expect(warned).toContain('字节超过 dsh-events 上限')
    expect(warned).toContain('1048576')
  })

  it('其它错误照旧往上抛，不退回不吞掉', async () => {
    const dbFile = tempDb()
    const events = fakeEvents(dbFile)
    const host = mount(dbFile, events)
    const opened = (await host.call('dispatch_open', { goal: 'g', brief: 'b' })) as { id: string }
    await host.settled()
    const before = rows(dbFile)

    const publish = events.service.publish
    events.service.publish = (input) => {
      if (input.name === 'dispatcher.ticket.reported') {
        throw Object.assign(new Error('总线挂了'), { code: 'EV-005' })
      }
      return publish(input)
    }

    await expect(host.call('dispatch_report', { id: opened.id, text: '一条' })).rejects.toThrow(/总线挂了/)
    expect(rows(dbFile)).toEqual(before)
  })
})

describe('events 服务不在：一个字节都不变', () => {
  it('publisher 写过之后再切回直写，同一张票还能折到一起', async () => {
    const dbFile = tempDb()
    const events = fakeEvents(dbFile)
    const host = mount(dbFile, events)
    const opened = (await host.call('dispatch_open', { goal: 'g', brief: 'b' })) as { id: string }
    await host.settled()

    // 回滚：新起一个没有 publisher 的门面，往同一张票上直写一条报告。
    const backend = new SqliteTicketStore(dbFile)
    closers.push(() => backend.close())
    const direct = new TicketLog(backend)
    direct.appendReport(opened.id, '回滚后补的一条')

    const ticket = direct.get(opened.id)!
    expect(ticket.status).toBe('running')
    expect(ticket.reports.map((entry) => entry.text)).toEqual(['回滚后补的一条'])
    // publisher 行和回滚后的直写行都带票号，按 ticketId 一列就能折全。
    const stored = rows(dbFile)
    expect(stored.every((row) => row.ticketId === opened.id)).toBe(true)
    expect(stored[stored.length - 1]!.type).toBe('legacy')
  })

  it('走原来的直写，type 还是短 kind，payload / ts / seq 同形', async () => {
    const dbFile = tempDb()
    const host = mount(dbFile)
    expect(host.infos.join('\n')).toContain('没有 events 服务：票事件走直写')

    const opened = (await host.call('dispatch_open', { goal: 'g', brief: 'b' })) as { id: string }
    await host.call('dispatch_send', { id: opened.id, text: '继续' })
    await host.settled()

    const stored = rows(dbFile)
    expect(stored[0]).toMatchObject({ seq: 1, type: 'published', ticketId: opened.id })
    expect(stored.map((row) => row.type)).toEqual(['published', 'spawned', 'queued', 'resumed', 'delivered'])
    for (const row of stored) {
      const payload = JSON.parse(row.payload) as TicketEvent & { at: string }
      // 直写：ticketId 是票号，ts 就是事件自己的 at，payload 是原事件。
      expect(row.ticketId).toBe(opened.id)
      expect(row.ts).toBe(payload.at)
      expect(row.type).toBe((payload as { kind?: string }).kind)
    }
  })

  it('events 服务在但后端是 jsonl：还是直写，publish 一次都不调', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatcher-bus-jsonl-'))
    dirs.push(dir)
    const file = join(dir, 'tickets.jsonl')
    const events = fakeEvents(join(dir, 'unused.db'))
    const host = mountPlugin({
      config: { stateFile: file },
      services: { events: events.service },
    })
    expect(host.infos.join('\n')).toContain('不支持外部落库：票事件走直写')

    await host.call('dispatch_open', { goal: 'g', brief: 'b' })
    await host.settled()

    expect(events.published).toHaveLength(0)
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines.map((line) => line.kind)).toEqual(['published', 'spawned'])
  })
})

describe('events 服务半残：注册不上就整条退回去', () => {
  it('defineEvent 抛错、registry 也查不到：不 publish，照老路直写', async () => {
    const dbFile = tempDb()
    const host = mountPlugin({
      config: { store: { backend: 'sqlite', file: dbFile } },
      services: {
        events: {
          defineEvent() {
            throw new Error('registry 冻住了')
          },
          publish() {
            throw new Error('不该走到 publish')
          },
        },
      },
    })
    expect(host.infos.join('\n')).toContain('类型没注册上')

    await host.call('dispatch_open', { goal: 'g', brief: 'b' })
    await host.settled()

    expect(rows(dbFile).map((row) => row.type)).toEqual(['published', 'spawned'])
  })
})
