import { describe, expect, it } from 'vitest'
import { hasIdFragment, hexFragments, idVariants, matchesId } from '../src/ids'

/**
 * 从 index.ts 抽出来的 id 比对规则，2026-11-03 起也被僵尸巡检复用。
 *
 * 这里锁的是边界：短标签能对上完整 id，纯中文标签一律对不上（不是报错），
 * 片段短于 6 位不参与比对。
 */

const FULL = '34b183b9-5d77-4c3e-9f00-112233445566'
const OTHER = 'aff73fb2-0000-4111-8222-333344445555'

describe('idVariants', () => {
  it('裸 id 和带 session- 前缀算同一路', () => {
    expect([...idVariants(FULL)]).toEqual([FULL, `session-${FULL}`])
    expect([...idVariants(`session-${FULL}`)]).toEqual([`session-${FULL}`, FULL])
  })
})

describe('hexFragments', () => {
  it('按 uuid 段拆，只留够 6 位的连续片段', () => {
    // 中间那几段只有 4 位，抽不出来；首段 8 位、尾段 12 位才是拿来做前缀比对的。
    expect(hexFragments(`session-${FULL}`)).toEqual(['34b183b9', '112233445566'])
  })

  it('纯中文和短英文标签抽不出片段', () => {
    expect(hexFragments('小丙')).toEqual([])
    expect(hexFragments('重启小鱼')).toEqual([])
    expect(hexFragments('fix-check-1')).toEqual([])
  })
})

describe('matchesId', () => {
  it('完整 uuid 与它的 session- 写法互认', () => {
    expect(matchesId(FULL, `session-${FULL}`)).toBe(true)
    expect(matchesId(`session-${FULL}`, FULL)).toBe(true)
  })

  it('短标签里的 uuid 前缀能对上完整 id，双向都行', () => {
    expect(matchesId('subagent aff73fb2', OTHER)).toBe(true)
    expect(matchesId(OTHER, 'subagent aff73fb2')).toBe(true)
    // 短的部分是长片段的前缀也算（7 位 uuid 前缀 → 12 位尾段）。
    expect(matchesId('subagent 3333444', OTHER)).toBe(true)
  })

  it('挑错了小鱼就不算：片段不是前缀关系一律不匹配', () => {
    expect(matchesId('subagent aff73fb2', FULL)).toBe(false)
    expect(matchesId('subagent cafebabe', OTHER)).toBe(false)
    // 只做前缀，不做任意子串：随便一个 8 位 hex 不该蒙中。
    expect(matchesId('worker 77889900', FULL)).toBe(false)
  })

  it('纯中文标签对不上任何会话，也不抛错', () => {
    expect(matchesId('小丙', OTHER)).toBe(false)
    expect(matchesId('重启小鱼', FULL)).toBe(false)
    expect(matchesId('重启小鱼', '小丙')).toBe(false)
  })

  it('片段短于 6 位不参与比对', () => {
    // 'abcde' 只有 5 位，抽不出来；精确相等仍然成立。
    expect(matchesId('abcde', OTHER)).toBe(false)
    expect(matchesId('abcde', 'abcde')).toBe(true)
  })

  it('大小写不影响片段比对', () => {
    expect(matchesId('subagent AFF73FB2', OTHER)).toBe(true)
  })
})

describe('hasIdFragment', () => {
  it('裸 uuid、带前缀、uuid 前缀短标签都算可辨识', () => {
    expect(hasIdFragment(FULL)).toBe(true)
    expect(hasIdFragment(`session-${FULL}`)).toBe(true)
    expect(hasIdFragment('subagent aff73fb2')).toBe(true)
  })

  it('纯文字标签和空 owner 算不可辨识', () => {
    expect(hasIdFragment('小丙')).toBe(false)
    expect(hasIdFragment('重启小鱼')).toBe(false)
    expect(hasIdFragment('fix-check-1')).toBe(false)
    expect(hasIdFragment('')).toBe(false)
    expect(hasIdFragment(undefined)).toBe(false)
  })
})
