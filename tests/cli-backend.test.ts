import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runTicketsCli } from '../src/cli'
import { loadCliConfig, parseDispatcherConfig } from '../src/cli-config'
import type { CliConfig } from '../src/cli-config'
import { migrateToSqlite } from '../src/store/migrate'

/**
 * CLI 后端选择的验收：
 *
 * - 同一个 fixture 迁进 sqlite 后，jsonl 与 sqlite 两种读法的 stdout / stderr /
 *   退出码逐字节一致（`--json`、`--id`、`--open-only`、`--recent`、人读格式）；
 * - `--backend` / `--db` / `--state` 的优先级和非法值；
 * - 不传参时读 profile 的 `store.backend` / `store.file`；
 * - profile 解析只认 dsh-dispatcher 这一条，不碰别的插件。
 *
 * 时钟钉死在 NOW，否则 `generatedAt` / `ageMinutes` 跨分钟后会让两份输出不等。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'tickets-20261104.jsonl')
const NOW = (): Date => new Date('2026-11-04T12:00:00.000Z')

let dir: string
let db: string
let stateFile: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dispatcher-cli-backend-'))
  db = join(dir, 'tickets.db')
  stateFile = join(dir, 'tickets.jsonl')
  const result = migrateToSqlite({ jsonl: FIXTURE, db })
  expect(result.ok).toBe(true)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface CliRun {
  code: number
  out: string
  err: string
}

function run(argv: readonly string[], config: CliConfig = {}): CliRun {
  let out = ''
  let err = ''
  const code = runTicketsCli(
    argv,
    {
      out: (text) => {
        out += text
      },
      err: (text) => {
        err += text
      },
    },
    { config, now: NOW },
  )
  return { code, out, err }
}

describe('CLI 在 jsonl / sqlite 两后端上输出一致', () => {
  const cases: string[][] = [
    ['--json'],
    ['--json', '--open-only'],
    ['--json', '--recent', '5'],
    ['--json', '--recent', '0'],
    ['--json', '--id', 't-mvxeoo0z-i5ab'],
    ['--json', '--id', 't-does-not-exist'],
    ['--open-only'],
    ['--recent', '3'],
  ]

  for (const extra of cases) {
    it(`输出逐字节一致：${extra.join(' ')}`, () => {
      const jsonl = run(['tickets', ...extra, '--state', FIXTURE])
      const sqlite = run(['tickets', ...extra, '--backend', 'sqlite', '--db', db])
      expect(sqlite).toEqual(jsonl)
    })
  }

  it('--db 单独出现就按 sqlite 读，不要求再写 --backend', () => {
    const fromJsonl = run(['tickets', '--json', '--state', FIXTURE])
    const fromDb = run(['tickets', '--json', '--db', db])
    expect(fromDb.code).toBe(0)
    expect(fromDb.err).toBe('')
    expect(fromDb.out).toBe(fromJsonl.out)
  })

  it('--backend= 等号形式也认', () => {
    const sqlite = run(['tickets', '--json', `--backend=sqlite`, `--db=${db}`])
    const jsonl = run(['tickets', '--json', '--state', FIXTURE])
    expect(sqlite.out).toBe(jsonl.out)
  })
})

describe('不传参时跟 profile 配置走', () => {
  it('配置 stateFile：默认读 jsonl 路径', () => {
    const log = join(dir, 'configured.jsonl')
    writeFileSync(log, readFileSync(FIXTURE, 'utf8'))
    const implicit = run(['tickets', '--json'], { stateFile: log })
    const explicit = run(['tickets', '--json', '--state', log])
    expect(implicit).toEqual(explicit)
  })

  it('配置 store.backend=sqlite + store.file：默认读库', () => {
    const implicit = run(['tickets', '--json'], {
      stateFile,
      store: { backend: 'sqlite', file: db },
    })
    const explicit = run(['tickets', '--json', '--backend', 'sqlite', '--db', db])
    expect(implicit).toEqual(explicit)
  })

  it('显式 --state 压过配置里的 sqlite（点名 jsonl 就按 jsonl 读）', () => {
    const explicitJsonl = run(['tickets', '--json', '--state', FIXTURE], {
      stateFile,
      store: { backend: 'sqlite', file: db },
    })
    const fromFixture = run(['tickets', '--json', '--state', FIXTURE])
    expect(explicitJsonl).toEqual(fromFixture)
    expect(explicitJsonl.code).toBe(0)
  })

  it('store.file 相对路径按 DSH_HOME 解析', () => {
    const home = join(dir, 'relative-home')
    const relativeDb = join(home, 'dispatcher', 'tickets.db')
    mkdirSync(join(home, 'dispatcher'), { recursive: true })
    expect(migrateToSqlite({ jsonl: FIXTURE, db: relativeDb }).ok).toBe(true)
    vi.stubEnv('DSH_HOME', home)
    try {
      const implicit = run(['tickets', '--json'], {
        stateFile: 'dispatcher/tickets.jsonl',
        store: { backend: 'sqlite', file: 'dispatcher/tickets.db' },
      })
      const explicit = run(['tickets', '--json', '--backend', 'sqlite', '--db', relativeDb])
      expect(implicit).toEqual(explicit)
      expect(implicit.code).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('显式 --backend sqlite --db 压过配置里的 jsonl', () => {
    const sqlite = run(['tickets', '--json', '--backend', 'sqlite', '--db', db], {
      store: { backend: 'jsonl' },
    })
    const jsonl = run(['tickets', '--json', '--state', FIXTURE])
    expect(sqlite.out).toBe(jsonl.out)
  })
})

describe('参数错误与 redis 拒绝', () => {
  it('redis 报未实现并退出 2', () => {
    const result = run(['tickets', '--backend', 'redis'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('还没实现')
    expect(result.out).toBe('')
  })

  it('不认识的 backend 退出 2', () => {
    const result = run(['tickets', '--backend', 'postgres'])
    expect(result.code).toBe(2)
    expect(result.err).toContain("'postgres'")
    expect(result.err).toContain('jsonl')
  })

  it('--backend jsonl 和 --db 互斥', () => {
    const result = run(['tickets', '--backend', 'jsonl', '--db', db])
    expect(result.code).toBe(2)
    expect(result.err).toContain('--db 只能配 --backend sqlite')
  })

  it('缺值、空值都退出 2', () => {
    for (const argv of [
      ['tickets', '--backend'],
      ['tickets', '--backend='],
      ['tickets', '--db'],
      ['tickets', '--db='],
      ['tickets', '--state'],
    ]) {
      const result = run(argv)
      expect(result.code, argv.join(' ')).toBe(2)
      expect(result.err, argv.join(' ')).toMatch(/要|缺一个值/)
    }
  })
})

describe('profile 配置解析', () => {
  it('只认 dsh-dispatcher，忽略别的 entry 和注释/数组', () => {
    const text = `# top comment
- id: other-plugin
  config:
    store:
      backend: redis
- id: dsh-dispatcher
  name: 'dsh-dispatcher'
  config:
    stateFile: dispatcher/tickets.jsonl
    store:
      backend: sqlite # 行尾注释
      file: 'dispatcher/tickets.db'
    routerTools:
      - dispatch_open
      - dispatch_send
- id: after
  config:
    stateFile: nope.jsonl
`
    expect(parseDispatcherConfig(text)).toEqual({
      stateFile: 'dispatcher/tickets.jsonl',
      store: { backend: 'sqlite', file: 'dispatcher/tickets.db' },
    })
  })

  it('inline map 和带 # 的引号值', () => {
    const text = `- name: dsh-dispatcher
  config: { stateFile: dispatcher/tickets.jsonl, store: { backend: sqlite, file: "/tmp/a#b.db" } }
`
    expect(parseDispatcherConfig(text)).toEqual({
      stateFile: 'dispatcher/tickets.jsonl',
      store: { backend: 'sqlite', file: '/tmp/a#b.db' },
    })
  })

  it('读不到文件回退空对象', () => {
    expect(loadCliConfig({ DSH_PROFILE_DIR: join(dir, 'nowhere') })).toEqual({})
  })

  it('按 DSH_PROFILE_DIR 读 cordis.patch.yml', () => {
    const profile = join(dir, 'profile')
    rmSync(profile, { recursive: true, force: true })
    writeFileSync(
      join(dir, 'profile.yml'),
      `- id: dsh-dispatcher
  config:
    store:
      backend: sqlite
      file: dispatcher/tickets.db
`,
    )
    // 用真实目录名 cordis.patch.yml，验证 loadCliConfig 的路径约定。
    mkdirSync(profile)
    renameSync(join(dir, 'profile.yml'), join(profile, 'cordis.patch.yml'))
    expect(loadCliConfig({ DSH_PROFILE_DIR: profile })).toEqual({
      store: { backend: 'sqlite', file: 'dispatcher/tickets.db' },
    })
  })
})
