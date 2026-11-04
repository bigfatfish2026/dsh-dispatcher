import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { BRIEF_MAX_COLUMNS } from './store'
import type { TicketBackendName } from './store/backend'

// Tunable configuration must be a Schemastery Schema, never a plain object:
// the harness validates it at load time and fails loud on invalid values, and
// every key can be changed from cordis.yml without editing code (guide §3.6).
/**
 * Global tool names a main session keeps when the router whitelist is on.
 *
 * Names must match the registered global tool exactly: `tools.restrict` throws
 * on an unknown name, so the plugin checks this list against the registry when
 * it installs the filter and drops (with a warning) anything it cannot find.
 *
 * 2026-11-04 起主会话不再自己 spawn 小鱼：`dispatch_open` 一步就把档、小鱼、
 * 票都办了，所以 `subagent` / `subagent_fork` 从这里摘掉。票面就六个名字，
 * 报告正文走 dispatch_read，打点归小鱼（progress_note 不在任何名单里）。
 */
export const DEFAULT_ROUTER_TOOLS: readonly string[] = [
  'dispatch_open',
  'dispatch_send',
  'dispatch_read',
  'dispatch_close',
  'dispatch_block',
  'dispatch_list',
  // 会话之间传话、收队列、看谁还活着：这三样和票无关，留在主会话。
  'send_message',
  'interrupt_agent',
  'list_agents',
  // Session bookkeeping.
  'todo_write',
  'present',
  'create_goal',
  'get_goal',
  'update_goal',
  // Memory, so the main session still remembers between turns.
  'memory_recall',
  'memory_entity',
  'memory_save',
  'memory_archive',
  'memory_merge',
  'memory_reflect',
  'chat_recall',
  // Talking to the person.
  'yuyu_face',
  'yuyu_face_list',
  // 主人常发图，看不见就聊不动。纯只读，不写盘。
  'read_image',
  // Machine health, read-only.
  'host_status',
  'host_alerts',
  // 宿主注册的只读文件工具。grep 2026-11-01 摘掉：输出体积不可控，一句没收住
  // 的搜索等于按整段日志付钱；要搜内容让小鱼去搜，把结果压成几行带回来。
  'read',
  'glob',
]

/**
 * Tool names a worker subagent must not see.
 *
 * Background: since 2026-11-01 the operator's rule is that only the main session
 * writes memory — a worker may `memory_recall`, never `memory_save` or anything
 * that rewrites what is remembered. `dsh-memory` enforces that at execute time
 * (its own guard, 0.3.3), so this list is a second layer of the same rule, not a
 * replacement for it.
 */
export const DEFAULT_WORKER_DENY_TOOLS: readonly string[] = [
  'memory_save',
  'memory_archive',
  'memory_merge',
  'memory_reflect',
  'memory_split',
  'memory_consolidate',
  'memory_sleep',
]

/**
 * The hand-off rules appended to the main session's system prompt.
 *
 * It lives here, not in index.ts, because it is a config default: the whole
 * text is meant to be rewritten in cordis.yml without a rebuild, and the schema
 * default has to be the same string the operator gets when they say nothing.
 *
 * 2026-11-04 重写：开票和派活合成一步（没有「先 spawn 再记票」了），交活靠票台
 * 自动推摘要（小鱼不再 send_message 喊人），终态票不收消息。
 */
