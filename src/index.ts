import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, DEFAULT_HANDOFF_POLICY, routerAllowList } from './config'
import type { Config as ConfigShape } from './config'
import {
  BRIEF_MAX_COLUMNS,
  TicketStore,
  briefIsBlank,
  createTicketBackend,
  briefOf,
  truncateColumns,
  isOpen,
  minutesSince,
  pending,
  resolveStateFile,
} from './store'
import type { TicketBroadcast, TicketSnapshot, TicketStatus } from './store'
import { hasIdFragment, idVariants, matchesId } from './ids'
import { evaluateZombies, shouldPush, summarizeZombies } from './zombie'
import type { ZombieHit } from './zombie'
import { isWorkerSession, noWaitReason } from './no-wait'
import { sendProgress } from './progress'
import { bindRouter } from './router'
import type { RouterAgent, RouterBinding } from './router'

// 票事件：store 每追加一行成功就广播一条，监听方按 id 处理受影响的那张票。
// 事件只带 { id, at, kind }，要看内容就从 store 的投影读——投影已经折好了，
// 监听方不该各读一遍日志。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'dispatcher/ticket'(payload: TicketBroadcast): void
  }
}

export const name = 'dsh-dispatcher'
export const inject = ['tools', 'agents']

// Re-export the schema so the loader can validate this plugin's config.
export { Config }

const STATUSES = ['open', 'running', 'waiting', 'blocked', 'done', 'dropped'] as const

/**
 * worker 无论配置怎么写都不该拿到的本包工具：写 status、开票关票、扫票、
 * 绕过票直接推手机。
 *
 * 名单按 README「谁写 status」那节定：worker 手上只该有 `dispatch_report` 和
 * `dispatch_send`，两条都只往队列里追加行，碰不到 status。`dispatch_open` 还会
 * 占 `maxOpen` 名额，`dispatch_sweep` 能把主会话叫醒，`progress_note` 正是
 * 派活规矩里明令不许 worker 走的那条推送绕路。
 *
 * 它拼在 `workerDenyTools` 之后、不进 config 默认值：operator 改写
 * `workerDenyTools` 不该顺手把这几样放回 worker 手里。
 */
export const WORKER_FORBIDDEN_TOOLS = [
  'dispatch_open',
  // 2026-11-04：报告只归主会话读——worker 读了自己那张票上别的小鱼写的报告，
  // «n 就被它悄悄清掉，主会话还以为没人交活。
  'dispatch_reports',
  'dispatch_touch',
  'dispatch_close',
  'dispatch_sweep',
  'progress_note',
] as const

