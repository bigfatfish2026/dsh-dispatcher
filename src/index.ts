import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, DEFAULT_HANDOFF_POLICY } from './config'
import type { Config as ConfigShape } from './config'
import { TicketStore, isOpen, minutesSince, pending, resolveStateFile } from './store'
import type { TicketSnapshot, TicketStatus } from './store'
import { isWorkerSession, noWaitReason } from './no-wait'
import { sendProgress } from './progress'
import { bindRouter } from './router'
import type { RouterAgent, RouterBinding } from './router'

export const name = 'dsh-dispatcher'
export const inject = ['tools', 'agents']

// Re-export the schema so the loader can validate this plugin's config.
export { Config }

const STATUSES = ['open', 'running', 'waiting', 'blocked', 'done', 'dropped'] as const

/** One ticket as a plain JSON object, which is what a tool may return. */
export interface TicketView {
  id: string
  goal: string
  status: TicketStatus
  dir?: string
  note?: string
  owner?: string
  ageMinutes: number
  stale: boolean
  /** Messages queued for the worker that have not reached it yet. */
  pendingInputs: number
  /** Reports the worker handed back that the main session has not read yet. */
  pendingReports: number
}

export function toView(ticket: TicketSnapshot, staleMinutes: number, now: Date = new Date()): TicketView {
  const ageMinutes = minutesSince(ticket.updatedAt, now)
  const view: TicketView = {
    id: ticket.id,
    goal: ticket.goal,
    status: ticket.status,
    ageMinutes,
    stale: isOpen(ticket.status) && ageMinutes >= staleMinutes,
    pendingInputs: pending(ticket.inputs ?? []).length,
    pendingReports: pending(ticket.reports ?? []).length,
  }
  // Tool output must be lossless JSON: leave absent fields out instead of
  // carrying `undefined`, which the tool layer rejects.
  if (ticket.dir) view.dir = ticket.dir
  if (ticket.note) view.note = ticket.note
  if (ticket.owner) view.owner = ticket.owner
  return view
}

/**
 * The hand-off rules that used to be hard-coded here. The text now lives in the
 * config schema as its default, so the operator can rewrite it in cordis.yml
 * without a rebuild; this alias stays for callers that only want the wording
 * the plugin ships with. The tools alone do not change behaviour: without this
 * the session still sits on long work and the person waits.
 */
export const HANDOFF_POLICY = DEFAULT_HANDOFF_POLICY

const ticketProperties = {  id: { type: 'string' },
  goal: { type: 'string' },
  status: { type: 'string' },
  dir: { type: 'string' },
  note: { type: 'string' },
  owner: { type: 'string' },
  ageMinutes: { type: 'number' },
  stale: { type: 'boolean' },
  pendingInputs: { type: 'number' },
  pendingReports: { type: 'number' },
} as const

