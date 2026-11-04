import { describe, expect, it } from 'vitest'
import {
  buildClassifyInput,
  buildClassifySystem,
  createLlmClassifier,
  parseChoice,
  parseModelRoute,
} from '../src/tickets/classify'
import type { ClassifyChoice, ClassifyInput, PresetInfo } from '../src/tickets/publish'

const PRESETS: PresetInfo[] = [
  { id: 't1', name: '常规', description: '能写盘能跑命令' },
  { id: 't2', name: '只读', whenToUse: '只查不改' },
]

const INPUT: ClassifyInput = {
  goal: '修掉登录页的闪退',
  brief: '登录页闪退',
  dir: '/home/julia/app',
  presets: PRESETS,
}

describe('parseModelRoute', () => {
  it('按第一个斜杠切 provider 和 model', () => {
    expect(parseModelRoute('deepseek-official/deepseek-flash')).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    })
  })

  it('模型名里带斜杠也留着', () => {
    expect(parseModelRoute('openrouter/vendor/model')).toEqual({ provider: 'openrouter', model: 'vendor/model' })
  })

  it('缺 provider、缺 model、整串空都直接抛', () => {
    expect(() => parseModelRoute('/only-model')).toThrow(/provider\/model/)
    expect(() => parseModelRoute('provider/')).toThrow(/provider\/model/)
    expect(() => parseModelRoute('   ')).toThrow(/provider\/model/)
  })
})

describe('prompt 拼装', () => {
  it('档位表原样带上 id、名字和说明，且不含硬编码档名', () => {
    const system = buildClassifySystem(PRESETS)
    expect(system).toContain('- t1（常规）：能写盘能跑命令')
    expect(system).toContain('- t2（只读）：只查不改')
  })

  it('硬判据在场：要写盘就不许给只读档', () => {
    expect(buildClassifySystem(PRESETS)).toContain('要写盘、要改文件、要跑命令的，就一定不能给只会读的档')
  })

  it('用户消息只有目标/摘要/目录，不掺档位表', () => {
    const text = buildClassifyInput(INPUT)
    expect(text).toContain('目标：修掉登录页的闪退')
    expect(text).toContain('摘要：登录页闪退')
    expect(text).toContain('工作目录：/home/julia/app')
    expect(text).not.toContain('t1')
  })

  it('没给目录就不写目录那一行', () => {
    expect(buildClassifyInput({ ...INPUT, dir: undefined })).not.toContain('工作目录')
  })
})

describe('parseChoice', () => {
  it('一行纯档名就够', () => {
    expect(parseChoice('t2', PRESETS)).toEqual({ preset: 't2' })
  })

  it('前后引号、前缀、句号都认，后面那截当理由', () => {
    expect(parseChoice('档位：t1。要改三个文件', PRESETS)).toEqual({ preset: 't1', why: '要改三个文件' })
  })

  it('整词匹配：t1 不命中 t10，也不命中 at1x', () => {
    expect(parseChoice('t10 最合适', PRESETS)).toBeUndefined()
    expect(parseChoice('at1x', PRESETS)).toBeUndefined()
  })

  it('同一行多个档名取最先出现的', () => {
    expect(parseChoice('t2，不对，还是 t1', PRESETS)?.preset).toBe('t2')
  })

  it('档名单独占一行，理由从下一行借', () => {
    expect(parseChoice('t1\n只读档改不了文件', PRESETS)).toEqual({ preset: 't1', why: '只读档改不了文件' })
  })

  it('理由太长就截到 120 字', () => {
    const choice = parseChoice(`t1 ${'很长'.repeat(100)}`, PRESETS)!
    expect(Array.from(choice.why ?? '').length).toBe(120)
  })

  it('没有合法档名返回 undefined', () => {
    expect(parseChoice('我觉得都行', PRESETS)).toBeUndefined()
    expect(parseChoice('', PRESETS)).toBeUndefined()
    expect(parseChoice('t1', [])).toBeUndefined()
  })
})

interface Recorded {
  config?: Record<string, unknown>
  options?: Record<string, unknown>
  aborted?: boolean
}

