import { describe, expect, it } from 'vitest'
import { foldEvents } from '../src/store'
import type { TicketStatus } from '../src/store'
import { evaluateZombies, shouldPush, summarizeZombies } from '../src/zombie'

/**
 * 僵尸票巡检的判定 + 节流。
 *
 * 时间全部写死：判定只跟票上的时间和 now 有关，跟跑测试的时钟无关。
 * owner 的两种情形各来一张：session id（查得到活表）和短标签（查不到）。
 */
const now = new Date('2026-11-02T12:00:00Z')
const ago = (min: number): string => new Date(now.getTime() - min * 60_000).toISOString()
const LIVE = '11111111-2222-4333-8444-555555555555'
const DEAD = '66666666-7777-4888-8999-aaaaaaaaaaaa'
/** 活表：只有 LIVE 活着；DEAD 查得到、已不在表里（返回 false）；短标签不查（undefined）。 */
const isAlive = (owner: string): boolean | undefined => {
  const bare = owner.replace(/^session-/, '')
  if (!/^[0-9a-f-]{36}$/i.test(bare)) return undefined
  return bare === LIVE
}

/** 日志事件的最小形状：够 fold 用，status 收窄成 TicketStatus 才能过类型检查。 */
interface Event {
  id: string
  at: string
  goal?: string
  status?: TicketStatus
  owner?: string
  note?: string
  report?: { id: string; text: string }
  delivered?: { kind: 'input' | 'report'; id: string }
}

const events: Event[] = [
  // 刚建票：owner 活着 → 不挑
  { id: 't-fresh-01', at: ago(2), goal: '刚派出去的小活', status: 'running', owner: LIVE },
  // 20 分钟没动静，owner 是短标签 → silent
  {
    id: 't-quiet-02',
    at: ago(60),
    goal: '调研 dispatcher 侧如何保证 ticket 完整生命周期不被 sweep 掐断的老话题，这句要截到四十字',
    status: 'running',
    owner: '重启小鱼',
  },
  // 有未读报告 + 静默 30 分钟 → silent，摘要带「未读报告 1 条」
  { id: 't-report-03', at: ago(90), goal: '给 sleep.js 加 REVOCATION_PATTERN', status: 'running', owner: '白名单修复小鱼' },
  { id: 't-report-03', at: ago(30), report: { id: 'e-r1', text: '改完了，测试过' } },
  // done → 跳过
  { id: 't-done-04', at: ago(120), goal: '已经收了的活', status: 'running', owner: DEAD },
  { id: 't-done-04', at: ago(10), status: 'done', note: '收工' },
  // owner 已不在活表 → worker-gone，哪怕才静默 40 分钟也不等重要
  { id: 't-gone-05', at: ago(40), goal: '小鱼死了票还挂着', status: 'running', owner: DEAD },
  // waiting：人按着没动 → 不算僵尸
  { id: 't-wait-06', at: ago(50), goal: '等主人拍板', status: 'waiting', owner: '重启小鱼' },
  // owner 活着 + 5 分钟前有报告 → 不挑
  { id: 't-live-07', at: ago(25), goal: '正常运行中的长活', status: 'running', owner: `session-${LIVE}` },
  { id: 't-live-07', at: ago(5), report: { id: 'e-r2', text: '做到一半' } },
]

const tickets = foldEvents(events.map((event) => ({ ...event })))