export const DEFAULT_HANDOFF_POLICY = `【派活规矩 · dispatcher】主会话的活是及时回话，长活交给小鱼。
下面任一条成立就 dispatch_open 派出去，别自己耗着：要等三十秒以上（编译、下载、批处理）、要跑好几轮才收（全量测试、多轮调研、翻资料比对）、主人正等着而活一时半会儿完不了。
都不成立就自己干：改一两处、查一眼状态、只有我能拍板的。
dispatch_open 一步到位：它自己挑档、自己起小鱼、自己记票，回执给票号。别自己 spawn 子会话——主会话手上已经没有那个工具了。
票号写进任务里让小鱼用 dispatch_report 交活；主人中途追加的话用 dispatch_send 进票，别转述丢了。
交活是自动的：报告一到就会有一句摘要推过来，要看正文用 dispatch_read。
票成了 done 或 dropped 就是收工了，不许再拿 dispatch_send 往里塞话——要接着干就开新票。
小鱼卡住会在报告里说清卡点，票挂在 waiting / blocked 上等你：决定下一步用 dispatch_block 挂起、dispatch_send 回话、dispatch_close 收工。
记忆只有主会话能写：小鱼只许 memory_recall 查，memory_save / memory_archive / memory_merge / memory_split 一律不许调，发现该记的东西在 dispatch_report 里提一句，交回主会话落笔。`

