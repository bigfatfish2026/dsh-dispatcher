/**
 * 可撤回路线 3 的「纯规则」：撤回指南校验、结票审计。
 *
 * 这一层不碰 IO、不碰 TicketDesk、不改任何票——desk 调它判定，测试直接喂数组。
 * 三个约定写死在这里，别散到别处：
 *
 * - `undo.howto` 必须是具体命令或具体路径。「回滚即可」「自行处理」这种空话
 *   在 `checkUndoHowto` 就被挡下：空话的撤回指南比没有更糟，它让人以为有退路。
 * - 开票不再收 intent（2026-11-14 起只由 `dispatch_declare` 交），所以开票
 *   路径上没有闸；`reversibility=none` 这类事实由审计事后列出来，不是拦下来。
 * - 审计只读：按 `closedAt` 限最近 N 天扫 done 票，产出文本，一个字节都不写。
 */
import type { ActionLogEntry, IntentUndo, TicketSnapshot } from '../store'

/** `undo.howto` 的最短字数（按字符数，不按列宽）：再短就说不清做什么。 */
export const UNDO_HOWTO_MIN_CHARS = 12

/**
 * 一眼就是空话的写法。整句等于这些词、或句子里含这些短语，都算不合格。
 * 只收确定没有信息量的写法，不猜语义——判定要能预测，不能靠感觉。
 */
const UNDO_VAGUE_WORDS: readonly string[] = [
  '回滚即可',
  '回滚就行',
  '回滚一下',
  '撤销即可',
  '撤销就行',
  '撤回来就行',
  '看着办',
  '自行处理',
  '见文档',
  '同上',
  '待定',
  '以后再补',
  'tbd',
  'todo',
  'fixme',
  'n/a',
]

/** 一句话里至少要有一种「能照着敲」的锚点：命令、路径或远端。 */
const UNDO_ANCHORS: readonly string[] = [
  '/',
  '~',
  'git ',
  'systemctl',
  'journalctl',
  'sqlite3',
  'cp ',
  'mv ',
  'rm ',
  'kill ',
  'curl ',
  'diff ',
  'npm ',
  'pnpm ',
  'node ',
  'dispatch_',
  'gh ',
  'ssh ',
]

export interface UndoCheckOk {
  ok: true
}

export interface UndoCheckFail {
  ok: false
  code: 'empty' | 'short' | 'vague' | 'no-anchor'
  reason: string
}

export type UndoCheck = UndoCheckOk | UndoCheckFail

function squash(value: string): string {
  return value
    .trim()
    .replace(/[。.!！?？~～,，;；\s]+$/u, '')
    .toLowerCase()
}

/**
 * 一句话能不能当撤回指南。
 *
 * 判定顺序：空 → 太短 → 空话 → 没有可照做的锚点。前三条是「说了等于没说」，
 * 最后一条是「看不出能干什么是」。
 */
export function checkUndoHowto(howto: unknown): UndoCheck {
  const raw = typeof howto === 'string' ? howto.trim() : ''
  if (!raw) {
    return { ok: false, code: 'empty', reason: 'undo.howto 是空的：必须写清怎么撤' }
  }
  const flat = squash(raw)
  // 先认空话再量长度：「自行处理，回头再说吧」短归短，问题在它是空话，
  // 报 vague 比报 short 更有用。
  const hit = UNDO_VAGUE_WORDS.find((word) => flat === word || flat.includes(word))
  if (hit) {
    return {
      ok: false,
      code: 'vague',
      reason: `undo.howto 是空话（「${raw}」）：换成具体命令或具体路径，别写「${hit}」`,
    }
  }
  const length = [...raw].length
  if (length < UNDO_HOWTO_MIN_CHARS) {
    return {
      ok: false,
      code: 'short',
      reason: `undo.howto 只有 ${length} 字（至少要 ${UNDO_HOWTO_MIN_CHARS} 字）：写具体命令或具体路径`,
    }
  }
  if (!UNDO_ANCHORS.some((anchor) => flat.includes(anchor))) {
    return {
      ok: false,
      code: 'no-anchor',
      reason: `undo.howto 看不出具体动作（「${raw}」）：至少要有一条命令或一个路径，例如 git checkout <sha> / cp /home/user/….bak /home/user/…`,
    }
  }
  return { ok: true }
}

