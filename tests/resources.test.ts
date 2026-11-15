import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  expandGitRoots,
  findGitRoot,
  normalizeResource,
  normalizeResources,
  parseResource,
  scanResources,
  RESOURCE_KINDS,
} from '../src/tickets/resources'

/** 一个真目录 + 一个指向它的符号链接；路径都取 realpath，免得 /tmp 本身是链接。 */
let root = ''
let linked = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-resources-')))
  mkdirSync(join(root, 'real', 'nested'), { recursive: true })
  writeFileSync(join(root, 'real', 'nested', 'a.md'), 'x')
  linked = join(root, 'link')
  symlinkSync(join(root, 'real'), linked)
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('拆资源串', () => {
  it('六种前缀都认，值原样取出来', () => {
    expect(parseResource('file:/a/b.md')).toEqual({ kind: 'file', value: '/a/b.md' })
    expect(parseResource('dir:/a/b')).toEqual({ kind: 'dir', value: '/a/b' })
    expect(parseResource('git:/srv/work/dsh-dispatcher')).toEqual({
      kind: 'git',
      value: '/srv/work/dsh-dispatcher',
    })
    expect(parseResource('svc:dsh-example')).toEqual({ kind: 'svc', value: 'dsh-example' })
    expect(parseResource('port:61208')).toEqual({ kind: 'port', value: '61208' })
    expect(parseResource('dev:/dev/fb1')).toEqual({ kind: 'dev', value: '/dev/fb1' })
  })

  it('前后空白和前缀大小写不影响结果', () => {
    expect(parseResource('  FILE: /a/b.md  ')).toEqual({ kind: 'file', value: '/a/b.md' })
  })

  it('没前缀、前缀不认识、只有前缀都当场拒绝', () => {
    expect(() => parseResource('/a/b.md')).toThrow(/缺前缀/)
    expect(() => parseResource('path:/a/b.md')).toThrow(/未知资源前缀/)
    expect(() => parseResource('file:   ')).toThrow(/没有值/)
  })

  it('前缀表就是设计稿那六种', () => {
    expect([...RESOURCE_KINDS]).toEqual(['file', 'dir', 'git', 'svc', 'port', 'dev'])
  })
})

describe('路径类归一化', () => {
  it('不存在的文件保留字面绝对路径，不抛错', () => {
    const missing = join(root, 'nope', 'ghost.md')
    expect(normalizeResource(`file:${missing}`)).toBe(`file:${missing}`)
  })

  it('展开 ~：用 home 拼出绝对路径', () => {
    const options = { home: root }
    expect(normalizeResource('file:~/fatfish/a.md', options)).toBe(`file:${join(root, 'fatfish', 'a.md')}`)
    expect(normalizeResource('dir:~', options)).toBe(`dir:${root}`)
  })

  it('相对路径按 base 转绝对', () => {
    const options = { base: join(root, 'real') }
    expect(normalizeResource('file:nested/a.md', options)).toBe(`file:${join(root, 'real', 'nested', 'a.md')}`)
    expect(normalizeResource('dir:./nested', options)).toBe(`dir:${join(root, 'real', 'nested')}`)
  })

  it('能 realpath 就解符号链接', () => {
    expect(normalizeResource(`git:${linked}`)).toBe(`git:${join(root, 'real')}`)
    expect(normalizeResource(`dev:${join(linked, 'nested', 'a.md')}`)).toBe(
      `dev:${join(root, 'real', 'nested', 'a.md')}`,
    )
  })

  it('realpath 解不了就用字面绝对路径（注入面同样守这条）', () => {
    const options = { realpath: () => undefined }
    expect(normalizeResource('file:~/x/y.md', { ...options, home: root })).toBe(
      `file:${join(root, 'x', 'y.md')}`,
    )
  })

  it('去掉尾斜杠，根目录保留', () => {
    expect(normalizeResource('dir:/tmp/')).toBe('dir:/tmp')
    expect(normalizeResource('dir:/tmp///')).toBe('dir:/tmp')
    expect(normalizeResource('dir:/')).toBe('dir:/')
    expect(normalizeResource('file:/tmp/a.md/')).toBe('file:/tmp/a.md')
  })

  it('同一个文件的三种写法归一成同一个值', () => {
    const options = { base: join(root, 'real'), home: root }
    const expected = `file:${join(root, 'real', 'nested', 'a.md')}`
    expect(normalizeResource(`file:${join(root, 'real', 'nested', 'a.md')}`, options)).toBe(expected)
    expect(normalizeResource('file:nested/a.md', options)).toBe(expected)
    // 符号链接穿过去以后还是同一个文件。
    expect(normalizeResource(`file:${linked}/nested/a.md`, options)).toBe(expected)
  })

  it('相对路径里的 .. 被解析掉', () => {
    const options = { base: join(root, 'real', 'nested') }
    expect(normalizeResource('file:../nested/a.md', options)).toBe(
      `file:${join(root, 'real', 'nested', 'a.md')}`,
    )
  })
})

