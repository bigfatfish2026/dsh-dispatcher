/**
 * 十一个工具的定义与注册：router 六个票工具、worker 侧 report/declare/touch、
 * 动作账本、打点。从 apply() 整段搬出来；apply 只拿回 WorkerTicketTools
 * （agent/created 那条兜底注册还要用它）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config'
import type { TicketOrigin, TicketStatus } from '../store'
import type { TicketView } from '../tickets/desk'
import { isWorkerSession } from '../no-wait'
import { TOOL_NAMES, TICKET_STATUSES } from '../protocol'
import { sendProgress } from '../progress'
import { WorkerTicketTools } from '../tickets/worker-tools'
import type { TicketDesk } from '../tickets/desk'
import type { SweepFacts } from '../tickets/sweep-facts'
import {
  actorOf,
  callerActorOf,
  intentPlanLines,
  intentSpecOf,
  planSpecOf,
  pathListLine,
  requestIdOf,
  ticketLine,
  statusMark,
  phaseMark,
} from '../tools-shared'

const STATUSES = TICKET_STATUSES

const RESOURCE_PREFIX = /^(?:file|dir|git|svc|port|dev):/i
const PATH_PREFIX = /^(?:file|dir|git|dev):/i

/**
 * 票工具收路径：裸路径补 `file:` 前缀，已是六种资源前缀的原样留下。
 *
 * `normalizeResources` 只认前缀，而这一层最靠近「人写路径」，别让子会话为了报
 * 个文件先学资源串语法。`dispatch_touch` 与 `dispatch_report` 的 paths 共用它。
 *
 * `pathOnly` 给 dispatch_report 的补声明用：那一栏只收文件路径，`svc:` / `port:`
 * 不是改动面，直接拒掉，别补成 `file:svc:...` 混进 intent.writes。`max` 是条数
 * 上限，超了报错让人分批，不静默截断。
 */
function pathResources(raw: unknown, options: { pathOnly?: boolean; max?: number } = {}): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    const known = RESOURCE_PREFIX.test(trimmed)
    if (options.pathOnly && known && !PATH_PREFIX.test(trimmed)) {
      throw new Error(
        `dispatch_report 的 paths 只收文件路径，${trimmed} 不是；服务、端口这类写进 intent.writes 要走 dispatch_declare`,
      )
    }
    const uri = known ? trimmed : `file:${trimmed}`
    if (seen.has(uri)) continue
    seen.add(uri)
    out.push(uri)
  }
  if (options.max !== undefined && out.length > options.max) {
    throw new Error(
      `dispatch_report 一次最多补 ${options.max} 条路径（这次 ${out.length} 条），请分批重交`,
    )
  }
  return out
}

export interface ToolsInstallerDeps {
  config: Config
  desk: TicketDesk
  sweepFacts: Pick<SweepFacts, 'forget'>
  warn: (message: string) => void
}

