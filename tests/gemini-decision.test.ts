/**
 * D2：命令判定的第三层（gemini-decision 桥）。
 *
 * 盯三件事：
 *   1. 客户端六项校验：HTTP 2xx / answers 形状 / 候选 / prob 键集合 / Σp / confidence 一致；
 *      任何一项不过都返回 ok:false，绝不把半个答案交给调用方；
 *   2. 开关关着时 classifyNeedsCommand 一次桥请求都不发，结论与接入前一致；
 *   3. 开着时只在模型没结论那一步生效：桥判 yes 且置信度够 → 采纳；桥判 no / 置信度
 *      不够 / 桥挂掉，一律退回关键词表；模型给了结论、强信号命中，都不问桥。
 *
 * 所有桥都是本机假的 http 服务，一个字节都不往外发。
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { classifyNeedsCommand } from '../src/tickets/classify-command'
import type { CommandJudgeDeps, NeedsCommandInput } from '../src/tickets/classify-command'
import { createGeminiDecision, geminiDecisionCfgOf } from '../src/tickets/gemini-decision'
import { DEFAULT_COMMAND_KEYWORDS } from '../src/tickets/preset-guard'

/* ── 假桥 ─────────────────────────────────────────────────────────── */

interface Bridge {
  baseUrl: string
  requests: Array<Record<string, unknown>>
  close: () => Promise<void>
}

/**
 * 起一个本机假桥。handler(body, res) 自己决定回什么；不给 handler 就永不响应（测超时）。
 */
async function startBridge(handler?: (body: Record<string, unknown>, res: ServerResponse) => void): Promise<Bridge> {
  const requests: Array<Record<string, unknown>> = []
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = { raw }
      }
      requests.push(body)
      if (handler) handler(body, res)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function replyWith(body: unknown, status = 200) {
  return (_reqBody: Record<string, unknown>, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}

/** 桥的 answer 形状：choice 是判出来的键，置信度在 probabilities[choice]。 */
function answerOf(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { answers: { q1: { type: 'choice', choice, confidence, probabilities } } }
}

const CRITERIA = { yes: '要执行命令', no: '不用执行命令' }

/* ── 客户端：六项校验 ─────────────────────────────────────────────── */

describe('gemini-decision 客户端', () => {
  it('正常答案原样回，请求里带 model / state / choice 题', async () => {
    const bridge = await startBridge(replyWith(answerOf('yes', 0.92, { yes: 0.92, no: 0.08 })))
    const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 })
    const result = await client.ask({ state: '一句话事实', instructions: '选一个', criteria: CRITERIA })
    await bridge.close()

    expect(result.ok).toBe(true)
    expect(result.choice).toBe('yes')
    expect(result.confidence).toBe(0.92)
    expect(bridge.requests).toHaveLength(1)
    const sent = bridge.requests[0] as {
      model: string
      state: string
      questions: { q1: { type: string; criteria: Record<string, string> } }
    }
    expect(sent.model).toBe('gemini-decision-1')
    expect(sent.state).toBe('一句话事实')
    expect(sent.questions.q1.type).toBe('choice')
    expect(Object.keys(sent.questions.q1.criteria)).toEqual(['yes', 'no'])
  })

  it('HTTP 400 直接失败，原因带状态码', async () => {
    const bridge = await startBridge(replyWith({ error: 'region' }, 400))
    const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 })
    const result = await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })
    await bridge.close()
    expect({ ok: result.ok, reason: result.reason }).toEqual({ ok: false, reason: 'http_400' })
  })

  it('坏 JSON / 缺 answers 都算失败', async () => {
    const badJson = await startBridge((_reqBody, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{not json')
    })
    const client1 = createGeminiDecision({ enabled: true, baseUrl: badJson.baseUrl, timeoutMs: 1000 })
    expect((await client1.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason).toBe('bad_json')
    await badJson.close()

    const noAnswers = await startBridge(replyWith({ answers: [] }))
    const client2 = createGeminiDecision({ enabled: true, baseUrl: noAnswers.baseUrl, timeoutMs: 1000 })
    expect((await client2.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason).toBe('shape')
    await noAnswers.close()
  })

  it('choice 不在候选里 → choice_not_candidate', async () => {
    const bridge = await startBridge(replyWith(answerOf('keep', 0.9, { yes: 0.1, no: 0.9 })))
    const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 })
    expect((await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason)
      .toBe('choice_not_candidate')
    await bridge.close()
  })

  it('probabilities 键集合必须与 criteria 完全相等', async () => {
    const missing = await startBridge(replyWith(answerOf('yes', 0.9, { yes: 0.9 })))
    const client1 = createGeminiDecision({ enabled: true, baseUrl: missing.baseUrl, timeoutMs: 1000 })
    expect((await client1.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason)
      .toBe('prob_keys')
    await missing.close()

    const extra = await startBridge(replyWith(answerOf('yes', 0.9, { yes: 0.9, no: 0, maybe: 0.1 })))
    const client2 = createGeminiDecision({ enabled: true, baseUrl: extra.baseUrl, timeoutMs: 1000 })
    expect((await client2.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason)
      .toBe('prob_keys')
    await extra.close()
  })

  it('Σp 必须落在 1±1e-6，超了算 prob_sum', async () => {
    const bridge = await startBridge(replyWith(answerOf('yes', 0.9, { yes: 0.9, no: 0.5 })))
    const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 })
    expect((await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason)
      .toBe('prob_sum')
    await bridge.close()
  })

  it('confidence 与 p[choice] 不一致算 bad_confidence', async () => {
    const bridge = await startBridge(replyWith(answerOf('yes', 0.7, { yes: 0.9, no: 0.1 })))
    const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 })
    expect((await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason)
      .toBe('bad_confidence')
    await bridge.close()
  })

  it('超时 → timeout，不重试（只发一次）', async () => {
    const bridge = await startBridge()
    const client = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 100 })
    expect((await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason).toBe('timeout')
    expect(bridge.requests).toHaveLength(1)
    await bridge.close()
  })

  it('开关关着不发请求；配置归一 enabled 只认严格 true', async () => {
    const cfg = geminiDecisionCfgOf({ enabled: 'true', timeoutMs: 10 })
    expect(cfg.enabled).toBe(false)
    expect(cfg.timeoutMs).toBe(200)
    const client = createGeminiDecision({ enabled: false })
    expect((await client.ask({ state: 'x', instructions: '选一个', criteria: CRITERIA })).reason).toBe('disabled')
  })
})

