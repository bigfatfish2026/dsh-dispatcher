import { describe, expect, it } from 'vitest'
import { judgeConflict } from '../src/tickets/conflict'

const side = (writes: string[] = [], reads: string[] = []) => ({ writes, reads })

describe('强冲突：两边都写同一个资源', () => {
  it('同一个 file', () => {
    const verdict = judgeConflict(side(['file:/a/b.md']), side(['file:/a/b.md']))
    expect(verdict.level).toBe('strong')
    expect(verdict.resources).toEqual(['file:/a/b.md'])
    expect(verdict.reasons).toHaveLength(1)
    expect(verdict.reasons[0]).toContain('file:/a/b.md')
  })

  it('同一个 git 路径', () => {
    const verdict = judgeConflict(
      side(['git:/home/user/dev/dsh-dispatcher']),
      side(['git:/home/user/dev/dsh-dispatcher']),
    )
    expect(verdict.level).toBe('strong')
    expect(verdict.resources).toEqual(['git:/home/user/dev/dsh-dispatcher'])
  })

  it('git 路径互为祖先后代，两个方向都判强', () => {
    expect(judgeConflict(side(['git:/a']), side(['git:/a/b'])).level).toBe('strong')
    expect(judgeConflict(side(['git:/a/b']), side(['git:/a'])).level).toBe('strong')
  })

  it('git 与 dir 混着比也按路径判：同一个路径、互相包含都算强', () => {
    expect(judgeConflict(side(['dir:/a']), side(['git:/a/b'])).level).toBe('strong')
    expect(judgeConflict(side(['git:/a']), side(['dir:/a'])).level).toBe('strong')
  })

  it('同一个 svc，.service 后缀归一化后相等', () => {
    const verdict = judgeConflict(side(['svc:dsh-example.service']), side(['svc:dsh-example']))
    expect(verdict.level).toBe('strong')
    expect(verdict.resources).toEqual(['svc:dsh-example'])
  })

  it('同一个 port，前导零归一化后相等', () => {
    const verdict = judgeConflict(side(['port:061208']), side(['port:61208']))
    expect(verdict.level).toBe('strong')
    expect(verdict.resources).toEqual(['port:61208'])
  })

  it('同一个 dev', () => {
    const verdict = judgeConflict(side(['dev:/dev/fb1']), side(['dev:/dev/fb1']))
    expect(verdict.level).toBe('strong')
    expect(verdict.resources).toEqual(['dev:/dev/fb1'])
  })
})

describe('强冲突：目录与文件的重叠', () => {
  it('同一个 dir', () => {
    expect(judgeConflict(side(['dir:/a/b']), side(['dir:/a/b'])).level).toBe('strong')
  })

  it('dir 互为祖先后代，两个方向都判强', () => {
    expect(judgeConflict(side(['dir:/a']), side(['dir:/a/b'])).level).toBe('strong')
    expect(judgeConflict(side(['dir:/a/b']), side(['dir:/a'])).level).toBe('strong')
  })

  it('按路径边界判祖先：/a/b 与 /a/bc 不算包含', () => {
    const verdict = judgeConflict(side(['dir:/a/b']), side(['dir:/a/bc']))
    expect(verdict.level).toBe('none')
    expect(verdict.reasons).toEqual([])
    expect(verdict.resources).toEqual([])
  })

  it('一方写 file，另一方写它的父 dir', () => {
    const verdict = judgeConflict(side(['file:/a/b/c.md']), side(['dir:/a/b']))
    expect(verdict.level).toBe('strong')
    expect(verdict.resources).toEqual(['file:/a/b/c.md', 'dir:/a/b'])
  })

  it('一方写 dir，另一方写 dir 里的 file', () => {
    const verdict = judgeConflict(side(['dir:/a/b']), side(['file:/a/b/c.md']))
    expect(verdict.level).toBe('strong')
    expect(verdict.reasons[0]).toContain('dir:/a/b')
    expect(verdict.reasons[0]).toContain('file:/a/b/c.md')
  })

  it('dir 与不相干的 file 不冲突', () => {
    expect(judgeConflict(side(['dir:/a/b']), side(['file:/a/c.md'])).level).toBe('none')
  })
})

