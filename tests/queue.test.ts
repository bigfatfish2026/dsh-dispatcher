import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore, pending } from '../src/store'

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function store(): TicketStore {
  dir = mkdtempSync(join(tmpdir(), 'dispatcher-queue-'))
  return new TicketStore(join(dir, 'tickets.jsonl'))
}

describe('ticket queues', () => {
  it('queues a message and marks it delivered', () => {
    const log = store()
    const ticket = log.open('build llvm')
    expect(pending(ticket.inputs)).toHaveLength(0)

    const { entry } = log.appendInput(ticket.id, 'also build clang')
    expect(pending(log.get(ticket.id)!.inputs)).toHaveLength(1)

    log.markDelivered(ticket.id, 'input', entry.id)
    const after = log.get(ticket.id)!
    expect(pending(after.inputs)).toHaveLength(0)
    expect(after.inputs[0]!.text).toBe('also build clang')
    expect(after.inputs[0]!.deliveredAt).toBeTruthy()
  })

  it('queues reports in order and survives a re-read of the log', () => {
    const log = store()
    const ticket = log.open('build llvm')
    log.appendReport(ticket.id, 'first')
    const second = log.appendReport(ticket.id, 'second')

    // A fresh store folds the same file again: the queue is in the log.
    const reread = new TicketStore(log.path).get(ticket.id)!
    expect(reread.reports.map((entry) => entry.text)).toEqual(['first', 'second'])
    expect(pending(reread.reports)).toHaveLength(2)

    new TicketStore(log.path).markDelivered(ticket.id, 'report', second.entry.id)
    const after = new TicketStore(log.path).get(ticket.id)!
    expect(pending(after.reports).map((entry) => entry.text)).toEqual(['first'])
  })

  it('keeps input and report delivery apart', () => {
    const log = store()
    const ticket = log.open('build llvm')
    const { entry: input } = log.appendInput(ticket.id, 'a')
    log.appendReport(ticket.id, 'b')

    log.markDelivered(ticket.id, 'report', input.id)
    const after = log.get(ticket.id)!
    expect(pending(after.inputs)).toHaveLength(1)
    expect(pending(after.reports)).toHaveLength(1)
  })

  it('refuses to queue onto an unknown ticket', () => {
    const log = store()
    expect(() => log.appendInput('t-nope', 'hi')).toThrow(/unknown ticket/)
    expect(() => log.appendReport('t-nope', 'hi')).toThrow(/unknown ticket/)
  })
})
