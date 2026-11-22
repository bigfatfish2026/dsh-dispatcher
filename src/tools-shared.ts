/** 工具层与票面渲染共用的小函数：调用方识别、参数收敛、票行/声明行。 */
import { truncateColumns } from './store'
import type { Actor, ConflictWait, IntentSpec, TicketPlan } from './store'
import type { TicketView } from './tickets/desk'
import { isWorkerSession } from './no-wait'

export function actorOf(exec: unknown): Actor {
  const agent = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent
  const sessionId = agent?.session?.id
  if (!sessionId) throw new Error('不知道是哪个会话在调这个工具：票得记在发起人名下')
  return { kind: 'main', sessionId }
}

/**
 * 调 `dispatch_report` 的调用者身份：worker 会话标 worker，其余按主会话。
 * 归属判定在 desk 里（`assertMayReport`），这里只负责把身份带过去；拿不到
 * 会话 id 就当场报错，别把报告记到一张不知道谁的票上。
 */
export function callerActorOf(exec: unknown): Actor {
  const agent = (exec as { agent?: { session?: { id?: string; header?: { origin?: string } } } } | undefined)?.agent
  const sessionId = agent?.session?.id
  if (!sessionId) throw new Error('不知道是哪个会话在调这个工具：报告得记在发起人名下')
  return { kind: isWorkerSession(agent?.session?.header?.origin) ? 'worker' : 'main', sessionId }
}

export function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function stringsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return items.length > 0 ? items.map((item) => item.trim()) : undefined
}

/**
 * 把工具参数里的 `intent` 收敛成协议形状：只留认识的栏，空值丢掉。
 *
 * 模型多塞的键不进日志；`reversibility` 给了不认识的值就整栏丢掉，不静默
 * 降级成 `auto`（那等于把闸拆了），也不报错——此前 intent 只由
 * `dispatch_declare` 交，声明里写错一个字不该把整条声明拒掉。
 */
export function intentSpecOf(raw: unknown): IntentSpec | undefined {
  const value = objectOf(raw)
  if (!value) return undefined
  const spec: IntentSpec = {}
  const impact = objectOf(value.impact)
  if (impact) {
    const paths = stringsOf(impact.paths)
    const services = stringsOf(impact.services)
    const remotes = stringsOf(impact.remotes)
    if (paths || services || remotes) {
      spec.impact = {
        ...(paths ? { paths } : {}),
        ...(services ? { services } : {}),
        ...(remotes ? { remotes } : {}),
      }
    }
  }
  const writes = stringsOf(value.writes)
  const reads = stringsOf(value.reads)
  if (writes) spec.writes = writes
  if (reads) spec.reads = reads
  if (value.reversibility === 'auto' || value.reversibility === 'manual' || value.reversibility === 'none') {
    spec.reversibility = value.reversibility
  }
  const dryRun = objectOf(value.dryRun)
  if (dryRun && typeof dryRun.ok === 'boolean') {
    const detail = typeof dryRun.detail === 'string' && dryRun.detail.trim() ? dryRun.detail.trim() : undefined
    spec.dryRun = { ok: dryRun.ok, ...(detail ? { detail } : {}) }
  }
  const undo = objectOf(value.undo)
  if (undo && typeof undo.kind === 'string' && typeof undo.howto === 'string') {
    const ref = typeof undo.ref === 'string' && undo.ref.trim() ? undo.ref.trim() : undefined
    spec.undo = { kind: undo.kind.trim(), ...(ref ? { ref } : {}), howto: undo.howto.trim() }
  }
  return Object.keys(spec).length > 0 ? spec : undefined
}

/**
 * 把工具参数里的 `plan` 收敛成协议形状：只留 summary / files，空值丢掉。
 *
 * 文件只到「路径 + 大概做什么」，行号和 diff 不进声明——那是执行轮的账本事。
 */
export function planSpecOf(raw: unknown): TicketPlan | undefined {
  const value = objectOf(raw)
  if (!value) return undefined
  const summary = typeof value.summary === 'string' ? value.summary.trim() : ''
  const files = Array.isArray(value.files)
    ? value.files
        .map((item) => objectOf(item))
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item) => {
          const path = typeof item.path === 'string' ? item.path.trim() : ''
          const what = typeof item.what === 'string' ? item.what.trim() : ''
          return { path, ...(what ? { what } : {}) }
        })
        .filter((item) => item.path)
    : []
  if (!summary && files.length === 0) return undefined
  return { ...(summary ? { summary } : {}), ...(files.length ? { files } : {}) }
}

