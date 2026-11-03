import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { apply } from '../src/index'
import { TicketStore } from '../src/store'

/**
 * `subagent/end` is the only thing that tells the log a 小鱼 is gone. The rule
 * under test is narrow on purpose: a matched open/running ticket becomes
 * `waiting`, and nothing else — `done`/`dropped` are the main session's call.
 */

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

interface EndInfo {
  id?: string
  stopReason?: string
}

type EndListener = (info: EndInfo) => unknown

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
    workerToolDeny: false,
    workerDenyTools: [],
    notifyScript: '',
    notifyTimeoutMs: 5000,
  }
}

/** Mount the plugin, keep the `subagent/end` listeners, and hand back the log. */
function mount(): { store: TicketStore; end: EndListener[] } {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-subagent-end-'))
  dirs.push(dir)
  const stateFile = join(dir, 'tickets.jsonl')
  const store = new TicketStore(stateFile)
  const end: EndListener[] = []
  const ctx = {
    agents: { list: () => [], get: () => undefined },
    effect: (callback: () => () => void) => callback(),
    on(event: string, listener: unknown) {
      if (event === 'subagent/end') end.push(listener as EndListener)
      return () => {}
    },
    tools: { register: () => () => {}, get: () => undefined },
    logger: { info() {}, warn() {} },
  }
  apply(ctx as never, testConfig(stateFile))
  return { store, end }
}

function fire(listeners: EndListener[], info: EndInfo): void {
  for (const listener of listeners) listener(info)
}

describe('subagent/end settles the ticket it owns', () => {
  it('turns a running ticket into waiting, never done', () => {
    const { store, end } = mount()
    const ticket = store.open('build llvm', '/tmp/work', 'build llvm')
    store.update(ticket.id, { status: 'running', owner: 'session-abc' })

    fire(end, { id: 'session-abc', stopReason: 'completed' })

    const settled = store.get(ticket.id)!
    expect(settled.status).toBe('waiting')
    expect(settled.status).not.toBe('done')
    // stopReason goes into the note verbatim.
    expect(settled.note).toBe('worker 结束（completed），票内无报告')
  })

  it('matches the owner through the session- prefix in either direction', () => {
    const { store, end } = mount()
    const bare = store.open('one')
    store.update(bare.id, { status: 'running', owner: 'abc' })
    const prefixed = store.open('two')
    store.update(prefixed.id, { status: 'running', owner: 'session-def' })

    // Both tickets share one owner id in the event: only the prefix variants match.
    fire(end, { id: 'session-abc', stopReason: 'aborted' })
    fire(end, { id: 'def', stopReason: 'error' })

    expect(store.get(bare.id)!.status).toBe('waiting')
    expect(store.get(prefixed.id)!.status).toBe('waiting')
    expect(store.get(prefixed.id)!.note).toBe('worker 结束（error），票内无报告')
  })

  it('leaves other owners, closed tickets and the done verdict alone', () => {
    const { store, end } = mount()
    const other = store.open('someone else')
    store.update(other.id, { status: 'running', owner: 'session-zzz' })
    const done = store.open('already shipped')
    store.update(done.id, { status: 'done', owner: 'session-abc', note: 'shipped' })
    const waiting = store.open('blocked on a person')
    store.update(waiting.id, { status: 'blocked', owner: 'session-abc' })

    fire(end, { id: 'session-abc', stopReason: 'completed' })

    expect(store.get(other.id)!.status).toBe('running')
    expect(store.get(done.id)!.status).toBe('done')
    expect(store.get(done.id)!.note).toBe('shipped')
    expect(store.get(waiting.id)!.status).toBe('blocked')
  })

  it('settles every open ticket with that owner', () => {
    const { store, end } = mount()
    const first = store.open('first')
    store.update(first.id, { status: 'running', owner: 'session-abc' })
    const second = store.open('second')
    store.update(second.id, { status: 'running', owner: 'session-abc' })

    fire(end, { id: 'session-abc', stopReason: 'max-tokens' })

    expect(store.get(first.id)!.status).toBe('waiting')
    expect(store.get(second.id)!.status).toBe('waiting')
    expect(store.get(first.id)!.note).toBe('worker 结束（max-tokens），票内无报告')
  })

  it('stays quiet for a missing id, an unknown id and an ownerless ticket', () => {
    const { store, end } = mount()
    const ownerless = store.open('nobody owns this')
    store.update(ownerless.id, { status: 'running' })

    expect(() => fire(end, {})).not.toThrow()
    expect(() => fire(end, { id: '' })).not.toThrow()
    expect(() => fire(end, { id: 'session-ghost', stopReason: 'completed' })).not.toThrow()
    expect(store.get(ownerless.id)!.status).toBe('running')
  })
})

