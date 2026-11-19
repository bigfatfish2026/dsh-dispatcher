import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  cleanTempDirs()
})

const T = (seconds: number): string => new Date(Date.UTC(2026, 11, 12, 0, 0, seconds)).toISOString()

/** 写一份票日志，行原样落盘（事件种类由内容决定）。 */
function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-plan-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

interface PlanIntent {
  intent?: {
    impact?: { paths?: string[]; services?: string[] }
    reversibility?: string
    undo?: { kind?: string; howto?: string }
  }
  plan?: { summary?: string; files?: Array<{ path?: string; what?: string }> }
}

interface TicketRow extends PlanIntent {
  id: string
  status: string
  phase?: string
  brief: string
  pendingReports: number
}

interface ListOutput {
  openCount: number
  tickets: TicketRow[]
}

interface ReadOutput {
  tickets: TicketRow[]
  returned: number
}

/** 一张探过路的票：published 带老意图，declared 覆盖成 plan + 新意图。 */
function declaredTicket(): string {
  return logFile([
    {
      kind: 'published',
      id: 't-plan',
      at: T(0),
      goal: '给资源串做归一化',
      brief: '资源串归一化',
      publisher: 'session-main',
      preset: 't1',
      presetSource: 'fallback',
      requestId: 'req-plan-1',
      intent: { reversibility: 'manual' },
    },
    { kind: 'planning', id: 't-plan', at: T(1), preset: 't2', workerId: 'probe-1' },
    {
      kind: 'declared',
      id: 't-plan',
      at: T(2),
      plan: {
        summary: '新增 resources.ts 并补测试',
        files: [{ path: 'src/tickets/resources.ts', what: '归一化函数' }],
      },
      intent: {
        impact: { paths: ['file:/srv/work/dsh-dispatcher/src/tickets/resources.ts'] },
        reversibility: 'auto',
        undo: { kind: 'git', howto: 'git checkout -- src/tickets/resources.ts' },
      },
    },
    { kind: 'touch-reported', id: 't-plan', at: T(3), actor: 'worker', paths: ['src/tickets/resources.ts'] },
    { kind: 'reported', id: 't-plan', at: T(4), report: { id: 'r-1', text: '干完了' }, source: 'worker' },
  ])
}

function renderOf(host: ReturnType<typeof mountPlugin>, name: string, value: unknown): string {
  const definition = host.definition(name) as unknown as {
    output: { render: (args: Record<string, unknown>, value: unknown) => Array<{ text: string }> }
  }
  return definition.output
    .render({}, value)
    .map((part) => part.text)
    .join('\n')
}

