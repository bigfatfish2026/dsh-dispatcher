import { describe, expect, it } from 'vitest'
import { parseNeedsCommand } from '../src/tickets/classify'
import {
  checkPresetChoice,
  commandHint,
  DEFAULT_COMMAND_KEYWORDS,
  parseToolsetDocument,
  presetRunsCommands,
  toolRunsCommands,
} from '../src/tickets/preset-guard'
import type { PresetTools } from '../src/tickets/preset-guard'

const allow = (...names: string[]): PresetTools => ({ mode: 'allow', names: new Set(names) })
const deny = (...names: string[]): PresetTools => ({ mode: 'deny', names: new Set(names) })

const T2_READ_ONLY = allow('read', 'glob', 'grep', 'dispatch_report', 'send_message')
const T1_FULL = allow('bash', 'read', 'write', 'edit', 'dispatch_report', 'send_message')
const T0_SMALL = allow('bash', 'read', 'write', 'edit', 'dispatch_report')
const PRESETS = ['t0', 't1', 't2']

const toolsOfFrom = (map: Record<string, PresetTools | Error | undefined>) => async (id: string) => {
  const value = map[id]
  if (value instanceof Error) throw value
  return value
}

describe('档位工具面：从声明里读 allow/deny', () => {
  it('allow 名单读出来，能认出 bash', () => {
    const content = `- name: dsh-preset-toolset
  config:
    allow:
      - read
      - bash
      - dispatch_report
`
    const tools = parseToolsetDocument(content)
    expect(tools?.mode).toBe('allow')
    expect([...(tools?.names ?? [])]).toEqual(['read', 'bash', 'dispatch_report'])
    expect(presetRunsCommands(tools)).toBe(true)
  })

  it('deny 名单读出来，bash 被挡就不能跑命令', () => {
    const tools = parseToolsetDocument(`- name: 'dsh-preset-toolset'
  config:
    deny:
      - bash
      - write
`)
    expect(tools).toEqual({ mode: 'deny', names: new Set(['bash', 'write']) })
    expect(presetRunsCommands(tools)).toBe(false)
  })

  it('没有 toolset 行 = 没减工具 = 能跑命令', () => {
    expect(parseToolsetDocument('- name: something-else\n  config: {}\n')).toBeUndefined()
    expect(presetRunsCommands(undefined)).toBe(true)
  })

  it('MCP 的 mcp__server__run_command 也算命令工具', () => {
    expect(toolRunsCommands('mcp__shell__run_command')).toBe(true)
    expect(toolRunsCommands('mcp__github__search_code')).toBe(false)
    expect(presetRunsCommands(allow('read', 'mcp__shell__run_command'))).toBe(true)
  })

  it('两个 toolset 行按交集算：第二个没 bash 就没 bash', () => {
    const content = `- name: dsh-preset-toolset
  config:
    allow:
      - bash
      - read
- name: dsh-preset-toolset
  config:
    allow:
      - read
`
    expect(presetRunsCommands(parseToolsetDocument(content))).toBe(false)
  })
})

