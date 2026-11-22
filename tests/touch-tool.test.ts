import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { intentPlanLines } from '../src/index'
import { TicketStore } from '../src/store'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'
import type { FakePluginHost } from './helpers/plugin-harness'

const BASE = '/srv/work/dsh-dispatcher'
const SRC = `${BASE}/src/index.ts`
const REDUCER = `${BASE}/src/store/reducer.ts`
const EVENTS = `${BASE}/src/store/events.ts`

const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  cleanTempDirs()
})

const T = (seconds: number): string => new Date(Date.UTC(2026, 11, 13, 0, 0, seconds)).toISOString()

function logFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatcher-touch-'))
  dirs.push(dir)
  const file = join(dir, 'tickets.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

function rows(file: string): Array<Record<string, unknown>> {
  const text = readFileSync(file, 'utf8').trim()
  return text ? text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) : []
}

/** 一张已派出子会话的执行票：声明了 src/index.ts 与 tests 目录。 */
function touchTicket(status?: 'done' | 'dropped', reads?: string[]): string {
  return logFile([
    {
      kind: 'published',
      id: 't-touch',
      at: T(0),
      goal: '收尾自报实际碰过的文件',
      brief: '收尾自报',
      publisher: 'session-main',
      preset: 't1',
      presetSource: 'fallback',
      requestId: 'req-touch-1',
      intent: {
        writes: [`file:${SRC}`, `dir:${BASE}/tests`],
        ...(reads?.length ? { reads } : {}),
        reversibility: 'auto',
      },
    },
    { kind: 'spawned', id: 't-touch', at: T(1), cause: 'tool', workerId: 'worker-touch-1', preset: 't1' },
    ...(status ? [{ kind: 'closed', id: 't-touch', at: T(2), cause: 'tool', outcome: status }] : []),
  ])
}

type Call = (name: string, args: Record<string, unknown>, options?: { agent?: unknown }) => Promise<unknown>

function mount(file: string, config: Record<string, unknown> = {}): { host: FakePluginHost; call: Call } {
  const host = mountPlugin({ config: { stateFile: file, ...config } })
  return { host, call: (name, args, options) => host.call(name, args, options as never) }
}

function worker(host: FakePluginHost, id: string): unknown {
  return host.makeAgent('subagent', id)
}

/** 跑工具的 output.render：模型看到的就是这一段文本。 */
function render(host: FakePluginHost, name: string, args: Record<string, unknown>, value: unknown): string {
  const output = host.definition(name).output as {
    render?: (args: Record<string, unknown>, value: unknown) => Array<{ type: string; text: string }>
  }
  return (output.render?.(args, value) ?? []).map((block) => block.text).join('\n')
}

describe('dispatch_touch', () => {
  it('正常写入：裸路径补 file:，声明里的前缀原样吃，事件与快照都对得上', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)

    const output = (await call(
      'dispatch_touch',
      { paths: [SRC, `file:${EVENTS}`] },
      { agent: worker(host, 'worker-touch-1') },
    )) as { id: string; paths: number; total: number }
    expect(output).toMatchObject({ id: 't-touch', paths: 2, total: 2 })

    const written = rows(file).at(-1)!
    expect(written.kind).toBe('touch-reported')
    expect(written.id).toBe('t-touch')
    expect(written.workerId).toBeUndefined()
    expect(written.paths).toEqual([`file:${SRC}`, `file:${EVENTS}`])

    const snapshot = new TicketStore(file).get('t-touch')!
    expect(snapshot.touched).toEqual([`file:${SRC}`, `file:${EVENTS}`])
    expect(snapshot.status).toBe('running')
  })

  it('多次 touch 合并去重，不会只剩最后一批', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')

    await call('dispatch_touch', { paths: [SRC] }, { agent })
    const second = (await call(
      'dispatch_touch',
      { paths: [REDUCER, SRC] },
      { agent },
    )) as { paths: number; total: number }
    expect(second).toMatchObject({ paths: 2, total: 2 })

    const snapshot = new TicketStore(file).get('t-touch')!
    expect(snapshot.touched).toEqual([`file:${SRC}`, `file:${REDUCER}`])
  })

  it('别人的票拒绝：票挂在 worker-touch-1 上，别的 worker 写不进去', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const before = rows(file).length

    await expect(
      call('dispatch_touch', { paths: [SRC] }, { agent: worker(host, 'worker-other-1') }),
    ).rejects.toThrow('没有挂在这个 worker 上的票')
    expect(rows(file)).toHaveLength(before)
    expect(new TicketStore(file).get('t-touch')!.touched).toBeUndefined()
  })

  it('票已结束时拒绝：done / dropped 都不许再报', async () => {
    for (const status of ['done', 'dropped'] as const) {
      const file = touchTicket(status)
      const { host, call } = mount(file)
      const before = rows(file).length

      await expect(
        call('dispatch_touch', { paths: [SRC] }, { agent: worker(host, 'worker-touch-1') }),
      ).rejects.toThrow(/票 t-touch 已结束/)
      expect(rows(file)).toHaveLength(before)
    }
  })

  it('没票时拒绝：worker 名下没票就报错，不写日志', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const before = rows(file).length

    await expect(
      call('dispatch_touch', { paths: [SRC] }, { agent: worker(host, 'worker-nobody') }),
    ).rejects.toThrow('没有挂在这个 worker 上的票')
    expect(rows(file)).toHaveLength(before)
  })
})

