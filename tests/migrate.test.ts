import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MIGRATE_USAGE,
  assertSafeOut,
  defaultOutPath,
  formatChecks,
  migrateToSqlite,
  runMigrateCli,
  scanJsonl,
  schemaOf,
} from '../src/store/migrate'

const dirs: string[] = []
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'migrate-sample.jsonl')

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-migrate-'))
  dirs.push(dir)
  return dir
}

function io(): { text: string; err: string; out: string[] } {
  const captured = { text: '', err: '', out: [] as string[] }
  return captured
}

function cliIo(captured: ReturnType<typeof io>) {
  return {
    out: (text: string) => {
      captured.text += text
      captured.out.push(text)
    },
    err: (text: string) => {
      captured.err += text
    },
  }
}

describe('迁移脚本：只读扫描与 dry-run', () => {
  it('扫 fixture：13 个非空行 = 13 条事件，2 张票', () => {
    const scan = scanJsonl(FIXTURE)
    expect(scan.lines).toBe(13)
    expect(scan.events).toHaveLength(13)
    expect(scan.badLines).toEqual([])
    const result = migrateToSqlite({ jsonl: FIXTURE, db: join(tempDir(), 'never.db'), dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.tickets).toBe(2)
    expect(result.events).toBe(13)
    expect(result.inserted).toBe(0)
  })

  it('dry-run 不建库、不改输入文件', () => {
    const dir = tempDir()
    const db = join(dir, 'dry.db')
    const before = readFileSync(FIXTURE)
    const captured = io()
    expect(runMigrateCli([FIXTURE, '--dry-run', '--out', db], cliIo(captured))).toBe(0)
    expect(existsSync(db)).toBe(false)
    expect(readFileSync(FIXTURE)).toEqual(before)
    expect(captured.text).toContain('迁移计划（--dry-run，只读，不建库）')
    expect(captured.text).toContain('事件    13 条')
    expect(captured.text).toContain('票      2 张')
  })

  it('默认输出落在 /tmp，不碰真实 ~/.dsh', () => {
    const out = defaultOutPath(new Date('2026-11-04T12:34:56.000Z'))
    expect(out.startsWith(join('/tmp', 'dsh-tickets-'))).toBe(true)
    expect(() => assertSafeOut(join(homedir(), '.dsh', 'dispatcher', 'tickets.db'))).toThrow(/拒绝写入/)
    expect(() => assertSafeOut(join(homedir(), '.dsh'))).toThrow(/拒绝写入/)
    expect(assertSafeOut(join(tmpdir(), 'ok.db'))).toBe(join(tmpdir(), 'ok.db'))
  })
})

describe('迁移脚本：写入 + 双向校验', () => {
  it('写入后核对表全过，票与终态和 jsonl 折出来的一致', () => {
    const db = join(tempDir(), 'tickets.db')
    const result = migrateToSqlite({ jsonl: FIXTURE, db })
    expect(result.ok).toBe(true)
    expect(result.inserted).toBe(13)
    expect(result.skipped).toBe(0)
    expect(result.checks.map((row) => row.item)).toEqual(['票数', '每票终态', '事件条数', 'lastSeq / 行数', '投影行数'])
    expect(result.checks.every((row) => row.ok)).toBe(true)
    expect(formatChecks(result.checks)).toContain('OK')

    const raw = new DatabaseSync(db)
    try {
      expect((raw.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(13)
      expect((raw.prepare("SELECT value FROM meta WHERE key = 'lastSeq'").get() as { value: string }).value).toBe(
        '13',
      )
      const states = raw.prepare('SELECT id, state FROM tickets ORDER BY id').all() as {
        id: string
        state: string
      }[]
      expect(states).toEqual([
        { id: 't-fixture-1', state: 'done' },
        { id: 't-fixture-2', state: 'done' },
      ])
    } finally {
      raw.close()
    }
    expect(schemaOf(db).tables).toEqual(['events', 'meta', 'tickets'])
    expect(schemaOf(db).indexes).toEqual(['idx_events_ticket', 'idx_tickets_state_updated'])
  })

  it('幂等重跑：已存在的 seq 跳过，不重复写、不改投影', () => {
    const db = join(tempDir(), 'tickets.db')
    migrateToSqlite({ jsonl: FIXTURE, db })
    const again = migrateToSqlite({ jsonl: FIXTURE, db })
    expect(again.ok).toBe(true)
    expect(again.inserted).toBe(0)
    expect(again.skipped).toBe(13)
    const raw = new DatabaseSync(db)
    try {
      expect((raw.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(13)
    } finally {
      raw.close()
    }
  })

  it('同一个 seq 载荷不同：报冲突、整次回滚、rc=1', () => {
    const dir = tempDir()
    const db = join(dir, 'tickets.db')
    migrateToSqlite({ jsonl: FIXTURE, db })

    const changed = join(dir, 'changed.jsonl')
    const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n')
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), note: '手改过的载荷' })
    writeFileSync(changed, `${lines.join('\n')}\n`)

    const captured = io()
    expect(runMigrateCli([changed, '--out', db], cliIo(captured))).toBe(1)
    expect(captured.err).toContain('与输入载荷不同')
    expect(captured.err).toContain('整次回滚')

    const raw = new DatabaseSync(db)
    try {
      expect((raw.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c).toBe(13)
      expect((raw.prepare("SELECT value FROM meta WHERE key = 'lastSeq'").get() as { value: string }).value).toBe(
        '13',
      )
    } finally {
      raw.close()
    }
  })

  it('jsonl 有坏行：不静默放过，核对表 rc=1', () => {
    const dir = tempDir()
    const bad = join(dir, 'bad.jsonl')
    copyFileSync(FIXTURE, bad)
    writeFileSync(bad, `${readFileSync(FIXTURE, 'utf8')}{"kind": broken\n`)
    const captured = io()
    expect(runMigrateCli([bad, '--out', join(dir, 'bad.db')], cliIo(captured))).toBe(1)
    expect(captured.text).toContain('FAIL')
    expect(captured.text).toContain('坏行')
  })

  it('jsonl 不存在：rc=1，不建库', () => {
    const dir = tempDir()
    const db = join(dir, 'missing.db')
    const captured = io()
    expect(runMigrateCli([join(dir, 'nope.jsonl'), '--out', db], cliIo(captured))).toBe(1)
    expect(captured.err).toContain('输入日志不存在')
    expect(existsSync(db)).toBe(false)
  })
})

describe('迁移脚本：CLI 参数面', () => {
  it('--help / 缺参数 / 多余参数', () => {
    const captured = io()
    expect(runMigrateCli(['--help'], cliIo(captured))).toBe(0)
    expect(captured.text).toContain(MIGRATE_USAGE)
    const missing = io()
    expect(runMigrateCli([], cliIo(missing))).toBe(2)
    const extra = io()
    expect(runMigrateCli([FIXTURE, FIXTURE], cliIo(extra))).toBe(2)
    const unknown = io()
    expect(runMigrateCli([FIXTURE, '--nope'], cliIo(unknown))).toBe(2)
  })

  it('--json 输出可解析的结果，--out= 形式也认', () => {
    const dir = tempDir()
    const db = join(dir, 'json.db')
    const captured = io()
    expect(runMigrateCli([FIXTURE, `--out=${db}`, '--json'], cliIo(captured))).toBe(0)
    const payload = JSON.parse(captured.text) as { ok: boolean; inserted: number; db: string }
    expect(payload.ok).toBe(true)
    expect(payload.inserted).toBe(13)
    expect(payload.db).toBe(db)
  })
})