/** 把工具层/事件里拿到的 undo 收成合法形状；不合格就抛，带上人话理由。 */
export function normalizeUndo(input: unknown): IntentUndo {
  const value = (input ?? {}) as { kind?: unknown; ref?: unknown; howto?: unknown }
  const kind = typeof value.kind === 'string' ? value.kind.trim() : ''
  if (!kind) throw new Error('undo.kind 不能为空：写清这是文件、git、服务还是消息')
  const howto = typeof value.howto === 'string' ? value.howto.trim() : ''
  const check = checkUndoHowto(howto)
  if (!check.ok) throw new Error(check.reason)
  const ref = typeof value.ref === 'string' && value.ref.trim() ? value.ref.trim() : undefined
  return { kind, ...(ref ? { ref } : {}), howto }
}

/** 审计窗口默认几天：只扫最近这阵子结的票，800+ 张 done 不能全扫。 */
export const REVERT_AUDIT_DAYS = 3

export type RevertAuditKind = 'missing-undo' | 'vague-undo' | 'irreversible'

export interface RevertAuditFinding {
  ticketId: string
  brief: string
  kind: RevertAuditKind
  /** 动作序号；整票级的问题（reversibility=none）不带。 */
  step?: number
  actor?: ActionLogEntry['actor']
  detail: string
}

export interface RevertAuditReport {
  days: number
  since: string
  /** 窗口内 done 票的张数。 */
  scanned: number
  findings: RevertAuditFinding[]
  /** 给人读的报告正文；没有缺口时也有一句。 */
  text: string
}

export interface RevertAuditOptions {
  now: Date
  days?: number
  /** 票一句话摘要；不传就用 `ticket.brief`，再没有就截 goal。 */
  briefOf?: (ticket: TicketSnapshot) => string
}

function briefOfDefault(ticket: TicketSnapshot): string {
  if (ticket.brief) return ticket.brief
  return Array.from(ticket.goal).slice(0, 17).join('')
}

/**
 * 结票审计：只看窗口内 `done` 的票（`dropped` 是人主动停的，不算账）。
 *
 * 两类问题分开报：动作级（撤回指南缺/空话）和票级（`reversibility=none`）。
 * 一个字节都不写，调用方自己决定把文本交给谁。
 */
export function auditClosedTickets(
  tickets: readonly TicketSnapshot[],
  options: RevertAuditOptions,
): RevertAuditReport {
  const days = options.days === undefined ? REVERT_AUDIT_DAYS : options.days
  if (!Number.isFinite(days) || days <= 0) throw new Error('审计窗口必须是正整数天')
  const since = new Date(options.now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  const briefOf = options.briefOf ?? briefOfDefault
  const findings: RevertAuditFinding[] = []
  let scanned = 0

  for (const ticket of tickets) {
    if (ticket.status !== 'done') continue
    // closedAt 缺席的票推不出窗口，跳过——不猜。
    if (!ticket.closedAt || ticket.closedAt < since) continue
    scanned += 1
    const brief = briefOf(ticket)

    if (ticket.intent?.reversibility === 'none') {
      const steps = ticket.actions.map((action) => action.step)
      findings.push({
        ticketId: ticket.id,
        brief,
        kind: 'irreversible',
        detail:
          steps.length > 0
            ? `reversibility=none，账本里 ${steps.length} 步动作都不可撤（第 ${steps.join('、')} 步）`
            : 'reversibility=none，票上没有动作记录',
      })
    }

    for (const action of ticket.actions) {
      const check = checkUndoHowto(action.undo?.howto)
      if (check.ok) continue
      findings.push({
        ticketId: ticket.id,
        brief,
        kind: check.code === 'empty' || check.code === 'short' ? 'missing-undo' : 'vague-undo',
        step: action.step,
        actor: action.actor,
        detail: `第 ${action.step} 步（${action.actor === 'worker' ? '子会话' : '主会话'}）：${check.reason}`,
      })
    }
  }

  return {
    days,
    since,
    scanned,
    findings,
    text: renderAudit(days, scanned, findings),
  }
}

function renderAudit(days: number, scanned: number, findings: readonly RevertAuditFinding[]): string {
  const head = `撤回审计：最近 ${days} 天 done 票 ${scanned} 张`
  if (findings.length === 0) return `${head}，没有缺口`
  const lines = [`${head}，缺口 ${findings.length} 处`]
  for (const finding of findings) {
    lines.push(`- ${finding.ticketId}「${finding.brief}」：${finding.detail}`)
  }
  return lines.join('\n')
}
