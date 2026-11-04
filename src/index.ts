/**
 * 插件的接线层：把票台（`tickets/desk.ts`）接成模型能调的工具，再把白名单、
 * 提示词和等待守卫装到会话上。
 *
 * 这一层**不写票**。开票、关票、挂起、投递、补报告全在 desk 里，工具只做三件事：
 * 从 `exec` 认出调用方、把参数转过去、把回执收窄成该给模型看的几栏。所以
 * 「工具也能改 status」这种第二条写者从结构上不存在。
 *
 * 也没有第二条队列：`serialize` 就是这个文件里那条 `ticketQueue`，desk 拿着它跑。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config, DEFAULT_HANDOFF_POLICY, legacySweepWarning, resolveSweepMs, routerAllowList } from './config'
import type { Config as ConfigShape } from './config'
import { createTicketBackend, resolveStateFile } from './store'
import type { Actor, TicketStatus } from './store'
import { TicketLog } from './store/log'
import { createDesk } from './tickets/desk'
import type { Serialize, TicketView } from './tickets/desk'
import { createLlmClassifier } from './tickets/classify'
import type { LlmService } from './tickets/classify'
import { createNotifier } from './tickets/notify'
import { TICKETS_SERVICE, TicketReadout } from './tickets/readout'
import { TicketSnapshotFile } from './tickets/snapshot'
import type { PresetCatalog } from './tickets/publish'
import type { SubagentSeam } from './tickets/workers'
import { bindRouter } from './router'
import type { RouterAgent, RouterBinding } from './router'
import { isWorkerSession, noWaitReason } from './no-wait'
import { sendProgress } from './progress'

export const name = 'dsh-dispatcher'
export const inject = ['tools', 'agents']

// Re-export the schema so the loader can validate this plugin's config.
export { Config }

export { DEFAULT_HANDOFF_POLICY as HANDOFF_POLICY }

/**
 * worker 无论配置怎么写都不该拿到的本包工具：开票、发话、读票、关票、挂起、
 * 列表、以及绕过票直接推手机的打点。
 *
 * 小鱼手上只留 `dispatch_report` 一个票工具，而且它只往队列里追加一行，碰不到
 * status。`dispatch_block` 也在这里：卡住该用报告说，不该自己把票标成挂起。
 *
 * 拼在 `workerDenyTools` 之后、不进 config 默认值：operator 改写
 * `workerDenyTools` 不该顺手把这几样放回 worker 手里。
 */
export const WORKER_FORBIDDEN_TOOLS = [
  'dispatch_open',
  'dispatch_send',
  'dispatch_read',
  'dispatch_close',
  'dispatch_block',
  'dispatch_list',
  'progress_note',
]

const STATUSES = ['open', 'running', 'waiting', 'blocked', 'done', 'dropped'] as const

/** 票事件队列的把手：测试等它排空，生产里没人用。 */
export const ticketEventQueue = new WeakMap<object, () => Promise<void>>()

/** `ctx.get` 拿不到就返回 undefined：票台少一个服务该是降级，不是崩溃。 */
function service<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof getter === 'function') {
    try {
      const found = getter.call(ctx, name)
      if (found !== undefined && found !== null) return found as T
    } catch {
      // 服务没就绪：往下走静态栏。
    }
  }
  const direct = (ctx as unknown as Record<string, unknown>)[name]
  return direct === undefined || direct === null ? undefined : (direct as T)
}

interface AgentLike {
  session?: { id?: string; header?: { origin?: string } }
  status?: string
  followup?: (message: unknown) => Promise<unknown>
}

interface AgentsService {
  list(): AgentLike[]
  get?: (id: string) => AgentLike | undefined
}

interface PresetRow {
  id?: string
  name?: string
  description?: string
}

interface PresetRegistry {
  list?: () => Promise<PresetRow[]>
  /** 注册表自己认的默认档。 */
  defaultId?: string
  composedPreset?: (ctx: unknown) => string | undefined
}

interface AgentHeader {
  origin?: string
}

/** 从 `exec` 认出调用方。没有会话 id 就不干——票得记在谁名下。 */
function actorOf(exec: unknown): Actor {
  const agent = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent
  const sessionId = agent?.session?.id
  if (!sessionId) throw new Error('不知道是哪个会话在调这个工具：票得记在发起人名下')
  return { kind: 'main', sessionId }
}

