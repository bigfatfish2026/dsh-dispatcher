/**
 * 降级票的写边界，以及「大根目录」不再硬拦。
 *
 * 今天两张票被 `dir:/home/julia` 锁死：探路超时降级时，arbiter 拿票的 dir 整片
 * 合成写锁，凭空占住整棵树（23 条 waitOn 里 15 条来自降级票）。这里的断言就钉
 * 两件事：
 *
 * 1. 降级且 writes 空时，写边界只来自 plan.files 的父目录；没有 plan 就什么也
 *    不占，绝不产出 `dir:<票的 dir>`。
 * 2. 显式声明 `dir:/`、`dir:<home>` 这类大根目录仍然合法，但判定只降成 weak 并
 *    warn 一行，不再把整棵树当强冲突；真正写在里面的具体文件照旧强冲突。
 */
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { foldEvents } from '../src/store'
import type { TicketEvent, TicketSnapshot } from '../src/store'
import { TicketLog } from '../src/store/log'
import { ConflictArbiter } from '../src/tickets/arbiter'
import { fakeClock } from '../src/tickets/clock'
import { judgeConflict } from '../src/tickets/conflict'
import { MemoryBackend } from './helpers/desk-harness'

const T = (second: number): string => `2026-11-16T12:00:${String(second).padStart(2, '0')}.000Z`

function published(id: string, second: number, dir?: string): TicketEvent {
  return {
    kind: 'published',
    id,
    at: T(second),
    goal: `活 ${id}`,
    brief: `活 ${id}`,
    publisher: 'session-main',
    preset: 't1',
    presetSource: 'fallback',
    seq: second,
    ...(dir ? { dir } : {}),
  }
}

/** 超时降级写的那一条：cause=timer、degraded=true，plan / intent 常常是空的。 */
function degraded(id: string, second: number, planFiles: Array<{ path: string }> = []): TicketEvent {
  return {
    kind: 'declared',
    id,
    at: T(second),
    cause: 'timer',
    plan: planFiles.length ? { files: planFiles } : {},
    intent: {},
    degraded: true,
  }
}

function tree(events: TicketEvent[]): {
  arbiter: ConflictArbiter
  warnings: string[]
  snap: (id: string) => TicketSnapshot
} {
  const backend = new MemoryBackend()
  for (const event of events) backend.append(event)
  const log = new TicketLog(backend)
  const warnings: string[] = []
  const arbiter = new ConflictArbiter({
    log,
    clock: fakeClock(new Date(T(59))),
    warn: (message) => warnings.push(message),
    commit: (event) => log.commit(event),
  })
  const snap = (id: string): TicketSnapshot => {
    const ticket = log.get(id)
    if (!ticket) throw new Error(`no ${id}`)
    return ticket
  }
  return { arbiter, warnings, snap }
}

describe('降级票不再拿票的 dir 整片当写锁', () => {
  it('degraded + writes 空 + 有 dir：不产生 dir:<票的 dir>', () => {
    const { arbiter, snap } = tree([
      published('t-deg', 1, '/home/julia'),
      degraded('t-deg', 2),
    ])
    const side = arbiter.side(snap('t-deg'))
    expect(side.writes).toEqual([])
    expect(side.writes).not.toContain('dir:/home/julia')
  })

  it('degraded + plan.files 绝对路径：只占父目录', () => {
    const { arbiter, snap } = tree([
      published('t-deg', 1, '/home/julia'),
      degraded('t-deg', 2, [{ path: '/home/julia/fatfish/plugins/dsh-dispatcher/src/a.ts' }]),
    ])
    const side = arbiter.side(snap('t-deg'))
    expect(side.writes).toEqual(['dir:/home/julia/fatfish/plugins/dsh-dispatcher/src'])
    expect(side.writes).not.toContain('dir:/home/julia')
  })

  it('degraded + plan.files 相对路径：按票的 dir 归一化父目录，不吃宿主 cwd', () => {
    const { arbiter, snap } = tree([
      published('t-deg', 1, '/home/julia/fatfish/plugins/dsh-dispatcher'),
      degraded('t-deg', 2, [{ path: 'src/tickets/arbiter.ts' }]),
    ])
    expect(arbiter.side(snap('t-deg')).writes).toEqual([
      'dir:/home/julia/fatfish/plugins/dsh-dispatcher/src/tickets',
    ])
  })

  it('degraded + plan 空 + 相对路径：没有基准就跳过，不按 cwd 猜', () => {
    const { arbiter, snap } = tree([
      published('t-deg', 1),
      degraded('t-deg', 2, [{ path: 'src/tickets/arbiter.ts' }]),
    ])
    expect(arbiter.side(snap('t-deg'))).toEqual({ writes: [], reads: [] })
  })

  it('plan.files 的父目录仍挡得住真的写在它里面的票', () => {
    const blocker: TicketEvent = {
      kind: 'declared',
      id: 't-blocker',
      at: T(2),
      cause: 'tool',
      plan: { files: [{ path: '/tmp/deg-work/a.ts' }] },
      intent: { writes: ['file:/tmp/deg-work/a.ts'] },
      workerId: 'worker-blocker',
    }
    const { arbiter, snap } = tree([
      published('t-blocker', 1),
      blocker,
      published('t-deg', 3, '/tmp/deg-work'),
      degraded('t-deg', 4, [{ path: 'a.ts' }]),
    ])
    const decision = arbiter.judge(snap('t-deg'))
    expect(decision.level).toBe('strong')
    expect(decision.waitOn).toEqual([
      {
        ticketId: 't-blocker',
        resources: ['dir:/tmp/deg-work', 'file:/tmp/deg-work/a.ts'],
      },
    ])
  })
})

