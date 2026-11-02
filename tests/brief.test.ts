import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** Longest goal that still fits: 10 汉字 = 20 columns. */
const TEN_HAN = '一二三四五六七八九十'

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

  it('keeps a short goal untouched', () => {
    expect(deriveBrief(TEN_HAN)).toBe(TEN_HAN)
    expect(textColumns(deriveBrief(TEN_HAN))).toBe(BRIEF_MAX_COLUMNS)
  })

  it('truncates to the column cap and marks the cut with an ellipsis', () => {
    const brief = deriveBrief(`${TEN_HAN}十一十二`)
    expect(brief.endsWith('…')).toBe(true)
    expect(textColumns(brief)).toBeLessThanOrEqual(BRIEF_MAX_COLUMNS)
    // 9 汉字 = 18 columns, plus the 2-column ellipsis = exactly the cap.
    expect(brief).toBe('一二三四五六七八九…')
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

  it('derives one from the goal when the caller passes none', async () => {
    const file = tempFile()
    const tools = mount(file)
    const opened = await tools
      .get('dispatch_open')!
      .execute({ goal: '在小屏第二行显示票的简短目标。整段任务书太长，塞不下。' })

    const stored = new TicketStore(file).get(String(opened.id))
    // 14 汉字 is 28 columns: cut to 9 汉字 plus the ellipsis, 20 columns total.
    expect(stored?.brief).toBe('在小屏第二行显示票…')
    expect(textColumns(stored!.brief!)).toBeLessThanOrEqual(BRIEF_MAX_COLUMNS)
  })

  it('caps a caller-supplied brief at the configured width', async () => {
    const file = tempFile()
    const tools = mount(file, { briefMaxColumns: 8 })
    const opened = await tools
      .get('dispatch_open')!
      .execute({ goal: 'g', brief: `${TEN_HAN}十一` })

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