export interface Config {
  /** Where the ticket log lives. One JSON object per line, append-only. */
  stateFile: string
  /**
   * Which storage backend serves the ticket log. Only the shape of the log is
   * fixed; this picks who reads and appends it.
   */
  store?: {
    /** 'jsonl' (default) | 'redis' | 'sqlite'. The last two fail loud for now. */
    backend?: TicketBackendName
  }
  /**
   * 桌面快照文件：每次票变化后落一份只读 JSON，给桌宠这类不能每 2 秒 fork 一个
   * node 进程的消费者。空串 = 跟着日志走（同目录的 `tickets.snapshot.json`）。
   */
  snapshotFile: string
  /** 关掉快照文件（测试或不需要桌宠时用）。 */
  snapshotEnabled: boolean
  /** 快照里未结票之外再带最近多少张已结票；0 = 只带未结票。 */
  snapshotRecentClosed: number
  /**
   * 默认档。**没有代码默认值**：值由 profile 给（今天 `t1`），配置和档位注册表
   * 都不给就拒绝开票。空串 = 没配（schemastery 的 null 默认不落地，用空串表达
   * 「没配」比塞一个假档名诚实）。
   */
  defaultPreset: string
  /** `llm` = 问一次小模型选档；`static` = 直接用默认档，不花那一次调用。 */
  presetStrategy: 'llm' | 'static'
  /** 选档用的模型，写成 `provider/model`。 */
  classifyModel: string
  /** 选档的推理档 id；空串 = 路由默认。今天 `none`（yml 里写 `off`）。 */
  classifyEffort: string
  /** 选档最多等多久，毫秒。到点就回落默认档，不阻塞开票。 */
  classifyTimeoutMs: number
  /** 传给 `startActivation` 的 provider 名。 */
  provider: string
  /** 往任务的活里带一层子会话：1 = 小鱼不能再派小鱼。 */
  maxDepth: number
  /** How many tickets may be open (not done, not dropped) at once. */
  maxOpen: number
  /**
   * Longest ticket brief, in character columns (a 汉字 is 2). What the little
   * screen's second line can hold; defaults to BRIEF_MAX_COLUMNS.
   */
  briefMaxColumns: number
  /** 巡检间隔，毫秒。只看状态、只发信号，不改票。0 = 关定时器（只由过时的 sweepMinutes 折算出来）。 */
  sweepMs: number
  /**
   * 已过时，改用 `sweepMs`。显式配置时它说了算：按 `sweepMinutes × 60000`
   * 折算成 `sweepMs`，装载时 warn 一句；0 = 关定时器。不配置就用 `sweepMs`。
   */
  sweepMinutes?: number
  /** waiting 多久算「该催一下」，分钟。 */
  waitingMinutes: number
  /** blocked 多久算「人忘了」，分钟。 */
  blockedMinutes: number
  /** running 多久提醒一次；0 = 不提醒。 */
  runningReminderMinutes: number
  /** disposed 之后多久才认小鱼真没了，挡正常重启的抖动。 */
  freshMinutes: number
  /** 小鱼一轮干完没交报告时，把最后一段输出自动记成报告。 */
  autoReport: boolean
  /** 一轮干完一条报告都没有时，推一句「缺报告」。 */
  noReportSignal: boolean
  /** 同一个人同一件事在这个窗口内再开票视为重复，分钟。 */
  repeatWindowMinutes: number
  /** Append the hand-off rules to the main session's system prompt. */
  handoffPolicy: boolean
  /** The hand-off rules themselves. Empty string turns the section off. */
  handoffPolicyText: string
  /** Refuse main-session tool calls that would sit and wait. */
  noWaitGuard: boolean
  /** Longest a single command may hold the main session, in milliseconds. */
  maxCommandMs: number
  /** Longest a job wait may hold the main session, in milliseconds. */
  maxWaitMs: number
  /** Install the router tool whitelist on every non-worker session. */
  routerRestrict: boolean
  /** An existing file here skips the whitelist; the emergency exit. */
  routerEscapeFile: string
  /** Global tool names the main session keeps. */
  routerTools: string[]
  /** Extra global tool names the main session keeps, appended to `routerTools`. */
  extraRouterTools: string[]
  /** Take the worker deny list out of every subagent's tool schema. */
  workerToolDeny: boolean
  /** Tool names a worker subagent does not see; write-side memory tools. */
  workerDenyTools: string[]
  /** Drop every tool-guidance prompt section from a worker subagent's prompt. */
  workerPromptPrune: boolean
  /** Script that pushes one line of text to the person on QQ. */
  notifyScript: string
  /** Hard cap on one push, in milliseconds. */
  notifyTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  stateFile: Schema.string()
    .default('dispatcher/tickets.jsonl')
    .description('Ticket log path, relative to the DSH home directory unless absolute.'),
  store: Schema.object({
    backend: Schema.union(['jsonl', 'redis', 'sqlite'] as const)
      .default('jsonl')
      .description(
        'Ticket log backend. jsonl is the only implementation today. redis and sqlite are accepted names that fail loud at load time until they exist; a new backend must satisfy the contract at the top of src/store/backend.ts.',
      ),
  })
    .default({ backend: 'jsonl' })
    .description('Storage selection for the ticket log; see store.backend.'),
  snapshotFile: Schema.string()
    .default('')
    .description(
      'Read-only snapshot file for cross-process consumers (desk pet). Written atomically after every ticket commit. Empty means "next to the log": the log directory plus tickets.snapshot.json. Relative paths resolve against the DSH home.',
    ),
  snapshotEnabled: Schema.boolean()
    .default(true)
    .description('Write the read-only snapshot file after every ticket commit.'),
  snapshotRecentClosed: Schema.natural()
    .default(20)
    .description(
      'Closed tickets kept in the snapshot in addition to every open one. Counts in the snapshot are always computed over the whole log, so the "N open" figure stays exact.',
    ),
  // 没有代码默认值：档位名单在 profile 的 agent-preset-registry 里，这里只接一个名字。
  defaultPreset: Schema.string()
    .default('')
    .description(
      'Default preset id for new tickets, e.g. t1. It has no code default on purpose: the preset list lives in the profile (agent-preset-registry), so the operator names one here. An empty string means "not configured": the desk then falls back to the registry default, and if that is empty too dispatch_open refuses with 没有可用档位 instead of guessing.',
    ),
  presetStrategy: Schema.union(['llm', 'static'] as const)
    .default('llm')
    .description(
      'How a new ticket picks its preset. llm: ask a small model once, validated against the registry, falling back to defaultPreset on any failure. static: use defaultPreset directly and spend no call. When the main session itself carries a preset it wins over both.',
    ),
  classifyModel: Schema.string()
    .default('deepseek/deepseek-flash')
    .description(
      'Model used for preset classification, written provider/model. The provider name must be one the host configures; a wrong route is not fatal (the ticket still opens on defaultPreset) but it logs a warning every time.',
    ),
  classifyEffort: Schema.string()
    .default('off')
    .description(
      'Reasoning effort for the classification call. Empty means the model default. off/none is the right choice: the task is one short classification, thinking costs seconds per ticket.',
    ),
  classifyTimeoutMs: Schema.natural()
    .default(8000)
    .description(
      'How long one classification may take, in milliseconds. On timeout the classifier is abandoned and the ticket opens on defaultPreset: a slow model must never block dispatch_open.',
    ),
  provider: Schema.string()
    .default('spawn')
    .description('Provider name passed to subagents.startActivation; spawn is the local subagent provider.'),
  maxDepth: Schema.natural()
    .default(2)
    .description('How deep a worker may itself delegate: 2 means a 小鱼 cannot hand work to another 小鱼.'),
  maxOpen: Schema.natural()
    .default(8)
    .description('Maximum number of tickets that are not done or dropped.'),
  // 小屏第二行的宽度：一个汉字占两列，默认 34 列 = 17 个汉字（2026-11-02 小屏实测）。
  briefMaxColumns: Schema.natural()
    .default(BRIEF_MAX_COLUMNS)
    .description(
      'Longest ticket brief, measured in character columns: a CJK character counts 2, a half-width one 1. The default (34) is 17 汉字, measured 2026-11-02. dispatch_open requires a brief and rejects a blank one.',
    ),
  sweepMs: Schema.number()
    .min(500)
    .default(10_000)
    .description(
      'Milliseconds between maintenance passes; default 10s, minimum 500ms. A pass only reads state and emits signals (waiting 20m, blocked 60m); it never writes a ticket. The timer skips a beat when the previous pass is still queued, so a slow pass never stacks up.',
    ),
  sweepMinutes: Schema.number()
    .min(0)
    .description(
      'Deprecated: use sweepMs. When set explicitly it wins (sweepMs = sweepMinutes × 60000) and the plugin logs a warning at load. 0 turns the timer off. Leave it out to use sweepMs.',
    ),
  waitingMinutes: Schema.natural()
    .default(20)
    .description('A waiting ticket this old is reported once: the 小鱼 stopped and nobody picked the work up.'),
  blockedMinutes: Schema.natural()
    .default(60)
    .description('A blocked ticket this old is reported once: someone forgot to decide.'),
  runningReminderMinutes: Schema.natural()
    .default(0)
    .description('A running ticket is nudged this often; 0 (default) means never: a long job should not nag.'),
  freshMinutes: Schema.natural()
    .default(2)
    .description(
      'A worker that disappears (agent/disposed) is only counted as gone after this many minutes without a ticket write: a normal restart must not end tickets.',
    ),
  autoReport: Schema.boolean()
    .default(true)
    .description(
      'When a round ends without a single dispatch_report, record the last assistant message as a report (source auto). The ticket still moves to waiting: an auto report is not a hand-off.',
    ),
  noReportSignal: Schema.boolean()
    .default(true)
    .description('When a round ends with no report at all and no last message, report that once.'),
  repeatWindowMinutes: Schema.natural()
    .default(10)
    .description(
      'Same session + same goal + same dir within this window (minutes) is treated as a duplicate open and returns the existing ticket instead of creating a second one.',
    ),
  handoffPolicy: Schema.boolean()
    .default(true)
    .description('Append the hand-off rules to the main session system prompt; subagent sessions are never touched.'),
  handoffPolicyText: Schema.string()
    .default(DEFAULT_HANDOFF_POLICY)
    .description(
      'The hand-off rules appended to the main session system prompt. Rewrite the whole block here to change the wording without touching code. An empty (or whitespace-only) string means the section is not injected at all.',
    ),
  noWaitGuard: Schema.boolean()
    .default(true)
    .description(
      'Refuse main-session calls that would wait: sleep, a timeout over maxCommandMs, a job wait over maxWaitMs. Worker subagents are unaffected.',
    ),
  maxCommandMs: Schema.natural()
    .default(30000)
    .description('Longest a single command may hold the main session, in milliseconds.'),
  maxWaitMs: Schema.natural()
    .default(5000)
    .description('Longest a job wait may hold the main session, in milliseconds.'),
  routerRestrict: Schema.boolean()
    .default(true)
    .description(
      'Restrict the main session to the router tool whitelist. Worker subagents are unaffected. Keep routerEscapeFile handy: it is the way out if the whitelist hid something needed.',
    ),
  routerEscapeFile: Schema.string()
    .default(join(homedir(), '.dsh', 'no-restrict'))
    .description('While this file exists the whitelist is not installed, on any session. Touch it to fall back to the full tool surface.'),
  routerTools: Schema.array(Schema.string())
    .default([...DEFAULT_ROUTER_TOOLS])
    .description('Global tool names the main session keeps. Unknown names are dropped with a warning instead of failing the restrict call.'),
  extraRouterTools: Schema.array(Schema.string())
    .default([])
    .description(
      'Extra global tool names the main session keeps, appended after routerTools. This is where tools registered by other plugins belong; values are passed through as written and unknown names are dropped with a warning.',
    ),
  workerToolDeny: Schema.boolean()
    .default(true)
    .description(
      'Take workerDenyTools out of every worker subagent tool schema. Only the schema is trimmed: the real refusal is the memory plugin guard at execute time. Independent of routerRestrict, and the escape file still turns it off.',
    ),
  workerDenyTools: Schema.array(Schema.string())
    .default([...DEFAULT_WORKER_DENY_TOOLS])
    .description(
      'Tool names a worker subagent does not see: the write-side memory tools. memory_recall and the read-only lookup tools stay. Unknown names are dropped with a warning instead of failing the restrict call.',
    ),
  workerPromptPrune: Schema.boolean()
    .default(true)
    .description(
      'Drop every tool-guidance section (tool:*, mcp:*, mcp-resource-servers) from a worker subagent system prompt. A worker tool set comes from its preset, so a static section can never match it. Main sessions are untouched, and the escape file still turns it off.',
    ),
  notifyScript: Schema.string()
    .default('/home/julia/fatfish/notify.sh')
    .description('Script used by progress_note to push one line to the person on QQ; it owns the openid.'),
  notifyTimeoutMs: Schema.natural()
    .default(5000)
    .description('Hard cap on one progress push in milliseconds; the child is killed and the tool returns sent=false.'),
})

