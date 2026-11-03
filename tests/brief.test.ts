import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { apply, toView } from '../src/index'
import {
  BRIEF_MAX_COLUMNS,
  TicketStore,
  briefOf,
  deriveBrief,
  foldEvents,
  textColumns,
  truncateColumns,
} from '../src/store'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
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

function testConfig(stateFile: string, overrides: Partial<Config> = {}): Config {
  return {
    stateFile,
    staleMinutes: 30,
    maxOpen: 8,
    briefMaxColumns: BRIEF_MAX_COLUMNS,
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
    ...overrides,
  }
}

interface RegisteredTool {
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** Mount the plugin the way the host does and keep the tools it registers. */
function mount(stateFile: string, overrides: Partial<Config> = {}): Map<string, RegisteredTool> {
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
  apply(ctx as never, testConfig(stateFile, overrides))
  return tools
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
    const tools = mount(file)
    const opened = await tools.get('dispatch_open')!.execute({ goal: '很长的任务书，写了一大段。', brief: '改插件字段' })

    const line = readFileSync(file, 'utf8').trim().split('\n').at(-1)!
    expect(JSON.parse(line)).toMatchObject({ id: opened.id, brief: '改插件字段' })
    expect(new TicketStore(file).get(String(opened.id))?.brief).toBe('改插件字段')
  })

  it('rejects a ticket opened with no brief at all', async () => {
    const file = tempFile()
    const tools = mount(file)
    // 2026-11-03 起 brief 必填：不传就是错误，不再从 goal 派生一句顶上来。
    // 缺参数在 schema 那道关就被拦下（required 列表），空串之类才轮到 execute 里的
    // 中文提示，两条路径都不许静默派生。
    await expect(
      tools.get('dispatch_open')!.execute({ goal: '在小屏第二行显示票的简短目标。整段任务书太长，塞不下。' }),
    ).rejects.toThrow(/missing required property "brief"/)
    // 一个事件都没写：错误发生在 store.open 之前。
    expect(existsSync(file) ? readFileSync(file, 'utf8').trim() : '').toBe('')
  })

  it('rejects an empty, whitespace-only or punctuation-only brief', async () => {
    const file = tempFile()
    const tools = mount(file)
    for (const brief of ['', '   ', '\n\t', '。', '…… ！？', '—— 、']) {
      await expect(tools.get('dispatch_open')!.execute({ goal: 'g', brief })).rejects.toThrow(/brief 必填/)
    }
    // 一个都没落盘：写入侧压根没走 store.open。
    expect(existsSync(file) ? readFileSync(file, 'utf8').trim() : '').toBe('')
  })

  it('names the column cap and the 汉字 count in the error', async () => {
    const tools = mount(tempFile(), { briefMaxColumns: 20 })
    await expect(tools.get('dispatch_open')!.execute({ goal: 'g', brief: ' ' })).rejects.toThrow(
      'brief 必填，写一句 20 列以内的短话（汉字按 2 列算，约 10 个汉字）',
    )
  })

  it('keeps a brief that is exactly at the cap untouched', async () => {
    const file = tempFile()
    const tools = mount(file)
    const opened = await tools.get('dispatch_open')!.execute({ goal: 'g', brief: AT_CAP })

    const stored = new TicketStore(file).get(String(opened.id))?.brief
    expect(stored).toBe(AT_CAP)
    expect(textColumns(stored!)).toBe(BRIEF_MAX_COLUMNS)
    expect(stored!.endsWith('…')).toBe(false)
  })

  it('cuts a brief one column over the cap to 32 columns plus the ellipsis', async () => {
    const file = tempFile()
    const tools = mount(file)
    // 34 列 + 一个半角字符 = 35 列，刚好越过上限一列。
    const opened = await tools.get('dispatch_open')!.execute({ goal: 'g', brief: `${AT_CAP}a` })

    const brief = new TicketStore(file).get(String(opened.id))?.brief!
    expect(brief.endsWith('…')).toBe(true)
    // 16 汉字 = 32 列，加上 2 列的省略号，总宽仍然正好是 34。
    expect(brief).toBe('一二三四五六七八九十一二三四五六…')
    expect(textColumns(brief)).toBe(BRIEF_MAX_COLUMNS)
  })

  it('caps a caller-supplied brief at the configured width', async () => {
    const file = tempFile()
    const tools = mount(file, { briefMaxColumns: 8 })
    const opened = await tools
      .get('dispatch_open')!
      .execute({ goal: 'g', brief: `${AT_CAP}八九十` })

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
    const tools = mount(file)
    const listed = (await tools.get('dispatch_list')!.execute({})) as {
      tickets: Array<{ id: string; goal: string; brief: string }>
    }
    const row = listed.tickets.find((ticket) => ticket.id === 't-old-1')!
    expect(row.brief).toBe('整理磁盘上的备份目录')
    expect(row.goal).toContain('顺手删掉')
  })

  it('lets a later event fill the field in without losing it', () => {
    const snapshots = foldEvents([
      ...lines,
      { id: 't-old-1', at: '2026-11-02T00:00:00.000Z', brief: '补上摘要' },
      { id: 't-old-1', at: '2026-11-02T00:05:00.000Z', status: 'running' },
    ])
    expect(snapshots[0].brief).toBe('补上摘要')
  })

  it('shows the derived brief in a ticket view', () => {
    const ticket = foldEvents(lines)[0]
    const view = toView(ticket, 30, new Date('2026-10-31T01:00:00.000Z'))
    expect(view.brief).toBe('整理磁盘上的备份目录')
  })
})