describe('svc 与 port', () => {
  it('svc 去掉 systemd 的 .service 后缀', () => {
    expect(normalizeResource('svc:dsh-example')).toBe('svc:dsh-example')
    expect(normalizeResource('svc:dsh-example.service')).toBe('svc:dsh-example')
    expect(normalizeResource('  svc: dsh-example.service  ')).toBe('svc:dsh-example')
  })

  it('port 收 1–65535 的整数，前导零归一', () => {
    expect(normalizeResource('port:61208')).toBe('port:61208')
    expect(normalizeResource('port:061208')).toBe('port:61208')
    expect(normalizeResource('port: 22 ')).toBe('port:22')
  })

  it('port 非法值抛错', () => {
    expect(() => normalizeResource('port:0')).toThrow(/1–65535/)
    expect(() => normalizeResource('port:65536')).toThrow(/1–65535/)
    expect(() => normalizeResource('port:abc')).toThrow(/不是整数/)
    expect(() => normalizeResource('port:80.5')).toThrow(/不是整数/)
  })
})

describe('批量归一化', () => {
  it('按首次出现顺序去重，归一化后相等算同一条', () => {
    const options = { home: root }
    const out = normalizeResources(
      ['file:~/a.md', 'svc:x.service', 'file:~/a.md', 'svc:x', 'port:061208'],
      options,
    )
    expect(out).toEqual([`file:${join(root, 'a.md')}`, 'svc:x', 'port:61208'])
  })

  it('空清单就是空清单', () => {
    expect(normalizeResources([])).toEqual([])
  })
})


describe('git 根探测与自动补全（A5，假 fs）', () => {
  const paths: Record<string, 'file' | 'dir'> = {
    '/repo': 'dir',
    '/repo/.git': 'dir',
    '/repo/a.ts': 'file',
    '/repo/deep/b.ts': 'file',
    '/wt': 'dir',
    '/wt/.git': 'file',
    '/wt/x.ts': 'file',
    '/outside/c.ts': 'file',
  }
  const stat = (path: string): 'file' | 'dir' | undefined => paths[path]
  const readText = (path: string): string | undefined =>
    path === '/wt/.git' ? 'gitdir: /repo/.git/worktrees/wt\n' : undefined
  const options = { stat, readText, realpath: () => undefined }

  it('主仓库：.git 是目录，根就是那一层', () => {
    expect(findGitRoot('/repo/deep/b.ts', options)).toEqual({ top: '/repo', root: '/repo', worktree: false })
  })

  it('worktree：.git 是文件，gitdir 解析到共用仓库根', () => {
    expect(findGitRoot('/wt/x.ts', options)).toEqual({ top: '/wt', root: '/repo', worktree: true })
  })

  it('仓外路径探不到仓库，返回 undefined', () => {
    expect(findGitRoot('/outside/c.ts', options)).toBeUndefined()
  })

  it('expandGitRoots 给仓内路径补 git 根，不碰仓外，已声明的 git 原样保留', () => {
    expect(expandGitRoots(['file:/repo/a.ts'], options)).toEqual(['file:/repo/a.ts', 'git:/repo'])
    expect(expandGitRoots(['file:/wt/x.ts'], options)).toEqual(['file:/wt/x.ts', 'git:/wt'])
    expect(expandGitRoots(['file:/outside/c.ts'], options)).toEqual(['file:/outside/c.ts'])
    expect(expandGitRoots(['git:/repo'], options)).toEqual(['git:/repo'])
  })
})

describe('脏资源串：宽容扫描不抛（历史票兜底）', () => {
  const SHAPES = [
    ['cmd:dsh --profile example --dump-config', '命令不是资源'],
    ['http:docs.deepseek.com', 'http 不是资源前缀'],
    ['port:192.0.2.10:8080 (with a note)', '端口写法不合法'],
    ['', '空串'],
  ] as const

  it.each(SHAPES)('%s 不抛，记进 invalid', (raw) => {
    const scan = scanResources([raw])
    expect(scan.resources).toEqual([])
    expect(scan.invalid).toHaveLength(1)
    expect(scan.invalid[0]).toMatchObject({ raw })
    expect(scan.invalid[0]!.reason.length).toBeGreaterThan(0)
  })

  it('合法资源照常归一化，脏的只进 invalid，不互相影响', () => {
    const scan = scanResources(['file:/tmp/a.ts', 'cmd:ls', 'port:61208', 'http:x', 'file:/tmp/a.ts'])
    expect(scan.resources).toEqual(['file:/tmp/a.ts', 'port:61208'])
    expect(scan.invalid.map((item) => item.raw)).toEqual(['cmd:ls', 'http:x'])
  })
})
