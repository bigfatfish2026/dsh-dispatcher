import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { apply } from '../src/index'
import { TicketStore } from '../src/store'
import type { TicketSnapshot } from '../src/store'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A log with fixed timestamps: the order under test is not the clock's. */
function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-revive-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

function testConfig(stateFile: string): Config {
  return {
    stateFile,
    staleMinutes: 30,
    maxOpen: 8,
    briefMaxColumns: 20,
    handoffPolicy: false,
    handoffPolicyText: '',
    sweepMinutes: 0,
    zombieMinutes: 20,
    noReportMinutes: 5,
    notifyOwner: false,
    quietSweep: true,
    ownerSessionId: '',
    qqPrefsPath: join(stateFile, '..', 'prefs.json'),
    ownerOpenId: '',
    noWaitGuard: false,
    maxCommandMs: 30000,
    maxWaitMs: 5000,
    routerRestrict: false,
    routerEscapeFile: join(stateFile, '..', 'no-restrict'),
    routerTools: [],
    extraRouterTools: [],
    workerToolDeny: false,
    workerDenyTools: [],
    workerPromptPrune: true,
    notifyScript: '',
    notifyTimeoutMs: 5000,
  }
}

interface RegisteredTool {
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** Mount the plugin the way the host does and keep the tools it registers. */
function mount(stateFile: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>()
  const ctx = {
    agents: { list: () => [], get: () => undefined },
    effect: (callback: () => () => void) => callback(),
    on: () => () => {},
    tools: {
      register(definition: { name: string } & RegisteredTool) {
        tools.set(definition.name, definition)
        return () => {}
      },
      get: () => undefined,
    },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx as never, testConfig(stateFile))
  return tools
}

async function sweep(tools: Map<string, RegisteredTool>): Promise<void> {
  await tools.get('dispatch_sweep')!.execute({})
}

function snapshot(file: string, id: string): TicketSnapshot {
  const ticket = new TicketStore(file).get(id)
  expect(ticket).toBeTruthy()
  return ticket!
}

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 2, 0, 0, seconds)).toISOString()

describe('sweep revive branch', () => {
  // The bug from 2026-11-02: a message queued while the ticket was still
  // running never reaches a worker whose session is gone, so it stays pending
  // forever. Closing the ticket and then sweeping used to count it as new mail
  // and write status=open with a fresh timestamp.
  it('leaves a done ticket closed when its pending input predates the close', async () => {
    const file = logFile([
      { id: 't-ghost', at: T(0), goal: 'ghost input', status: 'open', dir: '/tmp' },
      { id: 't-ghost', at: T(1), owner: 'dead-worker', status: 'running' },
      { id: 't-ghost', at: T(5), input: { id: 'e-ghost', text: 'worker never got this' } },
      { id: 't-ghost', at: T(9), status: 'done', note: 'delivered' },
    ])

    const before = readFileSync(file, 'utf8').trim().split('\n').length
    await sweep(mount(file))

    const ticket = snapshot(file, 't-ghost')
    expect(ticket.status).toBe('done')
    expect(ticket.closedAt).toBe(T(9))
    // Not one line was appended: the close is still the last word in the log.
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toHaveLength(before)
    expect(lines.filter((line) => line.status).at(-1).status).toBe('done')
  })

  it('reopens a done ticket when the input arrives after the close', async () => {
    const file = logFile([
      { id: 't-fresh', at: T(0), goal: 'late mail', status: 'open' },
      { id: 't-fresh', at: T(9), status: 'done', note: 'delivered' },
      { id: 't-fresh', at: T(20), input: { id: 'e-fresh', text: 'one more thing' } },
    ])

    await sweep(mount(file))

    const ticket = snapshot(file, 't-fresh')
    expect(ticket.status).toBe('open')
    expect(ticket.closedAt).toBeUndefined()
  })

  // A dropped ticket is a person's stop, not a queue to drain.
  it('never revives a dropped ticket, not even with mail after it', async () => {
    const file = logFile([
      { id: 't-stop', at: T(0), goal: 'stopped', status: 'open' },
      { id: 't-stop', at: T(9), status: 'dropped', note: 'person said stop' },
      { id: 't-stop', at: T(20), input: { id: 'e-stop', text: 'ignored' } },
    ])

    await sweep(mount(file))

    const ticket = snapshot(file, 't-stop')
    expect(ticket.status).toBe('dropped')
    expect(ticket.closedAt).toBe(T(9))
  })

  // Durability: the close lives in the log, so a reload or a restart recomputes
  // it from the same lines and reaches the same answer. Two stores, then a
  // second plugin mount on the same file, must all agree.
  it('recomputes closedAt from the log across a reload and a restart', async () => {
    const file = logFile([
      { id: 't-restart', at: T(0), goal: 'survives a restart', status: 'open' },
      { id: 't-restart', at: T(5), input: { id: 'e-restart', text: 'never delivered' } },
      { id: 't-restart', at: T(9), status: 'done', note: 'delivered' },
    ])

    const first = new TicketStore(file).get('t-restart')!
    // A second store off the same file is what a new process sees.
    const second = new TicketStore(file).get('t-restart')!
    expect(first.closedAt).toBe(T(9))
    expect(second.closedAt).toBe(first.closedAt)

    await sweep(mount(file))
    const after = snapshot(file, 't-restart')
    expect(after.status).toBe('done')
    expect(after.closedAt).toBe(T(9))

    // Same conclusion on a third mount, i.e. one more reload later.
    await sweep(mount(file))
    expect(snapshot(file, 't-restart').status).toBe('done')
  })
})