/** 调用编号当幂等键：同一次调用重放不许开第二张票。 */
export function requestIdOf(exec: unknown): string | undefined {
  const callId = (exec as { callId?: unknown } | undefined)?.callId
  return typeof callId === 'string' && callId ? callId : undefined
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * phase 的中文标记：票面只有 status 时，探路中/等放行/排队三档在屏上跟干活
 * 票长得一模一样。只在 phase 有值且不是 `running` 时补，老票不会撑出 undefined。
 *
 * `gated` 必须有一项：它的 status 也是 waiting，不补这一格就跟「干完等人接」
 * 完全分不出来。dispatch_list 的文本不限宽（每行截 200 列），这里用完整短词；
 * 小屏那一行放不下三个汉字，标记由桌宠自己画（见报告）。
 */
const PHASE_MARKS: Record<string, string> = {
  planning: '探路中',
  planned: '待放行',
  queued: '冲突排队',
  gated: '已驳回',
}

/** 票面上给人看的补充：status=blocked 是「等人」，phase=queued 是「等资源」。 */
const STATUS_MARKS: Record<string, string> = {
  blocked: '等人',
}

export function statusMark(status: string | undefined): string {
  const mark = status ? STATUS_MARKS[status] : undefined
  return mark ? `（${mark}）` : ''
}

export function phaseMark(phase: string | undefined): string {
  const mark = phase ? PHASE_MARKS[phase] : undefined
  return mark ? `（${mark}）` : ''
}

export function ticketLine(view: TicketView): string {
  const marks = [
    view.stale ? '!' : '',
    view.pendingInputs ? '»' + view.pendingInputs : '',
    view.pendingReports ? '«' + view.pendingReports : '',
  ].join('')
  return `${marks ? marks + ' ' : ''}${view.id} ${view.status}${statusMark(view.status)}${phaseMark(view.phase)}：${view.brief}`
}

/**
 * intent / plan 的文本行：模型看到的是 render 出来的文本，光有 JSON 字段不够，
 * 所以两个工具都在票行下面各补一两行。太长就截，别把列表撑成报告。
 */
/** 越界项回显用：路径类资源脱掉前缀，和任务书里的路径写法对齐。 */
export function displayPath(uri: string): string {
  return uri.replace(/^(?:file|dir|git|dev):/, '')
}

/**
 * 一条「标签 + 路径清单」：最多列 5 个，多了只报还剩几处。
 *
 * 越界行和交活软提醒的头部共用这一份：两边都是「一串路径给人扫一眼」，截断规则
 * 只该有一处，否则一边列 5 个、另一边列 7 个，看的人还得自己对齐口径。
 */
export function pathListLine(label: string, paths: readonly string[]): string {
  const total = paths.length
  const shown = paths.slice(0, 5).map(displayPath)
  // 路径太长时宁可少列两个，也要把「等 N 处」留在行尾：截断砍掉的恰好是它。
  let line = ''
  for (let count = shown.length; count >= 1; count -= 1) {
    const rest = total - count
    const candidate = `${label}${shown.slice(0, count).join('、')}${rest > 0 ? ` 等 ${rest} 处` : ''}`
    line = candidate
    if (truncateColumns(candidate, 200) === candidate) break
    line = truncateColumns(candidate, 200)
  }
  return line
}

/**
 * 交活软提醒的报告头部：差集非空时拼在报告正文最前面，给主会话看。
 *
 * `dispatch_report` 这一刀只提醒、不拦交活：报告照常落库，票面 status / intent /
 * touched 一个字节不动。判定口径与关票对账共用 `outOfScopePaths`（一样减
 * `intent.reads` 与合理产物白名单），区别只在去向——这里只进报告正文，不写票面
 * `outOfScope`、不推通知；关票才是唯一的记账点。小鱼按提醒补了声明（declare 或
 * 下次 report 带 `paths`），关票时这条自然消失；不补，关票才记一次最终账。
 *
 * 主会话在 `send` 里追加的允许范围只进排队消息，不进 `intent.writes`，所以那条
 * 路不会让这条提醒消失——要消掉只能真去改声明。
 */
export function undeclaredReportHeader(paths: readonly string[]): string {
  return [
    pathListLine('未声明的改动：', paths),
    '    这几处在本票 touched 里，但 intent.writes 没写；主会话 send 里追加的允许范围不算声明。',
    '    补法：dispatch_declare 的 intent.writes，或再交一次 dispatch_report 带 paths；不补，关票时仍按越界记一次。',
  ].join('\n')
}

export function intentPlanLines(view: {
  intent?: IntentSpec
  plan?: TicketPlan
  waitOn?: ConflictWait[]
  weakWith?: string[]
  outOfScope?: string[]
}): string[] {
  const lines: string[] = []
  const plan = view.plan
  if (plan) {
    const files = (plan.files ?? []).map((file) => file.path).filter(Boolean)
    const summary = plan.summary?.trim()
    const tail = files.length ? `（${files.join('、')}）` : ''
    lines.push(`    ${truncateColumns(`plan：${summary ?? ''}${tail}`, 200)}`)
  }
  const intent = view.intent
  if (intent) {
    const parts: string[] = []
    const impact = intent.impact
    for (const [label, list] of [
      ['paths', impact?.paths],
      ['services', impact?.services],
      ['remotes', impact?.remotes],
    ] as const) {
      if (list && list.length) parts.push(`${label} ${list.join(' ')}`)
    }
    if (intent.writes?.length) parts.push(`writes ${intent.writes.length}`)
    if (intent.reads?.length) parts.push(`reads ${intent.reads.length}`)
    if (intent.reversibility) parts.push(`reversibility ${intent.reversibility}`)
    if (intent.undo) parts.push(`undo ${intent.undo.kind}`)
    if (parts.length) lines.push(`    ${truncateColumns(`intent：${parts.join(' · ')}`, 200)}`)
  }
  // 排队与弱冲突各占一行：模型看的是 render 出来的文本，光有 JSON 字段看不见
  // 「为什么这张票没动」。
  for (const wait of view.waitOn ?? []) {
    const resources = wait.resources.length ? ` (${wait.resources.join(' ')})` : ''
    lines.push(`    ${truncateColumns(`waiting on ${wait.ticketId}${resources}`, 200)}`)
  }
  if (view.weakWith?.length) {
    lines.push(`    ${truncateColumns(`weak conflict：${view.weakWith.join('、')}（放行）`, 200)}`)
  }
  // 越界对账：最多列 5 个，多的只报还剩几处；没有越界就一个字都不加。
  if (view.outOfScope?.length) {
    lines.push(`    ${pathListLine('越界：', view.outOfScope)}`)
  }
  return lines
}