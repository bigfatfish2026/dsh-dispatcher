import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER_TOOLS } from '../src/config'
import { apply } from '../src/index'
import { cleanTempDirs, fakePluginHost, testConfig } from './helpers/plugin-harness'

afterEach(cleanTempDirs)

/**
 * 装一遍插件，给一个只回答「这条会话的 ctx 挂了哪档」的假注册表。
 * `existingAgents: 0` 让装载那一刻没有活会话，restrict 的两个入口都只剩
 * `agent/created`，测的就是新判据本身。
 */
function mount(presetOf: (agentCtx: unknown) => string | undefined, extra: { registered?: string[] } = {}) {
  const host = fakePluginHost({
    registered: [...DEFAULT_ROUTER_TOOLS, ...(extra.registered ?? [])],
    existingAgents: 0,
    services: { agentPresets: { composedPreset: presetOf } },
  })
  apply(host.ctx as never, testConfig())
  return host
}

describe('有档的会话由档里 toolset 定工具面', () => {
  it('挂了档的主会话不装 router allow', () => {
    let presetCtx: unknown
    const host = mount((agentCtx) => (agentCtx === presetCtx ? 't1' : undefined))
    const agent = host.makeAgent()
    presetCtx = agent.ctx

    host.emit('agent/created', { agent })

    expect(host.restricted).toEqual([])
    expect(host.denied).toEqual([])
    expect(host.changes).not.toContain('restrict')
  })

  it('挂了档的 worker 也不挂 worker deny：那一档就是上限', () => {
    let presetCtx: unknown
    const host = mount((agentCtx) => (agentCtx === presetCtx ? 't0' : undefined))
    const agent = host.makeAgent('subagent')
    presetCtx = agent.ctx

    host.emit('agent/created', { agent })

    expect(host.restricted).toEqual([])
    expect(host.denied).toEqual([])
  })

  it('没挂档的会话仍装 router allow，行为不变', () => {
    const host = mount(() => undefined)
    const agent = host.makeAgent()

    host.emit('agent/created', { agent })

    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
    expect(host.denied).toEqual([])
  })

  it('挂了档的会话工具面不动，但提示段照样裁', async () => {
    // 档定工具面；段是全局注册的，档没给的工具有一段照样在提示词里，所以要剥。
    const registered = ['bash', 'dispatch_open']
    let presetCtx: unknown
    const host = mount((agentCtx) => (agentCtx === presetCtx ? 't1' : undefined), { registered })
    const agent = host.makeAgent()
    presetCtx = agent.ctx

    // 插件级还有 handoff / worker-prompt 两条钩子，只看这一只会话新挂了几条。
    const before = host.hooks.length
    host.emit('agent/created', { agent })

    expect(host.restricted).toEqual([])
    expect(host.denied).toEqual([])
    expect(host.hooks.length - before).toBe(1)
    const promptHook = host.hooks[host.hooks.length - 1]

    const assembly = {
      tools: [{ name: 'bash' }, { name: 'browser_navigate' }, { name: 'bili_notify_unread' }],
      sections: [
        { name: 'tool:bash', text: 'Check the [exit code: N] marker on every bash result.' },
        { name: 'tool:browser', text: 'Use the browser tools (browser_navigate, browser_snapshot).' },
        { name: 'tool:bili-notify', text: "bili_notify_unread read the account's notifications." },
        { name: 'deployment:persona-prefix', text: '你是小鱼。' },
      ],
    }
    const pruned = await promptHook(assembly, {}, async () => assembly)
    expect(pruned.sections.map((section: { name: string }) => section.name)).toEqual(['tool:bash', 'deployment:persona-prefix'])
  })

  it('同一只会话连着来两次只挂一遍裁剪', () => {
    let presetCtx: unknown
    const host = mount((agentCtx) => (agentCtx === presetCtx ? 't1' : undefined))
    const agent = host.makeAgent()
    presetCtx = agent.ctx

    const before = host.hooks.length
    host.emit('agent/created', { agent })
    host.emit('agent/created', { agent })

    expect(host.hooks.length - before).toBe(1)
  })

  it('没挂档的 worker 仍只挂 worker deny', () => {
    const host = mount(() => undefined)
    const agent = host.makeAgent('subagent')

    host.emit('agent/created', { agent })

    expect(host.restricted).toEqual([])
    expect(host.denied).toHaveLength(1)
  })
})