/** 调用编号当幂等键：同一次调用重放不许开第二张票。 */
function requestIdOf(exec: unknown): string | undefined {
  const callId = (exec as { callId?: unknown } | undefined)?.callId
  return typeof callId === 'string' && callId ? callId : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function ticketLine(view: TicketView): string {
  const marks = [
    view.stale ? '!' : '',
    view.pendingInputs ? '»' + view.pendingInputs : '',
    view.pendingReports ? '«' + view.pendingReports : '',
  ].join('')
  return `${marks ? marks + ' ' : ''}${view.id} ${view.status}：${view.brief}`
}

export function apply(ctx: Context, config: ConfigShape): void {
  const logger = (ctx as unknown as { logger?: Record<string, ((message: string) => void) | undefined> }).logger
  const warn = (message: string): void => {
    logger?.warn?.(message)
  }
  const info = (message: string): void => {
    logger?.info?.(message)
  }

  // 票日志：唯一写者。第三个参数把每一条追加广播成 `dispatcher/ticket`，票台
  // 不靠它改状态（状态只在自己的事件处理里折），宿主和别的插件可以监听。
  const log = new TicketLog(
    createTicketBackend({ backend: config.store?.backend, stateFile: resolveStateFile(config.stateFile) }, warn),
    warn,
    (event) => {
      ;(ctx as unknown as { emit?: (name: string, payload: unknown) => void }).emit?.('dispatcher/ticket', event)
    },
  )

  // ── 统一只读出口 ────────────────────────────────────────────────
  // `/tickets` 指令（进程内）与桌宠（读文件/子进程）看的是同一份读数：CLI、
  // `dispatcher/tickets` 这个 service、桌面快照文件都从 TicketReadout 出，而
  // TicketReadout 只认 store 折好的快照。以后日志换 redis，消费者的形状不变。
  const readout = new TicketReadout(log, {
    briefMaxColumns: config.briefMaxColumns,
    waitingMinutes: config.waitingMinutes,
    blockedMinutes: config.blockedMinutes,
  })
  const provider = (ctx as unknown as { provide?: (name: string, value: unknown) => unknown }).provide
  if (typeof provider === 'function') {
    try {
      provider.call(ctx, TICKETS_SERVICE, readout)
    } catch (error) {
      // 热重载时同名服务可能还没被上一份 fiber 释放：降级成只有 CLI/文件可用。
      warn(`[dispatcher] ${TICKETS_SERVICE} 服务没挂上：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 桌面快照：每次 commit 之后同步重写，内容没变就不落盘。空 snapshotFile 跟着
  // 日志走（同目录的 tickets.snapshot.json），所以默认就是 $DSH_HOME/dispatcher/。
  const snapshotFile = (config.snapshotFile ?? '').trim()
  const snapshotPath = snapshotFile
    ? resolveStateFile(snapshotFile)
    : join(dirname(resolveStateFile(config.stateFile)), 'tickets.snapshot.json')
  if (config.snapshotEnabled ?? true) {
    const snapshots = new TicketSnapshotFile(
      readout,
      { file: snapshotPath, recentClosed: config.snapshotRecentClosed ?? 20 },
      warn,
    )
    snapshots.write()
    const stop = log.onCommitted(() => {
      snapshots.write()
    })
    ctx.effect(() => () => {
      stop()
    }, 'dsh-dispatcher.snapshot')
    info(`[dispatcher] 只读快照 -> ${snapshotPath}`)
  }

  // 全插件只有这一条队列：票台的每一次写都排在它上面，工具调用之间不会互相插队。
  let ticketQueue: Promise<void> = Promise.resolve()
  const serialize: Serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const run = ticketQueue.then(work)
    ticketQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
  ticketEventQueue.set(ctx as object, () => ticketQueue)

  // ── 服务探针 ────────────────────────────────────────────────────
  const agentsOf = (): AgentsService | undefined => service<AgentsService>(ctx, 'agents')
  const llmOf = () => service<LlmService>(ctx, 'llm')
  const registryOf = () => service<PresetRegistry>(ctx, 'agentPresets')

  const presets: PresetCatalog = {
    async list() {
      const registry = registryOf()
      let rows: PresetRow[] = []
      try {
        rows = (await registry?.list?.()) ?? []
      } catch (error) {
        warn(`[dispatcher] 读不到档位注册表：${error instanceof Error ? error.message : String(error)}`)
        return []
      }
      return rows
        .filter((row) => typeof row.id === 'string' && row.id.length > 0)
        .map((row) => ({
          id: row.id as string,
          ...(row.name ? { name: row.name } : {}),
          ...(row.description ? { description: row.description } : {}),
        }))
    },
    defaultId() {
      const id = registryOf()?.defaultId
      return typeof id === 'string' && id ? id : undefined
    },
  }

  /**
   * 主会话自己挂的档（可选探测）。主会话通常没挂档——profile 里 `agentPreset`
   * 是给 `tool-subagent` 的，不是给主会话的——所以这里多数时候返回 undefined，
   * 选档退回 `config.defaultPreset`。探测失败一律当没有。
   */
  const routerPreset = (): string | undefined => {
    const registry = registryOf()
    if (typeof registry?.composedPreset !== 'function') return undefined
    for (const agent of agentsOf()?.list() ?? []) {
      const origin = agent.session?.header?.origin
      if (isWorkerSession(origin)) continue
      try {
        const id = registry.composedPreset(agent)
        if (typeof id === 'string' && id) return id
      } catch {
        // 这个会话还没 compose 出档：下一个。
      }
    }
    return undefined
  }

  const classifier = createLlmClassifier({
    llm: llmOf,
    model: config.classifyModel,
    effort: config.classifyEffort,
    timeoutMs: config.classifyTimeoutMs,
    warn,
  })

  /** 提醒落在哪个会话上：第一个主会话（非小鱼）且能 followup 的。 */
  const wake = async (body: string): Promise<boolean> => {
    for (const agent of agentsOf()?.list() ?? []) {
      if (isWorkerSession(agent.session?.header?.origin)) continue
      if (typeof agent.followup !== 'function') continue
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: 'dsh-dispatcher' },
      })
      return true
    }
    return false
  }

  // 巡检间隔：新键 sweepMs 说了算，老键 sweepMinutes 显式配了才折算并 warn 一句。
  const sweepMs = resolveSweepMs(config)
  const legacySweep = legacySweepWarning(config)
  if (legacySweep) warn(`[dispatcher] ${legacySweep}`)

  const desk = createDesk({
    log,
    serialize,
    bus: {
      emit: (channel, payload) => {
        // 只留一行日志：报告正文不进这里，提醒里的摘要已经是全部该看的。
        const head = (payload ?? {}) as { id?: unknown; reason?: unknown; stopReason?: unknown }
        info(`[dispatcher] ${channel}${head.id ? `（票 ${String(head.id)}）` : ''}`)
      },
    },
    host: {
      on: (event, listener) => ctx.on(event as never, listener as never),
    },
    subagents: () => service<SubagentSeam>(ctx, 'subagents'),
    agents: () => {
      const agents = agentsOf()
      if (!agents) return undefined
      return { get: (id: string) => agents.get?.(id) }
    },
    presets,
    classify: config.presetStrategy === 'static' ? undefined : classifier,
    routerPreset,
    notifier: createNotifier({ wake, quiet: false, warn }),
    config: {
      defaultPreset: config.defaultPreset,
      presetStrategy: config.presetStrategy,
      classifyTimeoutMs: config.classifyTimeoutMs,
      provider: config.provider,
      maxDepth: config.maxDepth,
      maxOpen: config.maxOpen,
      briefMaxColumns: config.briefMaxColumns,
      waitingMinutes: config.waitingMinutes,
      blockedMinutes: config.blockedMinutes,
      runningReminderMinutes: config.runningReminderMinutes,
      sweepMs,
      freshMinutes: config.freshMinutes,
      autoReport: config.autoReport,
      noReportSignal: config.noReportSignal,
      repeatWindowMinutes: config.repeatWindowMinutes,
    },
    warn,
  })
  desk.attach()
  ctx.effect(() => () => {
    void desk.dispose()
  }, 'dsh-dispatcher.desk')

  // ── 派活规矩：只给主会话，小鱼有自己的任务书 ────────────────────
  const handoffText = config.handoffPolicy ? (config.handoffPolicyText ?? '').trim() : ''
  if (handoffText) {
    let announced = false
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const header = (context as { agent?: { session?: { header?: AgentHeader } } })?.agent?.session?.header
      if (header?.origin === 'subagent') return assembled
      if (!announced) {
        announced = true
        info(`[dispatcher] hand-off policy injected into the main session prompt (${handoffText.length} chars)`)
      }
      return {
        ...assembled,
        sections: [...assembled.sections, { name: 'dispatcher:handoff', order: 95, text: handoffText }],
      }
    })
  }

  // ── 等待守卫：主会话不许把回话卡在长命令上 ──────────────────────
  // 提示词里写了「别自己耗着」也可能被忽略；这一层是真拦住。装在各会话的 ctx
  // 上，所以有两个拥有者：会话先没了走 agent.ctx 的 effect，插件先没了走插件的
  // teardown。release 幂等，撤两次没事。
  if (config.noWaitGuard) {
    const limits = { maxCommandMs: config.maxCommandMs, maxWaitMs: config.maxWaitMs }
    const guarded = new WeakSet<object>()
    const guardReleases = new Set<() => void>()
    let announced = false
    const install = (agent: {
      session: { header: AgentHeader }
      ctx: {
        effect: (callback: () => () => void, label?: string) => unknown
        tools: { guard: (guard: (execution: { name: string; arguments: unknown }) => string | undefined) => () => void }
      }
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
      agent.ctx.effect(() => release, 'dsh-dispatcher.no-wait')
      if (!announced) {
        announced = true
        info('[dispatcher] waiting guard installed on the main session')
      }
    }
    for (const agent of agentsOf()?.list() ?? []) install(agent as never)
    ctx.on('agent/created', ({ agent }) => {
      install(agent as never)
      return undefined
    })
    ctx.effect(() => () => {
      for (const release of [...guardReleases]) release()
    }, 'dsh-dispatcher.no-wait-teardown')
  }

  // ── 七个工具：router 六个 + worker 一个 ──────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'dispatch_open',
      description:
        'Open a ticket and hand the work to a 小鱼 in one step: the desk picks the preset, starts the 小鱼, writes the ticket and returns its id. Call it before answering the person — never spawn a subagent yourself.',
      parameters: {
        goal: { type: 'string', required: true, description: 'What the 小鱼 is asked to do, verbatim and complete.' },
        brief: {
          type: 'string',
          required: true,
          description:
            'Required: the one line the little screen shows under the ticket title — a short phrase, not a sentence. At most briefMaxColumns character columns (34 by default), a 汉字 counts 2, so about 17 汉字 is the ceiling. Empty, whitespace-only or punctuation-only is rejected.',
        },
        dir: { type: 'string', description: 'Working directory the 小鱼 should use, if any.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            openCount: { type: 'number' },
            duplicate: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.duplicate
              ? `ticket ${value.id} already open (same request, ${value.openCount} open)`
              : `ticket ${value.id} opened, 小鱼 started (${value.openCount} open)`,
          },
        ],
      },
      async execute(args, exec) {
        const receipt = await desk.open(
          {
            goal: args.goal,
            brief: args.brief,
            ...(args.dir ? { dir: args.dir } : {}),
            ...(requestIdOf(exec) ? { requestId: requestIdOf(exec) as string } : {}),
          },
          actorOf(exec),
        )
        return {
          id: receipt.id,
          status: receipt.status,
          openCount: receipt.openCount,
          ...(receipt.duplicate ? { duplicate: receipt.duplicate } : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_send',
      description:
        'Put one more message into an open ticket. The 小鱼 receives it now if it is idle, otherwise on its next turn. A finished ticket refuses it: open a new one.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        text: { type: 'string', required: true, description: 'What to tell the 小鱼, verbatim.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            delivered: { type: 'boolean' },
            pendingInputs: { type: 'number' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `ticket ${value.id}: ${value.delivered ? 'delivered' : `queued (${value.pendingInputs} waiting)`}`,
          },
        ],
      },
      async execute(args, exec) {
        const receipt = await desk.send(args.id, args.text, actorOf(exec))
        return {
          id: receipt.id,
          status: receipt.status,
          delivered: receipt.delivered,
          pendingInputs: receipt.pendingInputs,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_read',
      description:
        'Read reports the 小鱼 left on tickets and mark them delivered. Omit id to read every open ticket with unread reports.',
      parameters: {
        id: { type: 'string', description: 'Ticket id; omit for every ticket with unread reports.' },
        limit: { type: 'number', description: 'Max report lines per ticket (default 20).' },
        includeRead: { type: 'boolean', description: 'Also return reports already read.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            returned: { type: 'number' },
            markedRead: { type: 'number' },
            tickets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string' },
                  goal: { type: 'string' },
                  pendingReports: { type: 'number' },
                  reports: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        n: { type: 'number' },
                        at: { type: 'string' },
                        read: { type: 'boolean' },
                        text: { type: 'string' },
                        truncated: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const tickets = value.tickets ?? []
          if (tickets.length === 0) return [{ type: 'text', text: 'no reports' }]
          const blocks = tickets.map((ticket) => {
            const head = `ticket ${ticket.id} ${ticket.status}：${ticket.goal}`
            const body = (ticket.reports ?? []).map(
              (report) => `  #${report.n}${report.read ? ' (read)' : ''} ${report.text}`,
            )
            return [head, ...body].join('\n')
          })
          return [{ type: 'text', text: blocks.join('\n') }]
        },
      },
      async execute(args) {
        const page = await desk.read(typeof args.id === 'string' && args.id ? args.id : undefined, {
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(args.includeRead === true ? { includeRead: true } : {}),
        })
        let returned = 0
        let markedRead = 0
        const tickets = page.tickets.map((ticket) => {
          const reports = ticket.reports.map((line, index) => {
            if (!line.read) markedRead += 1
            // 一条报告可能很长：截到 4000 字，别把上下文一次塞满。
            const text = line.text.length > 4000 ? line.text.slice(0, 4000) : line.text
            return {
              n: line.n ?? index + 1,
              at: line.at,
              read: line.read,
              text,
              ...(text.length < line.text.length ? { truncated: true } : {}),
            }
          })
          returned += reports.length
          return {
            id: ticket.id,
            status: ticket.status,
            goal: ticket.goal,
            pendingReports: ticket.pendingReports,
            reports,
          }
        })
        return { tickets, returned, markedRead }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_close',
      description:
        'Close a ticket for good: done when the work landed, dropped when it was abandoned. Messages still queued on it are voided and the 小鱼 is stopped.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        outcome: {
          type: 'string',
          enum: ['done', 'dropped'],
          description: "done (default) = the work landed; dropped = abandoned.",
        },
        note: { type: 'string', description: 'One line on how it ended.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            closed: { type: 'boolean' },
            openCount: { type: 'number' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.closed
              ? `ticket ${value.id} ${value.status} (${value.openCount} open)`
              : `ticket ${value.id} was already ${value.status}`,
          },
        ],
      },
      async execute(args, exec) {
        const outcome: 'done' | 'dropped' = args.outcome === 'dropped' ? 'dropped' : 'done'
        const receipt = await desk.close(args.id, {
          outcome,
          ...(args.note ? { note: args.note } : {}),
          actor: actorOf(exec),
        })
        return { id: receipt.id, status: receipt.status, closed: receipt.closed, openCount: receipt.openCount }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_block',
      description:
        'Park an open ticket as blocked while a person decides something. Router only: a 小鱼 reports the blocker instead and waits.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        reason: { type: 'string', required: true, description: 'What is being waited on, in one line.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, status: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: `ticket ${value.id} ${value.status}` }],
      },
      async execute(args, exec) {
        const receipt = await desk.block(args.id, args.reason, actorOf(exec))
        return { id: receipt.id, status: receipt.status }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'dispatch_list',
      description:
        'List tickets, oldest first. A leading ! marks one that has gone quiet, »n counts messages the 小鱼 has not received, «n counts reports you have not read.',
      parameters: {
        status: { type: 'string', enum: STATUSES, description: 'Only this status.' },
        includeClosed: { type: 'boolean', description: 'Also list done and dropped tickets.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            openCount: { type: 'number' },
            tickets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  status: { type: 'string' },
                  brief: { type: 'string' },
                  ageMinutes: { type: 'number' },
                  stale: { type: 'boolean' },
                  statusSince: { type: 'string' },
                  preset: { type: 'string' },
                  pendingInputs: { type: 'number' },
                  pendingReports: { type: 'number' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const tickets = value.tickets ?? []
          const head = `${value.openCount} open`
          if (tickets.length === 0) return [{ type: 'text', text: `${head}, none listed` }]
          return [
            {
              type: 'text',
              text: [head, ...tickets.map((ticket) => `  ${ticketLine(ticket as TicketView)}`)].join('\n'),
            },
          ]
        },
      },
      async execute(args) {
        const all = args.includeClosed === true
        const wanted = args.status as TicketStatus | undefined
        const views = desk
          .list({ all: all || wanted !== undefined })
          .filter((view) => !wanted || view.status === wanted)
        return {
          openCount: desk.list().length,
          tickets: views.map((view) => ({
            id: view.id,
            status: view.status,
            brief: view.brief,
            ageMinutes: view.ageMinutes,
            stale: view.stale,
            statusSince: view.statusSince,
            ...(view.preset ? { preset: view.preset } : {}),
            pendingInputs: view.pendingInputs,
            pendingReports: view.pendingReports,
          })),
        }
      },
    }),
  )

  // worker 侧唯一的票工具：追加一行，改不了任何状态。
  ctx.tools.register(
    defineTool({
      name: 'dispatch_report',
      description:
        'Hand a report back on the ticket you are working. Append-only: the ticket state stays where it is, the router decides. Call it once when this round is done, or to state a blocker and stop.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id you were given.' },
        text: { type: 'string', required: true, description: 'What you did, found, or are blocked on.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            epoch: { type: 'number' },
            pendingReports: { type: 'number' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `report recorded on ticket ${value.id} (round ${value.epoch})` },
        ],
      },
      async execute(args) {
        const receipt = await desk.report(args.id, args.text, 'worker')
        return { id: receipt.id, epoch: receipt.epoch, pendingReports: receipt.pendingReports }
      },
    }),
  )

  // ── 打点：一行进度直接推到主人手机上 ────────────────────────────
  // 不写 jsonl、不叫醒任何会话。推送失败只在日志里记一笔，不抛给模型——打点是
  // 顺手的礼貌，不该拖住干活。P3 起主会话和小鱼的白名单里都没有它（小鱼该用
  // dispatch_report），工具留着给手工调用和老的测试会话。
  ctx.tools.register(
    defineTool({
      name: 'progress_note',
      description:
        'Push one line of progress straight to the person on QQ. No session is woken and nothing is written to disk.',
      parameters: {
        text: { type: 'string', required: true, description: "One line of progress, short and in the person's own terms." },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { sent: { type: 'boolean' } },
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
  // 顺序有讲究：这一段必须跑在所有 `ctx.tools.register` 之后。装载器拿 allow
  // 名单去注册表点名，点不到的按「名字写错」剔掉；热重载时先装白名单会把本插件
  // 自己的 dispatch_* 当错名扔掉。
  if (config.routerRestrict || config.workerToolDeny || config.workerPromptPrune) {
    const routerSeen = new WeakSet<object>()
    const bindings = new Set<RouterBinding>()
    const bound = new WeakMap<object, RouterBinding>()
    let announced = false
    let workerAnnounced = false
    let tearingDown = false
    const registry = {
      get(name: string): unknown {
        const tools = (ctx as { tools?: { get?: (name: string) => unknown } }).tools
        return tools?.get?.(name)
      },
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
      // deny 叠加、越减越少，跟 allow 不打架。拼在配置之后、不进默认值。
      deny: config.workerToolDeny ? [...new Set([...config.workerDenyTools, ...WORKER_FORBIDDEN_TOOLS])] : [],
      pruneWorkerPrompt: config.workerPromptPrune,
      escapeFile: config.routerEscapeFile,
      log: warn,
      info,
      registry,
    }
    const install = (agent: RouterAgent): void => {
      const worker = isWorkerSession(agent.session.header.origin)
      if (worker ? !config.workerToolDeny && !config.workerPromptPrune : !config.routerRestrict) return
      let binding = bound.get(agent)
      if (binding === undefined) {
        if (routerSeen.has(agent)) return
        routerSeen.add(agent)
        binding = bindRouter(agent, options)
        bound.set(agent, binding)
        bindings.add(binding)
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
          info(`[dispatcher] worker subagents hide ${binding.installed().length} tool(s): ${binding.installed().join(', ')}`)
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
    for (const agent of agentsOf()?.list() ?? []) install(agent as never)
    ctx.on('agent/created', ({ agent }) => {
      install(agent as never)
      return undefined
    })
    ctx.on('tools/change', () => {
      if (tearingDown) return undefined
      for (const binding of [...bindings]) binding.sync()
      return undefined
    })
    ctx.effect(() => () => {
      tearingDown = true
      for (const binding of [...bindings]) binding.dispose()
      bindings.clear()
    }, 'dsh-dispatcher.router-teardown')
  }
}
