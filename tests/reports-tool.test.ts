import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TicketStore, foldEvents, pending } from '../src/store'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  cleanTempDirs()
})

/** A log with fixed timestamps: the order under test is not the clock's. */
function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-reports-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

const T = (seconds: number): string => new Date(Date.UTC(2026, 10, 3, 0, 0, seconds)).toISOString()

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>

function mount(file: string): { call: Call; file: string } {
  const host = mountPlugin({ config: { stateFile: file } })
  return { call: (name, args) => host.call(name, args), file }
}

/** One ticket, three reports; the first one is already read. */
function ticketWithReports(extra: Array<Record<string, unknown>> = []): string {
  return logFile([
    { id: 't-open', at: T(0), goal: '修报告工具', brief: '修报告工具', status: 'open' },
    { id: 't-open', at: T(1), report: { id: 'r-1', text: '第一条：存储抽层落盘' } },
    { id: 't-open', at: T(2), delivered: { kind: 'report', id: 'r-1' } },
    { id: 't-open', at: T(3), report: { id: 'r-2', text: '第二条：工具写完' } },
    { id: 't-open', at: T(4), report: { id: 'r-3', text: '第三条：测试全绿' } },
    ...extra,
  ])
}

interface ReportView {
  n: number
  id: string
  at: string
  text: string
  read: boolean
  truncated?: boolean
}

interface ReportsOutput {
  tickets: Array<{ id: string; status: string; goal: string; pendingReports: number; reports: ReportView[] }>
  returned: number
  markedRead: number
}

interface ListOutput {
  tickets: Array<{ id: string; pendingReports: number }>
}