/* ── 接线：第三层只在模型没结论时生效 ─────────────────────────────── */

const README_GOAL: NeedsCommandInput = { goal: '读一下 README，写三句摘要', brief: '写摘要' }
const GIT_GOAL: NeedsCommandInput = { goal: '翻一遍仓库历史，用 git 看半年前那次改动', brief: '查仓库历史' }

/** 模型调用必失败：prepareCall 直接抛。 */
function brokenLlm() {
  return {
    async prepareCall() {
      throw new Error('路由不存在')
    },
  }
}

/** 起一个开着的桥客户端，并给 deps 补齐默认值。 */
function judgeWith(
  bridge: Bridge,
  overrides: Partial<CommandJudgeDeps> = {},
  warns: string[] = [],
): { run: (input: NeedsCommandInput) => ReturnType<typeof classifyNeedsCommand>; warns: string[] } {
  const decide = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 })
  return {
    warns,
    run: (input) =>
      classifyNeedsCommand(input, {
        llm: () => brokenLlm() as never,
        model: 'deepseek/deepseek-flash',
        effort: 'off',
        timeoutMs: 50,
        keywords: DEFAULT_COMMAND_KEYWORDS,
        warn: (message) => warns.push(message),
        decide,
        ...overrides,
      }),
  }
}

