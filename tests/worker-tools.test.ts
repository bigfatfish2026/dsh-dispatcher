import { describe, expect, it } from 'vitest'
import { WorkerTicketTools } from '../src/tickets/worker-tools'

/**
 * 三个票工具按 agent 层装的那一道：档位的 allow 名单再窄，子会话手上也得有
 * declare / report / touch；反过来 `write` / `edit` / `bash` 一件都不许多。
 *
 * 假 agent 照宿主的两口做：`register` 按名字往这一层塞、重名就抛（跟
 * `ToolRuntime.register` 一样）；`restrict` 只记滤镜。可见面按 dsh-tools 的
 * 语义算：**restrictions intersect 只滤镜全局那一层，scoped 注册不受影响**
 * （`lib/index.js`: 「Scoped tools shadow globals」「Scoped registrations remain
 * visible」），所以这里先按 allow 滤镜全局，再把 scoped 的名字并回来。
 */

const DEFINITIONS = [
  { name: 'dispatch_declare' },
  { name: 'dispatch_report' },
  { name: 'dispatch_touch' },
]

/** t2：只读档的 allow 名单，跟真档位一样窄。 */
const T2_ALLOW = ['read', 'glob', 'grep']

const GLOBALS = ['read', 'glob', 'grep', 'write', 'edit', 'bash', 'dispatch_open', 'dispatch_send']

function fakeAgent(id = 'worker-1') {
  const scoped = new Map<string, unknown>()
  const filters: Array<{ allow?: string[]; deny?: string[] }> = []
  const agent = {
    id,
    session: { id },
    ctx: {
      tools: {
        register(definition: never) {
          const name = (definition as { name: string }).name
          if (scoped.has(name)) throw new Error(`${name} is already registered in this scope`)
          scoped.set(name, definition)
          return () => {
            scoped.delete(name)
          }
        },
        restrict(filter: { allow?: string[]; deny?: string[] }) {
          filters.push(filter)
          return () => {}
        },
      },
    },
  }
  /** 这一层最后能看见的工具面。 */
  const visible = (): string[] => {
    let globals = [...GLOBALS]
    for (const filter of filters) {
      if (filter.allow) globals = globals.filter((name) => filter.allow!.includes(name))
      if (filter.deny) globals = globals.filter((name) => !filter.deny!.includes(name))
    }
    return [...new Set([...globals, ...scoped.keys()])].sort()
  }
  return { agent, scoped, filters, visible }
}

describe('WorkerTicketTools：按 agent 层装三个票工具', () => {
  it('只读档的 allow 名单里一件票工具都没有，子会话手上照样有 declare / report / touch', () => {
    const { agent, filters, visible } = fakeAgent()
    // 档位插件先把 allow 名单压到这一层（真宿主里是 setAgentPreset 干的）。
    agent.ctx.tools.restrict({ allow: T2_ALLOW })
    expect(filters).toHaveLength(1)

    const tools = new WorkerTicketTools({ definitions: DEFINITIONS })
    expect(tools.attach(agent)).toBe(true)

    const names = visible()
    for (const name of ['dispatch_declare', 'dispatch_report', 'dispatch_touch']) {
      expect(names).toContain(name)
    }
    // 只读性质不破：写文件、改文件、跑命令一件都进不来。
    for (const name of ['write', 'edit', 'bash']) {
      expect(names).not.toContain(name)
    }
  })

  it('同一个 worker 只装一次：重名在宿主那一层就抛，所以第二次 attach 直接返回 false', () => {
    const { agent, scoped } = fakeAgent()
    let registers = 0
    const original = agent.ctx.tools.register
    agent.ctx.tools.register = (definition: never) => {
      registers += 1
      return original(definition)
    }

    const tools = new WorkerTicketTools({ definitions: DEFINITIONS })
    expect(tools.attach(agent)).toBe(true)
    expect(tools.attach(agent)).toBe(false)

    expect(registers).toBe(3)
    expect([...scoped.keys()].sort()).toEqual([
      'dispatch_declare',
      'dispatch_report',
      'dispatch_touch',
    ])
    expect(tools.has('worker-1')).toBe(true)
  })

  it('宿主没给 ctx.tools.register：喊一声、返回 false，不把派活带崩', () => {
    const warnings: string[] = []
    const tools = new WorkerTicketTools({
      definitions: DEFINITIONS,
      warn: (message) => warnings.push(message),
    })

    expect(tools.attach({ id: 'worker-9', ctx: {} } as never)).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('worker-9')
    expect(warnings[0]).toContain('ctx.tools.register')
  })

  it('detach 收回注册，之后能重装（热重载/会话收掉那一刀）', () => {
    const { agent, scoped, visible } = fakeAgent()
    agent.ctx.tools.restrict({ allow: T2_ALLOW })

    const tools = new WorkerTicketTools({ definitions: DEFINITIONS })
    tools.attach(agent)
    expect(visible()).toContain('dispatch_touch')

    expect(tools.detach('worker-1')).toBe(true)
    expect(scoped.size).toBe(0)
    expect(visible()).not.toContain('dispatch_touch')

    expect(tools.attach(agent)).toBe(true)
    expect(visible()).toContain('dispatch_touch')
  })

  it('按 workerId 装：活表里还没有这只就安安静静放过（agent/created 那一刀会补）', () => {
    const { agent } = fakeAgent()
    const warnings: string[] = []
    const tools = new WorkerTicketTools({
      definitions: DEFINITIONS,
      warn: (message) => warnings.push(message),
    })
    const table = new Map<string, unknown>()

    expect(tools.attachById('worker-1', () => ({ get: (id) => table.get(id) }))).toBe(false)
    expect(warnings).toHaveLength(0)

    table.set('worker-1', agent)
    expect(tools.attachById('worker-1', () => ({ get: (id) => table.get(id) }))).toBe(true)
    expect(tools.has('worker-1')).toBe(true)
  })

  it('detachAll 一把收回（台子收起）', () => {
    const first = fakeAgent('worker-1')
    const second = fakeAgent('worker-2')
    const tools = new WorkerTicketTools({ definitions: DEFINITIONS })
    tools.attach(first.agent)
    tools.attach(second.agent)
    expect(tools.size).toBe(2)

    tools.detachAll()
    expect(tools.size).toBe(0)
    expect(first.scoped.size).toBe(0)
    expect(second.scoped.size).toBe(0)
  })
})