describe('大根目录 dir: 只降成 weak', () => {
  it('dir:/ 撞 file:/etc/passwd：arbiter 判 weak 并 warn，不再强拦', () => {
    const { arbiter, warnings, snap } = tree([
      published('t-root', 1),
      {
        kind: 'declared',
        id: 't-root',
        at: T(2),
        cause: 'tool',
        plan: { files: [] },
        intent: { writes: ['dir:/'] },
        workerId: 'worker-root',
      },
      published('t-file', 3),
      {
        kind: 'declared',
        id: 't-file',
        at: T(4),
        cause: 'tool',
        plan: { files: [] },
        intent: { writes: ['file:/etc/passwd'] },
        workerId: 'worker-file',
      },
    ])
    const decision = arbiter.judge(snap('t-file'))
    expect(decision.level).toBe('weak')
    expect(decision.waitOn).toEqual([])
    expect(decision.weak).toEqual(['t-root'])
    expect(warnings.join('\n')).toContain('大根目录 dir:/')
    expect(warnings.join('\n')).toContain('只判 weak 放行')
  })

  it('dir:<home> 撞 home 里的文件：同样只 weak', () => {
    const home = homedir()
    const { arbiter, snap } = tree([
      published('t-home', 1),
      {
        kind: 'declared',
        id: 't-home',
        at: T(2),
        cause: 'tool',
        plan: { files: [] },
        intent: { writes: [`dir:${home}`] },
        workerId: 'worker-home',
      },
      published('t-inside', 3),
      {
        kind: 'declared',
        id: 't-inside',
        at: T(4),
        cause: 'tool',
        plan: { files: [] },
        intent: { writes: [`file:${home}/notes.md`] },
        workerId: 'worker-inside',
      },
    ])
    expect(arbiter.judge(snap('t-inside')).level).toBe('weak')
  })

  it('具体目录照旧强冲突：dir:/tmp/x 撞它里面的文件', () => {
    const { arbiter, snap } = tree([
      published('t-dir', 1),
      {
        kind: 'declared',
        id: 't-dir',
        at: T(2),
        cause: 'tool',
        plan: { files: [] },
        intent: { writes: ['dir:/tmp/deg-specific'] },
        workerId: 'worker-dir',
      },
      published('t-in', 3),
      {
        kind: 'declared',
        id: 't-in',
        at: T(4),
        cause: 'tool',
        plan: { files: [] },
        intent: { writes: ['file:/tmp/deg-specific/a.ts'] },
        workerId: 'worker-in',
      },
    ])
    expect(arbiter.judge(snap('t-in'))).toMatchObject({ level: 'strong' })
  })

  it('纯判定层语义没变：judgeConflict 对大根目录仍给 strong', () => {
    const verdict = judgeConflict({ writes: ['dir:/'] }, { writes: ['file:/etc/passwd'] })
    expect(verdict.level).toBe('strong')
  })
})
