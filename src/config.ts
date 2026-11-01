import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

// Tunable configuration must be a Schemastery Schema, never a plain object:
// the harness validates it at load time and fails loud on invalid values, and
// every key can be changed from cordis.yml without editing code (guide §3.6).
/**
 * Global tool names a main session keeps when the router whitelist is on.
 *
 * Names must match the registered global tool exactly: `tools.restrict` throws
 * on an unknown name, so the plugin checks this list against the registry when
 * it installs the filter and drops (with a warning) anything it cannot find.
 * The shape of the list is the point of the plugin: conversation, tickets and
 * memory stay on the main session; anything that reads, writes or waits is a
 * worker's job.
 */
export const DEFAULT_ROUTER_TOOLS: readonly string[] = [
  // Tickets: the main session hands work out and reads what comes back.
  'dispatch_open',
  'dispatch_close',
  'dispatch_list',
  'dispatch_send',
  'dispatch_report',
  'dispatch_touch',
  'dispatch_sweep',
  // 2026-11-01 加：主会话自己也要能打点，不然它干长活时主人照样干等。
  'progress_note',
  // Delegation itself.
  'subagent',
  'subagent_fork',
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
  // Talking to the person: QQ and the little screen.
  'yuyu_face',
  'yuyu_face_list',
  'external_send_file',
  // 2026-11-01 加：主人常发图，看不见就聊不动。纯只读，不写盘。
  'read_image',
  'screen_say',
  'screen_status',
  'screen_power',
  // Machine health, read-only.
  'host_status',
  'host_alerts',
  // 2026-11-01 加：宿主注册的只读文件工具——读文本、按 glob 列文件。
  // 宿主没有 ls / stat / tree，能列文件名的就是 glob。只读，不写盘。
  // grep 2026-11-01 摘掉：它的输出体积不可控，一次 -rn 就能把满仓的命中行倒进上下文；
  // 主会话的长上下文成本里 98.6% 是 cache read，一句没收住的搜索等于按整段日志付钱。
  // 要搜内容就让 worker 去搜，把结果压成几行带回来。
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
 * replacement for it: the names are taken out of the worker's tool schema, so
 * the model never reads them in the first place and cannot spend a turn on a
 * call that would be refused.
 *
 * Keep this list to write-side memory tools. A name that is not registered is
 * dropped with a warning instead of failing the restrict call.
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
 * The wording is deliberately not abstracted any further — one block of prose,
 * one key, so a change of tone is a yml edit and never a code change.
 */
export const DEFAULT_HANDOFF_POLICY = `【派活规矩 · dispatcher】主会话的活是及时回话，长活交给小鱼。
下面任一条成立就派出去，别自己耗着：要等三十秒以上（编译、下载、批处理）、要跑好几轮才收（全量测试、多轮调研、翻资料比对）、主人正等着而活一时半会儿完不了。
都不成立就自己干：改一两处、查一眼状态、只有我能拍板的。
派完立刻 dispatch_open 记票再回话，票关掉之前不许当它没发生。
派活时把票号写进任务里，让小鱼用 dispatch_report 交活；主人中途追加的话用 dispatch_send 进票，别转述丢了。
交活要两条都发：先 dispatch_report 把结论记进票，再 send_message 喊一声主会话；只落票不喊，主会话不一定当场知道。
派活时任务里写死打点义务：小鱼每出一段进度就调 progress_note 报一行，插件直接把这句话推到主人手机上，不经过会话也不用等谁醒；干完再报一次；不打点的长活就是让主人干等。
记忆只有主会话能写：小鱼只许 memory_recall 查，memory_save / memory_archive / memory_merge / memory_split 一律不许调，发现该记的东西在 dispatch_report 里提一句，交回主会话落笔。`

export interface Config {
  /** Where the ticket log lives. One JSON object per line, append-only. */
  stateFile: string
  /** Minutes without an update before a ticket is reported as stale. */
  staleMinutes: number
  /** How many tickets may be open (not done, not dropped) at once. */
  maxOpen: number
  /** Append the hand-off rules to the main session's system prompt. */
  handoffPolicy: boolean
  /** The hand-off rules themselves. Empty string turns the section off. */
  handoffPolicyText: string
  /** Minutes between sweeps that look for stale tickets. */
  sweepMinutes: number
  /** Wake the owner's session when a ticket goes stale. */
  notifyOwner: boolean
  /** Never wake the owner session from a sweep; reports stay in the log. */
  quietSweep: boolean
  /** Session to wake; empty means "find the owner's c2c session in the QQ prefs file". */
  ownerSessionId: string
  /** QQ prefs file that maps conversation keys to session ids. */
  qqPrefsPath: string
  /** Owner openid, used to pick the right c2c session. */
  ownerOpenId: string
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
  /** Take the worker deny list out of every subagent's tool schema. */
  workerToolDeny: boolean
  /** Tool names a worker subagent does not see; write-side memory tools. */
  workerDenyTools: string[]
  /** Script that pushes one line of text to the person on QQ. */
  notifyScript: string
  /** Hard cap on one push, in milliseconds. */
  notifyTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  stateFile: Schema.string()
    .default('dispatcher/tickets.jsonl')
    .description('Ticket log path, relative to the DSH home directory unless absolute.'),
  staleMinutes: Schema.natural()
    .default(30)
    .description('Minutes without an update before a ticket counts as stale.'),
  maxOpen: Schema.natural()
    .default(4)
    .description('Maximum number of tickets that are not done or dropped.'),
  handoffPolicy: Schema.boolean()
    .default(true)
    .description('Append the hand-off rules to the main session system prompt; subagent sessions are never touched.'),
  // 文案单独一项：改口径只动 yml，不动代码，也不用重新构建。
  // 空字符串 = 不注入这一段（效果同 handoffPolicy: false）；只写空白也算空。
  handoffPolicyText: Schema.string()
    .default(DEFAULT_HANDOFF_POLICY)
    .description(
      'The hand-off rules appended to the main session system prompt. Rewrite the whole block here to change the wording without touching code. An empty (or whitespace-only) string means the section is not injected at all, same as handoffPolicy: false.',
    ),
  sweepMinutes: Schema.natural()
    .default(5)
    .description('Minutes between sweeps; a sweep wakes the owner session about tickets that have gone quiet.'),
  notifyOwner: Schema.boolean()
    .default(true)
    .description('Wake the owner session on a stale ticket. Off means tickets are only reported when asked.'),
  quietSweep: Schema.boolean()
    .default(false)
    .description('Do not wake the main session on a sweep: reports only go into the ticket log and an outside script pushes them to QQ.'),
  ownerSessionId: Schema.string()
    .default('')
    .description('Session to wake. Empty: pick the owner c2c session from the QQ prefs file.'),
  qqPrefsPath: Schema.string()
    .default('')
    .description('QQ prefs file mapping conversation keys to session ids.'),
  ownerOpenId: Schema.string()
    .default('')
    .description('Owner openid, used to pick the right c2c session when several exist.'),
  noWaitGuard: Schema.boolean()
    .default(true)
    .description('Refuse main-session calls that would wait, as dsh-superagent does: sleep, a timeout over maxCommandMs, a job wait over maxWaitMs. Worker subagents are unaffected.'),
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
  // One list, two readers: the schema default and the self-test use the same
  // constant, so a name is added or corrected in one place.
  routerTools: Schema.array(Schema.string())
    .default([...DEFAULT_ROUTER_TOOLS])
    .description('Global tool names the main session keeps. Unknown names are dropped with a warning instead of failing the restrict call.'),
  // 记忆写权限只归主会话：这是第二层，第一层是 dsh-memory 在 execute 里的守卫。
  // 单独一个开关，不跟 routerRestrict 绑：一个是主会话方不方便，一个是能不能
  // 替主人改记忆，两件事，关一个不该顺手关掉另一个。
  workerToolDeny: Schema.boolean()
    .default(true)
    .description(
      'Take workerDenyTools out of every worker subagent tool schema. Only the schema is trimmed: the real refusal is the memory plugin guard at execute time. Independent of routerRestrict, and the escape file still turns it off.',
    ),
  workerDenyTools: Schema.array(Schema.string())
    .default([...DEFAULT_WORKER_DENY_TOOLS])
    .description(
      'Tool names a worker subagent does not see: the write-side memory tools (memory_save, memory_archive, memory_merge, memory_reflect, memory_split, memory_consolidate, memory_sleep). memory_recall and the read-only lookup tools stay. Unknown names are dropped with a warning instead of failing the restrict call.',
    ),
  // progress_note 的推送脚本：openid 和 token 都在脚本里，插件不存第二份。
  notifyScript: Schema.string()
    .default('/home/julia/fatfish/notify.sh')
    .description('Script used by progress_note to push one line to the person on QQ; it owns the openid.'),
  notifyTimeoutMs: Schema.natural()
    .default(5000)
    .description('Hard cap on one progress push in milliseconds; the child is killed and the tool returns sent=false.'),
})