describe('僵尸巡检判定', () => {
  const hits = evaluateZombies(tickets, { now, zombieMinutes: 20, freshMinutes: 2, isAlive })

  it('只挑 open/running 里该挑的那几张', () => {
    const got = hits.map((hit) => hit.ticket.id).sort()
    for (const hit of hits) {
      console.log(`${hit.ticket.id} ${hit.ticket.status} → ${hit.reason}，idle ${hit.idleMinutes} 分钟，未读报告 ${hit.pendingReports}，指纹 ${hit.fingerprint}`)
    }
    expect(got).toEqual(['t-gone-05', 't-quiet-02', 't-report-03'])
  })

  it('worker-gone 优先于 silent，且不用等静默阈值', () => {
    const gone = hits.find((hit) => hit.ticket.id === 't-gone-05')
    expect(gone?.reason).toBe('worker-gone')
    expect(gone?.idleMinutes).toBe(40)
  })

  it('有未读报告时数得出来', () => {
    expect(hits.find((hit) => hit.ticket.id === 't-report-03')?.pendingReports).toBe(1)
  })

  it('摘要一句，最多三张，goal 截断', () => {
    const text = summarizeZombies(hits)
    console.log(text)
    expect(text).toContain('t-quiet-02 疑似没动静 60 分钟（silent）')
    expect(text).toContain('未读报告 1 条')
    expect(text).toContain('…')
    expect(text.split('；').length).toBeLessThanOrEqual(3)
  })

  it('超过三张只说另有几张', () => {
    const many = [...hits, ...hits, ...hits].map((hit, index) => ({ ...hit, ticket: { ...hit.ticket, id: `x-${index}` } }))
    const text = summarizeZombies(many)
    expect(text).toContain('另有 6 张')
  })
})

describe('节流指纹', () => {
  it('同一张票没有新报告、状态没变就不重推；补一条报告只重推那一张', () => {
    const pushed = new Map<string, string>()
    const first = evaluateZombies(tickets, { now, zombieMinutes: 20, freshMinutes: 2, isAlive }).filter((hit) => shouldPush(hit, pushed))
    expect(first.map((hit) => hit.ticket.id).sort()).toEqual(['t-gone-05', 't-quiet-02', 't-report-03'])
    for (const hit of first) pushed.set(hit.ticket.id, hit.fingerprint)

    const again = evaluateZombies(tickets, { now, zombieMinutes: 20, freshMinutes: 2, isAlive }).filter((hit) => shouldPush(hit, pushed))
    expect(again).toHaveLength(0)

    // 补一条报告（时间仍在阈值之外，所以票还是僵尸），指纹变了 → 只重推这一张。
    const withReport = foldEvents([
      ...events.map((event) => ({ ...event })),
      { id: 't-report-03', at: ago(35), report: { id: 'e-r3', text: '又补一份' } },
    ])
    const after = evaluateZombies(withReport, { now, zombieMinutes: 20, freshMinutes: 2, isAlive }).filter((hit) => shouldPush(hit, pushed))
    expect(after.map((hit) => hit.ticket.id)).toEqual(['t-report-03'])
    // 有报告进来（1 分钟前）的票不算僵尸：它动了。
    const moved = foldEvents([
      ...events.map((event) => ({ ...event })),
      { id: 't-quiet-02', at: ago(1), report: { id: 'e-r4', text: '刚有动静' } },
    ])
    expect(
      evaluateZombies(moved, { now, zombieMinutes: 20, freshMinutes: 2, isAlive }).map((hit) => hit.ticket.id),
    ).not.toContain('t-quiet-02')
    // sweep 自己投递报告会追加一条 delivered 事件，那也会刷新 updatedAt——
    // 指纹要是用了 updatedAt，这轮投递会让下一轮再推一遍。现在不该重推。
    const delivered = foldEvents([
      ...events.map((event) => ({ ...event })),
      { id: 't-report-03', at: ago(1), delivered: { kind: 'report' as const, id: 'e-r1' } },
    ])
    expect(
      evaluateZombies(delivered, { now, zombieMinutes: 20, freshMinutes: 2, isAlive }).filter((hit) => shouldPush(hit, pushed)),
    ).toHaveLength(0)
  })

  it('票活了就把指纹清掉，下次再僵尸还能推', () => {
    const pushed = new Map<string, string>()
    const hits = evaluateZombies(tickets, { now, zombieMinutes: 20, freshMinutes: 2, isAlive })
    for (const hit of hits) pushed.set(hit.ticket.id, hit.fingerprint)
    // 模拟 sweep 的清理：本轮不再是僵尸的票删指纹。
    const aliveNow = evaluateZombies(
      tickets.map((ticket) => (ticket.id === 't-quiet-02' ? { ...ticket, status: 'done' as const } : ticket)),
      { now, zombieMinutes: 20, freshMinutes: 2, isAlive },
    )
    for (const id of [...pushed.keys()]) {
      if (!aliveNow.some((hit) => hit.ticket.id === id)) pushed.delete(id)
    }
    expect(pushed.has('t-quiet-02')).toBe(false)
  })
})
