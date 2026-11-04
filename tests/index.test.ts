import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore, foldEvents, isOpen, minutesSince } from '../src/store'
import { makeDesk } from './helpers/desk-harness'

const tempDirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-'))
  tempDirs.push(dir)
  return join(dir, 'tickets.jsonl')
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('foldEvents', () => {
  it('folds later events onto the first one', () => {
    const snapshots = foldEvents([
      { id: 't-1', at: '2026-11-01T00:00:00.000Z', goal: 'build it', status: 'open' },
      { id: 't-1', at: '2026-11-01T00:10:00.000Z', status: 'running', owner: 'sub-1' },
      { id: 't-1', at: '2026-11-01T00:20:00.000Z', status: 'done', note: 'shipped' },
    ])
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      id: 't-1',
      goal: 'build it',
      status: 'done',
      owner: 'sub-1',
      note: 'shipped',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:20:00.000Z',
    })
  })

  it('keeps tickets separate', () => {
    const snapshots = foldEvents([
      { id: 't-1', at: '2026-11-01T00:00:00.000Z', goal: 'a' },
      { id: 't-2', at: '2026-11-01T00:01:00.000Z', goal: 'b' },
      { id: 't-1', at: '2026-11-01T00:02:00.000Z', status: 'blocked' },
    ])
    expect(snapshots.map((ticket) => [ticket.id, ticket.status])).toEqual([
      ['t-1', 'blocked'],
      ['t-2', 'open'],
    ])
  })
})

describe('isOpen', () => {
  it('counts only unterminated statuses', () => {
    expect(isOpen('open')).toBe(true)
    expect(isOpen('running')).toBe(true)
    expect(isOpen('waiting')).toBe(true)
    expect(isOpen('blocked')).toBe(true)
    expect(isOpen('done')).toBe(false)
    expect(isOpen('dropped')).toBe(false)
  })
})

describe('minutesSince', () => {
  it('rounds to whole minutes and tolerates bad input', () => {
    const now = new Date('2026-11-01T01:00:00.000Z')
    expect(minutesSince('2026-11-01T00:30:00.000Z', now)).toBe(30)
    expect(minutesSince('not-a-date', now)).toBe(0)
  })
})

describe('TicketDesk 视图', () => {
  it('挂起超过阈值就标 stale，关掉的票永不 stale', async () => {
    const h = makeDesk({ now: new Date('2026-11-01T00:00:00.000Z') })
    const receipt = await h.desk.open({ goal: 'build it', brief: '开工', requestId: 'r-1' }, h.main)
    await h.desk.block(receipt.id, '等主人拍板', h.main)
    h.clock.advance(61 * 60_000)

    const parked = h.desk.get(receipt.id)!
    expect(parked.stale).toBe(true)
    expect(parked.statusSince).toBe('2026-11-01T00:00:00.000Z')

    await h.desk.close(receipt.id, { outcome: 'done', actor: h.main })
    expect(h.desk.get(receipt.id)!.stale).toBe(false)
  })

  it('视图带 statusSince、pending 计数和自己的档位来源', async () => {
    const h = makeDesk({ now: new Date('2026-11-01T00:00:00.000Z') })
    const receipt = await h.desk.open({ goal: 'build it', brief: '开工', requestId: 'r-2' }, h.main)
    const view = h.desk.get(receipt.id)!
    expect(view.statusSince).toBe('2026-11-01T00:00:00.000Z')
    expect(view.pendingInputs).toBe(0)
    expect(view.pendingReports).toBe(0)
    expect(view.preset).toBe('t1')
    expect(view.presetSource).toBe('fallback')
    expect(view.epoch).toBe(1)
  })
})

describe('TicketStore', () => {
  it('opens, updates and lists tickets from the log', () => {
    const store = new TicketStore(tempFile())
    const opened = store.open('do the thing', '/tmp/work')
    expect(opened.status).toBe('open')
    expect(opened.dir).toBe('/tmp/work')

    const running = store.update(opened.id, { status: 'running', owner: 'sub-9' })
    expect(running.status).toBe('running')
    expect(running.owner).toBe('sub-9')

    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(opened.id)
  })

  it('refuses to update an unknown ticket', () => {
    const store = new TicketStore(tempFile())
    expect(() => store.update('t-missing', { status: 'done' })).toThrow(/unknown ticket/)
  })

  it('skips a torn last line instead of failing', () => {
    const file = tempFile()
    const store = new TicketStore(file)
    store.open('first')
    appendFileSync(file, '{"id":"t-broken"')
    expect(store.list()).toHaveLength(1)
  })

  // 崩溃留下的半行没有换行符：下一次 append 直接粘上去的话，粘出来的整行会被当坏行丢掉，
  // 被丢的可能正是 done 或 delivered。
  it('does not glue the next event onto a torn last line', () => {
    const file = tempFile()
    const warnings: string[] = []
    const store = new TicketStore(file, (message) => warnings.push(message))
    const first = store.open('first')
    appendFileSync(file, '{"id":"t-torn","at":"2026-11-01T00:00:00.000Z"')

    const second = store.open('second')
    const listed = store.list()
    // 同一毫秒开两张票时，id 的随机盐决定 list() 的兜底顺序；这里只比集合，不比顺序。
    expect(listed.map((ticket) => ticket.id).sort()).toEqual([first.id, second.id].sort())
    // 坏行不是悄悄消失的：跳过之后留一条 warn。
    expect(warnings.join('\n')).toMatch(/skipped 1 line/)
  })

  // 一行能 parse 但不是事件（null）：readEvents 跳过它，foldEvents 也不许在 event.id 上抛，
  // 否则一次脏行就把整套 dispatch_* 打死。
  it('skips a null line and still reads the events after it', () => {
    const file = tempFile()
    const store = new TicketStore(file)
    const first = store.open('first')
    appendFileSync(file, 'null\n')
    const second = store.open('second')

    const listed = store.list()
    expect(listed.map((ticket) => ticket.id).sort()).toEqual([first.id, second.id].sort())
    expect(() =>
      foldEvents([null as never, { id: 't-1', at: '2026-11-01T00:00:00.000Z', goal: 'still folds' }]),
    ).not.toThrow()
  })
})
