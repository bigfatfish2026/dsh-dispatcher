import { describe, expect, it } from 'vitest'
import { fakeClassifier, fakePresets, INTENT, makeDesk } from './helpers/desk-harness'
import type { PresetTools } from '../src/tickets/preset-guard'

const allow = (...names: string[]): PresetTools => ({ mode: 'allow', names: new Set(names) })

const READ_ONLY: PresetTools = allow('read', 'glob', 'grep', 'dispatch_report', 'send_message')
const FULL: PresetTools = allow('bash', 'read', 'write', 'edit', 'dispatch_report', 'send_message')
const SMALL: PresetTools = allow('bash', 'read', 'dispatch_report')

const PRESETS = [
  { id: 't0', name: '交活' },
  { id: 't1', name: '常规' },
  { id: 't2', name: '只读' },
]
const TOOLS = { t0: SMALL, t1: FULL, t2: READ_ONLY }

const COMMAND_GOAL = '要真的用 bash 跑命令查源码，按能跑命令的档派；没有 bash 就第一行报缺 shell。'

describe('开票：选档驳回', () => {
  it('要跑命令却选了只读档：不建票、不 spawn，错误文本带建议档', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier({ preset: 't2', why: '纯只读', needsCommand: true }),
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1', 't2'] },
    })

    await expect(h.desk.open({ ...INTENT, goal: COMMAND_GOAL }, h.main)).rejects.toThrow(
      /任务要执行命令，但 t2（只读）档没有 bash/,
    )
    // 票一条都没落：published 都没有。
    expect(h.backend.events_).toHaveLength(0)
    expect(h.log.list()).toHaveLength(0)
    // 活也没派。
    expect(h.subagents.spawned).toHaveLength(0)
    // 驳回文本要能照着走：带建议档和改法。
    await expect(h.desk.open({ ...INTENT, goal: COMMAND_GOAL }, h.main)).rejects.toThrow(/建议改用 t0/)
    await expect(h.desk.open({ ...INTENT, goal: COMMAND_GOAL }, h.main)).rejects.toThrow(/改任务书/)
    // 日志一行：哪张活、选中哪档、哪条规则、为什么。
    expect(h.warnings.join('\n')).toMatch(/选档驳回 rule=needs-command-no-bash preset=t2/)
    expect(h.warnings.join('\n')).toContain('brief=拆票台')
  })

  it('驳回不占名额：执行名额计数不变，下一张正常票照开', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: {
        async classify(input) {
          // 读文件类不要命令；写「要跑命令」的才要。
          return { preset: 't2', needsCommand: input.goal.includes('命令') }
        },
      },
      config: { defaultPreset: 't1', maxExec: 2, allowedPresets: ['t0', 't1', 't2'] },
    })

    const first = await h.desk.open({ ...INTENT, goal: '读一遍这个文件' }, h.main)
    expect(first.openCount).toBe(1)
    // 驳回一次：名额还是 1。
    await expect(h.desk.open({ ...INTENT, requestId: 'req-2', goal: COMMAND_GOAL }, h.main)).rejects.toThrow(
      /没有 bash/,
    )
    // maxExec=2 时还能开出第二张真票，说明驳回那次没算进去。
    const second = await h.desk.open({ ...INTENT, requestId: 'req-3', goal: '再读一遍那个文件' }, h.main)
    expect(second.openCount).toBe(2)
    expect(h.backend.kinds().filter((kind) => kind === 'published')).toHaveLength(2)
    expect(h.backend.kinds()).not.toContain('closed')
  })

  it('rule0：读工具面抛错就驳回，不静默放行', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', { t2: new Error('YAML 解析失败') }),
      classify: fakeClassifier('t2'),
      config: { defaultPreset: 't1' },
    })
    await expect(h.desk.open(INTENT, h.main)).rejects.toThrow(/装不上/)
    expect(h.backend.events_).toHaveLength(0)
  })

  it('rule1：档不在允许清单里就驳回', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier('t2'),
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1'] },
    })
    await expect(h.desk.open(INTENT, h.main)).rejects.toThrow(/不在允许档位/)
    expect(h.backend.events_).toHaveLength(0)
  })

  it('纯只读任务 + t2：照开（今天最容易误伤的一种）', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier('t2'),
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1', 't2'] },
    })
    const receipt = await h.desk.open({ ...INTENT, goal: '读一遍这三个文件，比一比哪份新' }, h.main)
    expect(receipt.preset).toBe('t2')
    expect(h.subagents.spawned).toHaveLength(1)
  })

  it('任务书写「不许跑命令，只读文件」+ t2：放行（负向分句生效）', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier('t2'),
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1', 't2'] },
    })
    const receipt = await h.desk.open({ ...INTENT, goal: '不许跑命令，只读文件就行' }, h.main)
    expect(receipt.status).toBe('running')
  })

  it('needsCommand 缺省、关键词命中、t2 没 bash：驳回', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier('t2'),
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1', 't2'] },
    })
    await expect(h.desk.open({ ...INTENT, goal: COMMAND_GOAL }, h.main)).rejects.toThrow(/没有 bash/)
    expect(h.warnings.join('\n')).toContain('命中关键词')
  })

  it('rejectOnMismatch=false：回到裸选，不再驳回', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier({ preset: 't2', needsCommand: true }),
      config: { defaultPreset: 't1', rejectOnMismatch: false },
    })
    const receipt = await h.desk.open({ ...INTENT, goal: COMMAND_GOAL }, h.main)
    expect(receipt.preset).toBe('t2')
    expect(h.backend.kinds()).toContain('published')
  })
})

