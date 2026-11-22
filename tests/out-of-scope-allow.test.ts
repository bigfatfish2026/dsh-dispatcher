/**
 * 收工对账的白名单：备份、临时文件、构建产物不算越界，业务源码照样报。
 *
 * 取值依据（票 t-mwn0xmdc-o8r8）：票库里 152 张票带 outOfScope，绝大多数是
 * `backups/`、`/tmp`、`*.bak-时间戳` 这类票外产物，业务源码漏声明是另一回事，
 * 不能被白名单顺手放过。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_OUT_OF_SCOPE_ALLOW } from '../src/defaults'
import { isAllowedProduct, outOfScopePaths } from '../src/tickets/conflict'

const BASE = '/home/julia/fatfish/plugins/dsh-dispatcher'
const WRITES = [`file:${BASE}/src/tickets/conflict.ts`, `dir:${BASE}/tests`]

const report = (touched: string[]): string[] =>
  outOfScopePaths(touched, WRITES, { allow: DEFAULT_OUT_OF_SCOPE_ALLOW })

describe('合理产物白名单不报', () => {
  it('backups/ 下任何文件都不报（任意层级、任意深浅）', () => {
    expect(
      report([
        'file:/home/julia/fatfish/backups/sqlite/sbi-before-step8-20261118.db',
        'file:/home/julia/fatfish/backups/profiles/20261119-111237-ego-no-sbi/cordis.patch.yml',
        'file:/home/julia/backups/fatfish/2026-11-19/tickets.db',
        'file:/home/julia/backups/a/b/c/d.bin',
      ]),
    ).toEqual([])
  })

  it('/tmp 下的临时产物不报', () => {
    expect(
      report([
        'file:/tmp/sbi-smoke.mjs',
        'file:/tmp/sbi-smoke-baseline.txt',
        'file:/tmp/dump-config-t-mwkathnx-ksbe.yml',
        'dir:/tmp/verify-tgz',
      ]),
    ).toEqual([])
  })

  it('备份文件后缀不报：.bak / .bak.时间戳 / .bak-时间戳 / .orig / .rej / .DS_Store', () => {
    expect(
      report([
        `file:${BASE}/src/tickets/conflict.ts.bak`,
        `file:${BASE}/src/tickets/conflict.ts.bak.20261119`,
        'file:/home/julia/.dsh/profiles/qqbot/cordis.patch.yml.bak-20261116-1339-px52k',
        'file:/home/julia/fatfish/docs/design.md.orig-20261118',
        'file:/home/julia/fatfish/sbi/posts.json.rej',
        `file:${BASE}/.DS_Store`,
        'file:/home/julia/AGENTS.md.bak',
      ]),
    ).toEqual([])
  })

  it('logs/、node_modules/、.git/、__pycache__/ 不报', () => {
    expect(
      report([
        'file:/home/julia/fatfish/logs/after_restart.log',
        'file:/home/julia/.dsh/profiles/qqbot/node_modules/.bin/x',
        'file:/home/julia/fatfish/plugins/dsh-qqbot/.git/refs/tags',
        'file:/home/julia/fatfish/sbi/kb/__pycache__/common.cpython-312.pyc',
      ]),
    ).toEqual([])
  })
})

describe('目录边界按段判，不吃近邻', () => {
  it('/tmp/ 不匹配 /tmpfoo', () => {
    expect(isAllowedProduct('file:/tmpfoo/a.txt', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(false)
    expect(isAllowedProduct('file:/tmp/a.txt', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(true)
  })

  it('backups/ 不匹配 mybackups/', () => {
    expect(isAllowedProduct('file:/home/julia/mybackups/a.txt', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(false)
    expect(isAllowedProduct('file:/home/julia/a/backups/x.db', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(true)
  })

  it('logs/ 不匹配 logs2/，.git/ 不匹配 .gitignore', () => {
    expect(isAllowedProduct('file:/home/julia/fatfish/logs2/a.log', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(false)
    expect(isAllowedProduct('file:/home/julia/fatfish/.gitignore', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(false)
  })

  it('svc / port 不参与白名单：它们不是文件路径', () => {
    expect(isAllowedProduct('svc:/tmp/thing.service', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(false)
    expect(isAllowedProduct('port:8080', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(false)
  })
})

describe('不放松真越界', () => {
  it('业务源码没声明照样报', () => {
    expect(report([`file:${BASE}/src/tickets/other.ts`])).toEqual([`file:${BASE}/src/tickets/other.ts`])
  })

  it('业务仓库里的 src 与 plugins 子目录都不在白名单里', () => {
    expect(
      report([
        'file:/home/julia/fatfish/plugins/dsh-ego/lib/config.js',
        'file:/home/julia/fatfish/plugins/dsh-qqbot/.git/refs/tags',
      ]),
    ).toEqual(['file:/home/julia/fatfish/plugins/dsh-ego/lib/config.js'])
  })

  it('混着报：白名单项被剔掉，越界项按 touched 顺序留下', () => {
    expect(
      report([
        'file:/home/julia/fatfish/backups/sqlite/x.db',
        `file:${BASE}/src/tickets/desk.ts`,
        'file:/tmp/smoke.mjs',
        `file:${BASE}/src/store/reducer.ts`,
      ]),
    ).toEqual([`file:${BASE}/src/tickets/desk.ts`, `file:${BASE}/src/store/reducer.ts`])
  })

  it('声明 writes 覆盖优先于白名单：白名单关了也不动覆盖规则', () => {
    expect(outOfScopePaths([`file:${BASE}/tests/a.test.ts`], WRITES, { allow: [] })).toEqual([])
  })

  it('allow 给空数组 = 老口径，备份也报', () => {
    expect(outOfScopePaths(['file:/home/julia/backups/x.db'], WRITES, { allow: [] })).toEqual([
      'file:/home/julia/backups/x.db',
    ])
    expect(outOfScopePaths(['file:/home/julia/backups/x.db'], WRITES)).toEqual([
      'file:/home/julia/backups/x.db',
    ])
  })

  it('没有声明 writes 就不对账，白名单帮不上也不留痕', () => {
    expect(outOfScopePaths(['file:/home/julia/backups/x.db'], [], { allow: DEFAULT_OUT_OF_SCOPE_ALLOW })).toEqual([])
  })
})

describe('票就在 /tmp 里干活时，工作目录内照旧对账', () => {
  const scope = '/tmp/dispatcher-paths-abc'

  it('工作目录里的业务文件不算 /tmp 产物', () => {
    expect(
      outOfScopePaths([`file:${scope}/src/tickets/other.ts`], WRITES, {
        allow: DEFAULT_OUT_OF_SCOPE_ALLOW,
        base: scope,
      }),
    ).toEqual([`file:${scope}/src/tickets/other.ts`])
  })

  it('工作目录之外的 /tmp 冒烟文件仍然不报', () => {
    expect(
      outOfScopePaths(['file:/tmp/sbi-smoke.mjs'], WRITES, {
        allow: DEFAULT_OUT_OF_SCOPE_ALLOW,
        base: scope,
      }),
    ).toEqual([])
  })
})

describe('归一化后的路径参与匹配', () => {
  it('相对路径先归一化成绝对路径，再按目录段命中白名单', () => {
    // touched 的相对路径按 scanResources 的基准（cwd）转绝对，`backups/` 段仍命中。
    expect(outOfScopePaths(['file:backups/x.db'], WRITES, { allow: DEFAULT_OUT_OF_SCOPE_ALLOW })).toEqual([])
  })

  it('路径里的 `..` 不靠字面拼接骗过匹配：段比对看的是归一化结果', () => {
    expect(isAllowedProduct('file:/home/julia/backups/x.db', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(true)
    expect(isAllowedProduct('file:/home/julia/notbackups/x.db', DEFAULT_OUT_OF_SCOPE_ALLOW)).toBe(false)
  })
})

describe('已声明的只读路径不算越界', () => {
  // dispatch_touch 只有一个扁平 paths，读过的路径也报在里面；票面 reads 要能减掉。
  const READS = [`file:${BASE}/src/store/reducer.ts`, `dir:${BASE}/docs`]

  it('读声明不算越界：touched 里已声明 reads 的路径不报，未声明照报', () => {
    expect(
      outOfScopePaths(
        [
          `file:${BASE}/src/store/reducer.ts`,
          `file:${BASE}/docs/internals.zh.md`,
          `file:${BASE}/src/tickets/desk.ts`,
        ],
        WRITES,
        { reads: READS },
      ),
    ).toEqual([`file:${BASE}/src/tickets/desk.ts`])
  })

  it('reads 的目录边界按段判：dir 覆盖内部文件，近邻不吃', () => {
    expect(outOfScopePaths([`file:${BASE}/docs2/x.md`], WRITES, { reads: READS })).toEqual([
      `file:${BASE}/docs2/x.md`,
    ])
    expect(outOfScopePaths([`file:${BASE}/docs/x.md`], WRITES, { reads: READS })).toEqual([])
  })

  it('没给 reads 保持老口径：只读路径照报', () => {
    expect(outOfScopePaths([`file:${BASE}/src/store/reducer.ts`], WRITES)).toEqual([
      `file:${BASE}/src/store/reducer.ts`,
    ])
  })
})
