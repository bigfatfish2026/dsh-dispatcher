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
  // 2026-11-01 加：宿主注册的只读文件工具——读文本、搜内容、按 glob 列文件。
  // 宿主没有 ls / stat / tree，能列文件名的就是 glob。只读，不写盘。
  'read',
  'grep',
  'glob',
]

export interface Config {
  /** Where the ticket log lives. One JSON object per line, append-only. */
  stateFile: string
  /** Minutes without an update before a ticket is reported as stale. */
  staleMinutes: number
  /** How many tickets may be open (not done, not dropped) at once. */
  maxOpen: number
  /** Append the hand-off rules to the main session's system prompt. */
  handoffPolicy: boolean
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
})