describe('dispatch_read', () => {
  it('默认只返回未读，读完标记已读，«n 归零', async () => {
    const file = ticketWithReports()
    const { call } = mount(file)

    const output = (await call('dispatch_read', { id: 't-open' })) as ReportsOutput
    expect(output.returned).toBe(2)
    expect(output.markedRead).toBe(2)
    expect(output.tickets).toHaveLength(1)
    expect(output.tickets[0]!.pendingReports).toBe(0)
    // n 是该票完整报告列表里的 1 起序号：已读那条不返回，但号不能被顶掉。
    expect(output.tickets[0]!.reports.map((report) => report.n)).toEqual([2, 3])
    expect(output.tickets[0]!.reports.map((report) => report.text)).toEqual([
      '第二条：工具写完',
      '第三条：测试全绿',
    ])
    expect(output.tickets[0]!.reports.every((report) => report.read === false)).toBe(true)

    // 票上确实记了已读：pending 归零，dispatch_list 的 «n 跟着归零。
    expect(pending(new TicketStore(file).get('t-open')!.reports)).toHaveLength(0)
    const listed = (await call('dispatch_list', {})) as ListOutput
    expect(listed.tickets.find((ticket) => ticket.id === 't-open')!.pendingReports).toBe(0)

    // 再读一轮：没有未读了。
    const again = (await call('dispatch_read', { id: 't-open' })) as ReportsOutput
    expect(again).toMatchObject({ tickets: [], returned: 0, markedRead: 0 })
  })

  it('limit 挡下的不标已读，下一轮接着读', async () => {
    const file = ticketWithReports()
    const { call } = mount(file)

    // 三条报告、第一条已读：limit 给 1，只该取走「第二条」。
    const first = (await call('dispatch_read', { id: 't-open', limit: 1 })) as ReportsOutput
    expect(first.returned).toBe(1)
    expect(first.markedRead).toBe(1)
    expect(first.tickets[0]!.reports[0]!.n).toBe(2)
    // 被 limit 挡下的那条还挂着。
    expect(first.tickets[0]!.pendingReports).toBe(1)
    expect(pending(new TicketStore(file).get('t-open')!.reports)).toHaveLength(1)

    const second = (await call('dispatch_read', { id: 't-open' })) as ReportsOutput
    expect(second.returned).toBe(1)
    expect(second.tickets[0]!.reports[0]!.n).toBe(3)
    expect(second.tickets[0]!.pendingReports).toBe(0)
  })

  it('includeRead 把整段历史都带回来，已读的不重复记账', async () => {
    const file = ticketWithReports()
    const { call } = mount(file)
    await call('dispatch_read', { id: 't-open' })

    const output = (await call('dispatch_read', { id: 't-open', includeRead: true })) as ReportsOutput
    expect(output.returned).toBe(3)
    expect(output.markedRead).toBe(0)
    expect(output.tickets[0]!.reports.map((report) => report.n)).toEqual([1, 2, 3])
    expect(output.tickets[0]!.reports.every((report) => report.read === true)).toBe(true)
    expect(output.tickets[0]!.reports[0]!.text).toBe('第一条：存储抽层落盘')
  })

  it('省略 id：只读有未读的未结票，limit 跨票生效', async () => {
    const file = logFile([
      { id: 't-a', at: T(0), goal: 'A', status: 'open' },
      { id: 't-a', at: T(1), report: { id: 'a-1', text: 'A 的报告' } },
      { id: 't-b', at: T(2), goal: 'B', status: 'running' },
      { id: 't-b', at: T(3), report: { id: 'b-1', text: 'B 的报告' } },
      // 已关票上的报告不该被顺手读掉：得按 id 点名。
      { id: 't-done', at: T(4), goal: 'C', status: 'done' },
      { id: 't-done', at: T(5), report: { id: 'c-1', text: 'C 的报告' } },
    ])
    const { call } = mount(file)

    const first = (await call('dispatch_read', { limit: 1 })) as ReportsOutput
    expect(first.returned).toBe(1)
    expect(first.tickets.map((ticket) => ticket.id)).toEqual(['t-a'])

    const second = (await call('dispatch_read', { limit: 1 })) as ReportsOutput
    expect(second.tickets.map((ticket) => ticket.id)).toEqual(['t-b'])

    const third = (await call('dispatch_read', {})) as ReportsOutput
    expect(third.returned).toBe(0)
    expect(pending(new TicketStore(file).get('t-done')!.reports)).toHaveLength(1)
  })

  it('已关票按 id 点名才读得到，已读正文照给', async () => {
    const file = logFile([
      { id: 't-done', at: T(0), goal: '收工', status: 'done' },
      { id: 't-done', at: T(1), report: { id: 'd-1', text: '交付：三次提交、两次 tag' } },
      { id: 't-done', at: T(2), delivered: { kind: 'report', id: 'd-1' } },
    ])
    const { call } = mount(file)

    const quiet = (await call('dispatch_read', { id: 't-done' })) as ReportsOutput
    expect(quiet.returned).toBe(0)

    const output = (await call('dispatch_read', { id: 't-done', includeRead: true })) as ReportsOutput
    expect(output.returned).toBe(1)
    expect(output.markedRead).toBe(0)
    expect(output.tickets[0]!.reports[0]).toMatchObject({ n: 1, text: '交付：三次提交、两次 tag', read: true })
  })

  it('超长正文截到 4000 字并标 truncated', async () => {
    const long = '鱼'.repeat(4001)
    const file = logFile([
      { id: 't-long', at: T(0), goal: '长报告', status: 'open' },
      { id: 't-long', at: T(1), report: { id: 'l-1', text: long } },
      { id: 't-long', at: T(2), report: { id: 'l-2', text: '短的' } },
    ])
    const { call } = mount(file)

    const output = (await call('dispatch_read', { id: 't-long' })) as ReportsOutput
    const [first, second] = output.tickets[0]!.reports
    expect(Array.from(first!.text)).toHaveLength(4000)
    expect(first!.truncated).toBe(true)
    // 没截的条目不许带 truncated: undefined——工具层不接受 undefined 字段。
    expect(second!.truncated).toBeUndefined()
  })

  it('坏票 id 当场报错，不静默给一份空报告', async () => {
    const { call } = mount(ticketWithReports())
    await expect(call('dispatch_read', { id: 't-nope' })).rejects.toThrow(/没有票 t-nope/)
  })

  it('读报告只追加 delivered：状态和报告条数一个都不动', async () => {
    const file = ticketWithReports()
    const { call } = mount(file)
    const output = (await call('dispatch_read', { id: 't-open' })) as ReportsOutput
    expect(output.markedRead).toBe(2)

    const after = new TicketStore(file).get('t-open')!
    expect(after.status).toBe('open')
    expect(after.reports).toHaveLength(3)
    expect(pending(after.reports)).toHaveLength(0)
  })
})
