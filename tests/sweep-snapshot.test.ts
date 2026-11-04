import { afterEach, describe, expect, it } from 'vitest'
import type { PromptAssemblyHook } from '../src/prompt'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'

/**
 * 巡检事实的出口是 `system-prompt/assemble` 上挂的一段动态上下文：宿主把它渲染成
 * runtime-context 快照，主会话看见的是「环境近况」，不是主人发来的消息。所以
 * 这里查两件事——主会话一条 followup 都没收到；快照里有票号，读过之后又没了。
 */

afterEach(() => {
  cleanTempDirs()
})

interface ContextSection {
  name: string
  text: string
  interpolate?: boolean
}

type Assembly = Parameters<PromptAssemblyHook>[0] & { contexts?: ContextSection[] }

/** 按宿主的方式跑一遍装配：hook 依次套，最后看上下文。 */
async function assemble(host: ReturnType<typeof mountPlugin>): Promise<Assembly> {
  let assembly: Assembly = { sections: [], tools: [], contexts: [] }
  for (const hook of host.hooks) {
    const current = assembly
    assembly = (await hook(
      current as never,
      undefined,
      async () => current as never,
    )) as Assembly
  }
  return assembly
}

async function sweepText(host: ReturnType<typeof mountPlugin>): Promise<string | undefined> {
  const assembled = await assemble(host)
  return assembled.contexts?.find((section) => section.name === 'dispatcher:sweep')?.text
}

interface Opened {
  id: string
}

async function openTicket(host: ReturnType<typeof mountPlugin>): Promise<string> {
  const opened = (await host.call('dispatch_open', {
    goal: '把巡检提醒改成动态上下文',
    brief: '改巡检',
  })) as Opened
  return opened.id
}

describe('巡检事实走快照，不走消息', () => {
  it('报告到达：主会话零 followup，快照里能看见票号', async () => {
    const host = mountPlugin()
    const main = host.agents[0]!
    const id = await openTicket(host)
    const worker = host.makeAgent('subagent')

    await host.call('dispatch_report', { id, text: '报告：改完了' }, { agent: worker })
    await host.settled()

    expect(main.messages).toHaveLength(0)
    const text = await sweepText(host)
    expect(text).toBeDefined()
    expect(text).toContain(id)
    expect(text).toContain('还没读')
    expect(text).not.toContain('dispatch_read')
  })

  it('快照只进主会话：worker 会话里不出现', async () => {
    const host = mountPlugin()
    const id = await openTicket(host)
    const worker = host.makeAgent('subagent')
    await host.call('dispatch_report', { id, text: '报告：改完了' }, { agent: worker })
    await host.settled()

    const assembly: Assembly = { sections: [], tools: [], contexts: [] }
    let surfaced: Assembly = assembly
    for (const hook of host.hooks) {
      const current = surfaced
      surfaced = (await hook(current as never, { agent: { session: worker.session } }, async () => current as never)) as Assembly
    }
    expect(surfaced.contexts?.some((section) => section.name === 'dispatcher:sweep')).toBe(false)
  })

  it('dispatch_read 读掉之后条目消失', async () => {
    const host = mountPlugin()
    const id = await openTicket(host)
    const worker = host.makeAgent('subagent')
    await host.call('dispatch_report', { id, text: '报告：改完了' }, { agent: worker })
    await host.settled()
    expect(await sweepText(host)).toContain(id)

    await host.call('dispatch_read', { id })
    await host.settled()

    expect(await sweepText(host)).toBeUndefined()
    expect(host.agents[0]!.messages).toHaveLength(0)
  })

  it('dispatch_list 看一眼也算读过', async () => {
    const host = mountPlugin()
    const id = await openTicket(host)
    const worker = host.makeAgent('subagent')
    await host.call('dispatch_report', { id, text: '报告：改完了' }, { agent: worker })
    await host.settled()
    expect(await sweepText(host)).toContain(id)

    await host.call('dispatch_list', {})
    await host.settled()

    expect(await sweepText(host)).toBeUndefined()
  })

  it('dispatch_close 收工之后条目消失', async () => {
    const host = mountPlugin()
    const id = await openTicket(host)
    const worker = host.makeAgent('subagent')
    await host.call('dispatch_report', { id, text: '报告：改完了' }, { agent: worker })
    await host.settled()
    expect(await sweepText(host)).toContain(id)

    await host.call('dispatch_close', { id, outcome: 'done' })
    await host.settled()

    expect(await sweepText(host)).toBeUndefined()
  })

  it('两次装配逐字相同，解开又合上也不抖', async () => {
    const host = mountPlugin()
    const id = await openTicket(host)
    const worker = host.makeAgent('subagent')
    await host.call('dispatch_report', { id, text: '报告：改完了' }, { agent: worker })
    await host.settled()

    const first = await sweepText(host)
    expect(first).toBeDefined()
    expect(await sweepText(host)).toBe(first)
  })
})
