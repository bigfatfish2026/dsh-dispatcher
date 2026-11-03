import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore, createTicketBackend, foldEvents } from '../src/store'
import type { TicketBackend } from '../src/store/backend'
import type { TicketEvent } from '../src/store'
import { JsonlTicketStore } from '../src/store/jsonl'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-backend-'))
  dirs.push(dir)
  return join(dir, 'tickets.jsonl')
}

/**
 * 一个不碰盘的后端：只把事件记在数组里。门面对它一无所知——这就是「以后换
 * redis/sqlite、业务代码不改」的实证。
 */
class MemoryBackend implements TicketBackend {
  readonly location = 'memory://tickets'
  private events: TicketEvent[] = []
  private version = 0
  private seen = 0

  changed(): boolean {
    return this.seen !== this.version
  }

  load(): TicketEvent[] {
    this.seen = this.version
    return [...this.events]
  }

  append(event: TicketEvent): void {
    this.events.push(event)
    this.version += 1
  }

  get appended(): number {
    return this.events.length
  }
}

describe('存储后端选择', () => {
  it('默认 jsonl：路径原样交给 JsonlTicketStore', () => {
    const file = tempFile()
    const backend = createTicketBackend({ stateFile: file })
    expect(backend).toBeInstanceOf(JsonlTicketStore)
    expect(backend.location).toBe(file)
  })

  it('redis / sqlite 只留名字，选了就抛未实现', () => {
    for (const backend of ['redis', 'sqlite'] as const) {
      expect(() => createTicketBackend({ backend, stateFile: tempFile() })).toThrow(/还没实现/)
    }
  })

  it('不认识的后端名当场报错，不悄悄退回 jsonl', () => {
    expect(() => createTicketBackend({ backend: 'postgres', stateFile: tempFile() })).toThrow(/不认识/)
  })
})

describe('门面只认 TicketBackend 接口', () => {
  it('换一个内存后端，开票/改状态/报告/已读记账照旧跑', () => {
    const backend = new MemoryBackend()
    const store = new TicketStore(backend)

    const ticket = store.open('build llvm', '/tmp/llvm', '编译 LLVM')
    store.update(ticket.id, { status: 'running', owner: 'worker 1', ownerId: 'session-abc' })
    const input = store.appendInput(ticket.id, 'also build clang')
    store.markDelivered(ticket.id, 'input', input.entry.id)
    const report = store.appendReport(ticket.id, 'llvm 好了')
    store.update(ticket.id, { status: 'done', note: '交付' })
    // 读报告 = 再追加一条 delivered，不改报告那一行。
    store.markDelivered(ticket.id, 'report', report.entry.id)

    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: ticket.id, status: 'done', owner: 'worker 1', note: '交付' })
    expect(listed[0]!.inputs[0]!.delivered).toBe(true)
    expect(listed[0]!.reports[0]!.delivered).toBe(true)
    // 投影和「整份重放再 fold」是同一份结果，换后端也一样。
    expect(listed).toEqual(foldEvents(backend.load()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    // 每次写都是一条新事件，没有原地改：开票 1 + 状态 1 + input 1 + 已读 1 + 报告 1 + 状态 1 + 已读 1。
    expect(backend.appended).toBe(7)
  })

  it('门面自己的写也会让 changed() 归零：下一次 get 不重折', () => {
    const backend = new MemoryBackend()
    const store = new TicketStore(backend)
    const ticket = store.open('a')
    const first = store.get(ticket.id)
    expect(store.get(ticket.id)).toBe(first)
    expect(backend.changed()).toBe(false)
  })
})
