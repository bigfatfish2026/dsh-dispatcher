/**
 * `dispatcher` 查票服务的验收：dsh-backlog 挂工单之前用它确认票号真在。
 *
 * 这几条盯着三件事：
 * 1. 查得到的票字段对（status / goal / brief / preset / owner / createdAt）；
 * 2. 查不到的票返回 null，不抛错；hasTicket 与 lookupTicket 结论永远一致；
 * 3. 查票是纯读：日志一个字节不变、票的 status / updatedAt 不动。
 *
 * 票日志写在临时目录，用的是真 store 的折叠路径（`TicketLog`），不写真库。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DISPATCHER_SERVICE } from '../src/tickets/readout'
import type { DispatcherService, TicketLookup } from '../src/tickets/readout'
import type { TicketReadout } from '../src/tickets/readout'
import { mountPlugin } from './helpers/plugin-harness'

const TICKET = 't-mwj4472t-qo9d'
const MISSING = 't-00000000-nope'
const CREATED_AT = '2026-11-16T09:00:00.000Z'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-lookup-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

/** 一张已派出去的票：published 落 open，spawned 推 running 并带上 owner。 */
function writeTicketLog(): string {
  const file = join(tempDir(), 'tickets.jsonl')
  const lines = [
    {
      kind: 'published',
      id: TICKET,
      at: CREATED_AT,
      goal: '给 backlog 补票号校验',
      brief: '给 backlog 补票号校验',
      publisher: 'main',
      preset: 't1',
      presetSource: 'fallback',
      requestId: 'req-lookup-1',
    },
    {
      kind: 'spawned',
      id: TICKET,
      at: '2026-11-16T09:01:00.000Z',
      workerId: 'session-lookup-worker',
      provider: 'spawn',
      preset: 't1',
      label: 't1 给 backlog 补票号校验',
    },
  ]
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
  return file
}

function mount(logFile: string): {
  service: DispatcherService
  readout: TicketReadout
} {
  const host = mountPlugin({ config: { stateFile: logFile, snapshotEnabled: false } })
  const services = host.ctx as { get(name: string): unknown }
  const service = services.get(DISPATCHER_SERVICE) as DispatcherService | undefined
  const readout = services.get('dispatcher/tickets') as TicketReadout | undefined
  expect(service, 'dispatcher 服务没挂上').toBeDefined()
  expect(readout, 'dispatcher/tickets 服务没挂上').toBeDefined()
  return { service: service!, readout: readout! }
}

describe('dispatcher 服务：lookupTicket / hasTicket', () => {
  it('查得到已开的票，字段与票面一致', () => {
    const { service } = mount(writeTicketLog())
    const found = service.lookupTicket(TICKET)
    expect(found).not.toBeNull()
    const ticket = found as TicketLookup
    expect(ticket.id).toBe(TICKET)
    expect(ticket.status).toBe('running')
    expect(ticket.goal).toBe('给 backlog 补票号校验')
    expect(ticket.brief).toBe('给 backlog 补票号校验')
    expect(ticket.preset).toBe('t1')
    expect(ticket.owner).toBe('t1 给 backlog 补票号校验')
    expect(ticket.createdAt).toBe(CREATED_AT)
  })

  it('查不存在的票返回 null，不抛错', () => {
    const { service } = mount(writeTicketLog())
    expect(() => service.lookupTicket(MISSING)).not.toThrow()
    expect(service.lookupTicket(MISSING)).toBeNull()
  })

  it('hasTicket 与 lookupTicket 结论一致', () => {
    const { service } = mount(writeTicketLog())
    for (const id of [TICKET, MISSING, '']) {
      expect(service.hasTicket(id)).toBe(service.lookupTicket(id) !== null)
    }
    expect(service.hasTicket(TICKET)).toBe(true)
    expect(service.hasTicket(MISSING)).toBe(false)
  })

  it('只读：查票前后日志一个字节不变，status / updatedAt 不动', () => {
    const logFile = writeTicketLog()
    const { service, readout } = mount(logFile)
    const beforeBytes = readFileSync(logFile)
    const beforeMtime = statSync(logFile).mtimeMs
    const before = readout.get(TICKET)

    service.lookupTicket(TICKET)
    service.hasTicket(TICKET)
    service.lookupTicket(MISSING)
    service.hasTicket(MISSING)

    const after = readout.get(TICKET)
    expect(readFileSync(logFile).equals(beforeBytes), '查票把票日志改了').toBe(true)
    expect(statSync(logFile).mtimeMs).toBe(beforeMtime)
    expect(before).toBeDefined()
    expect(after?.status).toBe(before?.status)
    expect(after?.statusSince).toBe(before?.statusSince)
    expect(readout.payload().generatedAt).toBeDefined()
  })

  it('服务面只有两个只读方法，不递出 readout / log', () => {
    const { service } = mount(writeTicketLog())
    expect(Object.keys(service).sort()).toEqual(['hasTicket', 'lookupTicket'])
    const handle = service as unknown as Record<string, unknown>
    for (const forbidden of ['get', 'payload', 'list', 'select', 'append', 'commit', 'log', 'desk', 'readout']) {
      expect(handle[forbidden], `服务把 ${forbidden} 递出去了`).toBeUndefined()
    }
  })
})
