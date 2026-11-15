import { describe, expect, it } from 'vitest'
import {
  buildNeedsCommandInput,
  buildNeedsCommandSystem,
  classifyNeedsCommand,
  STRONG_COMMAND_SIGNALS,
} from '../src/tickets/classify-command'
import { DEFAULT_COMMAND_KEYWORDS } from '../src/tickets/preset-guard'

const BASE = {
  goal: '翻一遍仓库的历史，看看半年前那次改动',
  brief: '查仓库历史',
  dir: '/srv/app',
}

interface Recorded {
  config?: Record<string, unknown>
  options?: Record<string, unknown>
  calls?: number
}

function fakeLlm(
  chunks: Array<{ type: string; text?: string; reason?: Record<string, unknown> }>,
  record: Recorded = {},
) {
  return {
    async prepareCall(config: Record<string, unknown>) {
      record.calls = (record.calls ?? 0) + 1
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

function judge(overrides: Partial<Parameters<typeof classifyNeedsCommand>[1]> = {}, warns: string[] = []) {
  return classifyNeedsCommand(BASE, {
    llm: () => fakeLlm([{ type: 'text-delta', text: 'NEEDS_COMMAND: yes' }]),
    model: 'deepseek/deepseek-flash',
    effort: 'off',
    timeoutMs: 50,
    keywords: DEFAULT_COMMAND_KEYWORDS,
    warn: (message) => warns.push(message),
    ...overrides,
  })
}

describe('命令判定的 prompt 与输入', () => {
  it('system 只问一件事，点名 bash/脚本/git/测试/解压/查日志，只许回一行', () => {
    const system = buildNeedsCommandSystem()
    expect(system).toContain('需不需要真的运行程序')
    expect(system).toContain('bash 或脚本')
    expect(system).toContain('git 命令')
    expect(system).toContain('跑测试')
    expect(system).toContain('解压')
    expect(system).toContain('日志')
    expect(system).toContain('只输出一行：NEEDS_COMMAND: yes 或 NEEDS_COMMAND: no')
  })

  it('输入是目标 + 摘要 + 工作目录，不带档位表', () => {
    const text = buildNeedsCommandInput(BASE)
    expect(text).toContain(`目标：${BASE.goal}`)
    expect(text).toContain(`摘要：${BASE.brief}`)
    expect(text).toContain(`工作目录：${BASE.dir}`)
    expect(buildNeedsCommandInput({ ...BASE, dir: undefined })).not.toContain('工作目录')
  })

  it('强信号词只收显式声明，不收日志/grep 这类宽词', () => {
    expect(STRONG_COMMAND_SIGNALS).toContain('需要执行命令')
    expect(STRONG_COMMAND_SIGNALS).not.toContain('日志')
    expect(STRONG_COMMAND_SIGNALS).not.toContain('grep')
  })
})

describe('classifyNeedsCommand：模型给结论', () => {
  it('yes → needsCommand=true，来源 llm，模型/effort/输出上限传对', async () => {
    const record: Recorded = {}
    const verdict = await judge({ llm: () => fakeLlm([{ type: 'text-delta', text: 'NEEDS_COMMAND: yes' }], record) })
    expect(verdict).toEqual({ needsCommand: true, source: 'llm' })
    expect(record.config).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
      maxTokens: 20,
    })
    expect(record.options?.system).toContain('NEEDS_COMMAND')
  })

  it('no（任务书里没有命令类词）→ needsCommand=false', async () => {
    const verdict = await judge({ llm: () => fakeLlm([{ type: 'text-delta', text: 'NEEDS_COMMAND: no' }]) })
    expect(verdict).toEqual({ needsCommand: false, source: 'llm' })
  })

  it('分片到达也拼得起来，大小写和全角冒号都认', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: 'NEEDS_' },
      { type: 'text-delta', text: 'COMMAND：YES' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect((await judge({ llm: () => llm })).needsCommand).toBe(true)
  })

  it('模型判 no、任务书里出现 git → 以任务书为准（强信号优先）', async () => {
    const verdict = await classifyNeedsCommand(
      { goal: '用 git 看看这仓库改了什么', brief: '查仓库' },
      {
        llm: () => fakeLlm([{ type: 'text-delta', text: 'NEEDS_COMMAND: no' }]),
        model: 'deepseek/deepseek-flash',
        effort: 'off',
        timeoutMs: 50,
        keywords: DEFAULT_COMMAND_KEYWORDS,
      },
    )
    expect(verdict).toEqual({ needsCommand: true, source: 'keyword', matchedKeyword: 'git' })
  })

  it('任务书写明「需要执行命令」：直接 yes，一次调用都不花', async () => {
    const record: Recorded = {}
    const verdict = await classifyNeedsCommand(
      { goal: '这活需要执行命令：跑 npm test', brief: '跑测试' },
      {
        llm: () => fakeLlm([{ type: 'text-delta', text: 'NEEDS_COMMAND: no' }], record),
        model: 'deepseek/deepseek-flash',
        effort: 'off',
        timeoutMs: 50,
        keywords: DEFAULT_COMMAND_KEYWORDS,
      },
    )
    expect(verdict).toEqual({ needsCommand: true, source: 'strong', matchedKeyword: '需要执行命令' })
    expect(record.calls).toBeUndefined()
  })
})