describe('关票对账', () => {
  async function closedTicket(
    paths: string[],
    config: Record<string, unknown> = {},
  ): Promise<{ file: string; host: FakePluginHost }> {
    const file = touchTicket()
    const { host, call } = mount(file, config)
    const agent = worker(host, 'worker-touch-1')
    await call('dispatch_touch', { paths }, { agent })
    // 这条 helper 测的是关票对账：越界项要留到 close 那刀，交活这步别拦。
    await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })
    await host.call('dispatch_close', { id: 't-touch' })
    return { file, host }
  }

  it('越界被标出来：touched 里没被 writes 覆盖的路径写进 closed 事件与票面', async () => {
    const { file } = await closedTicket([SRC, EVENTS])

    const written = rows(file).at(-1)!
    expect(written.kind).toBe('closed')
    expect(written.outOfScope).toEqual([`file:${EVENTS}`])

    const snapshot = new TicketStore(file).get('t-touch')!
    expect(snapshot.outOfScope).toEqual([`file:${EVENTS}`])
  })

  it('越界不只进回执：走 notifier 给开票方推一句', async () => {
    const { host } = await closedTicket([SRC, EVENTS])
    const text = host.agents[0]!.messages.join('\n')
    expect(text).toContain('收工时对不上账')
    expect(text).toContain('动了没声明的资源')
    expect(text).toContain(`file:${EVENTS}`)
  })

  it('已声明的只读路径不算越界：touch 同时报 reads 与未声明路径，只报未声明那条', async () => {
    const file = touchTicket(undefined, [`file:${EVENTS}`, `dir:${BASE}/src/tickets`])
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    // SRC 声明为写，EVENTS 声明为读，desk.ts 落在声明为读的目录里，REDUCER 谁都没声明。
    await call(
      'dispatch_touch',
      { paths: [SRC, EVENTS, `${BASE}/src/tickets/desk.ts`, REDUCER] },
      { agent },
    )
    await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })
    await host.call('dispatch_close', { id: 't-touch' })

    const written = rows(file).at(-1)!
    expect(written.kind).toBe('closed')
    expect(written.outOfScope).toEqual([`file:${REDUCER}`])
    expect(new TicketStore(file).get('t-touch')!.outOfScope).toEqual([`file:${REDUCER}`])
    expect(host.agents[0]!.messages.join('\n')).not.toContain(`file:${EVENTS}`)
  })

  it('没越界不推：通知里没有对账那一句', async () => {
    const { host } = await closedTicket([SRC, `${BASE}/tests/helpers/plugin-harness.ts`])
    expect(host.agents[0]!.messages.join('\n')).not.toContain('收工时对不上账')
  })

  it('没越界不留痕：全部落在声明 writes 里，closed 不带 outOfScope，票面也没有', async () => {
    const { file } = await closedTicket([SRC, `${BASE}/tests/helpers/plugin-harness.ts`])

    const written = rows(file).at(-1)!
    expect(written.kind).toBe('closed')
    expect(written).not.toHaveProperty('outOfScope')

    const snapshot = new TicketStore(file).get('t-touch')!
    expect(snapshot.outOfScope).toBeUndefined()
  })

  it('备份与 /tmp 产物不报：白名单挡在覆盖判定前面（历史误报的主流）', async () => {
    const { file, host } = await closedTicket([
      SRC,
      `${BASE}/backups/sqlite/sbi-before-step8-20261118.db`,
      '/tmp/sbi-smoke.mjs',
      `${BASE}/src/tickets/conflict.ts.bak-20261119`,
      `${BASE}/.git/refs/tags`,
    ])

    expect(rows(file).at(-1)!).not.toHaveProperty('outOfScope')
    expect(new TicketStore(file).get('t-touch')!.outOfScope).toBeUndefined()
    expect(host.agents[0]!.messages.join('\n')).not.toContain('收工时对不上账')
  })

  it('白名单只挡产物：备份不报，业务源码照报', async () => {
    const { file } = await closedTicket([SRC, '/tmp/smoke.mjs', EVENTS])
    expect(rows(file).at(-1)!.outOfScope).toEqual([`file:${EVENTS}`])
  })

  it('白名单可关：outOfScopeAllowEnabled=false 退回老口径，备份也报', async () => {
    const backup = `${BASE}/backups/sqlite/x.db`
    const { file } = await closedTicket([SRC, backup], { outOfScopeAllowEnabled: false })
    expect(rows(file).at(-1)!.outOfScope).toEqual([`file:${backup}`])
  })

  it('没有声明 writes 就不对账：快路径的票不该满屏越界', async () => {
    const file = logFile([
      {
        kind: 'published',
        id: 't-plain',
        at: T(0),
        goal: '没声明的票',
        brief: '没声明',
        publisher: 'session-main',
        preset: 't1',
        presetSource: 'fallback',
        requestId: 'req-plain-1',
        intent: { reversibility: 'auto' },
      },
      { kind: 'spawned', id: 't-plain', at: T(1), cause: 'tool', workerId: 'worker-plain-1', preset: 't1' },
    ])
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-plain-1')
    await call('dispatch_touch', { paths: [SRC, EVENTS] }, { agent })
    await host.call('dispatch_close', { id: 't-plain' })

    expect(rows(file).at(-1)!).not.toHaveProperty('outOfScope')
    expect(new TicketStore(file).get('t-plain')!.outOfScope).toBeUndefined()
  })
})

