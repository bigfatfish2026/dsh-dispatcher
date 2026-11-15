import { describe, expect, it } from 'vitest'
import { installPromptGuard } from '../src/installers/prompt'

type Handler = (payload: unknown) => unknown

/**
 * `ToolsService.guard()` 内部要读 `this.guards`。如果安装器把方法拆成裸函数再调，
 * `this` 就丢了，宿主会抛 "Cannot read properties of undefined (reading 'guards')"。
 * 这条用例用一个同样依赖 this 的假服务守住调用方式。
 */
function fakeTools(calls: string[]): {
  guard: (fn: (execution: { name: string; arguments: unknown }) => string | undefined) => () => void
} {
  const tools = {
    guard(_fn: (execution: { name: string; arguments: unknown }) => string | undefined): () => void {
      if (this !== tools) throw new TypeError("Cannot read properties of undefined (reading 'guards')")
      calls.push('guard')
      return () => calls.push('stop')
    },
  }
  return tools
}

function fakeContext(handlers: Map<string, Handler>): unknown {
  return {
    on(event: string, handler: Handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect() {
      return () => {}
    },
  }
}

describe('installPromptGuard 的等待守卫', () => {
  it('从 tools 服务上调用 guard，不丢 this', () => {
    const calls: string[] = []
    const handlers = new Map<string, Handler>()
    const effects: Array<() => () => void> = []
    const tools = fakeTools(calls)
    const agent = {
      session: { header: { origin: 'main' } },
      ctx: {
        tools,
        effect(callback: () => () => void) {
          effects.push(callback)
          return () => {}
        },
      },
    }

    expect(() =>
      installPromptGuard(
        fakeContext(handlers) as never,
        { noWaitGuard: true, handoffPolicy: false, maxCommandMs: 30_000, maxWaitMs: 5_000 } as never,
        { sweepFacts: { text: () => '' }, info: () => {}, agents: () => ({ list: () => [agent] }) },
      ),
    ).not.toThrow()
    expect(calls).toEqual(['guard'])
    expect(effects).toHaveLength(1)
  })

  it('新建会话也走同一个调用路径', () => {
    const calls: string[] = []
    const handlers = new Map<string, Handler>()
    const agent = {
      session: { header: { origin: 'main' } },
      ctx: {
        tools: fakeTools(calls),
        effect() {
          return () => {}
        },
      },
    }

    installPromptGuard(
      fakeContext(handlers) as never,
      { noWaitGuard: true, handoffPolicy: false, maxCommandMs: 30_000, maxWaitMs: 5_000 } as never,
      { sweepFacts: { text: () => '' }, info: () => {}, agents: () => ({ list: () => [] }) },
    )
    handlers.get('agent/created')?.({ agent })

    expect(calls).toEqual(['guard'])
  })
})
