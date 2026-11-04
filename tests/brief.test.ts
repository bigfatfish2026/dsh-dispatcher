import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import {
  BRIEF_MAX_COLUMNS,
  TicketStore,
  briefOf,
  deriveBrief,
  foldEvents,
  textColumns,
  truncateColumns,
} from '../src/store'
import { makeDesk } from './helpers/desk-harness'
import { cleanTempDirs, mountPlugin, tempDir } from './helpers/plugin-harness'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  cleanTempDirs()
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-brief-'))
  dirs.push(dir)
  return join(dir, 'tickets.jsonl')
}

/** One line of the log, as foldEvents takes it. */
type TicketEvent = Parameters<typeof foldEvents>[0][number]

/** A log written by hand, the way an older version of the plugin wrote it. */
function logFile(lines: readonly TicketEvent[]): string {
  const file = tempFile()
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

interface RegisteredTool {
  execute(args: Record<string, unknown>, exec?: unknown): Promise<unknown>
}

/** 装一次插件，把注册的工具拿回来；票日志落在 stateFile。 */
function mount(stateFile: string, overrides: Partial<Config> = {}): {
  tools: Map<string, RegisteredTool>
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
  open: (args: Record<string, unknown>) => Promise<{ id: string }>
} {
  const host = mountPlugin({ config: { stateFile, ...overrides } })
  const tools = host.tools as unknown as Map<string, RegisteredTool>
  return {
    tools,
    call: (name, args) => host.call(name, args),
    open: (args) => host.call('dispatch_open', args) as Promise<{ id: string }>,
  }
}

/** A goal that exactly fills the cap: 17 汉字 = 34 columns (2026-11-02 little-screen measurement). */
const AT_CAP = '一二三四五六七八九十一二三四五六七'
/** One more 汉字 than fits, so the truncation has something to cut. */
const OVER_CAP = `${AT_CAP}八九十`

describe('deriveBrief', () => {
  it('takes the first sentence and drops the punctuation around it', () => {
    expect(deriveBrief('给票加 brief 字段。顺手补测试，再记一笔。')).toBe('给票加 brief 字段')
    expect(deriveBrief('先看代码！再看日志？')).toBe('先看代码')
    expect(deriveBrief('，收拾一下：磁盘，')).toBe('收拾一下：磁盘')
  })

  it('collapses whitespace and never returns an empty second line', () => {
    expect(deriveBrief('  跑   测试  ')).toBe('跑 测试')
    expect(deriveBrief('！！！')).toBe('！！！')
  })

  it('keeps a goal that fits untouched', () => {
    expect(BRIEF_MAX_COLUMNS).toBe(34)
    expect(textColumns(AT_CAP)).toBe(BRIEF_MAX_COLUMNS)
    expect(deriveBrief(AT_CAP)).toBe(AT_CAP)
    expect(deriveBrief('短').length).toBe(1)
  })

  it('truncates to the column cap and marks the cut with an ellipsis', () => {
    const brief = deriveBrief(OVER_CAP)
    expect(brief.endsWith('…')).toBe(true)
    expect(textColumns(brief)).toBeLessThanOrEqual(BRIEF_MAX_COLUMNS)
    // 16 汉字 = 32 columns, plus the 2-column ellipsis = exactly the cap.
    expect(brief).toBe('一二三四五六七八九十一二三四五六…')
    expect(textColumns(brief)).toBe(BRIEF_MAX_COLUMNS)
  })

  it('honours a configured cap, half-width text counting one column each', () => {
    expect(textColumns('abcdefghij')).toBe(10)
    expect(truncateColumns('abcdefghij', 6)).toBe('abcd…')
    expect(deriveBrief('build llvm from source', 8)).toBe('build …')
  })
})

describe('dispatch_open brief', () => {
  it('stores the brief the caller passed', async () => {
    const file = tempFile()
    const { open } = mount(file)
    const opened = await open({ goal: '很长的任务书，写了一大段。', brief: '改插件字段' })

    // 开票写两行：published（人交的活）和 spawned（派了小鱼）。摘要在第一行上。
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.find((line) => line.kind === 'published')).toMatchObject({ id: opened.id, brief: '改插件字段' })
    expect(new TicketStore(file).get(String(opened.id))?.brief).toBe('改插件字段')
  })

  it('rejects a ticket opened with no brief at all', async () => {
    const file = tempFile()
    const { tools, open } = mount(file)
    // brief 必填：不传就是错误，不再从 goal 派生一句顶上来。缺参数在 schema 那道
    // 关就被拦下（required 列表），空串之类才轮到 execute 里的中文提示。
    await expect(
      tools.get('dispatch_open')!.execute({ goal: '在小屏第二行显示票的简短目标。整段任务书太长，塞不下。' }),
    ).rejects.toThrow(/missing required property "brief"/)
    // 票日志里一条都没有：错误发生在落票之前。
    expect(existsSync(file) ? readFileSync(file, 'utf8').trim() : '').toBe('')
    await expect(open({ goal: 'g', brief: '' })).rejects.toThrow(/brief 不能为空/)
    expect(existsSync(file) ? readFileSync(file, 'utf8').trim() : '').toBe('')
  })

  it('rejects an empty, whitespace-only or punctuation-only brief', async () => {
    const file = tempFile()
    const { call } = mount(file)
    for (const brief of ['', '   ', '\n\t', '。', '…… ！？', '—— 、']) {
      await expect(call('dispatch_open', { goal: 'g', brief })).rejects.toThrow(/brief 不能为空/)
    }
    // 一个都没落盘：空摘要连票都不开。
    expect(existsSync(file) ? readFileSync(file, 'utf8').trim() : '').toBe('')
  })

  it('says what the field is for and refuses a blank one', async () => {
    const { call } = mount(tempFile(), { briefMaxColumns: 20 })
    await expect(call('dispatch_open', { goal: 'g', brief: ' ' })).rejects.toThrow(
      'brief 不能为空：它是小屏第二行，一句话说清这票干嘛',
    )
  })

  it('keeps a brief that is exactly at the cap untouched', async () => {
    const file = tempFile()
    const { open } = mount(file)
    const opened = await open({ goal: 'g', brief: AT_CAP })

    const stored = new TicketStore(file).get(String(opened.id))?.brief
    expect(stored).toBe(AT_CAP)
    expect(textColumns(stored!)).toBe(BRIEF_MAX_COLUMNS)
    expect(stored!.endsWith('…')).toBe(false)
  })

  it('cuts a brief one column over the cap to 32 columns plus the ellipsis', async () => {
    const file = tempFile()
    const { open } = mount(file)
    // 34 列 + 一个半角字符 = 35 列，刚好越过上限一列。
    const opened = await open({ goal: 'g', brief: `${AT_CAP}a` })

    const brief = new TicketStore(file).get(String(opened.id))?.brief!
    expect(brief.endsWith('…')).toBe(true)
    // 16 汉字 = 32 列，加上 2 列的省略号，总宽仍然正好是 34。
    expect(brief).toBe('一二三四五六七八九十一二三四五六…')
    expect(textColumns(brief)).toBe(BRIEF_MAX_COLUMNS)
  })

  it('caps a caller-supplied brief at the configured width', async () => {
    const file = tempFile()
    const { open } = mount(file, { briefMaxColumns: 8 })
    const opened = await open({ goal: 'g', brief: `${AT_CAP}八九十` })

    const brief = new TicketStore(file).get(String(opened.id))?.brief
    expect(textColumns(brief!)).toBeLessThanOrEqual(8)
    expect(brief!.endsWith('…')).toBe(true)
  })
})

