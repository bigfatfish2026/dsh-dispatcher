/**
 * 报告聚合提醒：每 N 秒把「交完活、变 waiting、报告还没被主会话读过」的票攒成
 * 一条推出去（`notify.ts` 的 `reportDigest`）。
 *
 * 三条边界先写死：
 *
 * - **不自己起定时器。** 挂在票台现有巡检拍子上（`desk.onPulse`），内部按
 *   `reportDigestSeconds` 节流：全机只有 `sweepMs` 那一套调度，热重载只需撤一个
 *   pulse 订阅。代价是 `sweepMs` 0（巡检整个关掉）时这里也不会触发——用户关巡检
 *   就是不要定时器噪音，聚合提醒跟着一起安静。
 * - **已读不另立字段。** 「读过」就是报告条目上的 `delivered`：`dispatch_read`
 *   追加一条 `delivered` 事件把它置位（`desk.ts` 的 `read()`）。这里只读它、
 *   不写、也不往票面加 reportSeq 之类的新账。
 * - **「已提醒」是本进程的小状态。** 票号 → 那一批里最新的未读报告 id：同一个
 *   id 不再发（同一批不二次发），同一张票又交新报告（id 变）就再提醒一次。进程
 *   重启后这份状态清空——那一刻票还等着人读，重发一条不算错，票面因此不用加字段。
 *
 * 没有待提醒的票就一条都不发：定时刷「暂无」是噪音，不是提醒。
 */
import { REPORT_DIGEST_MAX_LINES, REPORT_DIGEST_SUMMARY_COLUMNS } from '../defaults'
import { briefOf, isOpen, pending, truncateColumns } from '../store'
import type { TicketEntry, TicketSnapshot } from '../store'
import type { Clock } from './clock'
import type { DigestTicket, ReportDigestInput } from './notify'

/** 这一批里的一张票：对外那几栏 + 记账用的最新报告 id。 */
interface BatchTicket extends DigestTicket {
  /** 投递成功后拿它记「已提醒」；同一张票的下一条报告会有新 id。 */
  latest: string
}

export interface ReportDigestDeps {
  /** 扫哪些票：直接给日志快照（`log.list()`）。 */
  tickets: () => readonly TicketSnapshot[]
  clock: Clock
  /** 窗口秒数；0 或负数 = 关（一拍都不扫、一条都不发）。 */
  seconds: number
  /** brief 的列宽上限，跟 `dispatch_list` 一个口径。 */
  briefMaxColumns: number
  /** 攒够一批投出去；返回 false = 没送出去，这批不标记，下一个窗口重试。 */
  send: (input: ReportDigestInput) => Promise<boolean>
  warn?: (message: string) => void
  /** 一条最多列几张，默认 `REPORT_DIGEST_MAX_LINES`；测试可以调小看「还有 N 张」。 */
  maxLines?: number
}

export interface ReportDigest {
  /**
   * 巡检拍完之后调一次。不到窗口、窗口内没有待提醒的票、投递失败都返回 false；
   * 真发出去一条才返回 true。不抛：提醒失败不该让巡检跟着失败。
   */
  tick(now?: Date): Promise<boolean>
  /** 停用：清掉「已提醒」状态，之后 `tick` 一律 false。 */
  dispose(): void
}

/** 一行摘要：报告正文第一条非空行，压掉多余空白，按列宽截断。 */
function summaryOf(entry: TicketEntry): string {
  const line = entry.text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return line ? truncateColumns(line, REPORT_DIGEST_SUMMARY_COLUMNS) : ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createReportDigest(deps: ReportDigestDeps): ReportDigest {
  const maxLines = Math.max(1, deps.maxLines ?? REPORT_DIGEST_MAX_LINES)
  /** 上一次真扫的毫秒数；undefined = 还没扫过，第一拍就扫。 */
  let lastAt: number | undefined
  let stopped = false
  /** 票号 → 已提醒到哪条报告（最新的未读报告 id）。 */
  const alerted = new Map<string, string>()

  /** 窗口内该提醒的票，按日志顺序（老的先列）；顺手清掉不在 waiting 的旧键。 */
  function collect(): BatchTicket[] {
    const batch: BatchTicket[] = []
    const waiting = new Set<string>()
    for (const ticket of deps.tickets()) {
      if (!isOpen(ticket.status)) continue
      const unread = pending(ticket.reports)
      if (ticket.status !== 'waiting' || unread.length === 0) continue
      waiting.add(ticket.id)
      const latest = unread[unread.length - 1]
      if (!latest) continue
      // 这一批已经提过、之后没有新报告：不再发。
      if (alerted.get(ticket.id) === latest.id) continue
      batch.push({
        ticketId: ticket.id,
        brief: briefOf(ticket, deps.briefMaxColumns),
        reports: unread.length,
        summary: summaryOf(latest),
        latest: latest.id,
      })
    }
    // 票已经不在 waiting 了：键跟着摘，状态表不慢慢长。
    for (const id of [...alerted.keys()]) {
      if (!waiting.has(id)) alerted.delete(id)
    }
    return batch
  }

  return {
    async tick(now = deps.clock.now()) {
      if (stopped || deps.seconds <= 0) return false
      const at = now.getTime()
      // 节流按「上一次真扫」算：窗口内的每一拍直接放掉，不排队也不攒定时器。
      if (lastAt !== undefined && at - lastAt < deps.seconds * 1000) return false
      lastAt = at
      const batch = collect()
      if (batch.length === 0) return false
      const shown = batch.slice(0, maxLines)
      let sent = false
      try {
        sent = await deps.send({
          tickets: shown.map(({ latest, ...ticket }) => ticket),
          more: batch.length - shown.length,
        })
      } catch (error) {
        deps.warn?.(`报告聚合提醒没送出去：${messageOf(error)}`)
        return false
      }
      // 没送出去就不标记：票还等着人读，下一个窗口再试。
      if (!sent) return false
      for (const ticket of shown) alerted.set(ticket.ticketId, ticket.latest)
      return true
    },
    dispose() {
      stopped = true
      alerted.clear()
    },
  }
}