/**
 * The dispatcher: a ticket log plus the tools the main session uses to hand work
 * to worker subagents and to keep track of what is still running.
 *
 * It deliberately owns no execution. A worker is a subagent the main session
 * spawns; this plugin only records what was handed out, where it stands, and
 * whether anything has gone quiet for too long.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const store = new TicketStore(resolveStateFile(config.stateFile))
  const staleMinutes = config.staleMinutes
  const warn = (message: string): void => {
    ;(ctx as { logger?: { warn?: (message: string) => void } }).logger?.warn?.(message)
  }

  // The wording comes from config; an empty block means "do not inject this
  // section at all", which is the same thing handoffPolicy: false does.
  const handoffText = config.handoffPolicy ? (config.handoffPolicyText ?? '').trim() : ''
  if (handoffText) {
    let announced = false
    // `system-prompt/assemble` is a waterfall every turn goes through when it
    // builds its request. Workers get their own brief from the delegation, so
    // the hand-off rules go to the parent sessions only.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const header = (context as { agent?: { session?: { header?: { origin?: string } } } })?.agent?.session?.header
      if (header?.origin === 'subagent') return assembled
      if (!announced) {
        announced = true
        ;(ctx as { logger?: { info?: (message: string) => void } }).logger?.info?.(
          `[dispatcher] hand-off policy injected into the main session prompt (${handoffText.length} chars, from handoffPolicyText)`,
        )
      }
      return {
        ...assembled,
        sections: [
          ...assembled.sections,
          { name: 'dispatcher:handoff', order: 95, text: handoffText },
        ],
      }
    })
  }

  if (config.noWaitGuard) {
    const limits = { maxCommandMs: config.maxCommandMs, maxWaitMs: config.maxWaitMs }
    // The prompt section above asks the main session not to sit on long work;
    // this makes it hold. Upstream caps the router shell at five seconds and
    // guards the same three shapes, because an instruction the model may ignore
    // is not a guarantee. Sessions that already exist when the plugin loads get
    // the guard too, or a reload would only protect the next one.
    const guarded = new WeakSet<object>()
    let announced = false
    const install = (agent: {
      session: { header: { origin?: string } }
      ctx: { effect: (callback: () => () => void, label?: string) => unknown
        tools: { guard: (guard: (execution: { name: string; arguments: unknown }) => string | undefined) => () => void } }
    }): void => {
      if (isWorkerSession(agent.session.header.origin) || guarded.has(agent)) return
      guarded.add(agent)
      agent.ctx.effect(
        () =>
          agent.ctx.tools.guard((execution) =>
            noWaitReason(execution.name, (execution.arguments ?? {}) as Record<string, unknown>, limits),
          ),
        'dsh-dispatcher.no-wait',
      )
      if (!announced) {
        announced = true
        ;(ctx as { logger?: { info?: (message: string) => void } }).logger?.info?.(
          '[dispatcher] waiting guard installed on the main session',
        )
      }
    }
    for (const agent of ctx.agents.list()) install(agent)
    ctx.on('agent/created', ({ agent }) => {
      install(agent)
      return undefined
    })
  }

  ctx.tools.register(
    defineTool({
      name: 'dispatch_open',
      description:
        'Open a ticket for work handed to a 小鱼. Call this right after spawning the 小鱼, before answering the person.',
      parameters: {
        goal: { type: 'string', required: true, description: 'What the 小鱼 was asked to do, in one sentence.' },
        dir: { type: 'string', description: 'Working directory the 小鱼 uses, if any.' },
        owner: { type: 'string', description: '小鱼 handle: subagent id or a short label.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            openCount: { type: 'number' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `ticket ${value.id} opened (${value.openCount} open)` }],
      },
      async execute(args) {
        const openCount = store.list().filter((ticket) => isOpen(ticket.status)).length
        if (openCount >= config.maxOpen) {
          throw new Error(
            `too many open tickets (${openCount}/${config.maxOpen}); close one or raise maxOpen before handing out more work`,
          )
        }
        const ticket = store.open(args.goal, args.dir)
        if (args.owner) store.update(ticket.id, { owner: args.owner, status: 'running' })
        return {
          id: ticket.id,
          status: args.owner ? 'running' : 'open',
          openCount: openCount + 1,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_touch',
      description: 'Record progress on a ticket: status change and an optional one-line note.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        status: { type: 'string', required: true, enum: STATUSES, description: 'New status.' },
        note: { type: 'string', description: 'Latest progress in one line.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `ticket ${value.id}: ${value.status}${value.note ? ` — ${value.note}` : ''}` },
        ],
      },
      async execute(args) {
        const ticket = store.update(args.id, { status: args.status, note: args.note })
        return { id: ticket.id, status: ticket.status, note: ticket.note ?? '' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_list',
      description:
        'List tickets, oldest first. A leading ! marks a ticket that has gone quiet; »n counts messages the 小鱼 has not received yet, «n counts its reports this session has not read.',
      parameters: {
        status: { type: 'string', enum: STATUSES, description: 'Only tickets with this status.' },
        includeClosed: {
          type: 'boolean',
          description: 'Include done and dropped tickets. Defaults to false.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tickets: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: ticketProperties },
            },
            openCount: { type: 'number' },
            staleCount: { type: 'number' },
          },
        },
        render: (_args, value) => {
          const tickets = value.tickets ?? []
          if (tickets.length === 0) return [{ type: 'text', text: 'no tickets' }]
          const lines = tickets.map((ticket) => {
            // `»n` is n messages the worker has not received yet; `«n` is n
            // reports it handed back that this session has not read yet.
            const queued = [
              ticket.pendingInputs ? `»${ticket.pendingInputs}` : '',
              ticket.pendingReports ? `«${ticket.pendingReports}` : '',
            ]
              .filter(Boolean)
              .join(' ')
            return `${ticket.stale ? '!' : ' '} ${ticket.id} ${(ticket.status ?? '').padEnd(8)} ${ticket.ageMinutes}m ${queued.padEnd(6)} ${ticket.goal}`
          })
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        const now = new Date()
        const tickets = store
          .list()
          .filter((ticket) =>
            args.status ? ticket.status === args.status : args.includeClosed || isOpen(ticket.status),
          )
          .map((ticket) => toView(ticket, staleMinutes, now))
        return {
          tickets,
          openCount: tickets.filter((ticket) => isOpen(ticket.status)).length,
          staleCount: tickets.filter((ticket) => ticket.stale).length,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_close',
      description: 'Close a ticket once its work is delivered or abandoned.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        outcome: {
          type: 'string',
          enum: ['done', 'dropped'] as const,
          description: 'done when delivered, dropped when there was nothing to deliver. Defaults to done.',
        },
        note: { type: 'string', description: 'How it ended, in one line.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            openCount: { type: 'number' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `ticket ${value.id} ${value.status} (${value.openCount} open)` },
        ],
      },
      async execute(args) {
        const status: TicketStatus = args.outcome ?? 'done'
        const ticket = store.update(args.id, { status, note: args.note })
        const openCount = store.list().filter((item) => isOpen(item.status)).length
        return { id: ticket.id, status: ticket.status, openCount }
      },
    }),
  )

  // ── 巡检：主动看一眼有没有票卡住了 ──────────────────────────────
  // 原型的 Passes 是两秒心跳加到期唤醒，这里只缩成一件事：定时看票，
  // 卡住的就往主人会话 followup 一条，把它叫醒。会话忙就等下一轮，不丢。

  const prefsPath = config.qqPrefsPath.replace(/^~(?=$|\/)/, homedir())

  function resolveOwnerSession(): string {
    if (config.ownerSessionId) return config.ownerSessionId
    try {
      const data = JSON.parse(readFileSync(prefsPath, 'utf8')) as { sessionIds?: Record<string, string> }
      const keys = Object.keys(data.sessionIds ?? {}).filter((key) => key.split(':')[2] === 'c2c')
      const own = keys.filter((key) => config.ownerOpenId && key.endsWith(`:${config.ownerOpenId}`))
      const pick = own[0] ?? (keys.length === 1 ? keys[0] : keys[keys.length - 1])
      return pick ? String(data.sessionIds?.[pick] ?? '') : ''
    } catch {
      return ''
    }
  }

  interface WakeableAgent {
    status?: string
    followup?: (message: unknown) => Promise<unknown>
    steer?: (message: unknown) => Promise<unknown>
    inject?: (message: unknown) => Promise<unknown>
  }

  // 票 id → 上次提醒时的更新时间。票没动过就不再叫第二遍。
  const notified = new Map<string, number>()
  const BUSY = new Set(['running', 'streaming', 'thinking', 'tool', 'tool-call', 'cancelling'])

  const agentFor = (id: string | undefined): WakeableAgent | undefined => {
    if (!id) return undefined
    const agents = (ctx as unknown as { agents?: { get?: (id: string) => WakeableAgent | undefined } }).agents
    return agents?.get?.(id)
  }
  const isBusy = (agent: WakeableAgent | undefined): boolean =>
    agent?.status !== undefined && BUSY.has(String(agent.status))
  const message = (text: string) => ({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'dsh-dispatcher' },
  })

  interface SweepResult {
    stale: number
    delivered: number
    woke: boolean
    reason?: string
  }

  /**
   * One pass over the ticket log: revive tickets that ended but received more
   * mail, push queued messages to workers that are still alive, then carry
   * undelivered reports and quiet tickets to the owner session.
   *
   * This is the half of the prototype's `evaluateDue` that makes sense here.
   * The prototype has an input queue and a report delivery queue per ticket and
   * wakes an ended ticket that still has undelivered inputs; this plugin keeps
   * the same two queues as log entries and does the same two things with them.
   * What it does not do is any retry bookkeeping beyond "still pending, try on
   * the next sweep".
   */
  async function sweep(): Promise<SweepResult> {
    const now = new Date()
    let delivered = 0
    const notices: string[] = []

    // A ticket that ended but received more mail *after* it ended reopens — the
    // prototype's `tickets.wake`. A dropped ticket is a person's stop and stays
    // shut. The after-it-ended part is the whole point: an input queued while
    // the ticket was still running never reaches a worker whose session is gone
    // (dispatch_send only hands it over to a live, idle agent), so it sits in the
    // log forever. Counting that as "new mail" is what used to flip finished
    // tickets back to open on the next sweep, with a fresh timestamp.
    for (const ticket of store.list()) {
      if (ticket.status !== 'done') continue
      const since = Date.parse(ticket.closedAt ?? ticket.updatedAt)
      const fresh = pending(ticket.inputs).filter((entry) => Date.parse(entry.at) > since)
      if (fresh.length === 0) continue
      store.update(ticket.id, { status: 'open' })
      notices.push(`${ticket.id}「${ticket.goal}」结束后又收到新消息，已重新打开`)
    }

    // Queued messages go to the worker, if its session is still alive and idle.
    for (const ticket of store.list()) {
      if (!isOpen(ticket.status)) continue
      const queued = pending(ticket.inputs)
      if (queued.length === 0) continue
      const worker = agentFor(ticket.owner)
      if (!worker?.steer || isBusy(worker)) continue
      for (const entry of queued) {
        await worker.steer(message(entry.text))
        store.markDelivered(ticket.id, 'input', entry.id)
        delivered += 1
      }
    }

    // Reports and quiet tickets both need the owner session; one message carries both.
    const reports = store
      .list()
      .flatMap((ticket) => pending(ticket.reports).map((entry) => ({ ticket, entry })))
    const stale = store
      .list()
      .filter((ticket) => isOpen(ticket.status) && minutesSince(ticket.updatedAt, now) >= staleMinutes)
      .filter((ticket) => notified.get(ticket.id) !== Date.parse(ticket.updatedAt))
    const wantReports = reports.length > 0
    const wantStale = config.notifyOwner && stale.length > 0

    // Quiet sweep: never wake the owner session. One followup costs a whole
    // session turn with all of its context, so when an outside script pushes the
    // reports to QQ the sweep only keeps the log honest: mark the reports
    // delivered and refresh the stale snapshot so nothing is announced twice.
    if (config.quietSweep) {
      for (const { ticket, entry } of reports) {
        store.markDelivered(ticket.id, 'report', entry.id)
        delivered += 1
      }
      for (const ticket of stale) notified.set(ticket.id, Date.parse(ticket.updatedAt))
      return { stale: stale.length, delivered, woke: false, reason: 'quiet' }
    }

    if (!wantReports && !wantStale && notices.length === 0) {
      return { stale: stale.length, delivered, woke: false }
    }

    const sessionId = resolveOwnerSession()
    const owner = agentFor(sessionId)
    if (!owner?.followup) return { stale: stale.length, delivered, woke: false, reason: 'no-session' }
    if (isBusy(owner)) return { stale: stale.length, delivered, woke: false, reason: 'busy' }

    const lines: string[] = []
    if (wantReports) {
      for (const { ticket, entry } of reports) {
        lines.push(`小鱼 交回 ${ticket.id}「${ticket.goal}」：${entry.text}`)
      }
    }
    for (const notice of notices) lines.push(notice)
    if (wantStale) {
      for (const ticket of stale) {
        lines.push(`${ticket.id}「${ticket.goal}」${ticket.status}，${minutesSince(ticket.updatedAt, now)} 分钟没动静`)
      }
    }
    const text = `（dispatcher 巡检，不是主人发的）${lines.join('；')}。用 dispatch_list 看一眼，收票或者继续派活。`
    await owner.followup(message(text))
    for (const { ticket, entry } of reports) {
      store.markDelivered(ticket.id, 'report', entry.id)
      delivered += 1
    }
    for (const ticket of stale) notified.set(ticket.id, Date.parse(ticket.updatedAt))
    return { stale: stale.length, delivered, woke: true }
  }

  if (config.sweepMinutes > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void sweep()
      }, Math.max(1, config.sweepMinutes) * 60_000)
      return () => clearInterval(timer)
    }, 'dsh-dispatcher.sweep')
  }

  ctx.tools.register(
    defineTool({
      name: 'dispatch_sweep',
      description:
        'Run one sweep now instead of waiting for the timer: deliver queued reports and quiet tickets to the owner session, and push queued messages to live 小鱼.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stale: { type: 'number' },
            delivered: { type: 'number' },
            woke: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `sweep: ${value.stale} stale, ${value.delivered} delivered, woke=${value.woke}${value.reason ? ` (${value.reason})` : ''}`,
          },
        ],
      },
      async execute() {
        const result = await sweep()
        return { stale: result.stale, delivered: result.delivered, woke: result.woke, reason: result.reason ?? '' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_send',
      description:
        'Queue one more message for a ticket\'s 小鱼. If the 小鱼 session is alive and idle it receives it at once; otherwise the message stays in the ticket log and a later sweep or the 小鱼 picks it up.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        text: { type: 'string', required: true, description: 'What the 小鱼 should hear, in the person\'s own terms.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            pendingInputs: { type: 'number' },
            delivered: { type: 'boolean' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `ticket ${value.id}: ${value.delivered ? 'sent now' : 'queued'} (${value.pendingInputs} pending)`,
          },
        ],
      },
      async execute(args) {
        const { ticket, entry } = store.appendInput(args.id, args.text)
        const worker = agentFor(ticket.owner)
        let delivered = false
        if (worker?.steer && !isBusy(worker)) {
          await worker.steer(message(args.text))
          store.markDelivered(ticket.id, 'input', entry.id)
          delivered = true
        }
        const after = store.get(ticket.id)!
        return { id: ticket.id, pendingInputs: pending(after.inputs).length, delivered }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_report',
      description:
        'Record a report on a ticket without ending it. The main session reads it on its next turn or sweep, and it survives a restart because it lives in the ticket log. A 小鱼 (a subagent) calls this with the ticket id it was given.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        text: { type: 'string', required: true, description: 'What the 小鱼 has to say: result, numbers, where the work stands.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            pendingReports: { type: 'number' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `ticket ${value.id}: report recorded (${value.pendingReports} unread)` },
        ],
      },
      async execute(args) {
        const { ticket } = store.appendReport(args.id, args.text)
        const after = store.get(ticket.id)!
        return { id: ticket.id, pendingReports: pending(after.reports).length }
      },
    }),
  )

  // ── 打点：一行进度直接推到主人手机上 ────────────────────────────
  // 原型靠 heartbeat 脚本扫 progress/ 再推，插件这边一步到位：worker 调工具，
  // 工具跑 notify.sh，主人手机上就出现了这一行。不写 jsonl、不叫醒任何会话。
  // 推送失败只在日志里记一笔，不抛给模型——打点是顺手的礼貌，不该拖住干活。
  ctx.tools.register(
    defineTool({
      name: 'progress_note',
      description:
        'Push one line of progress straight to the person on QQ. Call it every minute or two while a long job runs, and once more when it ends: the plugin sends it, no session is woken and nothing is written to disk.',
      parameters: {
        text: { type: 'string', required: true, description: 'One line of progress, short and in the person\'s own terms.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sent: { type: 'boolean' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: value.sent ? 'progress pushed to the person' : 'progress not pushed (notify failed)' },
        ],
      },
      async execute(args) {
        const result = await sendProgress(args.text, {
          script: config.notifyScript,
          timeoutMs: config.notifyTimeoutMs,
          log: warn,
        })
        return { sent: result.sent }
      },
    }),
  )

  // ── 主会话白名单 + worker 反向名单 ──────────────────────────────
  // 模型还是会自己决定怎么干活；能保证的只有一件事——重活在主会话里没有
  // 工具可调，于是「派出去」不再和「在这儿干」竞争，长任务也卡不住回话。
  // worker 这边只摘一样东西：写记忆的工具（workerDenyTools）。记忆写权限
  // 只归主会话，这是第二层，第一层是 dsh-memory 在 execute 里的守卫。
  //
  // 顺序是有讲究的：这一段必须跑在所有 `ctx.tools.register` 之后。装载器会
  // 在安装白名单时拿 allow 名单去注册表里点名，点不到的就按「名字写错」剔掉；
  // 热重载时旧注册刚释放、新注册还没落地，先装白名单就会把本插件自己的
  // dispatch_* 当成错名扔掉，主会话随即少七个工具。启动路径也吃这一条：
  // 那时 agents.list() 是空的，白名单留给 agent/created，注册已经完成。
  //
  // 但「跑在最后」靠不住：外部插件注册得比本插件晚，allow 里的
  // 名字当时还不存在。所以每个 agent 留一个 binding，listen `tools/change`
  // 补装——白名单的最终内容按「加载完成后注册表里真实有的名字」算，不是
  // 按第一次安装那一刻。
  if (config.routerRestrict || config.workerToolDeny) {
    const routerSeen = new WeakSet<object>()
    const bindings = new Set<RouterBinding>()
    const bound = new WeakMap<object, RouterBinding>()
    let announced = false
    let workerAnnounced = false
    const log = (message: string): void => {
      ;(ctx as { logger?: { warn?: (message: string) => void } }).logger?.warn?.(message)
    }
    const info = (message: string): void => {
      ;(ctx as { logger?: { info?: (message: string) => void } }).logger?.info?.(message)
    }
    // The self-test must not read through this agent's own restriction: once
    // the first pass is in, every name it hid reads as unregistered. The plain
    // plugin context answers from the global view instead, which no scoped
    // restriction can filter.
    const registry = {
      get(name: string): unknown {
        const tools = (ctx as { tools?: { get?: (name: string) => unknown } }).tools
        return tools?.get?.(name)
      },
      // Two readers now. The worker deny list's safety check wants the whole
      // projection; the router asks for it lazily, only about names `get` has
      // already said no to — the global view is the authority for a global
      // tool, and a preset's agent-plane tool never appears here at all, which
      // is why the router also treats anything already installed as known.
      names(): readonly string[] {
        const tools = (ctx as { tools?: { schemas?: () => readonly { name: string }[] } }).tools
        try {
          return (tools?.schemas?.() ?? []).map((schema) => schema.name)
        } catch {
          return []
        }
      },
    }
    const options = {
      allow: config.routerTools,
      deny: config.workerToolDeny ? config.workerDenyTools : [],
      escapeFile: config.routerEscapeFile,
      log,
      info,
      registry,
    }
    const install = (agent: RouterAgent): void => {
      // Two independent switches: routerRestrict decides whether the main
      // session is trimmed, workerToolDeny whether a subagent loses the
      // memory-writing tools. Turning one off must not turn the other off.
      const worker = isWorkerSession(agent.session.header.origin)
      if (worker ? !config.workerToolDeny : !config.routerRestrict) return
      let binding = bound.get(agent)
      if (binding === undefined) {
        if (routerSeen.has(agent)) return
        routerSeen.add(agent)
        binding = bindRouter(agent, options)
        bound.set(agent, binding)
        bindings.add(binding)
      } else {
        binding.sync()
      }
      const outcome = binding.outcome()
      if (worker) {
        if ((outcome === 'denied' || outcome === 'updated') && !workerAnnounced) {
          workerAnnounced = true
          info(
            `[dispatcher] worker subagents hide ${binding.installed().length} memory-write tool(s): ${binding.installed().join(', ')}`,
          )
        }
        return
      }
      if ((outcome === 'installed' || outcome === 'updated') && !announced) {
        announced = true
        info(
          `[dispatcher] router whitelist installed on the main session (${binding.installed().length}/${config.routerTools.length} tools registered)`,
        )
      }
    }
    // Sessions that already exist when the plugin loads get it too, or a reload
    // would only protect the next one. The self-test inside runs here, which is
    // also how a wrong name shows up in the log at load time.
    for (const agent of ctx.agents.list()) install(agent)
    ctx.on('agent/created', ({ agent }) => {
      install(agent)
      return undefined
    })
    // `tools/change` fires for a registration, an unregistration, and a scoped
    // restriction change. Our own reinstall fires it too, which is why `sync`
    // short-circuits on an unchanged list instead of reinstalling blindly.
    ctx.on('tools/change', () => {
      for (const binding of bindings) binding.sync()
      return undefined
    })
  }
}