describe('old tickets without a brief', () => {
  const lines: TicketEvent[] = [
    { id: 't-old-1', at: '2026-10-31T00:00:00.000Z', goal: '整理磁盘上的备份目录。顺手删掉三个月前的。', status: 'open' },
    { id: 't-old-1', at: '2026-10-31T00:10:00.000Z', note: '刚开工' },
  ]

  it('folds without exploding and keeps brief undefined', () => {
    const snapshots = foldEvents(lines)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].brief).toBeUndefined()
    expect(snapshots[0].goal).toContain('整理磁盘')
  })

  it('derives the brief on read so the second line is never blank', () => {
    const store = new TicketStore(logFile(lines))
    const ticket = store.get('t-old-1')!
    expect(briefOf(ticket)).toBe('整理磁盘上的备份目录')
    expect(briefOf(ticket)).toBe(deriveBrief(ticket.goal))
  })

  it('exposes the derived brief through dispatch_list', async () => {
    const file = logFile(lines)
    const { call } = mount(file)
    const listed = (await call('dispatch_list', {})) as {
      tickets: Array<{ id: string; goal: string; brief: string }>
    }
    const row = listed.tickets.find((ticket) => ticket.id === 't-old-1')!
    expect(row.brief).toBe('整理磁盘上的备份目录')
    // 小屏只放摘要；整段目标留在日志里，命令里不重复占位。
    expect(row).not.toHaveProperty('goal')
    expect(new TicketStore(file).get('t-old-1')!.goal).toContain('顺手删掉')
  })

  it('lets a later event fill the field in without losing it', () => {
    const snapshots = foldEvents([
      ...lines,
      { id: 't-old-1', at: '2026-11-02T00:00:00.000Z', brief: '补上摘要' },
      { id: 't-old-1', at: '2026-11-02T00:05:00.000Z', status: 'running' },
    ])
    expect(snapshots[0].brief).toBe('补上摘要')
  })

  it('shows the derived brief in a ticket view', async () => {
    const h = makeDesk({ now: new Date('2026-10-31T01:00:00.000Z') })
    h.backend.append(lines[0]!)
    h.backend.append(lines[1]!)
    h.desk.attach()
    expect(h.desk.get('t-old-1')!.brief).toBe('整理磁盘上的备份目录')
  })
})
