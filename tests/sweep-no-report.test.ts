import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { apply } from '../src/index'
import { TicketStore } from '../src/store'

/**
 * 2026-11-03「waiting 不等于交活」这一刀，端到端跑一遍 sweep。
 *
 * 原来 waiting 根本不在巡检池里：小鱼退了、票落 waiting、一条报告都没留，这张票
 * 就彻底失联。现在 waiting 且无报告会被推一次，且只推一次；补报之后它不再是候选，
 * 指纹也随 sweep 那套清理消失。
 */

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-no-report-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

const OWNER = 'session-owner'

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
    notifyOwner: true,
    quietSweep: false,
    ownerSessionId: OWNER,
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

interface Injected {
  text: string
}

/** Mount with an idle owner session that records every followup the sweep sends. */
function mount(stateFile: string): { tools: Map<string, RegisteredTool>; inbox: Injected[] } {
  const tools = new Map<string, RegisteredTool>()
  const inbox: Injected[] = []
  const owner = {
    status: 'idle',
    followup: async (message: unknown) => {
      inbox.push(message as Injected)
      return undefined
    },
    steer: async () => undefined,
  }
  const ctx = {
    agents: {
      list: () => [],
      get: (id: string) => (id === OWNER ? owner : undefined),
    },
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
  return { tools, inbox }
}

function injectedText(inbox: Injected[]): string {
  return inbox
    .flatMap((message) => {
      const content = (message as unknown as { content?: Array<{ text?: string }> }).content ?? []
      return content.map((part) => part.text ?? '')
    })
    .join('')
}

interface SweepOutput {
  stale: number
  delivered: number
  cleared: number
  woke: boolean
  reason: string
}

async function sweep(tools: Map<string, RegisteredTool>): Promise<SweepOutput> {
  return (await tools.get('dispatch_sweep')!.execute({})) as SweepOutput
}

/** 2026-11-01 的固定时刻，久到所有阈值都过。 */
const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 1, 0, 0, seconds)).toISOString()

describe('a waiting ticket with no report is reported once', () => {
  it('pushes the 补报 wording, then goes quiet, then drops out after a report', async () => {
    const file = logFile([
      { id: 't-silent', at: T(0), goal: '搬完那批日志', status: 'open' },
      { id: 't-silent', at: T(1), owner: OWNER, status: 'running' },
      // 小鱼退了，钩子写了 waiting，note 里明说一条报告都没有。
      { id: 't-silent', at: T(2), status: 'waiting', note: 'worker 结束（error），票内无报告' },
      // 对照组：waiting 但已经交了报告，主会话该收的活，不该被问。
      { id: 't-reported', at: T(0), goal: '另一张已经交过的票', status: 'open' },
      { id: 't-reported', at: T(1), owner: OWNER, status: 'running' },
      { id: 't-reported', at: T(2), report: { id: 'e-reported', text: '做完了' } },
      { id: 't-reported', at: T(3), status: 'waiting', note: 'worker 结束（completed），票内 1 条报告' },
    ])

    const { tools, inbox } = mount(file)
    const first = await sweep(tools)

    expect(first.woke).toBe(true)
    expect(first.stale).toBe(1)
    expect(inbox).toHaveLength(1)
    const text = injectedText(inbox)
    expect(text).toContain('t-silent 的小鱼退了但票里一条报告都没有')
    expect(text).toContain('dispatch_send')
    expect(text).toContain('看它干了什么')
    expect(text).not.toContain('t-reported')

    // 第二轮：指纹没变，不该再吵一次（stale 仍是 1：它还是候选，只是已经推过了）。
    const second = await sweep(tools)
    expect(second.woke).toBe(false)
    expect(second.stale).toBe(1)
    expect(inbox).toHaveLength(1)

    // 主会话叫它补报，报告落进日志：这张票不再是「无报告」，不再被盯上。
    new TicketStore(file).appendReport('t-silent', '补报了：改了钩子和列表，测试全过')
    const third = await sweep(tools)
    expect(third.woke).toBe(false)
    expect(third.stale).toBe(0)
    expect(inbox).toHaveLength(1)
  })

  it('says nothing while the ticket is still inside noReportMinutes', async () => {
    const now = Date.now()
    const file = logFile([
      { id: 't-fresh', at: new Date(now - 60_000).toISOString(), goal: '刚退出来一分钟', status: 'open' },
      { id: 't-fresh', at: new Date(now - 30_000).toISOString(), status: 'waiting', note: 'worker 结束（completed），票内无报告' },
    ])

    const { tools, inbox } = mount(file)
    await sweep(tools)

    expect(inbox).toHaveLength(0)
  })
})
