import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, DEFAULT_HANDOFF_POLICY } from './config'
import type { Config as ConfigShape } from './config'
import {
  BRIEF_MAX_COLUMNS,
  TicketStore,
  briefIsBlank,
  briefOf,
  truncateColumns,
  isOpen,
  minutesSince,
  pending,
  resolveStateFile,
} from './store'
import type { TicketSnapshot, TicketStatus } from './store'
import { evaluateZombies, shouldPush, summarizeZombies } from './zombie'
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
  /** Short summary for the little screen's second line; capped at briefMaxColumns. */
  brief: string
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

export function toView(
  ticket: TicketSnapshot,
  staleMinutes: number,
  now: Date = new Date(),
  briefMaxColumns: number = BRIEF_MAX_COLUMNS,
): TicketView {
  const ageMinutes = minutesSince(ticket.updatedAt, now)
  const view: TicketView = {
    id: ticket.id,
    goal: ticket.goal,
    // 老票没有存 brief：这里现算一遍，显示侧拿到的永远是能直接上屏的一句。
    brief: briefOf(ticket, briefMaxColumns),
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
  brief: { type: 'string' },
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
  // 重开票不再有推送，但也不能悄悄发生：留一条 info 日志，排「票怎么自己变 open 了」时能查。
  const info = (message: string): void => {
    ;(ctx as { logger?: { info?: (message: string) => void } }).logger?.info?.(message)
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
        brief: {
          type: 'string',
          required: true,
          description:
            'Required. The one line the little screen shows under the ticket title — write a short phrase, not a sentence. At most briefMaxColumns character columns (34 by default), and a 汉字 counts 2, so about 17 汉字 is the ceiling. Empty, whitespace-only or punctuation-only is rejected; nothing is derived from goal any more.',
        },
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
        // brief 是必填的：空着就报错，不再从 goal 派生。派生那条路只留给
        // 老日志的读取侧（见 briefOf），写入侧一律要求调用方写一句给人看的短话。
        if (briefIsBlank(args.brief)) {
          const cap = config.briefMaxColumns
          throw new Error(
            `brief 必填，写一句 ${cap} 列以内的短话（汉字按 2 列算，约 ${Math.max(1, Math.floor(cap / 2))} 个汉字）：这是小屏第二行给人看的那行字，不要静默留空`,
          )
        }
        const brief = truncateColumns(String(args.brief).trim(), config.briefMaxColumns)
        const ticket = store.open(args.goal, args.dir, brief)
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
          .map((ticket) => toView(ticket, staleMinutes, now, config.briefMaxColumns))
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

  // 僵尸票节流：票 id → 上次推送时的指纹（`报告条数|最后活动|状态`）。
  // 故意不用 updatedAt：巡检把排队消息交给活着的 worker、给已关票清账时都会往日志
  // 追加 delivered 事件、也刷 updatedAt，拿它当指纹会让刚推过的票下一轮再推一遍。
  // 没有新报告、状态也没动过，指纹就不变，同一张票只推一次。
  // 进程重启后这段记忆清空，同一张票最多重推一次，接受。
  const zombiePushed = new Map<string, string>()
  const BUSY = new Set(['running', 'streaming', 'thinking', 'tool', 'tool-call', 'cancelling'])

  const agentFor = (id: string | undefined): WakeableAgent | undefined => {
    if (!id) return undefined
    const agents = (ctx as unknown as { agents?: { get?: (id: string) => WakeableAgent | undefined } }).agents
    return agents?.get?.(id)
  }

  /**
   * owner 的 agent 还在不在活表里。
   *
   * AgentRegistry.get(agent.session.id) 是唯一可靠的判活入口（dsh-agent 的
   * registry key 就是 session id），但票里的 owner 是主会话随手填的：可能裸 uuid、
   * 可能带 session- 前缀、也可能是「重启小鱼」这种短标签。短标签查不到活不等于
   * 小鱼死了，所以那种情况返回 undefined，交给静默阈值兜底。
   */
  const agentAlive = (owner: string): boolean | undefined => {
    const agents = (ctx as unknown as { agents?: { get?: (id: string) => unknown } }).agents
    if (!agents?.get) return undefined
    for (const id of idVariants(owner)) {
      if (agents.get(id)) return true
    }
    return false
  }

  /**
   * owner / 子 session id 的前缀变体。票里的 owner 是主会话随手填的：可能裸
   * uuid、可能带 `session-` 前缀；`subagent/end` 给的 id 也可能是这两种写法。
   * 比对时两边都过一遍这组变体，一处实现，判活和收票共用。
   */
  function idVariants(id: string): Set<string> {
    const bare = id.replace(/^session-/, '')
    return new Set([id, bare, `session-${bare}`])
  }

  // 小鱼退出后票不能空挂：宿主在子 session 收尾时广播 `subagent/end`，payload
  // 是 dsh-subagent 的 SubagentRunEndInfo（runId / provider / id / local /
  // stopReason / lastAssistantMessage?），`id` 就是子 session id。
  //
  // 这里只做一件事：把 owner 对得上的 open/running 票落成 waiting，让主会话
  // 知道「小鱼不干了，该你判交付了」。done / dropped 是交付判断，只归主会话
  // （README 那条硬规矩），这个钩子绝不写。
  //
  // 订阅放在 apply 顶层而不是某个开关分支里：noWaitGuard / routerRestrict 关掉
  // 时票照样不能空挂。命中多张票就逐张落 waiting；owner 为空、id 缺失、票在
  // list 和 update 之间消失，都只是跳过，不抛错也不写日志。
  //
  // `subagent/end` 是 dsh-subagent 扩出来的事件，这个包不依赖它，cordis 的
  // keyof Events 里没有这一项，所以按结构收窄后再订阅，不引入新的依赖。
  //
  // 订阅本身也包在 try/catch 里：这个钩子只该让票自动落 waiting，不值得为它
  // 把整个 dispatcher 拖下水。真订阅失败就 warn 一行，dispatch_* 照常工作。
  try {
    ;(ctx as unknown as {
      on(name: string, listener: (information: { id?: string; stopReason?: string }) => unknown): unknown
    }).on('subagent/end', (information) => {
      const finished = typeof information?.id === 'string' ? information.id : ''
      if (!finished) return undefined
      const ended = idVariants(finished)
      for (const ticket of store.list()) {
        if (ticket.status !== 'open' && ticket.status !== 'running') continue
        if (!ticket.owner) continue
        let same = false
        for (const candidate of idVariants(ticket.owner)) {
          if (ended.has(candidate)) {
            same = true
            break
          }
        }
        if (!same) continue
        // 票里的 reports 在这张快照上已经 fold 好了（store.ts 那段 fold），
        // 顺手数一下写进 note：主会话光看备注就知道小鱼到底交没交活，
        // 不用为这个再翻一遍报告。只写 note，status 还是 waiting、绝不写 done。
        const carried = ticket.reports.length
        try {
          store.update(ticket.id, {
            status: 'waiting',
            note: `worker 结束（${String(information.stopReason ?? 'unknown')}），${
              carried === 0 ? '票内无报告' : `票内 ${carried} 条报告`
            }`,
          })
        } catch {
          // 票已经不在日志里：跳过，别把监听器抛进宿主的事件总线。
        }
      }
      return undefined
    })
  } catch (error) {
    warn(
      `[dispatcher] subagent/end 订阅失败，票不会自动落 waiting（dispatch_* 不受影响）：${error instanceof Error ? error.message : String(error)}`,
    )
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
    /** Zombie tickets the pass saw (before throttling), for the log line. */
    stale: number
    /** Entries handed to a live worker this pass (queued inputs, nothing else). */
    delivered: number
    /** Report entries cleared from closed tickets this pass; see the sweep body. */
    cleared: number
    woke: boolean
    reason?: string
  }

  /**
   * One pass over the ticket log: revive tickets that ended but received more
   * mail, push queued messages to workers that are still alive, clear the report
   * entries nobody can read any more, then report zombie tickets — one line,
   * once — to the owner session.
   *
   * It does not deliver reports, and no other thing it does may wake the owner
   * session. A worker hands its report back with `send_message`; the main
   * session reads the log with `dispatch_list`, where a ticket's `«n` counts the
   * reports it has not read. A sweep has no consumer for a report, and carrying
   * one to the owner was the 2026-11-02 flood: the entries stayed `delivered:
   * false` for the life of every ticket, so the first tick after `sweepMinutes`
   * came back from 0 replayed a day of finished work as one message. Reports
   * therefore stay put — pending on an open ticket, cleared from a closed one —
   * and only a zombie ticket is worth a whole main-session turn.
   *
   * This is the half of the prototype's `evaluateDue` that makes sense here. The
   * prototype has an input queue and a report delivery queue per ticket and
   * wakes an ended ticket that still has undelivered inputs; this plugin keeps
   * the same two queues as log entries but only the input queue is a queue with
   * a consumer. What it does not do is any retry bookkeeping beyond "still
   * pending, try on the next sweep".
   */
  async function sweep(): Promise<SweepResult> {
    const now = new Date()
    let delivered = 0
    let cleared = 0

    // A ticket that ended but received more mail *after* it ended reopens — the
    // prototype's `tickets.wake`. A dropped ticket is a person's stop and stays
    // shut. The after-it-ended part is the whole point: an input queued while
    // the ticket was still running never reaches a worker whose session is gone
    // (dispatch_send only hands it over to a live, idle agent), so it sits in the
    // log forever. Counting that as "new mail" is what used to flip finished
    // tickets back to open on the next sweep, with a fresh timestamp.
    // 重开只改状态，不叫醒主会话：报告这条推送线撤掉之后，醒一次只值一条僵尸摘要。
    for (const ticket of store.list()) {
      if (ticket.status !== 'done') continue
      const since = Date.parse(ticket.closedAt ?? ticket.updatedAt)
      const fresh = pending(ticket.inputs).filter((entry) => Date.parse(entry.at) > since)
      if (fresh.length === 0) continue
      store.update(ticket.id, { status: 'open' })
      info(`[dispatcher] ${ticket.id}「${ticket.goal}」结束后又收到新消息，已重新打开（不推送）`)
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

    // 账目清理：已关票上积压的报告没有消费者。小鱼交活走 send_message，巡检从来没
    // 投递过它们的报告，所以 delivered 一直是 false；票一关，更没人会来读。这里只往
    // 日志补一条 delivered（和 quietSweep 一样只动账本、不通知任何人），否则
    // dispatch_list 每轮都报「未读报告 N 条」，日志里永远挂着一堆没人读的未读。
    //
    // 未结票的报告一律**不动**：留在 pending 上，由 dispatch_list 的 «n 显示出来，
    // 主会话自己扫。巡检不替主会话收集报告——收集就是 2026-11-02 那次刷屏的起点。
    for (const ticket of store.list()) {
      if (isOpen(ticket.status)) continue
      for (const entry of pending(ticket.reports)) {
        store.markDelivered(ticket.id, 'report', entry.id)
        cleared += 1
      }
    }

    // 僵尸巡检：主池是 open/running（waiting/blocked 是人按着没动，done/dropped 已结束），
    // 外加一档「waiting 但票里一条报告都没有」——小鱼退了不等于交了活，这种票原来谁都
    // 不看，落 waiting 就彻底失联。它有自己的阈值 noReportMinutes，不吃 zombieMinutes。
    // 判定和摘要都在 ./zombie，这里只做两件事：注入活表查询、按指纹节流。
    const zombies = config.notifyOwner
      ? evaluateZombies(store.list(), {
          now,
          zombieMinutes: config.zombieMinutes,
          noReportMinutes: config.noReportMinutes,
          isAlive: agentAlive,
        })
      : []
    // 不再命中的票（活了、关了、补报了）把指纹扔掉，下次真出事时还能再推一次。
    for (const id of [...zombiePushed.keys()]) {
      if (!zombies.some((hit) => hit.ticket.id === id)) zombiePushed.delete(id)
    }
    const freshZombies = zombies.filter((hit) => shouldPush(hit, zombiePushed))

    // Quiet sweep: 仍然守住「定时器不花主会话的 turn」这条线。报告这条推送线已经整个
    // 撤掉，所以这个分支现在只剩上面那段账目清理的语义——它清的是已关票上没人会读的
    // 报告，不是「替外部脚本先标已读」；未结票的报告一条都不动，外部脚本要发就照发。
    // 僵尸不推、也不记指纹：安静的一轮什么都没宣布，不该把第一次真正的宣布压掉。
    if (config.quietSweep) {
      return { stale: zombies.length, delivered, cleared, woke: false, reason: 'quiet' }
    }

    // 唯一会 followup 的条件：这一轮有没推过的僵尸票。没有就直接返回，一条消息不发。
    if (freshZombies.length === 0) {
      return { stale: zombies.length, delivered, cleared, woke: false }
    }

    const sessionId = resolveOwnerSession()
    const owner = agentFor(sessionId)
    if (!owner?.followup) {
      return { stale: zombies.length, delivered, cleared, woke: false, reason: 'no-session' }
    }
    if (isBusy(owner)) return { stale: zombies.length, delivered, cleared, woke: false, reason: 'busy' }

    // 一句摘要，不带报告正文：报告不再由巡检送，正文进来这条消息就成了第二份报告。
    const text = `（dispatcher 巡检，不是主人发的）${summarizeZombies(freshZombies)}。用 dispatch_list 看一眼，收票或者继续派活。`
    await owner.followup(message(text))
    for (const hit of freshZombies) zombiePushed.set(hit.ticket.id, hit.fingerprint)
    return { stale: zombies.length, delivered, cleared, woke: true }
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
        'Run one sweep now instead of waiting for the timer: reopen tickets that got mail after they ended, push queued messages to live 小鱼, clear report entries left on closed tickets, and report zombie tickets in one line. It does not deliver reports — read those with dispatch_list.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stale: { type: 'number' },
            delivered: { type: 'number' },
            cleared: { type: 'number' },
            woke: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `sweep: ${value.stale} stale, ${value.delivered} delivered to 小鱼, ${value.cleared} cleared, woke=${value.woke}${value.reason ? ` (${value.reason})` : ''}`,
          },
        ],
      },
      async execute() {
        const result = await sweep()
        return {
          stale: result.stale,
          delivered: result.delivered,
          cleared: result.cleared,
          woke: result.woke,
          reason: result.reason ?? '',
        }
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
  // 但「跑在最后」靠不住：有些插件注册得比本插件晚，allow 里的
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