describe('弱冲突：放行但提示', () => {
  it('同一个 dir 下的不同 file', () => {
    const verdict = judgeConflict(side(['file:/a/b/x.md']), side(['file:/a/b/y.md']))
    expect(verdict.level).toBe('weak')
    expect(verdict.resources).toEqual(['file:/a/b/x.md', 'file:/a/b/y.md'])
    expect(verdict.reasons).toHaveLength(1)
    expect(verdict.reasons[0]).toContain('/a/b')
  })

  it('不同 dir 下的 file 是 none', () => {
    expect(judgeConflict(side(['file:/a/x.md']), side(['file:/a/b/y.md'])).level).toBe('none')
  })

  it('一方只读同一 file，另一方写', () => {
    const verdict = judgeConflict(side([], ['file:/a/b.md']), side(['file:/a/b.md']))
    expect(verdict.level).toBe('weak')
    expect(verdict.resources).toEqual(['file:/a/b.md'])
    expect(verdict.reasons[0]).toContain('只读')
  })

  it('只读方向反过来一样判弱', () => {
    const verdict = judgeConflict(side(['file:/a/b.md']), side([], ['file:/a/b.md']))
    expect(verdict.level).toBe('weak')
    expect(verdict.resources).toEqual(['file:/a/b.md'])
  })

  it('一方读 dir，另一方写 dir 里的 file（包含关系）', () => {
    const verdict = judgeConflict(side([], ['dir:/a/b']), side(['file:/a/b/c.md']))
    expect(verdict.level).toBe('weak')
    expect(verdict.resources).toEqual(['dir:/a/b', 'file:/a/b/c.md'])
  })

  it('一方读 file，另一方写它的父 dir（包含关系，反向）', () => {
    expect(judgeConflict(side([], ['file:/a/b/c.md']), side(['dir:/a/b'])).level).toBe('weak')
  })

  it('强冲突优先：只报强的那条，不掺弱冲突', () => {
    const verdict = judgeConflict(
      side(['file:/a/b.md'], ['file:/a/b.md']),
      side(['file:/a/b.md']),
    )
    expect(verdict.level).toBe('strong')
    expect(verdict.reasons).toHaveLength(1)
  })
})

describe('none：不冲突', () => {
  it('两张都只读同一 file', () => {
    const verdict = judgeConflict(side([], ['file:/a/b.md']), side([], ['file:/a/b.md']))
    expect(verdict.level).toBe('none')
    expect(verdict.reasons).toEqual([])
    expect(verdict.resources).toEqual([])
  })

  it('两个 dir 互不相交', () => {
    expect(judgeConflict(side(['dir:/a/b']), side(['dir:/c/d'])).level).toBe('none')
  })

  it('端口不同、服务不同', () => {
    expect(judgeConflict(side(['port:61208']), side(['port:61209'])).level).toBe('none')
    expect(judgeConflict(side(['svc:dsh-example']), side(['svc:dsh-memory'])).level).toBe('none')
  })

  it('资源种类不同也不相交', () => {
    expect(judgeConflict(side(['file:/a/b.md']), side(['svc:dsh-example'])).level).toBe('none')
  })

  it('不相交的 git 路径判 none，路径边界不算包含', () => {
    expect(judgeConflict(side(['git:/a']), side(['git:/b'])).level).toBe('none')
    expect(judgeConflict(side(['git:/a/b']), side(['git:/a/bc'])).level).toBe('none')
  })

  it('一张票什么都没声明', () => {
    expect(judgeConflict(side(), side(['file:/a/b.md'])).level).toBe('none')
    expect(judgeConflict(side(), side()).level).toBe('none')
  })

  it('进来的资源串会先归一化（尾斜杠）', () => {
    expect(judgeConflict(side(['dir:/a/b/']), side(['dir:/a/b'])).level).toBe('strong')
  })
})