/** One ticket as a plain JSON object, which is what a tool may return. */
export interface TicketView {
  id: string
  goal: string
  /** Short summary for the little screen's second line; capped at briefMaxColumns. */
  brief: string
  status: TicketStatus
  dir?: string
  note?: string
  /** Human label for the worker; what the little screen shows. */
  owner?: string
  /** The worker's session id, when the ticket was opened with one. */
  ownerId?: string
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
  if (ticket.ownerId) view.ownerId = ticket.ownerId
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

/**
 * Queue of ticket-event work started by `emit`, keyed by the plugin context.
 * The host never needs it; tests await it instead of guessing how many
 * microtasks a delivery takes. Kept out of the context object itself so a
 * reloaded plugin does not leave a stale queue behind.
 */
export const ticketEventQueue = new WeakMap<object, () => Promise<void>>()

const ticketProperties = {  id: { type: 'string' },
  goal: { type: 'string' },
  brief: { type: 'string' },
  status: { type: 'string' },
  dir: { type: 'string' },
  note: { type: 'string' },
  owner: { type: 'string' },
  ownerId: { type: 'string' },
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
  const staleMinutes = config.staleMinutes
  const warn = (message: string): void => {
    ;(ctx as { logger?: { warn?: (message: string) => void } }).logger?.warn?.(message)
  }
  // 重开票不再有推送，但也不能悄悄发生：留一条 info 日志，排「票怎么自己变 open 了」时能查。
  const info = (message: string): void => {
    ;(ctx as { logger?: { info?: (message: string) => void } }).logger?.info?.(message)
  }
  // 日志里读不过来的行（崩溃留下的半截行、一行 null）不静默：跳过之后记一条 warn，
  // 不然「有一张票莫名不见了」只能靠猜。
  // 第三个参数是广播：append 成功后发一条票事件，内部写入（quiet）不发。测试里的假
  // ctx 没有事件总线，所以按可选成员探一下，不能假定宿主一定有 emit。
  // 后端按 config.store.backend 选（默认 jsonl）；redis/sqlite 现在只有名字，
  // 选了就在装载时抛错，不会悄悄退回文件。坏行由后端自己 warn，所以这里的
  // 第二栏留空（只有传路径时才用它）。
  const store = new TicketStore(
    createTicketBackend({ backend: config.store?.backend, stateFile: resolveStateFile(config.stateFile) }, warn),
    undefined,
    (event) => {
      ;(ctx as unknown as { emit?: (name: string, payload: unknown) => void }).emit?.('dispatcher/ticket', event)
    },
  )

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
    // guard 装在各会话的 ctx 上，所以它有两个拥有者：会话先没了走 agent.ctx 的
    // effect，插件先没了（卸载 / 热重载）走下面那个插件级 teardown。两边都会调到，
    // release 自己幂等，撤第二次什么也不做。
    const guardReleases = new Set<() => void>()
    let announced = false
    const install = (agent: {
      session: { header: { origin?: string } }
      ctx: { effect: (callback: () => () => void, label?: string) => unknown
        tools: { guard: (guard: (execution: { name: string; arguments: unknown }) => string | undefined) => () => void } }
    }): void => {
      if (isWorkerSession(agent.session.header.origin) || guarded.has(agent)) return
      guarded.add(agent)
      let stopGuard: (() => void) | undefined = agent.ctx.tools.guard((execution) =>
        noWaitReason(execution.name, (execution.arguments ?? {}) as Record<string, unknown>, limits),
      )
      const release = (): void => {
        const stop = stopGuard
        stopGuard = undefined
        guardReleases.delete(release)
        stop?.()
      }
      guardReleases.add(release)
      // 两个拥有者：会话先没了走这里；插件先没了走下面的 teardown。release 幂等。
      agent.ctx.effect(() => release, 'dsh-dispatcher.no-wait')
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
    // 插件这一侧的生命周期：热重载只换掉插件 fiber，不会去动 agent 的 scope，
    // 所以卸下 guard 的动作得挂在这里，否则旧 limit 会一直压着新实例。
    ctx.effect(() => () => {
      for (const release of [...guardReleases]) release()
    }, 'dsh-dispatcher.no-wait-teardown')
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
        owner: {
          type: 'string',
          description:
            'The 小鱼 in plain words — this is the label the little screen shows, e.g. 「t4 查qqbot PR」. Human label, not an id.',
        },
        ownerId: {
          type: 'string',
          description:
            'Optional but strongly recommended: the raw session id `spawn` returned for this 小鱼 (uuid, a leading session- is fine). Copy it verbatim — do not retype it from memory. Only with ownerId can the zombie sweep tell worker-gone right away; without it a dead worker is only noticed after the 20 minute silent threshold, and a Chinese label can never be matched at all. If the id is not in the live agent table the ticket is refused.',
        },
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
        const owner = typeof args.owner === 'string' ? args.owner.trim() : ''
        const ownerId = typeof args.ownerId === 'string' ? args.ownerId.trim() : ''
        // ownerId 是拿来判活的，填错了比不填更坏：巡检会立刻把这票当 worker-gone。
        // 所以开票前先问一次活表。查不到 agents 服务（还没就绪）时放行 + 记日志，
        // 不能因为服务没起来就把活堵死。
        if (ownerId) {
          const alive = agentAlive(ownerId, true)
          if (alive === false) {
            throw new Error(
              `ownerId 不在活表，可能是填错了或小鱼已经结束：${ownerId}。填 spawn 返回的原始 session id，或者去掉 ownerId 只留人话 owner`,
            )
          }
          if (alive === undefined) {
            warn(`[dispatcher] 查不到 agents 活表，ownerId 没校验就开票了（服务可能还没就绪）：${ownerId}`)
          }
        }
        const ticket = store.open(args.goal, args.dir, brief)
        if (owner) {
          store.update(ticket.id, { owner, ...(ownerId ? { ownerId } : {}), status: 'running' })
        } else if (ownerId) {
          store.update(ticket.id, { ownerId })
        }
        return {
          id: ticket.id,
          status: owner ? 'running' : 'open',
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

  // 空 = 没配映射文件（默认），不读盘：下面的 resolveOwnerSession 直接给空，
  // 主人会话只能由 ownerSessionId 明确指定。
  const prefsPath = config.qqPrefsPath.replace(/^~(?=$|\/)/, homedir())

  function resolveOwnerSession(): string {
    if (config.ownerSessionId) return config.ownerSessionId
    if (!prefsPath) return ''
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

  /** 票里能和真 session id 比对的那一栏：新票是 ownerId，老票退回人话 owner。 */
  const ownerKey = (ticket: { owner?: string; ownerId?: string }): string | undefined =>
    ticket.ownerId ?? ticket.owner

  const agentFor = (id: string | undefined): WakeableAgent | undefined => {
    if (!id) return undefined
    const agents = (ctx as unknown as { agents?: { get?: (id: string) => WakeableAgent | undefined } }).agents
    return agents?.get?.(id)
  }

  /**
   * owner 的 agent 还在不在活表里。三态：
   *
   * - `true`  活表里有这个会话；
   * - `false` 活表查得到、里面确实没有这个会话 → 可以判 worker-gone；
   * - `undefined` 没法判断（没有 agents 服务、活表还是空的、owner 是「小丙」
   *   这种抽不出 id 片段的纯文字标签）→ 只能退回静默阈值。
   *
   * AgentRegistry.get(agent.session.id) 是唯一可靠的判活入口（dsh-agent 的
   * registry key 就是 session id）。
   *
   * `exact` 为真表示传进来的是票里的 ownerId（spawn 原文，主会话照抄，不会填错）：
   * 只认 idVariants 那几种写法，查不到就是 false，不再走「抽不出片段 = 没法比」
   * 那道兜底——开票时已经校验过一次，落到这儿的 ownerId 就是能比对的。
   * 为假时是老路径：owner 是随手填的，可能裸 uuid、带 session- 前缀，也可能只写
   * `subagent 34b183b9` 这种 uuid 前缀。前两种走 get，最后一种扫 list 用 matchesId 比。
   */
  const agentAlive = (owner: string, exact = false): boolean | undefined => {
    const agents = (ctx as unknown as {
      agents?: {
        get?: (id: string) => unknown
        list?: () => Array<{ id?: string; session?: { id?: string } }>
      }
    }).agents
    if (!agents?.get) return undefined
    for (const id of idVariants(owner)) {
      if (agents.get(id)) return true
    }
    // 短标签兜底：票里的 owner 可能只写了 uuid 前缀（`subagent 34b183b9`），
    // 活表的 key 才是完整的 session id。查活宁可宽松——命中了就算活。
    const live = agents.list?.() ?? []
    // 活表空着基本只会是服务还没就绪（主会话自己也在表里），这时候「扫不到」
    // 说明不了任何事，不能拿去判死。
    if (live.length === 0) return undefined
    // ownerId：idVariants 都试过了，活表非空还没命中 → 会话真没了。精确比对
    // 不借 matchesId 的前缀兜底，也不看片段——id 是原文抄的，不需要猜。
    if (exact) {
      const variants = idVariants(owner)
      for (const agent of live) {
        const id = agent?.session?.id ?? agent?.id
        if (typeof id === 'string' && variants.has(id)) return true
      }
      return false
    }
    for (const agent of live) {
      const id = agent?.session?.id ?? agent?.id
      if (typeof id === 'string' && matchesId(owner, id)) return true
    }
    // 扫完了确实没有。但这个结论只对「有 id 片段、能拿来比」的 owner 成立：
    // `小丙` 抽不出片段，扫不到只意味着没法比，刚派出去的活不能被这一下判死。
    return hasIdFragment(owner) ? false : undefined
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
      for (const ticket of store.list()) {
        if (ticket.status !== 'open' && ticket.status !== 'running') continue
        const known = ownerKey(ticket)
        if (!known) continue
        if (!matchesId(known, finished)) continue
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

  // 同一条排队消息只许投一次：dispatch_send、agent/status 和 tick 三条路都可能
  // 同时看上它。先占位再 await，JS 单线程，另一条路就会跳过。
  const inFlight = new Set<string>()

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
   * 票事件串行队列。append 的调用栈里不就地干活：dispatch_send 追加 input 之后
   * 自己也会顺手投递，处理器得等它让出这一步，才看得见 delivered 已经记上。
   * 队列也保证同一个 id 的两次事件按顺序处理。
   *
   * 内部写入（巡检的重开、投递记账）走 store.quietly，不发事件；否则处理器写日志、
   * 日志再叫醒处理器，自己喂自己。
   */
  let ticketQueue: Promise<void> = Promise.resolve()
  const enqueue = (work: () => Promise<void>): void => {
    ticketQueue = ticketQueue.then(work).catch((error) => {
      warn(`[dispatcher] 票事件处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
  ticketEventQueue.set(ctx as object, () => ticketQueue)

  /**
   * 重开：done 的票在 closedAt 之后又收到 input。
   *
   * The after-it-ended part is the whole point: an input queued while the ticket
   * was still running never reaches a worker whose session is gone, so counting
   * it as "new mail" is what used to flip finished tickets back to open on the
   * next sweep. dropped 是人按下的停止，永远不重开。只改状态，不叫醒主会话。
   */
  function reopenIfMailed(id: string): boolean {
    const ticket = store.get(id)
    if (!ticket || ticket.status !== 'done') return false
    const since = Date.parse(ticket.closedAt ?? ticket.updatedAt)
    const fresh = pending(ticket.inputs).filter((entry) => Date.parse(entry.at) > since)
    if (fresh.length === 0) return false
    store.quietly(() => store.update(id, { status: 'open' }))
    info(`[dispatcher] ${id}「${ticket.goal}」结束后又收到新消息，已重新打开（不推送）`)
    return true
  }

  /** 把票里排队的 input 交给还活着、且不忙的 worker。返回这一轮投出去几条。 */
  async function deliverQueued(id: string): Promise<number> {
    const ticket = store.get(id)
    if (!ticket || !isOpen(ticket.status)) return 0
    const queued = pending(ticket.inputs).filter((entry) => !inFlight.has(entry.id))
    if (queued.length === 0) return 0
    const worker = agentFor(ownerKey(ticket))
    if (!worker?.steer || isBusy(worker)) return 0
    for (const entry of queued) inFlight.add(entry.id)
    let delivered = 0
    try {
      for (const entry of queued) {
        await worker.steer(message(entry.text))
        store.quietly(() => store.markDelivered(id, 'input', entry.id))
        delivered += 1
      }
    } finally {
      for (const entry of queued) inFlight.delete(entry.id)
    }
    return delivered
  }

  /**
   * 账目清理：已关票上积压的报告没有消费者。小鱼交活走 send_message，巡检从来没
   * 投递过它们的报告，票一关更没人来读。这里只补一条 delivered，不通知任何人。
   * 未结票的报告一律不动：留在 pending 上，由 dispatch_list 的 «n 显示出来。
   */
  function clearClosedReports(id: string): number {
    const ticket = store.get(id)
    if (!ticket || isOpen(ticket.status)) return 0
    let cleared = 0
    for (const entry of pending(ticket.reports)) {
      store.quietly(() => store.markDelivered(id, 'report', entry.id))
      cleared += 1
    }
    return cleared
  }

  /**
   * 僵尸判定。`withAlive` 为真时接活表（worker-gone 快路），为假时不接——
   * 低频 tick 只留静默兜底那两档，worker 没了由 agent/disposed 当场判。
   */
  function zombiesFor(tickets: readonly TicketSnapshot[], now: Date, withAlive: boolean): ZombieHit[] {
    if (!config.notifyOwner) return []
    return evaluateZombies(tickets, {
      now,
      zombieMinutes: config.zombieMinutes,
      noReportMinutes: config.noReportMinutes,
      ...(withAlive ? { isAlive: agentAlive } : {}),
    })
  }

  /** 这轮该真推的：指纹和上次推过的一样就跳过。 */
  function freshHits(hits: readonly ZombieHit[]): ZombieHit[] {
    return hits.filter((hit) => shouldPush(hit, zombiePushed))
  }

  /** 不再命中的票把指纹扔掉，下次真出事时还能再推一次。 */
  function forgetHealed(hits: readonly ZombieHit[]): void {
    for (const id of [...zombiePushed.keys()]) {
      if (!hits.some((hit) => hit.ticket.id === id)) zombiePushed.delete(id)
    }
  }

  type AnnounceOutcome = 'woke' | 'quiet' | 'no-session' | 'busy' | 'none'

  /**
   * 唯一会 followup 的出口：一句摘要，不带报告正文。报告正文进来这条消息就
   * 成了第二份报告。quietSweep 下不推、也不记指纹——安静的一轮什么都没宣布，
   * 不该把第一次真正的宣布压掉。
   */
  async function announce(fresh: readonly ZombieHit[]): Promise<AnnounceOutcome> {
    if (fresh.length === 0) return 'none'
    if (config.quietSweep) return 'quiet'
    const sessionId = resolveOwnerSession()
    const owner = agentFor(sessionId)
    if (!owner?.followup) return 'no-session'
    if (isBusy(owner)) return 'busy'
    const text = `（dispatcher 巡检，不是主人发的）${summarizeZombies(fresh)}。用 dispatch_list 看一眼，收票或者继续派活。`
    await owner.followup(message(text))
    for (const hit of fresh) zombiePushed.set(hit.ticket.id, hit.fingerprint)
    return 'woke'
  }

  /** 单票判定 + 立推：agent/disposed 和票事件走这条。 */
  async function judgeAndPush(id: string, now: Date, withAlive = true): Promise<void> {
    const ticket = store.get(id)
    if (!ticket) return
    const hits = zombiesFor([ticket], now, withAlive)
    const fresh = freshHits(hits)
    if (fresh.length === 0) {
      zombiePushed.delete(id)
      return
    }
    await announce(fresh)
  }

  /**
   * 只处理受影响那张票的处理器：重开、投递排队 input、清已关票的报告账、
   * 单票僵尸判定。sweep 和事件总线走的是同一组函数，行为不会分叉。
   */
  async function handleTicketEvent(payload: TicketBroadcast): Promise<void> {
    switch (payload.kind) {
      case 'input':
        reopenIfMailed(payload.id)
        await deliverQueued(payload.id)
        return
      case 'status':
        clearClosedReports(payload.id)
        await judgeAndPush(payload.id, new Date())
        return
      case 'report':
        await judgeAndPush(payload.id, new Date())
        return
      default:
        return
    }
  }

  ctx.on('dispatcher/ticket', (payload) => {
    enqueue(() => handleTicketEvent(payload))
    return undefined
  })

  // ── 宿主事件 ────────────────────────────────────────────────────
  // 事件的形状来自 dsh-agent 的 runtime-types.d.ts（agent/status: { agent, status }、
  // agent/disposed: { agent }），这个包不依赖 dsh-agent，所以按结构收窄后订阅，
  // 和上面 subagent/end 一个路子。订阅失败只 warn，dispatch_* 照常工作。
  const agentIdOf = (agent: unknown): string => {
    const shaped = agent as { session?: { id?: string }; id?: string } | undefined
    return shaped?.session?.id ?? shaped?.id ?? ''
  }
  const hostEvents = ctx as unknown as {
    on(
      name: string,
      listener: (payload: { agent?: unknown; status?: string }) => unknown,
    ): unknown
  }

  /** worker 名下所有还开着的票，逐张试着投递。 */
  async function deliverForOwner(sessionId: string): Promise<number> {
    let delivered = 0
    for (const ticket of store.list()) {
      if (!isOpen(ticket.status)) continue
      const known = ownerKey(ticket)
      if (!known || !matchesId(known, sessionId)) continue
      delivered += await deliverQueued(ticket.id)
    }
    return delivered
  }

  /**
   * agent/disposed：worker 从活表里没了，名下还开着的票当场按 worker-gone 判。
   * 只推提醒，绝不自动改票 status——写权限只归主会话（README「谁写 status」）。
   * `freshMinutes: 0`：id 都从活表里被摘掉了，不用再给注册留宽限。
   */
  async function judgeGone(sessionId: string): Promise<void> {
    if (!config.notifyOwner) return
    const now = new Date()
    // 一次死的 worker 可能名下有不止一张票：攒成一句再发，别一张一条 followup。
    const hits: ZombieHit[] = []
    for (const ticket of store.list()) {
      if (!isOpen(ticket.status)) continue
      const known = ownerKey(ticket)
      if (!known || !matchesId(known, sessionId)) continue
      hits.push(
        ...evaluateZombies([ticket], {
          now,
          freshMinutes: 0,
          zombieMinutes: config.zombieMinutes,
          noReportMinutes: config.noReportMinutes,
          isAlive: () => false,
        }),
      )
    }
    const fresh = freshHits(hits)
    if (fresh.length > 0) await announce(fresh)
  }

  try {
    // worker 变 idle：立刻投递它名下排队的 input，不等低频 tick。
    // 这一条就是替掉原来 sweep 里拿 isBusy 轮询 wait 的判断。
    hostEvents.on('agent/status', (payload) => {
      if (payload?.status !== 'idle') return undefined
      const id = agentIdOf(payload.agent)
      if (!id) return undefined
      enqueue(async () => {
        await deliverForOwner(id)
      })
      return undefined
    })
    hostEvents.on('agent/disposed', (payload) => {
      const id = agentIdOf(payload.agent)
      if (!id) return undefined
      enqueue(async () => {
        await judgeGone(id)
      })
      return undefined
    })
  } catch (error) {
    warn(
      `[dispatcher] agent/status 或 agent/disposed 订阅失败，投递与 worker-gone 会退化到低频 tick：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  /**
   * One pass over the ticket log: revive tickets that ended but received more
   * mail, push queued messages to workers that are still alive, clear the report
   * entries nobody can read any more, then report zombie tickets — one line,
   * once — to the owner session.
   *
   * It does not deliver reports, and no other thing it does may wake the owner
   * session: a worker hands its report back with `send_message`, and the main
   * session reads the log with `dispatch_list`, where a ticket's `«n` counts the
   * reports it has not read. Carrying reports to the owner was the 2026-11-02
   * flood. Only a zombie ticket is worth a whole main-session turn.
   *
   * `dispatch_sweep` still runs the whole thing on demand (tests and the manual
   * tool depend on it); the timer runs `tick`, which is the subset that has no
   * event to wait for.
   */
  async function sweep(): Promise<SweepResult> {
    const now = new Date()
    let delivered = 0
    let cleared = 0

    // 一次 list()：投影读一次，后面每张票的处理器都只碰自己那张。
    const tickets = store.list()
    for (const ticket of tickets) {
      reopenIfMailed(ticket.id)
      delivered += await deliverQueued(ticket.id)
      cleared += clearClosedReports(ticket.id)
    }

    // 判僵尸在写完之后再看快照：重开改了 status，投递记账改了 updatedAt。
    const after = tickets
      .map((ticket) => store.get(ticket.id))
      .filter((ticket): ticket is TicketSnapshot => Boolean(ticket))
    const zombies = zombiesFor(after, now, true)
    forgetHealed(zombies)
    const outcome = await announce(freshHits(zombies))
    const result: SweepResult = { stale: zombies.length, delivered, cleared, woke: outcome === 'woke' }
    if (outcome !== 'woke' && outcome !== 'none') result.reason = outcome
    return result
  }

  /**
   * 低频兜底 tick（间隔仍走 sweepMinutes）。只做三件没有事件可等的事：
   *
   * 1. 投递失败重试：steer 抛过、或者 worker 上一轮还忙，票里的 input 还挂着。
   *    正常路径是 agent/status 变 idle 当场投，这一条只是漏网兜底。
   * 2. 20 分钟静默：worker 没死、也没交活，就是不动了——没有任何事件会在
   *    「沉默满 20 分钟」那一刻发出来，只能靠时钟。
   * 3. waiting 但票里一条报告都没有的 5 分钟档：小鱼退出有 subagent/end，
   *    但「退了却没交活」要等满 noReportMinutes 才成立，同样是时间条件。
   *
   * worker-gone 不在这里：agent/disposed 已经当场判了，再扫一遍活表只是重复。
   */
  async function tick(): Promise<void> {
    const now = new Date()
    const tickets = store.list()
    for (const ticket of tickets) {
      try {
        await deliverQueued(ticket.id)
      } catch (error) {
        warn(
          `[dispatcher] 投递重试失败（${ticket.id}）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const after = tickets
      .map((ticket) => store.get(ticket.id))
      .filter((ticket): ticket is TicketSnapshot => Boolean(ticket))
    // 不传 isAlive：静默兜底和 no-report 两档不需要活表，worker-gone 归宿主事件。
    const zombies = zombiesFor(after, now, false)
    forgetHealed(zombies)
    await announce(freshHits(zombies))
  }

  if (config.sweepMinutes > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void tick()
      }, Math.max(1, config.sweepMinutes) * 60_000)
      return () => clearInterval(timer)
    }, 'dsh-dispatcher.tick')
  }

  ctx.tools.register(
    defineTool({
      name: 'dispatch_sweep',
      description:
        'Run one sweep now instead of waiting for the timer: reopen tickets that got mail after they ended, push queued messages to live 小鱼, clear report entries left on closed tickets, and report zombie tickets in one line. It does not deliver reports — read those with dispatch_reports.',
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
        // 追加之前先看它是不是已经关掉了：这一条落在 closedAt 之后就当场重开，
        // 不等下一轮 tick。dropped 是人按的停止，不重开。
        const before = store.get(args.id)
        if (!before) throw new Error(`unknown ticket: ${args.id}`)
        const { ticket, entry } = store.appendInput(args.id, args.text)
        const closedAt = Date.parse(before.closedAt ?? before.updatedAt)
        if (before.status === 'done' && Date.parse(ticket.updatedAt) > closedAt) {
          store.update(args.id, { status: 'open' })
        }
        const worker = agentFor(ownerKey(ticket))
        let delivered = false
        if (worker?.steer && !isBusy(worker)) {
          inFlight.add(entry.id)
          try {
            await worker.steer(message(args.text))
            store.markDelivered(ticket.id, 'input', entry.id)
            delivered = true
          } finally {
            inFlight.delete(entry.id)
          }
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
        'Record a report on a ticket without ending it. Nothing is pushed: the main session reads it with dispatch_reports, which also marks it read (dispatch_list shows «n unread until then). It survives a restart because it lives in the ticket log. A 小鱼 (a subagent) calls this with the ticket id it was given.',
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

  // ── 读报告：票上的正文只在这里取，读一条记一条已读 ──────────────
  // 报告不是推送（2026-11-02 那次洪水之后，巡检和 announce 都不带正文了），所以
  // 主会话得有个「自己取」的入口：不读，«n 就一直挂着；读完这一轮真返回的每一条
  // 都补一条 delivered，下一轮 dispatch_list 就干净了。被 limit 挡下的不算读过，
  // 下一轮取到的条数跟剩下的 «n 严格对齐。
  /** 一条报告最多回多少字：再长就截断并标 truncated，别把一轮上下文撑爆。 */
  const REPORT_TEXT_MAX = 4000
  ctx.tools.register(
    defineTool({
      name: 'dispatch_reports',
      description:
        'Read the report text on tickets. By default only unread reports are returned, and every report returned is marked read: after this call, «n in dispatch_list counts what is still unread. Nothing is pushed to this session — this is the only place report text is read. A 小鱼 (a subagent) cannot call this.',
      parameters: {
        id: {
          type: 'string',
          description:
            'Ticket id. Omit to read every open ticket that still has unread reports, oldest ticket first. A closed ticket has to be named explicitly.',
        },
        limit: {
          type: 'number',
          description:
            'How many reports to return in one call, oldest first. Default 10, at most 50. Reports the limit cut off are not marked read, so the next call picks them up.',
        },
        includeRead: {
          type: 'boolean',
          description: 'Also return reports already read — the whole history of the ticket. Default false: unread only.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tickets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string' },
                  goal: { type: 'string' },
                  unread: { type: 'number' },
                  reports: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        n: { type: 'number' },
                        id: { type: 'string' },
                        at: { type: 'string' },
                        text: { type: 'string' },
                        read: { type: 'boolean' },
                        truncated: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
            /** Reports actually returned this call. */
            returned: { type: 'number' },
            /** Of those, how many were unread and are now marked read. */
            markedRead: { type: 'number' },
          },
        },
        render: (_args, value) => {
          const tickets = value.tickets ?? []
          if (tickets.length === 0) return [{ type: 'text', text: 'no reports' }]
          const blocks = tickets.map((ticket) => {
            const head = `ticket ${ticket.id} ${ticket.status}${ticket.unread ? ` (${ticket.unread} unread left)` : ''}：${ticket.goal}`
            const body = (ticket.reports ?? []).map(
              (report) =>
                `  #${report.n}${report.read ? ' (read)' : ''} ${report.text}${report.truncated ? ' …[truncated]' : ''}`,
            )
            return [head, ...body].join('\n')
          })
          return [{ type: 'text', text: blocks.join('\n') }]
        },
      },
      async execute(args) {
        // limit：默认 10，上限 50；不是数就当没给。被它挡下的报告一条都不标。
        const asked = Number(args.limit)
        const budget = Number.isFinite(asked) ? Math.min(50, Math.max(1, Math.trunc(asked))) : 10
        const includeRead = args.includeRead === true
        const wanted = typeof args.id === 'string' ? args.id.trim() : ''

        let candidates: TicketSnapshot[]
        if (wanted) {
          const one = store.get(wanted)
          // 坏票号当场报错：静默回一份空报告会让主会话以为「这张票没交活」。
          if (!one) throw new Error(`unknown ticket: ${wanted}`)
          candidates = [one]
        } else {
          // 省略 id = 所有还有未读的未结票。已关票要走 id 点名才读得到正文。
          candidates = store
            .list()
            .filter((ticket) => isOpen(ticket.status) && pending(ticket.reports ?? []).length > 0)
        }

        const tickets: Array<{
          id: string
          status: string
          goal: string
          unread: number
          reports: Array<{ n: number; id: string; at: string; text: string; read: boolean; truncated?: boolean }>
        }> = []
        let returned = 0
        let markedRead = 0
        for (const ticket of candidates) {
          if (returned >= budget) break
          const reports: Array<{ n: number; id: string; at: string; text: string; read: boolean; truncated?: boolean }> = []
          for (let index = 0; index < ticket.reports.length && returned < budget; index += 1) {
            const entry = ticket.reports[index]!
            if (!includeRead && entry.delivered) continue
            const chars = Array.from(entry.text)
            const truncated = chars.length > REPORT_TEXT_MAX
            reports.push({
              // n 是这张票完整报告列表里的 1 起序号，跟读没读无关：同一份报告永远
              // 同一个号，主会话隔一轮回来对账不会串号。
              n: index + 1,
              id: entry.id,
              at: entry.at,
              text: truncated ? chars.slice(0, REPORT_TEXT_MAX).join('') : entry.text,
              read: entry.delivered,
              ...(truncated ? { truncated: true } : {}),
            })
            returned += 1
            if (!entry.delivered) {
              // 记账走门面的 quietly：delivered 事件落在 handleTicketEvent 的
              // default 分支上空转，不自激。
              store.quietly(() => store.markDelivered(ticket.id, 'report', entry.id))
              markedRead += 1
            }
          }
          if (reports.length === 0) continue
          const fresh = store.get(ticket.id)
          tickets.push({
            id: ticket.id,
            status: ticket.status,
            goal: ticket.goal,
            // 读完这一轮之后还剩多少未读：被 limit 挡下的还挂在票上，下一轮取到的
            // 条数跟这个数严格对齐，读完归零。
            unread: fresh ? pending(fresh.reports).length : 0,
            reports,
          })
        }
        return { tickets, returned, markedRead }
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
  // worker 这边摘两样东西：写记忆的工具（workerDenyTools）和本包那几个能改票的
  // 工具（WORKER_FORBIDDEN_TOOLS）。记忆写权限只归主会话，这是第二层，第一层是
  // dsh-memory 在 execute 里的守卫；票的 status 只归主会话和巡检，worker 连名字
  // 都不该看见（README「谁写 status」）。
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
  if (config.routerRestrict || config.workerToolDeny || config.workerPromptPrune) {
    const routerSeen = new WeakSet<object>()
    const bindings = new Set<RouterBinding>()
    const bound = new WeakMap<object, RouterBinding>()
    let announced = false
    let workerAnnounced = false
    // teardown 开始以后，`tools/change` 不许再把还没拆到的 binding 装回去：
    // dispose 撤 restrict 会同步触发它。
    let tearingDown = false
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
      allow: routerAllowList(config),
      // deny 是叠加语义、越减越少，跟 allow 不会互相打架。这一份拼在配置之后、
      // 不进 config 默认值：operator 改写 workerDenyTools 不该顺手放出这几样。
      deny: config.workerToolDeny
        ? [...new Set([...config.workerDenyTools, ...WORKER_FORBIDDEN_TOOLS])]
        : [],
      // 提示词剪枝跟 deny 名单是两件事：deny 决定手上有什么工具，剪枝决定
      // 提示词里还写不写那些静态说明。两个开关，各关各的。
      pruneWorkerPrompt: config.workerPromptPrune,
      escapeFile: config.routerEscapeFile,
      log,
      info,
      registry,
    }
    const install = (agent: RouterAgent): void => {
      // Independent switches: routerRestrict decides whether the main session is
      // trimmed, workerToolDeny whether a subagent loses the memory-writing
      // tools, workerPromptPrune whether its prompt keeps the static tool
      // sections. Turning one off must not turn another off.
      const worker = isWorkerSession(agent.session.header.origin)
      if (worker ? !config.workerToolDeny && !config.workerPromptPrune : !config.routerRestrict) return
      let binding = bound.get(agent)
      if (binding === undefined) {
        if (routerSeen.has(agent)) return
        routerSeen.add(agent)
        binding = bindRouter(agent, options)
        bound.set(agent, binding)
        bindings.add(binding)
        // 会话没了就把这条 binding 撤掉、从集合里删掉。强引用 Set 只增不删的话，
        // 死掉的作用域会一直被 tools/change 叫醒着去 sync。dispose 幂等，
        // 插件卸载时下面那段 teardown 再调一次也没事。
        const own = binding
        agent.ctx.effect(() => () => {
          own.dispose()
          bindings.delete(own)
        }, 'dsh-dispatcher.router-release')
      } else {
        binding.sync()
      }
      const outcome = binding.outcome()
      if (worker) {
        if ((outcome === 'denied' || outcome === 'updated') && !workerAnnounced) {
          workerAnnounced = true
          info(
            `[dispatcher] worker subagents hide ${binding.installed().length} tool(s): ${binding.installed().join(', ')}`,
          )
        }
        return
      }
      if ((outcome === 'installed' || outcome === 'updated') && !announced) {
        announced = true
        info(
          `[dispatcher] router whitelist installed on the main session (${binding.installed().length}/${options.allow.length} tools registered)`,
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
      if (tearingDown) return undefined
      for (const binding of [...bindings]) binding.sync()
      return undefined
    })
    // 插件这一侧的 disposer：热重载/卸载只替换插件 fiber，不会动 agent 的
    // scope，所以装在各会话上的 restrict、worker deny 和 prompt pass 必须在这里
    // 撤掉。只挂 agent.ctx 的后果 2026-11-01 真出过：旧的 26 个工具压着新白名单的
    // 36 个，取交集之后改配置完全无效。
    // tearingDown 先置位：dispose 里撤 restrict 会同步触发 tools/change，别让
    // 还没撤到的 binding 在拆的过程中又装回去。
    ctx.effect(() => () => {
      tearingDown = true
      for (const binding of [...bindings]) binding.dispose()
      bindings.clear()
    }, 'dsh-dispatcher.router-teardown')
  }
}
