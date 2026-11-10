import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  normalizeResource,
  normalizeResources,
  parseResource,
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
    expect(parseResource('git:/home/user/dev/dsh-dispatcher')).toEqual({
      kind: 'git',
      value: '/home/user/dev/dsh-dispatcher',
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