describe('classifyNeedsCommand × decision 桥（D2）', () => {
  it('开关关着：模型失败也不打桥，照旧退回关键词表', async () => {
    const bridge = await startBridge(replyWith(answerOf('yes', 0.99, { yes: 0.99, no: 0.01 })))
    const warns: string[] = []
    const verdict = await classifyNeedsCommand(README_GOAL, {
      llm: () => brokenLlm() as never,
      model: 'deepseek/deepseek-flash',
      effort: 'off',
      timeoutMs: 50,
      keywords: DEFAULT_COMMAND_KEYWORDS,
      warn: (message) => warns.push(message),
      decide: createGeminiDecision({ enabled: false, baseUrl: bridge.baseUrl }),
    })
    expect(verdict).toEqual({ needsCommand: false, source: 'keyword' })
    expect(bridge.requests).toHaveLength(0)
    expect(warns.join('\n')).toContain('退回关键词表')
    await bridge.close()
  })

  it('模型没结论、桥判 yes 且置信度够 → 采纳，source=gemini', async () => {
    const bridge = await startBridge(replyWith(answerOf('yes', 0.92, { yes: 0.92, no: 0.08 })))
    const { run, warns } = judgeWith(bridge)
    const verdict = await run(GIT_GOAL)
    expect(verdict).toEqual({ needsCommand: true, source: 'gemini' })
    expect(bridge.requests).toHaveLength(1)
    const sent = bridge.requests[0] as {
      state: string
      questions: { q1: { criteria: Record<string, string> } }
    }
    expect(sent.state).toContain('翻一遍仓库历史')
    expect(Object.keys(sent.questions.q1.criteria)).toEqual(['yes', 'no'])
    expect(warns.join('\n')).toContain('gemini:call site=dispatcher.command')
    expect(warns.join('\n')).toContain('gemini:use site=dispatcher.command taken=1')
    expect(warns.join('\n')).not.toContain('退回关键词表')
    await bridge.close()
  })

  it('桥判 yes 但置信度低于门槛 → 仍走词表（命中 git）', async () => {
    const bridge = await startBridge(replyWith(answerOf('yes', 0.7, { yes: 0.7, no: 0.3 })))
    const { run, warns } = judgeWith(bridge)
    const verdict = await run(GIT_GOAL)
    expect(verdict).toEqual({ needsCommand: true, source: 'keyword', matchedKeyword: 'git' })
    expect(warns.join('\n')).toContain('gemini:use site=dispatcher.command taken=0')
    expect(warns.join('\n')).toContain('退回关键词表')
    await bridge.close()
  })

  it('桥判 no → 仍走词表（README 不命中 → false）', async () => {
    const bridge = await startBridge(replyWith(answerOf('no', 0.95, { yes: 0.05, no: 0.95 })))
    const { run } = judgeWith(bridge)
    expect(await run(README_GOAL)).toEqual({ needsCommand: false, source: 'keyword' })
    await bridge.close()
  })

  it('桥 400 → 退回词表，日志记 gemini:fail kind=region_400', async () => {
    const bridge = await startBridge(replyWith({ error: 'region' }, 400))
    const { run, warns } = judgeWith(bridge)
    const verdict = await run(GIT_GOAL)
    expect(verdict).toEqual({ needsCommand: true, source: 'keyword', matchedKeyword: 'git' })
    expect(warns.join('\n')).toContain('gemini:fail site=dispatcher.command kind=region_400')
    await bridge.close()
  })

  it('桥超时 → 退回词表，日志记 kind=network', async () => {
    const bridge = await startBridge()
    const { run, warns } = judgeWith(bridge, {}, [])
    // 覆盖成短超时：judgeWith 的客户端固定 1000ms，这里单独建一个
    const decide = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 100 })
    const verdict = await classifyNeedsCommand(GIT_GOAL, {
      llm: () => brokenLlm() as never,
      model: 'deepseek/deepseek-flash',
      effort: 'off',
      timeoutMs: 50,
      keywords: DEFAULT_COMMAND_KEYWORDS,
      warn: (message) => warns.push(message),
      decide,
    })
    expect(verdict).toEqual({ needsCommand: true, source: 'keyword', matchedKeyword: 'git' })
    expect(warns.join('\n')).toContain('gemini:fail site=dispatcher.command kind=network ms=')
    await bridge.close()
    void run
  })

  it('模型给了结论 → 不问桥', async () => {
    const bridge = await startBridge(replyWith(answerOf('yes', 0.99, { yes: 0.99, no: 0.01 })))
    const decide = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 })
    const llm = {
      async prepareCall() {
        return {
          config: { temperature: 0 },
          async *stream() {
            yield { type: 'text-delta', text: 'NEEDS_COMMAND: no' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    }
    const verdict = await classifyNeedsCommand(README_GOAL, {
      llm: () => llm as never,
      model: 'deepseek/deepseek-flash',
      effort: 'off',
      timeoutMs: 50,
      keywords: DEFAULT_COMMAND_KEYWORDS,
      decide,
    })
    expect(verdict).toEqual({ needsCommand: false, source: 'llm' })
    expect(bridge.requests).toHaveLength(0)
    await bridge.close()
  })

  it('强信号命中 → 不问桥，也不再调模型', async () => {
    const bridge = await startBridge(replyWith(answerOf('yes', 0.99, { yes: 0.99, no: 0.01 })))
    const decide = createGeminiDecision({ enabled: true, baseUrl: bridge.baseUrl, timeoutMs: 1000 })
    const verdict = await classifyNeedsCommand(
      { goal: '这活需要执行命令：跑 npm test', brief: '跑测试' },
      {
        llm: () => {
          throw new Error('不该调模型')
        },
        model: 'deepseek/deepseek-flash',
        effort: 'off',
        timeoutMs: 50,
        keywords: DEFAULT_COMMAND_KEYWORDS,
        decide,
      },
    )
    expect(verdict).toEqual({ needsCommand: true, source: 'strong', matchedKeyword: '需要执行命令' })
    expect(bridge.requests).toHaveLength(0)
    await bridge.close()
  })
})