describe('越界 render', () => {
  it('dispatch_list 与 dispatch_read 各多一行「越界：…」，没越界一个字都不多写', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    await call('dispatch_touch', { paths: [SRC, EVENTS] }, { agent })
    // 越界要留到 close 才由票面显示，这条用例别让交活那一步先拦住。
    await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })
    await host.call('dispatch_close', { id: 't-touch' })

    const listed = (await host.call('dispatch_list', { includeClosed: true })) as unknown
    const listText = render(host, 'dispatch_list', { includeClosed: true }, listed)
    expect(listText).toContain(`越界：${EVENTS}`)

    const read = (await host.call('dispatch_read', { id: 't-touch' })) as unknown
    const readText = render(host, 'dispatch_read', { id: 't-touch' }, read)
    expect(readText).toContain(`越界：${EVENTS}`)
  })

  it('没越界的票：列表与读票都不出现「越界」两个字', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    await call('dispatch_touch', { paths: [`${BASE}/tests/helpers/plugin-harness.ts`] }, { agent })
    await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })
    await host.call('dispatch_close', { id: 't-touch' })

    const listed = (await host.call('dispatch_list', { includeClosed: true })) as unknown
    expect(render(host, 'dispatch_list', { includeClosed: true }, listed)).not.toContain('越界')

    const read = (await host.call('dispatch_read', { id: 't-touch' })) as unknown
    expect(render(host, 'dispatch_read', { id: 't-touch' }, read)).not.toContain('越界')
  })

  it('最多列 5 个，多的写「等 N 处」', () => {
    const outOfScope = Array.from({ length: 7 }, (_, index) => `file:/x/${index}.ts`)
    const lines = intentPlanLines({ outOfScope })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('越界：')
    expect(lines[0]).toContain('/x/0.ts')
    expect(lines[0]).toContain('/x/4.ts')
    expect(lines[0]).not.toContain('/x/5.ts')
    expect(lines[0]).toContain('等 2 处')
  })

  it('路径太长时少列几个也要保住行尾「等 N 处」', () => {
    const outOfScope = Array.from({ length: 7 }, (_, index) => `file:${BASE}/x/${index}.ts`)
    const lines = intentPlanLines({ outOfScope })
    expect(lines[0]).toMatch(/等 \d+ 处$/)
    expect(lines[0]).not.toContain('/x/5.ts')
  })
})