describe('需求判定：关键词兜底', () => {
  it('任务书的「要真的用 bash 跑命令」命中', () => {
    expect(commandHint('要真的用 bash 跑命令查源码，按能跑命令的档派。')).toBe('跑命令')
    expect(commandHint('用 git 命令查四个仓库')).toBe('git')
  })

  it('否定分句不算：不许跑命令，只读文件', () => {
    expect(commandHint('不许跑命令，只读文件就行')).toBeUndefined()
  })

  it('否定只否决它那一句：不许改文件，但要跑 git 命令', () => {
    expect(commandHint('不许改文件，但要跑 git 命令')).toBe('git')
  })

  it('拉丁词按整词认：digit 不算 git，category 不算 cat', () => {
    expect(commandHint('digit 有多少位')).toBeUndefined()
    expect(commandHint('把 category 分一下')).toBeUndefined()
    expect(commandHint('用 grep 翻日志')).toBe('grep')
    expect(commandHint('GREP 一下')).toBe('grep')
  })

  it('远程排障词表：grep/zstd/journalctl 都能认出来', () => {
    expect(commandHint('grep 一下会话里的报错')).toBe('grep')
    expect(commandHint('把归档 zstd 解压出来看看')).toBe('zstd')
    expect(commandHint('gunzip 这个包')).toBe('gunzip')
    expect(commandHint('sed -n 1,20p 那个文件')).toBe('sed')
    expect(commandHint('awk 数一下第三列')).toBe('awk')
    expect(commandHint('curl 一下健康检查')).toBe('curl')
    expect(commandHint('journalctl -u dsh-qqbot 看服务日志')).toBe('journalctl')
    expect(commandHint('翻一下日志，找解压失败那回')).toBe('日志')
    expect(commandHint('把这个包解压出来')).toBe('解压')
    expect(commandHint('翻会话记录，找那次报错')).toBe('会话记录')
    expect(commandHint('cat 一下压缩包里的清单')).toBe('cat')
    expect(commandHint('按时间排序')).toBe('排序')
    expect(commandHint('统计每个服务的内存')).toBe('统计')
    expect(commandHint('把测试跑一遍')).toBe('跑一遍')
    expect(commandHint('按计划执行')).toBe('执行')
  })

  it('负例不误伤：读 README / 查记忆 / 网页搜索都不算要命令', () => {
    expect(commandHint('读一下 README，写三句摘要')).toBeUndefined()
    expect(commandHint('查一下记忆里主人喜欢什么')).toBeUndefined()
    expect(commandHint('上网查一下下周天气')).toBeUndefined()
    expect(commandHint('只读代码审查，挑逻辑问题')).toBeUndefined()
  })

  it('没有迹象就不命中', () => {
    expect(commandHint('读一下这个文件，总结成三句')).toBeUndefined()
  })

  it('表可换：换成只认 build 就只认 build', () => {
    expect(commandHint('npm 安装依赖', ['build'])).toBeUndefined()
    expect(commandHint('先 build 再跑', ['build'])).toBe('build')
  })

  it('默认表里没有「commit/push」这类只读也不该拦的词', () => {
    expect(DEFAULT_COMMAND_KEYWORDS).not.toContain('commit')
    expect(DEFAULT_COMMAND_KEYWORDS).not.toContain('push')
  })
})

describe('分类器第三行 NEEDS_COMMAND', () => {
  it('yes/no 都认，大小写和全角冒号也认', () => {
    expect(parseNeedsCommand('t1\n要跑命令\nNEEDS_COMMAND: yes')).toBe(true)
    expect(parseNeedsCommand('t2\n只读\nneeds_command：no')).toBe(false)
    expect(parseNeedsCommand('t1\n理由\nNEEDS_COMMAND: 是')).toBe(true)
  })

  it('没写就是 undefined，不把「没表态」当成不要', () => {
    expect(parseNeedsCommand('t1\n只说档名和理由')).toBeUndefined()
  })
})