/**
 * The whitelist the router actually installs: `routerTools` followed by
 * `extraRouterTools`, order kept, duplicates dropped.
 *
 * Two keys, not one, because they answer different questions: `routerTools` is
 * this package's own table (tickets, memory, delegation), `extraRouterTools` is
 * whatever the operator's other plugins register.
 */
export function routerAllowList(config: Pick<Config, 'routerTools' | 'extraRouterTools'>): string[] {
  const allow: string[] = []
  for (const name of [...config.routerTools, ...config.extraRouterTools]) {
    if (!name || allow.includes(name)) continue
    allow.push(name)
  }
  return allow
}

/** 过时键的告警口径：整句写死，测试和文档都按这一句核。 */
export const LEGACY_SWEEP_WARNING = 'sweepMinutes 已过时，改用 sweepMs'

/**
 * 巡检间隔从哪儿来：显式配了 `sweepMinutes` 就按分钟折算（老 yml 里
 * `sweepMinutes: 0` 关定时器的写法还得照旧生效），否则用 `sweepMs`。
 */
export function resolveSweepMs(config: Pick<Config, 'sweepMs'> & { sweepMinutes?: number }): number {
  const legacy = config.sweepMinutes
  if (legacy === undefined || legacy === null) return config.sweepMs
  return Math.max(0, Math.round(legacy * 60_000))
}

/** 显式配了过时键就返回要 warn 的那一句，没配返回 undefined。 */
export function legacySweepWarning(config: { sweepMinutes?: number }): string | undefined {
  const legacy = config.sweepMinutes
  if (legacy === undefined || legacy === null) return undefined
  return `${LEGACY_SWEEP_WARNING}（按 sweepMinutes=${legacy} 折算，0 = 关定时器）`
}