describe('开票：命令判定先判一次，结论透传给守卫', () => {
  const judgeYes = async () => ({ needsCommand: true, source: 'llm' as const })
  const judgeNo = async () => ({ needsCommand: false, source: 'llm' as const })

  it('judge 判 yes：只读档驳回，票一条都不落', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier('t2'),
      judgeCommand: judgeYes,
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1', 't2'] },
    })
    await expect(
      h.desk.open({ ...INTENT, requestId: 'req-judge-yes', goal: '读一遍这三个文件，比一比哪份新' }, h.main),
    ).rejects.toThrow(/任务要执行命令，但 t2（只读）档没有 bash/)
    expect(h.backend.events_).toHaveLength(0)
    expect(h.subagents.spawned).toHaveLength(0)
  })

  it('judge 判 no、任务书里没有命令词：只读档照开', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier('t2'),
      judgeCommand: judgeNo,
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1', 't2'] },
    })
    const receipt = await h.desk.open({ ...INTENT, requestId: 'req-judge-no', goal: '读一遍这三个文件' }, h.main)
    expect(receipt.preset).toBe('t2')
    expect(h.subagents.spawned).toHaveLength(1)
  })

  it('judge 抛错：warn 一行后交回关键词表，任务书明写要命令仍驳回', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier('t2'),
      judgeCommand: async () => {
        throw new Error('judge 挂了')
      },
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1', 't2'] },
    })
    await expect(h.desk.open({ ...INTENT, requestId: 'req-judge-boom', goal: COMMAND_GOAL }, h.main)).rejects.toThrow(
      /没有 bash/,
    )
    expect(h.warnings.join('\n')).toContain('命令判定没给结论')
    expect(h.warnings.join('\n')).toContain('judge 挂了')
  })

  it('judge 判 no 但任务书出现 git：守卫按矛盾驳回（强信号优先）', async () => {
    const h = makeDesk({
      presets: fakePresets(PRESETS, 't1', TOOLS),
      classify: fakeClassifier('t2'),
      judgeCommand: judgeNo,
      config: { defaultPreset: 't1', allowedPresets: ['t0', 't1', 't2'] },
    })
    await expect(
      h.desk.open({ ...INTENT, requestId: 'req-judge-git', goal: '用 git 看看这仓库，纯只读' }, h.main),
    ).rejects.toThrow(/任务书里出现命令类词「git」/)
    expect(h.warnings.join('\n')).toMatch(/选档驳回 rule=needs-command-no-bash/)
  })
})
