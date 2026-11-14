/**
 * 可撤回路线 3 的账本测试：协议兼容、动作账本、结票审计、撤回指南校验。
 *
 * 三层各测各的，别混在一起：
 * - `tickets/revert.ts` 是纯函数，表驱动直接喂；
 * - `TicketDesk` 测「声明怎么落成票」；
 * - 插件层只测接线（工具参数进得去、拒绝理由出得来、账本真落盘）。
 *
 * 2026-11-14 起开票不再收 intent，分级闸随 open 那条路一起删了；这里保留
 * 老日志的兼容用例和审计、账本、指南校验。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fold } from '../src/store/reducer'
import type { ActionLogged, Published, TicketEvent } from '../src/store'
import { auditClosedTickets, checkUndoHowto, normalizeUndo } from '../src/tickets/revert'
import { INTENT, makeDesk } from './helpers/desk-harness'
import { cleanTempDirs, mountPlugin } from './helpers/plugin-harness'

afterEach(cleanTempDirs)

const GOOD_UNDO = {
  kind: 'file',
  ref: '/home/user/dev/dsh-dispatcher/cordis.patch.yml.bak',
  howto: 'cp /home/user/dev/dsh-dispatcher/cordis.patch.yml.bak /home/user/dev/dsh-dispatcher/cordis.patch.yml',
}

const NOW = new Date('2026-11-10T13:00:00.000Z')

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString()
}

const DAY = 24 * 60 * 60 * 1000

function published(id: string, at: string, extra: Partial<Published> = {}): Published {
  return {
    kind: 'published',
    id,
    at,
    goal: `目标 ${id}`,
    brief: `票 ${id}`,
    publisher: 'session-main',
    preset: 't1',
    presetSource: 'fallback',
    requestId: `req-${id}`,
    ...extra,
  }
}

describe('协议兼容：老票没有 intent/origin/actions', () => {
  it('老行折叠后 intent 是 undefined、origin 按 main、actions 空', () => {
    const events: TicketEvent[] = [
      { id: 't-legacy', at: iso(-DAY), goal: '旧活', status: 'open' },
      published('t-new', iso(-DAY)),
    ]
    const state = fold(events)
    const legacy = state.get('t-legacy')!
    expect(legacy.intent).toBeUndefined()
    expect(legacy.origin).toBe('main')
    expect(legacy.actions).toEqual([])
    // 老行不带 kind，新票也不写 origin/intent：投影里照样是默认值。
    expect(state.get('t-new')!.origin).toBe('main')
    expect(state.get('t-new')!.intent).toBeUndefined()
    expect(state.get('t-new')!.actions).toEqual([])
  })

  it('published 不写 origin/intent 时事件里也没有这两个键（老行形状不变）', async () => {
    const h = makeDesk()
    await h.desk.open(INTENT, h.main)
    const event = h.backend.events_[0] as Published
    expect(event).not.toHaveProperty('origin')
    expect(event).not.toHaveProperty('intent')
  })
})

describe('动作账本 action-logged', () => {
  it('fold：只追加数组，不碰 status / closedAt；收工后还能补记', () => {
    const events: TicketEvent[] = [
      published('t-1', iso(-3 * 3600_000), { intent: { reversibility: 'manual', undo: GOOD_UNDO } }),
      { kind: 'closed', id: 't-1', at: iso(-2 * 3600_000), outcome: 'done' },
      {
        kind: 'action-logged',
        id: 't-1',
        at: iso(-3600_000),
        ticketId: 't-1',
        actor: 'worker',
        step: 1,
        summary: '改了 profile',
        undo: GOOD_UNDO,
      },
    ]
    const ticket = fold(events).get('t-1')!
    expect(ticket.status).toBe('done')
    expect(ticket.closedAt).toBe(iso(-2 * 3600_000))
    expect(ticket.actions).toHaveLength(1)
    expect(ticket.actions[0]).toMatchObject({ step: 1, actor: 'worker', summary: '改了 profile' })
  })

  it('desk.logAction：自动编号、附撤回指南；终态票也收', async () => {
    const h = makeDesk()
    const receipt = await h.desk.open(INTENT, h.main)
    const first = await h.desk.logAction(
      receipt.id,
      { summary: '改了 profile', undo: GOOD_UNDO },
      'worker',
    )
    const second = await h.desk.logAction(
      receipt.id,
      { summary: 'git commit 了一个修复', undo: { kind: 'git', ref: 'abc1234', howto: 'git revert abc1234' } },
      'worker',
    )
    expect([first.step, second.step]).toEqual([1, 2])
    expect(second.actions).toBe(2)
    const event = h.backend.events_.at(-1) as ActionLogged
    expect(event).toMatchObject({ kind: 'action-logged', ticketId: receipt.id, actor: 'worker', step: 2 })
    await h.desk.close(receipt.id, { outcome: 'done' })
    const after = await h.desk.logAction(
      receipt.id,
      { summary: '补记最后一步', undo: GOOD_UNDO },
      'main',
    )
    expect(after.step).toBe(3)
    const closed = h.log.get(receipt.id)!
    expect(closed.status).toBe('done')
    expect(closed.actions).toHaveLength(3)
  })

  it('撤回指南不合格就不进日志：空、空话、无锚点都拒', async () => {
    const h = makeDesk()
    const receipt = await h.desk.open(INTENT, h.main)
    await expect(
      h.desk.logAction(receipt.id, { summary: 'x', undo: { kind: 'file', howto: '' } }, 'worker'),
    ).rejects.toThrow(/undo\.howto/)
    await expect(
      h.desk.logAction(receipt.id, { summary: 'x', undo: { kind: 'file', howto: '回滚即可回滚即可回滚即可' } }, 'worker'),
    ).rejects.toThrow(/空话/)
    await expect(
      h.desk.logAction(receipt.id, { summary: 'x', undo: { kind: 'file', howto: '把刚才那个东西恢复原样就行了' } }, 'worker'),
    ).rejects.toThrow(/至少要有一条命令或一个路径/)
    expect(h.log.get(receipt.id)!.actions).toEqual([])
  })

  it('summary 为空、step 重复、step 非法都拒', async () => {
    const h = makeDesk()
    const receipt = await h.desk.open(INTENT, h.main)
    await expect(
      h.desk.logAction(receipt.id, { summary: '  ', undo: GOOD_UNDO }, 'worker'),
    ).rejects.toThrow(/summary/)
    await h.desk.logAction(receipt.id, { summary: '第一步', undo: GOOD_UNDO, step: 5 }, 'worker')
    await expect(
      h.desk.logAction(receipt.id, { summary: '又一步', undo: GOOD_UNDO, step: 5 }, 'worker'),
    ).rejects.toThrow(/已经记过/)
    await expect(
      h.desk.logAction(receipt.id, { summary: '零步', undo: GOOD_UNDO, step: 0 }, 'worker'),
    ).rejects.toThrow(/正整数/)
    // 省略 step 时接在最大序号后面，不是接在条数后面。
    const next = await h.desk.logAction(receipt.id, { summary: '下一步', undo: GOOD_UNDO }, 'worker')
    expect(next.step).toBe(6)
  })

  it('插件层：主会话记 actor=main，子会话记 actor=worker', async () => {
    const host = mountPlugin()
    const { id } = (await host.call('dispatch_open', { goal: '查一下日志', brief: '查日志' })) as { id: string }
    await host.call('dispatch_log_action', {
      id,
      summary: '主会话先看了一遍日志',
      undo: GOOD_UNDO,
    })
    const worker = host.makeAgent('subagent')
    await host.call(
      'dispatch_log_action',
      { id, summary: '子会话改了配置', undo: GOOD_UNDO },
      { agent: worker },
    )
    const actions = (await host.call('dispatch_list', { includeClosed: true, status: 'running' })) as {
      tickets: Array<{ id: string }>
    }
    expect(actions.tickets[0]!.id).toBe(id)
    // 账本不经过 list 的展示面，直接读盘核事件。
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(host.config.stateFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind?: string; actor?: string; step?: number })
      .filter((event) => event.kind === 'action-logged')
    expect(lines.map((event) => [event.actor, event.step])).toEqual([
      ['main', 1],
      ['worker', 2],
    ])
  })
})

describe('撤回指南校验：空话挡得住，具体命令放得过', () => {
  it('表驱动', () => {
    const cases: Array<[string, boolean, string?]> = [
      ['', false, 'empty'],
      ['回滚即可', false, 'vague'],
      ['回滚即可回滚即可回滚即可', false, 'vague'],
      ['自行处理，回头再说吧', false, 'vague'],
      ['撤一下', false, 'short'],
      ['把刚才那个东西恢复原样就行了', false, 'no-anchor'],
      ['cp /home/user/x.yml.bak /home/user/x.yml', true],
      ['git revert abc1234', true],
      ['systemctl --user restart dsh-example', true],
      ['撤不回；只能 git revert abc1234 后重新 push', true],
    ]
    for (const [howto, ok, code] of cases) {
      const check = checkUndoHowto(howto)
      expect(check.ok, `howto=${howto}`).toBe(ok)
      if (!check.ok) expect(check.code, `howto=${howto}`).toBe(code)
    }
  })
})

describe('撤回指南与审计的边界', () => {
  it('非字符串 howto 当空；normalizeUndo 缺 kind / howto 不对都抛', () => {
    expect(checkUndoHowto(42)).toMatchObject({ ok: false, code: 'empty' })
    expect(() => normalizeUndo({ howto: GOOD_UNDO.howto })).toThrow(/kind 不能为空/)
    expect(() => normalizeUndo({ kind: 'file', howto: 42 })).toThrow(/undo\.howto 是空的/)
  })

  it('审计窗口显式给 0 或负数直接拒', () => {
    expect(() => auditClosedTickets([], { now: NOW, days: 0 })).toThrow(/正整数/)
    expect(() => auditClosedTickets([], { now: NOW, days: -1 })).toThrow(/正整数/)
  })

  it('主会话的动作缺口用「主会话」称呼；没有 brief 就用 goal 摘要', () => {
    const events: TicketEvent[] = [
      published('t-h', iso(-DAY), { brief: undefined }),
      { kind: 'closed', id: 't-h', at: iso(-DAY + 60_000), outcome: 'done' },
      {
        kind: 'action-logged',
        id: 't-h',
        at: iso(-DAY + 120_000),
        ticketId: 't-h',
        actor: 'main',
        step: 1,
        summary: '改了配置',
        undo: { kind: 'file', howto: '回滚即可' },
      },
    ]
    const report = auditClosedTickets([...fold(events).values()], { now: NOW, days: 1 })
    expect(report.findings[0]).toMatchObject({ ticketId: 't-h', kind: 'vague-undo', actor: 'main' })
    expect(report.text).toContain('主会话')
    expect(report.text).toContain('目标 t-h')
  })
})

describe('结票审计：按 closedAt 限窗口，只列不改', () => {
  const badHowto = { kind: 'file', howto: '回滚即可回滚即可回滚即可' }

  const events: TicketEvent[] = [
    // A：窗口内 done，动作指南是空话。
    published('t-a', iso(-4 * DAY)),
    { kind: 'closed', id: 't-a', at: iso(-DAY), outcome: 'done' },
    {
      kind: 'action-logged',
      id: 't-a',
      at: iso(-DAY + 60_000),
      ticketId: 't-a',
      actor: 'worker',
      step: 1,
      summary: '改了配置',
      undo: badHowto,
    },
    // B：窗口外的 done，不该被扫到。
    published('t-b', iso(-8 * DAY)),
    { kind: 'closed', id: 't-b', at: iso(-5 * DAY), outcome: 'done' },
    {
      kind: 'action-logged',
      id: 't-b',
      at: iso(-5 * DAY + 60_000),
      ticketId: 't-b',
      actor: 'worker',
      step: 1,
      summary: '改了配置',
      undo: badHowto,
    },
    // C：窗口内但 dropped，是人主动停的，不算账。
    published('t-c', iso(-2 * DAY)),
    { kind: 'closed', id: 't-c', at: iso(-DAY), outcome: 'dropped' },
    // D：窗口内 done，intent 标了不可撤，动作指南合格。
    published('t-d', iso(-3 * DAY), {
      intent: { reversibility: 'none', impact: { services: ['dsh-example'] }, undo: GOOD_UNDO },
    }),
    { kind: 'closed', id: 't-d', at: iso(-2 * DAY), outcome: 'done' },
    {
      kind: 'action-logged',
      id: 't-d',
      at: iso(-2 * DAY + 60_000),
      ticketId: 't-d',
      actor: 'worker',
      step: 1,
      summary: '重启了 qqbot',
      undo: GOOD_UNDO,
    },
  ]

  const tickets = [...fold(events).values()]

  it('只扫窗口内 done 票，两类缺口分开列', () => {
    const report = auditClosedTickets(tickets, { now: NOW, days: 3 })
    expect(report.scanned).toBe(2)
    expect(report.findings).toHaveLength(2)
    expect(report.findings.map((finding) => [finding.ticketId, finding.kind])).toEqual([
      ['t-a', 'vague-undo'],
      ['t-d', 'irreversible'],
    ])
    expect(report.text).toContain('缺口 2 处')
    expect(report.text).toContain('t-a')
    expect(report.text).not.toContain('t-b')
    expect(report.text).not.toContain('t-c')
  })

  it('窗口边界：正好 N 天前（含）算在内，晚一毫秒就被挤出窗口', () => {
    const boundary = [
      ...fold([
        published('t-e', iso(-4 * DAY)),
        { kind: 'closed', id: 't-e', at: iso(-3 * DAY), outcome: 'done' },
      ]).values(),
    ]
    expect(auditClosedTickets(boundary, { now: NOW, days: 3 }).scanned).toBe(1)
    // 现在往后挪一点点，同一个 closedAt 就落在窗口外了。
    expect(auditClosedTickets(boundary, { now: new Date(NOW.getTime() + 1), days: 3 }).scanned).toBe(0)
    expect(auditClosedTickets(boundary, { now: new Date(NOW.getTime() - 1), days: 3 }).scanned).toBe(1)
  })

  it('没有缺口时也给一句人话，不返回空串', () => {
    const clean = [...fold([published('t-f', iso(-DAY)), { kind: 'closed', id: 't-f', at: iso(-DAY), outcome: 'done' }]).values()]
    const report = auditClosedTickets(clean, { now: NOW, days: 3 })
    expect(report.findings).toEqual([])
    expect(report.text).toContain('没有缺口')
  })

  it('desk.auditRevert 走真实票台：窗口、条数、文本都对得上', async () => {
    const h = makeDesk({ now: NOW })
    const receipt = await h.desk.open(INTENT, h.main)
    await h.desk.logAction(
      receipt.id,
      { summary: '改了 profile', undo: GOOD_UNDO },
      'worker',
    )
    await h.desk.close(receipt.id, { outcome: 'done' })
    const report = await h.desk.auditRevert({ days: 3 })
    expect(report.scanned).toBe(1)
    expect(report.findings).toEqual([])
    expect(report.text).toContain('没有缺口')
  })
})