export function installTools(ctx: Context, deps: ToolsInstallerDeps): WorkerTicketTools {
  const { config, desk, sweepFacts, warn } = deps
  // ── 七个工具：router 六个 + worker 一个 ──────────────────────────
  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.open,
      description:
        'Open a ticket and hand the work to a 子会话 in one step: the desk picks the preset, starts the 子会话, writes the ticket and returns its id. Call it before answering the person — never spawn a subagent yourself. Every ticket starts with a read-only probe round: that first 子会话 has no write / edit / bash, reads the code and hands its plan and intent back with dispatch_declare before anything is touched. dispatch_open takes neither intent nor probe — there is no path that skips the probe round.',
      parameters: {
        goal: { type: 'string', required: true, description: 'What the 子会话 is asked to do, verbatim and complete.' },
        brief: {
          type: 'string',
          required: true,
          description:
            'Required: the one line the little screen shows under the ticket title — a short phrase, not a sentence. At most briefMaxColumns character columns (34 by default), a 汉字 counts 2, so about 17 汉字 is the ceiling. Empty, whitespace-only or punctuation-only is rejected.',
        },
        dir: { type: 'string', description: 'Working directory the 子会话 should use, if any.' },
        origin: {
          type: 'string',
          enum: ['main', 'ego'],
          description:
            'Who is opening this ticket. Omit for main (the person / main session). ego must pass "ego".',
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
            duplicate: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.duplicate
              ? `ticket ${value.id} already open (same request, ${value.openCount} open)`
              : value.reason
                ? `ticket ${value.id} held in waiting, 子会话 not started: ${value.reason}`
                : `ticket ${value.id} opened, 子会话 started (${value.openCount} open)`,
          },
        ],
      },
      async execute(args, exec) {
        const raw = args as unknown as Record<string, unknown>
        // 老调用方还会塞 intent：不静默忽略——那会让人以为意图已经落库。
        // 明说去哪儿交，模型下一轮就会改用 dispatch_declare。
        if (raw.intent !== undefined) {
          throw new Error(
            'dispatch_open 不再收 intent：子会话探路后会自己用 dispatch_declare 交代 intent',
          )
        }
        // probe 开关也删了：所有票一律探路，没有「不探路直接干」的快路径。
        // 静默忽略会让人以为快路径还在，所以照 intent 的做法明拒。
        if (raw.probe !== undefined) {
          throw new Error('dispatch_open 不再收 probe：所有票一律先探路，没有跳过的快路径')
        }
        const receipt = await desk.open(
          {
            goal: args.goal,
            brief: args.brief,
            ...(args.dir ? { dir: args.dir } : {}),
            ...(requestIdOf(exec) ? { requestId: requestIdOf(exec) as string } : {}),
            ...(raw.origin ? { origin: raw.origin as TicketOrigin } : {}),
          },
          actorOf(exec),
        )
        return {
          id: receipt.id,
          status: receipt.status,
          openCount: receipt.openCount,
          ...(receipt.duplicate ? { duplicate: receipt.duplicate } : {}),
          ...(receipt.reason ? { reason: receipt.reason } : {}),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.send,
      description:
        'Put one more message into an open ticket. The 子会话 receives it now if it is idle, otherwise on its next turn. A finished ticket refuses it: open a new one.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id.' },
        text: { type: 'string', required: true, description: 'What to tell the 子会话, verbatim.' },
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
      name: TOOL_NAMES.read,
      description:
        'Read reports the 子会话 left on tickets and mark them delivered. Omit id to read every open ticket with unread reports.',
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
                  phase: { type: 'string' },
                  goal: { type: 'string' },
                  pendingReports: { type: 'number' },
                  intent: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      writes: { type: 'array', items: { type: 'string' } },
                      reads: { type: 'array', items: { type: 'string' } },
                      impact: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          paths: { type: 'array', items: { type: 'string' } },
                          services: { type: 'array', items: { type: 'string' } },
                          remotes: { type: 'array', items: { type: 'string' } },
                        },
                      },
                      reversibility: { type: 'string', enum: ['auto', 'manual', 'none'] },
                      dryRun: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
                      },
                      undo: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          kind: { type: 'string' },
                          ref: { type: 'string' },
                          howto: { type: 'string' },
                        },
                      },
                    },
                  },
                  plan: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      summary: { type: 'string' },
                      files: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: { path: { type: 'string' }, what: { type: 'string' } },
                        },
                      },
                    },
                  },
                  outOfScope: { type: 'array', items: { type: 'string' } },
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
            const head = `ticket ${ticket.id} ${ticket.status}${statusMark(ticket.status)}${phaseMark(ticket.phase)}：${ticket.goal}`
            const body = (ticket.reports ?? []).map(
              (report) => `  #${report.n}${report.read ? ' (read)' : ''} ${report.text}`,
            )
            // 同 dispatch_list：render 的值按 TicketView 读。
            return [head, ...intentPlanLines(ticket as TicketView), ...body].join('\n')
          })
          return [{ type: 'text', text: blocks.join('\n') }]
        },
      },
      async execute(args) {
        const page = await desk.read(typeof args.id === 'string' && args.id ? args.id : undefined, {
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(args.includeRead === true ? { includeRead: true } : {}),
        })
        // 看过的票从巡检事实里摘掉：下一轮快照里它就不出现了。
        for (const ticket of page.tickets) sweepFacts.forget(ticket.id, ['report', 'no-report'])
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
            ...(ticket.phase ? { phase: ticket.phase } : {}),
            goal: ticket.goal,
            pendingReports: ticket.pendingReports,
            ...(ticket.intent ? { intent: ticket.intent } : {}),
            ...(ticket.plan ? { plan: ticket.plan } : {}),
            ...(ticket.outOfScope?.length ? { outOfScope: ticket.outOfScope } : {}),
            reports,
          }
        })
        return { tickets, returned, markedRead }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.close,
      description:
        'Close a ticket for good: done when the work landed, dropped when it was abandoned. Messages still queued on it are voided and the 子会话 is stopped.',
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
        // 收工的票不再需要巡检提醒：条目全摘。
        sweepFacts.forget(receipt.id)
        return { id: receipt.id, status: receipt.status, closed: receipt.closed, openCount: receipt.openCount }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.block,
      description:
        'Park an open ticket as blocked while a person decides something. Router only: a 子会话 reports the blocker instead and waits.',
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
      name: TOOL_NAMES.list,
      description:
        'List tickets, oldest first. A leading ! marks one that has gone quiet, »n counts messages the 子会话 has not received, «n counts reports you have not read.',
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
                  phase: { type: 'string' },
                  brief: { type: 'string' },
                  ageMinutes: { type: 'number' },
                  stale: { type: 'boolean' },
                  statusSince: { type: 'string' },
                  preset: { type: 'string' },
                  pendingInputs: { type: 'number' },
                  pendingReports: { type: 'number' },
                  waitOn: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        ticketId: { type: 'string' },
                        resources: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                  weakWith: { type: 'array', items: { type: 'string' } },
                  outOfScope: { type: 'array', items: { type: 'string' } },
                  intent: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      writes: { type: 'array', items: { type: 'string' } },
                      reads: { type: 'array', items: { type: 'string' } },
                      impact: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          paths: { type: 'array', items: { type: 'string' } },
                          services: { type: 'array', items: { type: 'string' } },
                          remotes: { type: 'array', items: { type: 'string' } },
                        },
                      },
                      reversibility: { type: 'string', enum: ['auto', 'manual', 'none'] },
                      dryRun: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
                      },
                      undo: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          kind: { type: 'string' },
                          ref: { type: 'string' },
                          howto: { type: 'string' },
                        },
                      },
                    },
                  },
                  plan: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      summary: { type: 'string' },
                      files: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: { path: { type: 'string' }, what: { type: 'string' } },
                        },
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
          const head = `${value.openCount} open`
          if (tickets.length === 0) return [{ type: 'text', text: `${head}, none listed` }]
          return [
            {
              type: 'text',
              text: [
                head,
                ...tickets.flatMap((ticket) => [
                  `  ${ticketLine(ticket as TicketView)}`,
                  // 值的真实形状是 TicketView（schema 推导出来的形状每栏都可选，
                  // 跟 IntentSpec 的必填项对不上），和上面 ticketLine 同一个读法。
                  ...intentPlanLines(ticket as TicketView),
                ]),
              ].join('\n'),
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
        // 列表里已经出现过的票，不必再在巡检快照里重复一遍。
        for (const view of views) sweepFacts.forget(view.id)
        return {
          openCount: desk.list().length,
          tickets: views.map((view) => ({
            id: view.id,
            status: view.status,
            ...(view.phase ? { phase: view.phase } : {}),
            brief: view.brief,
            ageMinutes: view.ageMinutes,
            stale: view.stale,
            statusSince: view.statusSince,
            ...(view.preset ? { preset: view.preset } : {}),
            pendingInputs: view.pendingInputs,
            pendingReports: view.pendingReports,
            ...(view.intent ? { intent: view.intent } : {}),
            ...(view.plan ? { plan: view.plan } : {}),
            ...(view.waitOn?.length ? { waitOn: view.waitOn } : {}),
            ...(view.weakWith?.length ? { weakWith: view.weakWith } : {}),
            ...(view.outOfScope?.length ? { outOfScope: view.outOfScope } : {}),
          })),
        }
      },
    }),
  )

  // worker 侧的票工具之一：追加一行，改不了任何状态。
  const reportTool = defineTool({
    name: TOOL_NAMES.report,
    description:
      'Hand a report back on the ticket you are working. Append-only: the ticket state stays where it is, the router decides. Call it once when this round is done, or to state a blocker and stop. The report is always recorded: if the paths this round actually touched are not declared in intent, the list is printed at the top of the report and echoed back — pass them again in paths (they are added to intent.writes) or declare them with dispatch_declare. A path allowed only in a send message is not a declaration.',
    parameters: {
      id: { type: 'string', required: true, description: 'Ticket id you were given.' },
      text: { type: 'string', required: true, description: 'What you did, found, or are blocked on.' },
      paths: {
        type: 'array',
        description:
          'Files you actually wrote or edited this round that the ticket intent did not declare. Absolute paths (a file: prefix is also accepted); duplicates are merged; at most 50 per call. They are added to intent.writes before the report is recorded. Optional.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          epoch: { type: 'number' },
          pendingReports: { type: 'number' },
          outOfScope: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        // 报告已经落库；差集非空时把清单和补声明用法一并给出去。模型看到的就是
        // 这段文本，光给一个 outOfScope 字段它不知道下一步干什么。
        const head = `report recorded on ticket ${value.id} (round ${value.epoch})`
        if (!value.outOfScope?.length) return [{ type: 'text', text: head }]
        return [
          { type: 'text', text: head },
          { type: 'text', text: pathListLine('未声明的改动：', value.outOfScope) },
          {
            type: 'text',
            text: '加了声明就不会出现在关票对账里：dispatch_declare 的 intent.writes，或再交一次 dispatch_report 带 paths。',
          },
        ]
      },
    },
    async execute(args, exec) {
      const paths = pathResources((args as { paths?: unknown }).paths, { pathOnly: true, max: 50 })
      const receipt = await desk.report(args.id, args.text, 'worker', callerActorOf(exec), {
        ...(paths.length > 0 ? { paths } : {}),
      })
      return {
        id: receipt.id,
        epoch: receipt.epoch,
        pendingReports: receipt.pendingReports,
        ...(receipt.outOfScope?.length ? { outOfScope: receipt.outOfScope } : {}),
      }
    },
  })

  ctx.tools.register(reportTool)

  // 探路交活：票号不给，按调用者反查自己名下那张票，别人的票写不进来。
  // 也不碰状态：declared 只是信息，转 planned 由主会话的动作写。
  const declareTool = defineTool({
    name: TOOL_NAMES.declare,
    description:
      'Declare your plan and reversal intent on the ticket you are working. Ticket id is not a parameter: the desk looks up the ticket attached to this worker, so you cannot write on someone else\'s. Append-only, status untouched. Write absolute paths in writes/reads: relative ones are resolved against the ticket dir and echoed back, and a ticket without a dir keeps them as-is. Refused when no ticket is attached to this worker or the ticket is already done/dropped.',
    parameters: {
      plan: {
        type: 'object',
        additionalProperties: false,
        description: 'What you intend to do: a summary and the files you will touch (file level, no line numbers).',
        properties: {
          summary: { type: 'string', description: 'One paragraph on how this ticket gets done.' },
          files: {
            type: 'array',
            description: 'Files you plan to change, each with roughly what happens to it.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true, description: 'Concrete file path.' },
                what: { type: 'string', description: 'One line: what changes in this file.' },
              },
            },
          },
        },
      },
      intent: {
        type: 'object',
        additionalProperties: false,
        description:
          'Reversal intent: writes, reads, impact, reversibility, dryRun, undo. This is where intent comes from now — dispatch_open does not take it.',
        properties: {
          writes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Resources this ticket will write, as URIs: file:/dir:/git:/svc:/port:/dev: (see the six prefixes). Optional.',
          },
          reads: {
            type: 'array',
            items: { type: 'string' },
            description: 'Same URI form: resources this ticket only reads. Optional.',
          },
          impact: {
            type: 'object',
            additionalProperties: false,
            description: 'What the work touches. Paths, services and remotes, as concrete strings.',
            properties: {
              paths: { type: 'array', items: { type: 'string' }, description: 'File or directory paths.' },
              services: { type: 'array', items: { type: 'string' }, description: 'systemd units or other services.' },
              remotes: { type: 'array', items: { type: 'string' }, description: 'git remotes / hosts / accounts.' },
            },
          },
          reversibility: {
            type: 'string',
            enum: ['auto', 'manual', 'none'],
            description:
              'auto = the side effect is confined and can be undone in one step; manual = a person has to follow undo.howto; none = cannot be taken back (restart, push, sent message).',
          },
          dryRun: {
            type: 'object',
            additionalProperties: false,
            description: 'Result of a rehearsal (--dry-run, config dump, diff).',
            properties: {
              ok: { type: 'boolean', required: true, description: 'Whether the rehearsal passed.' },
              detail: { type: 'string', description: 'One line a person can read when ok=false.' },
            },
          },
          undo: {
            type: 'object',
            additionalProperties: false,
            description: 'How to undo it. howto must be a concrete command or a concrete path.',
            properties: {
              kind: { type: 'string', required: true, description: 'file / git / service / message / config …' },
              ref: { type: 'string', description: 'Backup path, commit sha, message id, unit name.' },
              howto: { type: 'string', required: true, description: 'The exact command or path a person would run.' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          epoch: { type: 'number' },
          files: { type: 'number' },
          resources: { type: 'number' },
          resolved: {
            type: 'array',
            description: 'Relative paths resolved against the ticket dir: what you wrote → what was stored.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { from: { type: 'string' }, to: { type: 'string' } },
            },
          },
          unresolved: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relative resources kept as-is because the ticket has no dir; write absolute paths.',
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          // 回执只说「交上了」，不说「放行」：冲突判定要等探路子会话 idle 那一拍，
          // 以前的英文回执被子会话读成「已经判过、放行了」。
          `ticket ${value.id} 已登记 ${value.files} 个文件、${value.resources} 个资源，等探路收工后判定冲突`,
        ]
        // 声明落盘的是绝对路径：相对路径解析成了什么，当场回显，别让子会话自己猜。
        if (value.resolved?.length) {
          lines.push('路径已按票的 dir 解析：')
          for (const item of value.resolved) lines.push(`  ${item.from} → ${item.to}`)
        }
        if (value.unresolved?.length) {
          lines.push(
            `票上没有 dir，这些相对路径原样落盘：${value.unresolved.join('、')}。路径一律写绝对路径。`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      // 票号不收：按调用者的会话 id 反查归属，desk 只许写到这张票上。
      const raw = args as unknown as { plan?: unknown; intent?: unknown }
      const receipt = await desk.declare(
        actorOf(exec).sessionId,
        planSpecOf(raw.plan) ?? {},
        intentSpecOf(raw.intent) ?? {},
      )
      return {
        id: receipt.id,
        status: receipt.status,
        epoch: receipt.epoch,
        files: receipt.files,
        resources: receipt.resources,
        resolved: receipt.resolved,
        unresolved: receipt.unresolved,
      }
    },
  })

  ctx.tools.register(declareTool)

  // 收尾自报：执行子会话干完把实际动过的文件报上来，给关票那一刀对账。
  // 归属跟 dispatch_declare 同一套反查，票号不由调用方给；不碰状态。
  // t2（只读探路）和 t3（记忆）的白名单里没有它：探路轮不该报「动过什么」。
  const touchTool = defineTool({
    name: TOOL_NAMES.touch,
    description:
      'Report the files you actually touched this round on the ticket you are working. Ticket id is not a parameter: the desk looks up the ticket attached to this worker, so you cannot report on someone else\'s. Append-only and status untouched; calls merge by path. Refused when no ticket is attached to this worker or the ticket is already done/dropped.',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        description:
          'Absolute file paths you actually wrote or edited (a file: prefix is also accepted). Directories and other resource prefixes are passed through.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          paths: { type: 'number' },
          total: { type: 'number' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `touched ${value.paths} path(s) on ticket ${value.id} (${value.total} total)`,
        },
      ],
    },
    async execute(args, exec) {
      const paths = pathResources((args as { paths?: unknown }).paths)
      const receipt = await desk.touch(actorOf(exec).sessionId, paths)
      return { id: receipt.id, paths: receipt.paths, total: receipt.total }
    },
  })

  ctx.tools.register(touchTool)

  // 三件装给 worker 用：`publish.ts` 派活回来按 workerId 伸一次手，`agent/created`
  // 那一刀按 origin 再伸一次，谁先到谁装（`attach` 幂等）。
  const workerTicketTools = new WorkerTicketTools({ definitions: [reportTool, declareTool, touchTool], warn })
  ctx.effect(() => () => workerTicketTools.detachAll(), 'dsh-dispatcher.worker-tools')

  // 动作账本：子会话（和主会话）每干完一步就记一条。附录用，不改状态。
  // 不进 WORKER_FORBIDDEN_TOOLS：子会话必须能写账，否则「可撤回」只剩意图那一栏。
  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.logAction,
      description:
        'Append one action to a ticket ledger right after you actually did it. Log every step with a side effect: writing or editing a file, any git operation, changing config or profile, sending a message, restarting/stopping a service, running a command that changes state. Append-only: the ticket status is never touched. undo.howto must be a concrete command or a concrete path (for something that cannot be undone, write the compensating action) — generic lines like "revert it" are rejected.',
      parameters: {
        id: { type: 'string', required: true, description: 'Ticket id this action belongs to.' },
        summary: {
          type: 'string',
          required: true,
          description: 'One line: what you actually did (file:line, commit, unit, message target). At most 300 characters.',
        },
        undo: {
          type: 'object',
          additionalProperties: false,
          required: true,
          description: 'How to take this step back.',
          properties: {
            kind: { type: 'string', required: true, description: 'file / git / service / message / config …' },
            ref: { type: 'string', description: 'Backup path, commit sha, message id, unit name.' },
            howto: {
              type: 'string',
              required: true,
              description: 'The exact command or path a person would run, e.g. "cp /srv/app/x.yml.bak /srv/app/x.yml".',
            },
          },
        },
        step: {
          type: 'integer',
          description: 'Step number in this ticket. Omit to append after the last step.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            step: { type: 'number' },
            actions: { type: 'number' },
            at: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `action #${value.step} logged on ticket ${value.id} (${value.actions} on record)` },
        ],
      },
      async execute(args, exec) {
        // 谁在记：worker 的 session header 带 origin='subagent'；主会话没有。
        const agent = (exec as { agent?: { session?: { header?: { origin?: string } } } }).agent
        const actor = isWorkerSession(agent?.session?.header?.origin) ? 'worker' : 'main'
        const receipt = await desk.logAction(
          args.id,
          {
            summary: args.summary,
            undo: args.undo,
            ...(args.step !== undefined ? { step: args.step } : {}),
          },
          actor,
        )
        return { id: receipt.id, step: receipt.step, actions: receipt.actions, at: receipt.at }
      },
    }),
  )

  // ── 打点：一行进度直接推到使用方手机上 ────────────────────────────
  // 不写 jsonl、不叫醒任何会话。推送失败只在日志里记一笔，不抛给模型——打点是
  // 顺手的礼貌，不该拖住干活。P3 起主会话和子会话的白名单里都没有它（子会话该用
  // dispatch_report），工具留着给手工调用和老的测试会话。
  ctx.tools.register(
    defineTool({
      name: TOOL_NAMES.progressNote,
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

  return workerTicketTools
}