function fakeLlm(chunks: Array<{ type: string; text?: string; reason?: Record<string, unknown> }>, record: Recorded = {}) {
  return {
    async prepareCall(config: Record<string, unknown>) {
      record.config = config
      return {
        config: { temperature: 0 },
        async *stream(options: Record<string, unknown>) {
          record.options = options
          for (const chunk of chunks) yield chunk
        },
      }
    },
  }
}

function classifier(overrides: Partial<Parameters<typeof createLlmClassifier>[0]> = {}, warns: string[] = []) {
  return createLlmClassifier({
    llm: () => fakeLlm([{ type: 'text-delta', text: 't1 要动代码' }]),
    model: 'deepseek-official/deepseek-flash',
    effort: 'off',
    timeoutMs: 2000,
    warn: (message) => warns.push(message),
    ...overrides,
  })
}

describe('createLlmClassifier', () => {
  it('一次调用就出档名：provider/model/effort/输出上限都传对', async () => {
    const record: Recorded = {}
    const choice = await classifier({ llm: () => fakeLlm([{ type: 'text-delta', text: 't1 要动代码' }], record) }).classify(
      INPUT,
    )
    expect(choice).toEqual({ preset: 't1', why: '要动代码' })
    expect(record.config).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
      maxTokens: 200,
    })
    expect(record.options?.system).toContain('t2（只读）')
  })

  it('chunks 分片到达也拼得起来', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: 't' },
      { type: 'text-delta', text: '2 ' },
      { type: 'text-delta', text: '只查不改' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const choice = (await classifier({ llm: () => llm }).classify(INPUT)) as ClassifyChoice
    expect(choice.preset).toBe('t2')
  })

  it('effort 是空串就不传 reasoningEffort', async () => {
    const record: Recorded = {}
    await classifier({ effort: '', llm: () => fakeLlm([{ type: 'text-delta', text: 't1' }], record) }).classify(INPUT)
    expect(record.config).not.toHaveProperty('reasoningEffort')
  })

  it('llm 服务不在就抛，不自己猜档', async () => {
    await expect(classifier({ llm: () => undefined }).classify(INPUT)).rejects.toThrow(/llm 服务不可用/)
  })

  it('没有档位直接抛', async () => {
    await expect(classifier().classify({ ...INPUT, presets: [] })).rejects.toThrow(/没有档位/)
  })

  it('模型回 finish/error 就抛', async () => {
    const llm = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: '额度用完了' } } }])
    await expect(classifier({ llm: () => llm }).classify(INPUT)).rejects.toThrow(/额度用完了/)
  })

  it('回答里没有合法档名：抛，且警告里不带工单原文', async () => {
    const warns: string[] = []
    const llm = fakeLlm([{ type: 'text-delta', text: '我哪知道' }])
    await expect(classifier({ llm: () => llm }, warns).classify({ ...INPUT, goal: '机密目标：删库' })).rejects.toThrow(
      /合法档名/,
    )
    expect(warns.join('\n')).not.toContain('机密目标')
    expect(warns.join('\n')).toContain('deepseek-flash')
  })

  it('prepareCall 报错：只记模型和错误，不记 prompt', async () => {
    const warns: string[] = []
    const llm = {
      async prepareCall() {
        throw new Error('路由不存在')
      },
    }
    await expect(
      classifier({ llm: () => llm as never }, warns).classify({ ...INPUT, brief: '机密摘要' }),
    ).rejects.toThrow(/路由不存在/)
    expect(warns.join('\n')).toContain('路由不存在')
    expect(warns.join('\n')).not.toContain('机密摘要')
  })

  it('超时就 abort 并抛，不拖住开票', async () => {
    let signal: AbortSignal | undefined
    const llm = {
      async prepareCall(_config: Record<string, unknown>, passed?: AbortSignal) {
        signal = passed
        return {
          config: {},
          async *stream() {
            await new Promise<void>((resolve) => {
              passed?.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        }
      },
    }
    await expect(classifier({ llm: () => llm as never, timeoutMs: 20 }).classify(INPUT)).rejects.toThrow(
      /DISPATCHER_CLASSIFY_TIMEOUT/,
    )
    expect(signal?.aborted).toBe(true)
  })
})