/**
 * 2026-11-03: a ticket that lands in `waiting` used to look exactly like one
 * that delivered — nothing in the log said whether the 小鱼 had left a single
 * report. The note carries that count now, so "did it hand anything back?" can
 * be answered from `dispatch_list` alone. Still a note and only a note: no new
 * event kind, no status, and never `done`.
 */
describe('the waiting note says whether anything was handed back', () => {
  it('writes 票内无报告 when the ticket carries none', () => {
    const { store, end } = mount()
    const ticket = store.open('nothing handed back')
    store.update(ticket.id, { status: 'running', owner: 'session-abc' })

    fire(end, { id: 'session-abc', stopReason: 'completed' })

    const settled = store.get(ticket.id)!
    expect(settled.status).toBe('waiting')
    expect(settled.note).toBe('worker 结束（completed），票内无报告')
    expect(settled.reports).toHaveLength(0)
  })

  it('writes 票内 N 条报告 when the ticket carries two', () => {
    const { store, end } = mount()
    const ticket = store.open('handed two back')
    store.update(ticket.id, { status: 'running', owner: 'session-abc' })
    store.appendReport(ticket.id, '第一条：改完了')
    store.appendReport(ticket.id, '第二条：测试过了')

    fire(end, { id: 'session-abc', stopReason: 'completed' })

    const settled = store.get(ticket.id)!
    expect(settled.status).toBe('waiting')
    expect(settled.reports).toHaveLength(2)
    expect(settled.note).toBe('worker 结束（completed），票内 2 条报告')
  })

  it('leaves the same evidence when the worker died with an error', () => {
    const { store, end } = mount()
    const empty = store.open('died without a word')
    store.update(empty.id, { status: 'running', owner: 'session-abc' })
    const reported = store.open('died after reporting')
    store.update(reported.id, { status: 'running', owner: 'session-abc' })
    store.appendReport(reported.id, '只剩这一步没做完')

    fire(end, { id: 'session-abc', stopReason: 'error' })

    expect(store.get(empty.id)!.note).toBe('worker 结束（error），票内无报告')
    expect(store.get(reported.id)!.note).toBe('worker 结束（error），票内 1 条报告')
    // The note is a note: the hook still never decides the ticket is done.
    expect(store.get(empty.id)!.status).toBe('waiting')
    expect(store.get(reported.id)!.status).toBe('waiting')
  })
})

/**
 * 2026-11-03: a broken dispatcher took the whole ticket system down. This hook
 * is a nicety — it may never be the reason `dispatch_*` disappear. A host that
 * refuses the event (an older cordis, a stricter registry) must cost us one
 * warning line, not the plugin.
 */
describe('subagent/end subscription is not load-bearing', () => {
  it('keeps apply() and every tool alive when the host refuses the event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatcher-subagent-end-hard-'))
    dirs.push(dir)
    const stateFile = join(dir, 'tickets.jsonl')
    const warnings: string[] = []
    const registered: string[] = []
    const ctx = {
      agents: { list: () => [], get: () => undefined },
      effect: (callback: () => () => void) => callback(),
      on(event: string) {
        if (event === 'subagent/end') throw new Error('unknown event')
        return () => {}
      },
      tools: {
        register(definition: { name: string }) {
          registered.push(definition.name)
          return () => {}
        },
        get: () => undefined,
      },
      logger: { info() {}, warn: (message: string) => warnings.push(message) },
    }

    expect(() => apply(ctx as never, testConfig(stateFile))).not.toThrow()
    // The ticket tools came up anyway, which is the only part that matters.
    expect(registered).toContain('dispatch_open')
    expect(registered).toContain('dispatch_report')
    expect(warnings.join('\n')).toContain('subagent/end')
  })
})
