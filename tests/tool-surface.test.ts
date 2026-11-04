import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_HANDOFF_POLICY } from '../src/config'
import { WORKER_FORBIDDEN_TOOLS } from '../src/index'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'

afterEach(cleanTempDirs)

const TICKET_TOOLS = [
  'dispatch_open',
  'dispatch_send',
  'dispatch_read',
  'dispatch_close',
  'dispatch_block',
  'dispatch_list',
  'dispatch_report',
]

function lines(host: { config: { stateFile: string } }): Array<Record<string, unknown>> {
  if (!existsSync(host.config.stateFile)) return []
  const text = readFileSync(host.config.stateFile, 'utf8').trim()
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : []
}

async function opened(host: ReturnType<typeof mountPlugin>, extra: Record<string, unknown> = {}) {
  const receipt = (await host.call('dispatch_open', {
    goal: '把测试补齐',
    brief: '补齐测试',
    dir: '/home/julia/dev/dsh-dispatcher',
    ...extra,
  })) as { id: string }
  return receipt.id
}

describe('工具面', () => {
  it('票工具只剩七个，progress_note 还注册着但不在白名单里', () => {
    const host = mountPlugin()
    const registered = host.names().filter((name) => name.startsWith('dispatch_'))
    expect(registered.sort()).toEqual([...TICKET_TOOLS].sort())
    expect(host.names()).toContain('progress_note')
    for (const dead of ['dispatch_touch', 'dispatch_sweep', 'dispatch_reports']) {
      expect(host.names()).not.toContain(dead)
    }
  })

  it('dispatch_open 只要 goal/brief/dir 三个参数，不暴露 workerId', () => {
    const schema = (mountPlugin().definition('dispatch_open').parameters ?? {}) as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['brief', 'dir', 'goal'])
    expect([...(schema.required ?? [])].sort()).toEqual(['brief', 'goal'])
  })

  it('worker 禁表：六个 router 票工具加 progress_note，只留 report', () => {
    expect([...WORKER_FORBIDDEN_TOOLS].sort()).toEqual(
      ['dispatch_open', 'dispatch_send', 'dispatch_read', 'dispatch_close', 'dispatch_block', 'dispatch_list', 'progress_note'].sort(),
    )
    expect(WORKER_FORBIDDEN_TOOLS).not.toContain('dispatch_report')
  })
})

describe('开票', () => {
  it('没配默认档、注册表也没给默认：直接报错，一张票都不写', async () => {
    const host = mountPlugin({
      config: { defaultPreset: '' },
      services: {
        agentPresets: { list: async () => [{ id: 't1', name: '常规' }], defaultId: undefined },
      },
    })
    await expect(host.call('dispatch_open', { goal: '随便干点', brief: '随便' })).rejects.toThrow(/没有可用档位/)
    expect(lines(host)).toHaveLength(0)
  })

  it('同一请求再开一次：回同一张票，不重复发布、不再起小鱼', async () => {
    const host = mountPlugin()
    const first = (await host.call('dispatch_open', {
      goal: '整理日志',
      brief: '整理日志',
      dir: '/tmp',
    })) as { id: string }
    const again = (await host.call('dispatch_open', {
      goal: '整理日志',
      brief: '整理日志',
      dir: '/tmp',
    })) as { id: string; duplicate?: string }

    expect(again.id).toBe(first.id)
    expect(again.duplicate).toBeDefined()
    expect(lines(host).filter((line) => line.kind === 'published')).toHaveLength(1)
    expect(host.subagents.spawned).toHaveLength(1)
  })

  it('收工的票再 send：拒绝，日志一字节不改', async () => {
    const host = mountPlugin()
    const id = await opened(host)
    await host.call('dispatch_close', { id, outcome: 'done' })
    const before = lines(host).length

    await expect(host.call('dispatch_send', { id, text: '还能加一句吗' })).rejects.toThrow(/已收工，要接着干就开新票/)
    expect(lines(host)).toHaveLength(before)
  })
})

describe('报告与读票', () => {
  it('dispatch_report 只追加一行，票状态不动', async () => {
    const host = mountPlugin()
    const id = await opened(host)
    const statusBefore = (await host.call('dispatch_list', {})) as { tickets: Array<{ id: string; status: string }> }
    const before = statusBefore.tickets.find((ticket) => ticket.id === id)!.status

    const receipt = (await host.call('dispatch_report', { id, text: '做到一半，卡在权限上' })) as {
      id: string
      epoch: number
      pendingReports: number
    }
    expect(receipt).toMatchObject({ id, epoch: 1, pendingReports: 1 })
    const after = (await host.call('dispatch_list', {})) as { tickets: Array<{ id: string; status: string }> }
    expect(after.tickets.find((ticket) => ticket.id === id)!.status).toBe(before)
  })

  it('dispatch_read 读一次就标 delivered，第二次没有新东西', async () => {
    const host = mountPlugin()
    const id = await opened(host)
    await host.call('dispatch_report', { id, text: '交付清单' })

    const first = (await host.call('dispatch_read', {})) as { returned: number; markedRead: number }
    expect(first).toMatchObject({ returned: 1, markedRead: 1 })

    const second = (await host.call('dispatch_read', {})) as { returned: number; markedRead: number }
    expect(second).toMatchObject({ returned: 0, markedRead: 0 })

    const listed = (await host.call('dispatch_list', {})) as { tickets: Array<{ id: string; pendingReports: number }> }
    expect(listed.tickets.find((ticket) => ticket.id === id)!.pendingReports).toBe(0)
  })
})

describe('交接说明', () => {
  it('默认交接文本写明：开票一步到位、交活自动、收工票不收消息', () => {
    expect(DEFAULT_HANDOFF_POLICY).toContain('dispatch_open 一步到位')
    expect(DEFAULT_HANDOFF_POLICY).toContain('交活是自动的')
    expect(DEFAULT_HANDOFF_POLICY).toContain('要接着干就开新票')
    expect(DEFAULT_HANDOFF_POLICY).toContain('dispatch_report')
    expect(DEFAULT_HANDOFF_POLICY).not.toContain('dispatch_touch')
  })
})
