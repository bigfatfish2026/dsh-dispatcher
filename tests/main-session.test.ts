import { afterEach, describe, expect, it } from 'vitest'
import { createWake } from '../src/installers/desk'
import {
  createMainSessionFilter,
  qqbotScopeOfSessionKey,
} from '../src/tickets/main-session'
import type { QqbotPrefsLike } from '../src/tickets/main-session'
import type { PromptAssemblyHook } from '../src/prompt'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'

/**
 * 巡检只进主会话：宿主 header 分不出群聊，判据落在 qqbot 的会话键上——
 * `qqbot:<appId>:<c2c|group>:<peerId>`，映射从 `qqbot/prefs` 服务的
 * `payload().sessionIds` 反查。这里守住三件事：
 *
 * - 会话键解析只认 `c2c` / `group` 那一段；
 * - 群聊会话不注入快照、不收唤醒，并且留 debug 一行；
 * - 主会话的未读报告提醒照旧，非 qqbot 部署不被误伤。
 */

afterEach(() => {
  cleanTempDirs()
})

const C2C_ID = 'session-bf215eaa-9a74-4989-9c0a-070323bf5ccf'
const GROUP_ID = 'session-ea5fe7b6-09e0-4f86-be3b-5fe344139d75'
const GROUP_KEY = 'qqbot:1905918172:group:BD816D36C5D621AB29FFB148BC33A175'
const C2C_KEY = 'qqbot:1905918172:c2c:64532D871A10E466D163FD001524AD83'

function fakePrefs(sessionIds: Record<string, string>): QqbotPrefsLike {
  return { payload: () => ({ sessionIds }) }
}

describe('会话键解析', () => {
  it('认 qqbot 的 c2c / group 段', () => {
    expect(qqbotScopeOfSessionKey(C2C_KEY)).toBe('c2c')
    expect(qqbotScopeOfSessionKey(GROUP_KEY)).toBe('group')
  })

  it('不是 qqbot 键、或者格式不全的，一律判不出来', () => {
    expect(qqbotScopeOfSessionKey('session-bf215eaa')).toBeUndefined()
    expect(qqbotScopeOfSessionKey('qqbot:1905918172')).toBeUndefined()
    expect(qqbotScopeOfSessionKey('qqbot:1905918172:unknown:peer')).toBeUndefined()
    // peerId 里带冒号不影响取第三段。
    expect(qqbotScopeOfSessionKey('qqbot:1:c2c:a:b')).toBe('c2c')
  })
})

describe('主会话判据', () => {
  const prefs = () => fakePrefs({ [C2C_KEY]: C2C_ID, [GROUP_KEY]: GROUP_ID })

  it('群聊会话判掉，原因说清', () => {
    const filter = createMainSessionFilter({ prefs })
    const group = { session: { id: GROUP_ID, header: {} } }
    expect(filter.allows(group)).toBe(false)
    expect(filter.verdict(group)).toEqual({ main: false, reason: 'qqbot-group', sessionId: GROUP_ID })
  })

  it('私聊会话与判不出来的非 qqbot 会话都放行', () => {
    const filter = createMainSessionFilter({ prefs })
    expect(filter.allows({ session: { id: C2C_ID, header: {} } })).toBe(true)
    // qqbot 映射表里没有这张：终端 / headless 会话，按主会话。
    expect(filter.allows({ session: { id: 'session-terminal', header: {} } })).toBe(true)
    // 没有 qqbot 服务（非 qqbot 部署）不能因此把巡检关掉。
    expect(createMainSessionFilter().allows({ session: { id: 'session-any' } })).toBe(true)
  })

  it('子会话一律判掉；宿主没给 agent 时按主会话放行', () => {
    const filter = createMainSessionFilter({ prefs })
    expect(filter.allows({ session: { id: 'worker-1', header: { origin: 'subagent' } } })).toBe(false)
    expect(filter.allows(undefined)).toBe(true)
  })

  it('跳过留 debug 一行；同一会话同一原因只记一次', () => {
    const lines: string[] = []
    const filter = createMainSessionFilter({ prefs, debug: (message) => lines.push(message) })
    const group = { session: { id: GROUP_ID, header: {} } }
    filter.allows(group)
    filter.allows(group)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(GROUP_ID)
    expect(lines[0]).toContain('群聊')
    // 放行的会话不记。
    filter.allows({ session: { id: C2C_ID, header: {} } })
    expect(lines).toHaveLength(1)
  })
})

interface ContextSection {
  name: string
  text: string
  interpolate?: boolean
}

type Assembly = Parameters<PromptAssemblyHook>[0] & { contexts?: ContextSection[] }

/** 按宿主的方式跑一遍装配，agent 由调用方给（真宿主装配时一定带 agent）。 */
async function assemble(
  host: ReturnType<typeof mountPlugin>,
  agent: { session: { id: string; header: Record<string, unknown> } },
): Promise<Assembly> {
  let assembly: Assembly = { sections: [], tools: [], contexts: [] }
  for (const hook of host.hooks) {
    const current = assembly
    assembly = (await hook(current as never, { agent } as never, async () => current as never)) as Assembly
  }
  return assembly
}