describe('intent / plan 从工具里读得回来', () => {
  it('dispatch_list 带 intent 与 plan，declared 覆盖 published 上的旧意图', async () => {
    const host = mountPlugin({ config: { stateFile: declaredTicket() } })
    const output = (await host.call('dispatch_list', {})) as ListOutput
    const row = output.tickets.find((ticket) => ticket.id === 't-plan')!
    expect(row.plan?.summary).toBe('新增 resources.ts 并补测试')
    expect(row.plan?.files?.map((file) => file.path)).toEqual(['src/tickets/resources.ts'])
    expect(row.intent?.impact?.paths).toEqual(['file:/srv/work/dsh-dispatcher/src/tickets/resources.ts'])
    expect(row.intent?.reversibility).toBe('auto')
    expect(row.intent?.undo?.kind).toBe('git')
    // 状态仍只由主会话的动作写：planning / declared / touch-reported 都不改它。
    expect(row.status).toBe('open')
    // phase 是单独一栏：声明完了就等放行，票面别跟干活票长得一样。
    expect(row.phase).toBe('planned')
  })

  it('dispatch_list 的文本行里也有 plan 与 intent，模型看得见', async () => {
    const host = mountPlugin({ config: { stateFile: declaredTicket() } })
    const output = (await host.call('dispatch_list', {})) as ListOutput
    const text = renderOf(host, 'dispatch_list', output)
    expect(text).toContain('open（待放行）：资源串归一化')
    expect(text).toContain('plan：新增 resources.ts 并补测试（src/tickets/resources.ts）')
    expect(text).toContain('intent：paths file:/srv/work/dsh-dispatcher/src/tickets/resources.ts')
    expect(text).toContain('reversibility auto')
  })

  it('dispatch_read 也带得回来，文本行同样有', async () => {
    const host = mountPlugin({ config: { stateFile: declaredTicket() } })
    const output = (await host.call('dispatch_read', { id: 't-plan' })) as ReadOutput
    const row = output.tickets[0]!
    expect(row.plan?.summary).toBe('新增 resources.ts 并补测试')
    expect(row.intent?.reversibility).toBe('auto')
    const text = renderOf(host, 'dispatch_read', output)
    expect(text).toContain('plan：新增 resources.ts 并补测试')
    expect(text).toContain('intent：paths file:')
  })

  it('没探过路的老票：两栏整个不出现，文本行也不多出来', async () => {
    const file = logFile([
      { id: 't-old', at: T(0), goal: '老票', brief: '老票', status: 'open' },
      { id: 't-old', at: T(1), report: { id: 'r-old', text: '老报告' } },
    ])
    const host = mountPlugin({ config: { stateFile: file } })
    const output = (await host.call('dispatch_list', {})) as ListOutput
    const row = output.tickets[0]!
    expect('intent' in row).toBe(false)
    expect('plan' in row).toBe(false)
    // 老票没有 phase：不许在票面上撑出 undefined。
    expect('phase' in row).toBe(false)
    const text = renderOf(host, 'dispatch_list', output)
    expect(text).not.toContain('plan：')
    expect(text).not.toContain('intent：')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('（')
  })

  it('gated 也翻成中文：status 是 waiting，标记补出「已驳回」', async () => {
    const file = logFile([
      {
        kind: 'published',
        id: 't-gated',
        at: T(0),
        goal: '要跑命令但档里没 bash',
        brief: '跑测试',
        publisher: 'session-main',
        preset: 't1',
        presetSource: 'fallback',
        requestId: 'req-gated',
      },
      {
        kind: 'gated',
        id: 't-gated',
        at: T(1),
        cause: 'reaction',
        reason: 't1 没有 bash，判驳回',
      },
    ])
    const host = mountPlugin({ config: { stateFile: file } })
    const output = (await host.call('dispatch_list', {})) as ListOutput
    const row = output.tickets[0]!
    // status 仍是 waiting：光看它跟「干完等人接」分不出来。
    expect(row.status).toBe('waiting')
    expect(row.phase).toBe('gated')

    const text = renderOf(host, 'dispatch_list', output)
    expect(text).toContain('waiting（已驳回）：跑测试')
  })

  it('票面把 phase 翻成中文：探路中 / 冲突排队', async () => {
    const file = logFile([
      {
        kind: 'published',
        id: 't-probe',
        at: T(0),
        goal: '先探一下',
        brief: '先探一下',
        publisher: 'session-main',
        preset: 't1',
        presetSource: 'fallback',
        requestId: 'req-probe',
      },
      { kind: 'planning', id: 't-probe', at: T(1), preset: 't1', workerId: 'probe-1' },
      {
        kind: 'published',
        id: 't-queued',
        at: T(2),
        goal: '抢同一片',
        brief: '抢同一片',
        publisher: 'session-main',
        preset: 't1',
        presetSource: 'fallback',
        requestId: 'req-queued',
      },
      { kind: 'spawned', id: 't-queued', at: T(3), workerId: 'worker-1', provider: 'test', preset: 't1' },
      {
        kind: 'declared',
        id: 't-queued',
        at: T(4),
        plan: { summary: '改同一片' },
        intent: { writes: ['dir:/a/b'] },
      },
      {
        kind: 'conflict-checked',
        id: 't-queued',
        at: T(5),
        level: 'strong',
        waitOn: [{ ticketId: 't-probe', resources: ['dir:/a/b'] }],
      },
      { kind: 'reported', id: 't-queued', at: T(6), report: { id: 'r-1', text: '排着队' }, source: 'worker' },
    ])
    const host = mountPlugin({ config: { stateFile: file } })
    const output = (await host.call('dispatch_list', {})) as ListOutput
    const probe = output.tickets.find((ticket) => ticket.id === 't-probe')!
    const queued = output.tickets.find((ticket) => ticket.id === 't-queued')!
    expect(probe.phase).toBe('planning')
    expect(queued.phase).toBe('queued')

    const text = renderOf(host, 'dispatch_list', output)
    expect(text).toContain('t-probe open（探路中）：先探一下')
    expect(text).toContain('t-queued running（冲突排队）：抢同一片')
    expect(text).toContain('waiting on t-probe (dir:/a/b)')

    // dispatch_read 的票头也带同一行标记。
    const read = (await host.call('dispatch_read', {})) as ReadOutput
    const readRow = read.tickets.find((ticket) => ticket.id === 't-queued')!
    expect(readRow.phase).toBe('queued')
    const readText = renderOf(host, 'dispatch_read', read)
    expect(readText).toContain('ticket t-queued running（冲突排队）：抢同一片')
  })
})