describe('选档守卫：三条规则', () => {
  const base = {
    goal: '读一下这个文件',
    allowedPresets: PRESETS as string[],
    keywords: DEFAULT_COMMAND_KEYWORDS as string[],
    candidates: PRESETS,
  }

  it('rule0：注册表里没有这个档就驳回', async () => {
    const rejection = await checkPresetChoice({
      ...base,
      preset: 't9',
      toolsOf: toolsOfFrom({}),
    })
    expect(rejection?.rule).toBe('preset-unavailable')
    expect(rejection?.message).toContain('没有 t9 这个档')
  })

  it('rule0：读工具面抛错（解析失败）也驳回，不放行', async () => {
    const rejection = await checkPresetChoice({
      ...base,
      preset: 't2',
      toolsOf: toolsOfFrom({ t2: new Error('YAML 坏了') }),
    })
    expect(rejection?.rule).toBe('preset-unavailable')
    expect(rejection?.message).toContain('装不上')
  })

  it('rule1：档不在 allowedPresets 里就驳回', async () => {
    const rejection = await checkPresetChoice({
      ...base,
      preset: 't2',
      allowedPresets: ['t0', 't1'],
      toolsOf: toolsOfFrom({ t2: T2_READ_ONLY }),
    })
    expect(rejection?.rule).toBe('not-allowed')
    expect(rejection?.message).toContain('t0 / t1')
  })

  it('rule2：要跑命令 + t2 没 bash → 驳回，并建议最省的有 bash 档', async () => {
    const rejection = await checkPresetChoice({
      ...base,
      preset: 't2',
      label: '只读',
      needsCommand: true,
      toolsOf: toolsOfFrom({ t0: T0_SMALL, t1: T1_FULL, t2: T2_READ_ONLY }),
    })
    expect(rejection?.rule).toBe('needs-command-no-bash')
    expect(rejection?.message).toContain('任务要执行命令，但 t2（只读）档没有 bash')
    expect(rejection?.message).toContain('建议改用 t0')
  })

  it('rule2：needsCommand 没给 + 关键词命中 → 也驳回', async () => {
    const rejection = await checkPresetChoice({
      ...base,
      preset: 't2',
      goal: '要真的用 bash 跑命令查源码',
      toolsOf: toolsOfFrom({ t0: T0_SMALL, t1: T1_FULL, t2: T2_READ_ONLY }),
    })
    expect(rejection?.rule).toBe('needs-command-no-bash')
    expect(rejection?.matchedKeyword).toBe('跑命令')
  })

  it('rule2：needsCommand=false 但任务书出现命令类词 → 按矛盾驳回，点名命中词', async () => {
    const rejection = await checkPresetChoice({
      ...base,
      preset: 't2',
      label: '只读',
      needsCommand: false,
      goal: '用 git 看看这仓库，纯只读',
      toolsOf: toolsOfFrom({ t2: T2_READ_ONLY }),
    })
    expect(rejection?.rule).toBe('needs-command-no-bash')
    expect(rejection?.matchedKeyword).toBe('git')
    expect(rejection?.message).toContain('任务书里出现命令类词「git」，判成不需要执行命令')
  })

  it('rule2：三条命令类正例（grep 日志 / zstd 解压 / journalctl 查）即使 false 也驳回', async () => {
    const cases: Array<[string, string]> = [
      ['grep 一下原始会话里的报错', 'grep'],
      ['把归档 zstd 解压出来看看', 'zstd'],
      ['journalctl -u dsh-qqbot 最近一百行', 'journalctl'],
    ]
    for (const [goal, keyword] of cases) {
      const rejection = await checkPresetChoice({
        ...base,
        preset: 't2',
        needsCommand: false,
        goal,
        toolsOf: toolsOfFrom({ t0: T0_SMALL, t1: T1_FULL, t2: T2_READ_ONLY }),
      })
      expect(rejection?.rule).toBe('needs-command-no-bash')
      expect(rejection?.matchedKeyword).toBe(keyword)
    }
  })

  it('rule2：三条负例（读 README / 查记忆 / 网页搜索）false 时放行', async () => {
    const goals = ['读一下 README，写三句摘要', '查一下记忆里主人喜欢什么', '上网查一下下周天气']
    for (const goal of goals) {
      const rejection = await checkPresetChoice({
        ...base,
        preset: 't2',
        needsCommand: false,
        goal,
        toolsOf: toolsOfFrom({ t2: T2_READ_ONLY }),
      })
      expect(rejection).toBeUndefined()
    }
  })

  it('rule2：false + 命中关键词，但档里有 bash → 放行', async () => {
    const rejection = await checkPresetChoice({
      ...base,
      preset: 't1',
      needsCommand: false,
      goal: 'grep 一下会话日志',
      toolsOf: toolsOfFrom({ t0: T0_SMALL, t1: T1_FULL, t2: T2_READ_ONLY }),
    })
    expect(rejection).toBeUndefined()
  })

  it('纯只读任务、needsCommand 缺省、关键词不中：t2 放行（不误伤）', async () => {
    const rejection = await checkPresetChoice({
      ...base,
      preset: 't2',
      goal: '读一下这三个文件，比一比哪份更新',
      toolsOf: toolsOfFrom({ t2: T2_READ_ONLY }),
    })
    expect(rejection).toBeUndefined()
  })

  it('要跑命令 + t0/t1 有 bash：放行', async () => {
    for (const preset of ['t0', 't1']) {
      const rejection = await checkPresetChoice({
        ...base,
        preset,
        goal: '要真的用 bash 跑命令',
        toolsOf: toolsOfFrom({ t0: T0_SMALL, t1: T1_FULL, t2: T2_READ_ONLY }),
      })
      expect(rejection).toBeUndefined()
    }
  })
})