describe('交活软提醒', () => {
  it('差集为空：正文原样落库，回执不带 outOfScope，render 只报一行', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    await call('dispatch_touch', { paths: [SRC] }, { agent })

    const receipt = (await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })) as {
      pendingReports: number
      outOfScope?: string[]
    }
    expect(receipt).toMatchObject({ pendingReports: 1 })
    expect(receipt.outOfScope).toBeUndefined()
    const written = rows(file).at(-1)!
    expect(written.kind).toBe('reported')
    expect((written.report as { text: string }).text).toBe('干完了')

    const text = render(host, 'dispatch_report', { id: 't-touch', text: '干完了' }, receipt)
    expect(text).toContain('report recorded')
    expect(text).not.toContain('未声明的改动')
  })

  it('有差集：报告照常落库，顶部拼出未声明的改动，票面一个字节不动', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    await call('dispatch_touch', { paths: [SRC, EVENTS] }, { agent })
    const before = rows(file).length

    const receipt = (await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })) as {
      outOfScope?: string[]
      pendingReports: number
    }
    expect(receipt.outOfScope).toEqual([`file:${EVENTS}`])
    expect(receipt.pendingReports).toBe(1)
    // 不拦交活：日志多了一条 reported，正文是「头部 + 分隔线 + 原正文」。
    expect(rows(file)).toHaveLength(before + 1)
    const written = rows(file).at(-1)!
    expect(written.kind).toBe('reported')
    const body = (written.report as { text: string }).text
    expect(body.startsWith('未声明的改动：')).toBe(true)
    expect(body).toContain(EVENTS)
    expect(body.endsWith('干完了')).toBe(true)
    // 头部说清 send 里追加的允许范围不算声明，也指出去哪儿补。
    expect(body).toContain('send')
    expect(body).toContain('paths')

    // 票面不动：状态还是 running，intent / touched / outOfScope 都没被这次提醒改。
    const snapshot = new TicketStore(file).get('t-touch')!
    expect(snapshot.status).toBe('running')
    expect(snapshot.intent?.writes).toEqual([`file:${SRC}`, `dir:${BASE}/tests`])
    expect(snapshot.touched).toEqual([`file:${SRC}`, `file:${EVENTS}`])
    expect(snapshot.outOfScope).toBeUndefined()

    // 模型看到的回执：清单 + 补声明用法。
    const text = render(host, 'dispatch_report', { id: 't-touch', text: '干完了' }, receipt)
    expect(text).toContain('未声明的改动')
    expect(text).toContain(EVENTS)
    expect(text).toContain('paths')
  })

  it('多文件：差集全报，头部最多列 5 个、行尾写等 N 处', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    // 短路径才放得下 5 个：截断规则先砍清单、再保行尾「等 N 处」。
    const extra = Array.from({ length: 7 }, (_, index) => `/x/${index}.ts`)
    await call('dispatch_touch', { paths: [SRC, ...extra] }, { agent })

    const receipt = (await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })) as {
      outOfScope?: string[]
    }
    expect(receipt.outOfScope).toEqual(extra.map((path) => `file:${path}`))

    const body = (rows(file).at(-1)!.report as { text: string }).text
    for (const index of [0, 1, 2, 3, 4]) expect(body).toContain(`/x/${index}.ts`)
    expect(body).not.toContain('/x/5.ts')
    expect(body).toContain('等 2 处')
  })

  it('只读路径不误报：声明过的 reads 与落在 reads 目录里的 touched 都不进差集', async () => {
    const file = touchTicket(undefined, [`file:${EVENTS}`, `dir:${BASE}/src/tickets`])
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    // SRC 声明为写；EVENTS 声明为读；desk.ts 落在声明为读的目录里。
    await call(
      'dispatch_touch',
      { paths: [SRC, EVENTS, `${BASE}/src/tickets/desk.ts`] },
      { agent },
    )

    const receipt = (await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })) as {
      outOfScope?: string[]
    }
    expect(receipt.outOfScope).toBeUndefined()
    expect((rows(file).at(-1)!.report as { text: string }).text).toBe('干完了')
  })

  it('带 paths 补声明：差集当场消掉，顶部不拼头部，关票也不再报', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    await call('dispatch_touch', { paths: [SRC, EVENTS] }, { agent })

    // 同一路径重复提交（裸路径与 file: 各一次）只算一条。
    const receipt = (await call(
      'dispatch_report',
      { id: 't-touch', text: '干完了', paths: [EVENTS, `file:${EVENTS}`] },
      { agent },
    )) as { outOfScope?: string[]; pendingReports: number }
    expect(receipt.outOfScope).toBeUndefined()
    expect(receipt.pendingReports).toBe(1)
    expect((rows(file).at(-1)!.report as { text: string }).text).toBe('干完了')

    const snapshot = new TicketStore(file).get('t-touch')!
    expect(snapshot.intent?.writes).toEqual([`file:${SRC}`, `dir:${BASE}/tests`, `file:${EVENTS}`])
    expect(snapshot.touched).toEqual([`file:${SRC}`, `file:${EVENTS}`])

    await host.call('dispatch_close', { id: 't-touch' })
    expect(rows(file).at(-1)!).not.toHaveProperty('outOfScope')
    expect(new TicketStore(file).get('t-touch')!.outOfScope).toBeUndefined()
  })

  it('提醒不等于记账：交活只写报告不推送，不补声明时关票那刀照旧记越界并推一句', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    await call('dispatch_touch', { paths: [SRC, EVENTS] }, { agent })
    await call('dispatch_report', { id: 't-touch', text: '干完了' }, { agent })

    // 交活这一步不推越界通知：同一条路径只在关票时记一次最终账。
    expect(host.agents[0]!.messages.join('\n')).not.toContain('收工时对不上账')
    expect(new TicketStore(file).get('t-touch')!.outOfScope).toBeUndefined()

    await host.call('dispatch_close', { id: 't-touch' })
    expect(rows(file).at(-1)!.outOfScope).toEqual([`file:${EVENTS}`])
    expect(host.agents[0]!.messages.join('\n')).toContain('收工时对不上账')
  })

  it('补声明只收路径：svc:/port: 这类不是改动面，当场拒掉，不往 intent.writes 里塞', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')

    await expect(
      call('dispatch_report', { id: 't-touch', text: '干完了', paths: ['svc:nginx'] }, { agent }),
    ).rejects.toThrow(/只收文件路径/)
    expect(new TicketStore(file).get('t-touch')!.intent?.writes).toEqual([`file:${SRC}`, `dir:${BASE}/tests`])
    expect(new TicketStore(file).get('t-touch')!.reports).toHaveLength(0)
  })

  it('补声明一次最多 50 条：超了报错让人分批，不静默截断', async () => {
    const file = touchTicket()
    const { host, call } = mount(file)
    const agent = worker(host, 'worker-touch-1')
    const many = Array.from({ length: 51 }, (_, index) => `${BASE}/src/gen/${index}.ts`)

    await expect(
      call('dispatch_report', { id: 't-touch', text: '干完了', paths: many }, { agent }),
    ).rejects.toThrow(/最多补 50 条/)
    expect(new TicketStore(file).get('t-touch')!.reports).toHaveLength(0)
  })
})