async function sweepText(
  host: ReturnType<typeof mountPlugin>,
  agent: { session: { id: string; header: Record<string, unknown> } },
): Promise<string | undefined> {
  const assembled = await assemble(host, agent)
  return assembled.contexts?.find((section) => section.name === 'dispatcher:sweep')?.text
}

describe('巡检快照只进主会话', () => {
  it('群聊会话不注入，主会话照旧看见未读报告', async () => {
    const host = mountPlugin({
      existingAgents: 0,
      services: { 'qqbot/prefs': fakePrefs({ [C2C_KEY]: C2C_ID, [GROUP_KEY]: GROUP_ID }) },
    })
    const main = host.makeAgent(undefined, C2C_ID)
    const group = host.makeAgent(undefined, GROUP_ID)
    host.agents.push(main, group)

    const opened = (await host.call('dispatch_open', {
      goal: '把巡检提醒改成动态上下文',
      brief: '改巡检',
    }, { agent: main })) as { id: string }
    const worker = host.makeAgent('subagent', 'worker-1')
    await host.call('dispatch_report', { id: opened.id, text: '报告：改完了' }, { agent: worker })
    await host.settled()

    expect(await sweepText(host, main)).toContain(opened.id)
    expect(await sweepText(host, group)).toBeUndefined()
    // 群聊会话一个 followup 都不该收。
    expect(group.messages).toHaveLength(0)
  })

  it('宿主没给 qqbot 服务时照旧注入（非 qqbot 部署）', async () => {
    const host = mountPlugin({ existingAgents: 0 })
    const main = host.makeAgent(undefined, 'session-terminal')
    host.agents.push(main)
    const opened = (await host.call('dispatch_open', {
      goal: '把巡检提醒改成动态上下文',
      brief: '改巡检',
    }, { agent: main })) as { id: string }
    const worker = host.makeAgent('subagent', 'worker-1')
    await host.call('dispatch_report', { id: opened.id, text: '报告：改完了' }, { agent: worker })
    await host.settled()
    expect(await sweepText(host, main)).toContain(opened.id)
  })
})

interface WakeAgent {
  session?: { id?: string; header?: { origin?: string } }
  followup?: (message: unknown) => Promise<unknown>
}

function wakeAgent(id: string, messages: string[]): WakeAgent {
  return {
    session: { id, header: {} },
    async followup(message) {
      const text = (message as { content?: Array<{ text?: string }> }).content?.[0]?.text
      if (text) messages.push(text)
      return { id: `msg-${messages.length}` }
    },
  }
}

describe('巡检唤醒只找主会话', () => {
  it('列表里群聊在前也只投给主会话，跳过留 debug', async () => {
    const lines: string[] = []
    const filter = createMainSessionFilter({
      prefs: () => fakePrefs({ [C2C_KEY]: C2C_ID, [GROUP_KEY]: GROUP_ID }),
      debug: (message) => lines.push(message),
    })
    const groupMessages: string[] = []
    const mainMessages: string[] = []
    const group = wakeAgent(GROUP_ID, groupMessages)
    const main = wakeAgent(C2C_ID, mainMessages)
    const wake = createWake(() => ({ list: () => [group, main] }), filter)

    expect(await wake('[sweep] 票 t-x 该看一眼了')).toBe(true)
    expect(groupMessages).toHaveLength(0)
    expect(mainMessages).toHaveLength(1)
    expect(mainMessages[0]).toContain('t-x')
    expect(lines.some((line) => line.includes('群聊'))).toBe(true)
  })

  it('指名的群聊会话送不进去就回落主会话，不吞话', async () => {
    const filter = createMainSessionFilter({
      prefs: () => fakePrefs({ [C2C_KEY]: C2C_ID, [GROUP_KEY]: GROUP_ID }),
    })
    const groupMessages: string[] = []
    const mainMessages: string[] = []
    const group = wakeAgent(GROUP_ID, groupMessages)
    const main = wakeAgent(C2C_ID, mainMessages)
    const wake = createWake(() => ({ list: () => [group, main] }), filter)

    expect(await wake('[sweep] 放行', GROUP_ID)).toBe(true)
    expect(groupMessages).toHaveLength(0)
    expect(mainMessages).toEqual(['[sweep] 放行'])
  })

  it('活表里只有群聊会话时不投，返回 false', async () => {
    const filter = createMainSessionFilter({
      prefs: () => fakePrefs({ [GROUP_KEY]: GROUP_ID }),
    })
    const groupMessages: string[] = []
    const wake = createWake(() => ({ list: () => [wakeAgent(GROUP_ID, groupMessages)] }), filter)

    expect(await wake('[sweep] 票 t-x 该看一眼了')).toBe(false)
    expect(groupMessages).toHaveLength(0)
  })
})
