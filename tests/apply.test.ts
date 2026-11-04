import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER_TOOLS, DEFAULT_WORKER_DENY_TOOLS } from '../src/config'
import type { Config } from '../src/config'
import { WORKER_FORBIDDEN_TOOLS, apply } from '../src/index'
import { cleanTempDirs, fakePluginHost, testConfig } from './helpers/plugin-harness'

afterEach(cleanTempDirs)

const DISPATCH_TOOLS = DEFAULT_ROUTER_TOOLS.filter((name) => name.startsWith('dispatch_'))
/** 本包注册的工具：七个票工具 + progress_note。 */
const OWN_TOOLS = [...DISPATCH_TOOLS, 'progress_note']
/** 白名单里由别的插件注册的那些名字。 */
const FOREIGN_TOOLS = DEFAULT_ROUTER_TOOLS.filter((name) => !OWN_TOOLS.includes(name))

function mount(options: { registered?: string[]; existingAgents?: number } = {}, overrides: Partial<Config> = {}) {
  const host = fakePluginHost(options)
  apply(host.ctx as never, testConfig(overrides))
  return host
}

describe('apply', () => {
  // 热重载时旧注册已经撤掉、新注册还没落地，先装白名单会让自检把本插件自己的
  // dispatch_* 当「错名」扔掉，主会话随即少七个工具。
  it('registers its own tools before it installs the whitelist', () => {
    const host = mount({ registered: [...FOREIGN_TOOLS] })

    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
    // 票面六个名字全在白名单里；progress_note 注册了但主会话拿不到（P4 删）。
    for (const name of DISPATCH_TOOLS) expect(host.restricted[0]).toContain(name)
    expect(host.restricted[0]).not.toContain('progress_note')
    expect(host.names()).toContain('progress_note')
    expect(host.warnings.join('\n')).not.toMatch(/no registered global tool/)

    let lastRegister = -1
    host.changes.forEach((event, index) => {
      if (event.startsWith('register:')) lastRegister = index
    })
    expect(lastRegister).toBeGreaterThanOrEqual(0)
    expect(host.changes.indexOf('restrict')).toBeGreaterThan(lastRegister)
  })

  it('covers a session created after load with the same full list', () => {
    const host = mount({ registered: [...FOREIGN_TOOLS], existingAgents: 0 })

    expect(host.restricted).toEqual([])
    expect(host.createdListeners.length).toBeGreaterThan(0)
    for (const listener of host.createdListeners) listener({ agent: host.makeAgent() })
    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
  })

  // 2026-11-01 的规矩：只有主会话写记忆。dsh-memory 在 execute 里拦，这一层是
  // 上面那层——名字根本不进小鱼的 schema。
  it('hides the memory-write tools from a worker and from nobody else', () => {
    const host = mount({ registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 })

    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
    expect(host.denied).toEqual([])

    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })

    expect(host.denied).toEqual([[...DEFAULT_WORKER_DENY_TOOLS, ...WORKER_FORBIDDEN_TOOLS]])
    expect(host.restricted).toHaveLength(1)
    expect(host.infos.join('\n')).toContain(
      `worker subagents hide ${DEFAULT_WORKER_DENY_TOOLS.length + WORKER_FORBIDDEN_TOOLS.length}`,
    )
  })

  // 小鱼手上只留 dispatch_report：开票、发话、读票、关票、挂起、列表、打点都拿走，
  // 而且不因为 operator 改了 workerDenyTools 就放回去。
  it('keeps the ticket tools away from a worker whatever the config says', () => {
    const host = mount(
      { registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 },
      { workerDenyTools: ['memory_save'] },
    )

    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
    for (const name of DISPATCH_TOOLS) expect(host.restricted[0]).toContain(name)
    expect(host.restricted[0]).not.toContain('progress_note')

    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })
    expect(host.denied).toHaveLength(1)
    for (const name of WORKER_FORBIDDEN_TOOLS) expect(host.denied[0]).toContain(name)
    expect(host.denied[0]).toContain('memory_save')
    expect(host.denied[0]).not.toContain('dispatch_report')
  })

  // 两个开关两条规矩：收窄主会话和拿走小鱼的记忆写权限不是同一件事。
  it('applies the worker deny list even when the main whitelist is off', () => {
    const host = mount(
      { registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 },
      { routerRestrict: false },
    )

    expect(host.restricted).toEqual([])
    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })
    expect(host.denied).toEqual([[...DEFAULT_WORKER_DENY_TOOLS, ...WORKER_FORBIDDEN_TOOLS]])
  })

  it('leaves the worker alone when workerToolDeny is off', () => {
    const host = mount(
      { registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 },
      { workerToolDeny: false },
    )

    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })
    expect(host.denied).toEqual([])
    expect(host.restricted).toEqual([[...DEFAULT_ROUTER_TOOLS]])
  })

  it('trims the worker prompt even when workerToolDeny is off', () => {
    const host = mount(
      { registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 },
      { workerToolDeny: false },
    )
    const before = host.hooks.length

    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })
    expect(host.denied).toEqual([])
    expect(host.hooks.length - before).toBe(1)
  })

  it('leaves the worker prompt alone when workerPromptPrune is off', () => {
    const host = mount(
      { registered: [...FOREIGN_TOOLS, ...DEFAULT_WORKER_DENY_TOOLS], existingAgents: 1 },
      { workerPromptPrune: false },
    )
    const before = host.hooks.length

    for (const listener of host.createdListeners) listener({ agent: host.makeAgent('subagent') })
    expect(host.denied).toEqual([[...DEFAULT_WORKER_DENY_TOOLS, ...WORKER_FORBIDDEN_TOOLS]])
    expect(host.hooks.length).toBe(before)
  })

  // 别的插件注册得比本插件晚：第一遍看不见，靠 tools/change 补装。
  it('adds a tool that registers after the whitelist went on', () => {
    const late = FOREIGN_TOOLS[0]!
    const host = mount({ registered: FOREIGN_TOOLS.filter((name) => name !== late) })

    expect(host.restricted).toHaveLength(1)
    expect(host.restricted[0]).not.toContain(late)
    expect(host.warnings.join('\n')).toContain(late)

    ;(host.ctx.tools as { register: (definition: { name: string }) => unknown }).register({ name: late })

    expect(host.restricted).toHaveLength(2)
    expect(host.restricted[1]).toEqual([...DEFAULT_ROUTER_TOOLS])
    expect(host.infos.join('\n')).toContain(late)
    expect(host.restricted[1]).not.toContain('ghost_tool')
  })

  // 七个票工具的名字就是最终面：没有 touch / sweep / reports，也没有旧名。
  it('registers exactly the seven ticket tools plus progress_note', () => {
    const host = mount({ registered: [...FOREIGN_TOOLS] })
    const dispatch = host.names().filter((name) => name.startsWith('dispatch_')).sort()
    expect(dispatch).toEqual([
      'dispatch_block',
      'dispatch_close',
      'dispatch_list',
      'dispatch_open',
      'dispatch_read',
      'dispatch_report',
      'dispatch_send',
    ])
  })
})