describe('classifyNeedsCommand：失败退回关键词表', () => {
  it('回答里没有 NEEDS_COMMAND 行 → 退回词表，warn 一行', async () => {
    const warns: string[] = []
    const verdict = await judge(
      { llm: () => fakeLlm([{ type: 'text-delta', text: '我觉得不用吧' }]) },
      warns,
    )
    expect(verdict.source).toBe('keyword')
    expect(warns.join('\n')).toContain('命令判定失败')
    expect(warns.join('\n')).toContain('退回关键词表')
  })

  it('词表命中（grep 日志）→ yes，带上命中词', async () => {
    const verdict = await classifyNeedsCommand(
      { goal: 'grep 一下会话里的报错', brief: '查报错' },
      {
        llm: () => fakeLlm([{ type: 'text-delta', text: '我没有格式' }]),
        model: 'deepseek/deepseek-flash',
        effort: 'off',
        timeoutMs: 50,
        keywords: DEFAULT_COMMAND_KEYWORDS,
      },
    )
    expect(verdict.needsCommand).toBe(true)
    expect(verdict.matchedKeyword).toBe('grep')
  })

  it('词表也不命中（读 README）→ no，不误伤', async () => {
    const verdict = await classifyNeedsCommand(
      { goal: '读一下 README，写三句摘要', brief: '写摘要' },
      {
        llm: () => fakeLlm([{ type: 'text-delta', text: '没有这行' }]),
        model: 'deepseek/deepseek-flash',
        effort: 'off',
        timeoutMs: 50,
        keywords: DEFAULT_COMMAND_KEYWORDS,
      },
    )
    expect(verdict).toEqual({ needsCommand: false, source: 'keyword' })
  })

  it('llm 服务不在 → 退回词表，不抛', async () => {
    const warns: string[] = []
    const verdict = await judge({ llm: () => undefined }, warns)
    expect(verdict).toEqual({ needsCommand: false, source: 'keyword' })
    expect(warns.join('\n')).toContain('llm 服务不可用')
  })

  it('prepareCall 报错 → 退回词表，warn 里不带任务书原文', async () => {
    const warns: string[] = []
    const llm = {
      async prepareCall() {
        throw new Error('路由不存在')
      },
    }
    const verdict = await classifyNeedsCommand(
      { goal: '机密目标：读这个文件', brief: '机密摘要' },
      {
        llm: () => llm as never,
        model: 'deepseek/deepseek-flash',
        effort: 'off',
        timeoutMs: 50,
        keywords: DEFAULT_COMMAND_KEYWORDS,
        warn: (message) => warns.push(message),
      },
    )
    expect(verdict).toEqual({ needsCommand: false, source: 'keyword' })
    expect(warns.join('\n')).toContain('路由不存在')
    expect(warns.join('\n')).not.toContain('机密目标')
    expect(warns.join('\n')).not.toContain('机密摘要')
  })

  it('模型回 finish/error → 退回词表', async () => {
    const llm = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: '额度用完了' } } }])
    const warns: string[] = []
    const verdict = await judge({ llm: () => llm }, warns)
    expect(warns.join('\n')).toContain('额度用完了')
    expect(verdict.source).toBe('keyword')
  })

  it('超时就 abort 并退回词表，不拖住开票', async () => {
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
    const warns: string[] = []
    const verdict = await judge({ llm: () => llm as never, timeoutMs: 20 }, warns)
    expect(signal?.aborted).toBe(true)
    expect(warns.join('\n')).toContain('DISPATCHER_CLASSIFY_TIMEOUT')
    expect(verdict.source).toBe('keyword')
  })
})
