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
  // waiting 但一条报告都没有：小鱼退了没交活 → 这一档会挑出来（no-report）
  { id: 't-wait-06', at: ago(50), goal: '等主人拍板', status: 'waiting', owner: '重启小鱼' },
  // waiting 但已经交了报告 → 主会话该收的活，不是失联，不挑
  { id: 't-wait-07', at: ago(50), goal: '交了报告在等收票', status: 'waiting', owner: '重启小鱼' },
  { id: 't-wait-07', at: ago(45), report: { id: 'e-r5', text: '都做完了，等收' } },
  // waiting 刚落下 3 分钟，还没到 noReportMinutes（5）→ 这一轮不挑
  { id: 't-wait-08', at: ago(3), goal: '刚退出来三分钟', status: 'waiting', owner: '重启小鱼' },
  // owner 活着 + 5 分钟前有报告 → 不挑
  { id: 't-live-07', at: ago(25), goal: '正常运行中的长活', status: 'running', owner: `session-${LIVE}` },
  { id: 't-live-07', at: ago(5), report: { id: 'e-r2', text: '做到一半' } },
]

const tickets = foldEvents(events.map((event) => ({ ...event })))

describe('僵尸巡检判定', () => {
  const hits = evaluateZombies(tickets, { now, zombieMinutes: 20, noReportMinutes: 5, freshMinutes: 2, isAlive })

  it('挑出该挑的那几张：open/running 僵尸 + waiting 无报告', () => {
    const got = hits.map((hit) => hit.ticket.id).sort()
    for (const hit of hits) {
      console.log(`${hit.ticket.id} ${hit.ticket.status} → ${hit.reason}，idle ${hit.idleMinutes} 分钟，未读报告 ${hit.pendingReports}，指纹 ${hit.fingerprint}`)
    }
    expect(got).toEqual(['t-gone-05', 't-quiet-02', 't-report-03', 't-wait-06'])
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
    expect(text).toContain('另有 1 张')
  })

  it('超过三张只说另有几张', () => {
    const many = [...hits, ...hits, ...hits].map((hit, index) => ({ ...hit, ticket: { ...hit.ticket, id: `x-${index}` } }))
    const text = summarizeZombies(many)
    expect(text).toContain('另有 9 张')
  })
})

/**
 * 2026-11-03：小鱼退出后票落 waiting，原来两边的池子都不收，票就彻底失联。现在
 * waiting 且票里一条报告都没有会被单独盯上，阈值是自己的 noReportMinutes（默认 5），
 * 不吃给跑着的票用的 zombieMinutes（20）。
 */
describe('waiting 无报告', () => {
  const opts = { now, zombieMinutes: 20, noReportMinutes: 5, freshMinutes: 2, isAlive }

  it('挑 waiting · 无报告，reason 是 no-report', () => {
    const hit = evaluateZombies(tickets, opts).find((one) => one.ticket.id === 't-wait-06')
    expect(hit?.reason).toBe('no-report')
    expect(hit?.idleMinutes).toBe(50)
    expect(hit?.pendingReports).toBe(0)
  })

  it('waiting 但已有报告，或者还没到 5 分钟，都不挑', () => {
    const ids = evaluateZombies(tickets, opts).map((hit) => hit.ticket.id)
    expect(ids).not.toContain('t-wait-07')
    expect(ids).not.toContain('t-wait-08')
    // 8 分钟就挑：证明这一档确实没在等 zombieMinutes（20）。
    const eight = foldEvents([{ id: 't-wait-09', at: ago(8), goal: '退了八分钟', status: 'waiting' }])
    expect(evaluateZombies(eight, opts).map((hit) => hit.ticket.id)).toEqual(['t-wait-09'])
  })

  it('摘要能直接指导处置：叫它补报，或者自己去看它干了什么', () => {
    const text = summarizeZombies(evaluateZombies(tickets, opts), 10)
    console.log(text)
    expect(text).toContain('t-wait-06 的小鱼退了但票里一条报告都没有（50 分钟）')
    expect(text).toContain('dispatch_send')
    expect(text).toContain('看它干了什么')
  })

  it('推一次；补上报告后不再是候选，指纹也被清掉', () => {
    const pushed = new Map<string, string>()
    const first = evaluateZombies(tickets, opts).filter((hit) => shouldPush(hit, pushed))
    const wait = first.find((hit) => hit.ticket.id === 't-wait-06')!
    for (const hit of first) pushed.set(hit.ticket.id, hit.fingerprint)

    // 下一轮同一张票指纹没变 → 不再推。
    const second = evaluateZombies(tickets, opts).filter((hit) => shouldPush(hit, pushed))
    expect(second.map((hit) => hit.ticket.id)).not.toContain('t-wait-06')

    // 小鱼补了一条报告：waiting 且有报告 → 不再是候选，sweep 那套清理会把指纹删掉。
    const reported = foldEvents([
      { id: 't-wait-06', at: ago(4), goal: '等主人拍板', status: 'waiting' },
      { id: 't-wait-06', at: ago(1), report: { id: 'e-r6', text: '补报了：改了三处，测试过了' } },
    ])
    const later = evaluateZombies(reported, opts)
    expect(later.map((hit) => hit.ticket.id)).not.toContain('t-wait-06')
    for (const id of [...pushed.keys()]) {
      if (!later.some((hit) => hit.ticket.id === id)) pushed.delete(id)
    }
    expect(pushed.has('t-wait-06')).toBe(false)
    // 指纹能吃下这个区分：报告条数 0、最后活动是落 waiting 那一刻、状态 waiting。
    expect(wait.fingerprint).toBe(`0|${ago(50)}|waiting`)
  })
})

describe('节流指纹', () => {
  it('同一张票没有新报告、状态没变就不重推；补一条报告只重推那一张', () => {
    const pushed = new Map<string, string>()
    const first = evaluateZombies(tickets, { now, zombieMinutes: 20, freshMinutes: 2, isAlive }).filter((hit) => shouldPush(hit, pushed))
    expect(first.map((hit) => hit.ticket.id).sort()).toEqual(['t-gone-05', 't-quiet-02', 't-report-03', 't-wait-06'])
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
