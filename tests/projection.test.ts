import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore, foldEvents } from '../src/store'
import type { TicketEvent } from '../src/store'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-projection-'))
  dirs.push(dir)
  return join(dir, 'tickets.jsonl')
}

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 3, 0, 0, seconds)).toISOString()

/** Read the log the slow way: parse every line and fold from scratch. */
function fullFold(file: string): ReturnType<typeof foldEvents> {
  const text = readFileSync(file, 'utf8')
  const events: TicketEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as TicketEvent)
    } catch {
      // 坏行照旧跳过，和 store 的容错一致。
    }
  }
  return foldEvents(events).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

describe('内存投影', () => {
  it('每次 append 只折新行，结果和整份 fold 一致', () => {
    const file = tempFile()
    const store = new TicketStore(file)

    const ticket = store.open('build llvm', '/tmp/llvm', '编译 LLVM')
    store.update(ticket.id, { status: 'running', owner: 'worker 1', ownerId: 'session-abc' })
    const { entry } = store.appendInput(ticket.id, 'also build clang')
    store.markDelivered(ticket.id, 'input', entry.id)
    store.appendReport(ticket.id, 'llvm 好了')
    store.update(ticket.id, { status: 'done', note: '交付' })

    const projected = store.list()
    expect(projected).toEqual(fullFold(file))
    expect(projected[0]).toMatchObject({
      id: ticket.id,
      status: 'done',
      owner: 'worker 1',
      ownerId: 'session-abc',
      note: '交付',
    })
    expect(projected[0]!.inputs[0]!.delivered).toBe(true)
    expect(projected[0]!.reports).toHaveLength(1)
  })

  it('没变的文件不会重新 fold：两次 get 拿到的是同一份快照', () => {
    const file = tempFile()
    writeFileSync(file, `${JSON.stringify({ id: 't-1', at: T(0), goal: 'a', status: 'open' })}\n`, 'utf8')
    const store = new TicketStore(file)

    const first = store.get('t-1')
    const second = store.get('t-1')
    expect(second).toBe(first)
    expect(store.list()[0]).toBe(first)
  })

  it('外部追加会触发一次整份重建，新票可见', () => {
    const file = tempFile()
    writeFileSync(file, `${JSON.stringify({ id: 't-1', at: T(0), goal: 'a', status: 'open' })}\n`, 'utf8')
    const store = new TicketStore(file)
    expect(store.list()).toHaveLength(1)

    appendFileSync(file, `${JSON.stringify({ id: 't-2', at: T(1), goal: 'b', status: 'open' })}\n`, 'utf8')
    expect(store.list().map((ticket) => ticket.id)).toEqual(['t-1', 't-2'])
    expect(store.get('t-2')!.goal).toBe('b')
    // 重建之后又是同一份投影：再读不会再折一遍。
    expect(store.get('t-2')).toBe(store.get('t-2'))
  })

  it('文件被截断/重写也会重建，不留下已经不存在的票', () => {
    const file = tempFile()
    writeFileSync(
      file,
      [
        JSON.stringify({ id: 't-1', at: T(0), goal: 'a', status: 'open' }),
        JSON.stringify({ id: 't-2', at: T(1), goal: 'b', status: 'open' }),
      ].join('\n') + '\n',
      'utf8',
    )
    const store = new TicketStore(file)
    expect(store.list()).toHaveLength(2)

    writeFileSync(file, `${JSON.stringify({ id: 't-1', at: T(0), goal: 'a', status: 'done' })}\n`, 'utf8')
    expect(store.list().map((ticket) => ticket.id)).toEqual(['t-1'])
    expect(store.get('t-1')!.status).toBe('done')
    expect(store.get('t-2')).toBeUndefined()
  })

  it('坏行容错照旧：跳过坏行，其余照常折', () => {
    const file = tempFile()
    writeFileSync(
      file,
      [
        'not json at all',
        JSON.stringify({ id: 't-1', at: T(0), goal: 'a', status: 'open' }),
        'null',
        JSON.stringify({ at: T(1), noId: true }),
        JSON.stringify({ id: 't-1', at: T(2), status: 'running' }),
      ].join('\n') + '\n',
      'utf8',
    )
    const store = new TicketStore(file)
    expect(store.list().map((ticket) => [ticket.id, ticket.status])).toEqual([['t-1', 'running']])
  })
})
