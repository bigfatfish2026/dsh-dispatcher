/**
 * 协议常量：事件名、工具名、票状态/相位、写类工具名单。
 *
 * 这里的值**不许进 Config schema，也不许被 profile 覆盖**：改这里等于改协议，
 * 要同时考虑事件版本、迁移与旧日志回放。可配置的默认值在 `defaults.ts`。
 *
 * 本文件不 import 任何东西，挂在最底层，store 与 tickets 都可以直接取。
 */

/** 票事件在 dsh-events 上的名字。key 是事件 `kind`，value 是带命名空间的名字。 */
export const TICKET_EVENT_NAMES = Object.freeze({
  published: 'dispatcher.ticket.published',
  spawned: 'dispatcher.ticket.spawned',
  'spawn-failed': 'dispatcher.ticket.spawn-failed',
  ended: 'dispatcher.ticket.ended',
  idled: 'dispatcher.ticket.idled',
  resumed: 'dispatcher.ticket.resumed',
  queued: 'dispatcher.ticket.queued',
  delivered: 'dispatcher.ticket.delivered',
  reported: 'dispatcher.ticket.reported',
  'action-logged': 'dispatcher.ticket.action-logged',
  planning: 'dispatcher.ticket.planning',
  declared: 'dispatcher.ticket.declared',
  'touch-reported': 'dispatcher.ticket.touch-reported',
  // 漏过一版：2026-11-14 之前这张表里没有它，冲突判定在 events 总线上落成
  // `dispatcher.ticket.legacy`，按 `.status` 名字订阅的监听器一条都收不到。
  'conflict-checked': 'dispatcher.ticket.conflict-checked',
  blocked: 'dispatcher.ticket.blocked',
  gated: 'dispatcher.ticket.gated',
  closed: 'dispatcher.ticket.closed',
  // 只用于回放旧日志；新代码不写这两个名字。
  'legacy/status': 'dispatcher.ticket.status',
  legacy: 'dispatcher.ticket.legacy',
} as const)

/** 本包注册的工具名。别的插件按名字调用时以这里为准。 */
export const TOOL_NAMES = Object.freeze({
  open: 'dispatch_open',
  send: 'dispatch_send',
  read: 'dispatch_read',
  close: 'dispatch_close',
  block: 'dispatch_block',
  list: 'dispatch_list',
  logAction: 'dispatch_log_action',
  report: 'dispatch_report',
  declare: 'dispatch_declare',
  touch: 'dispatch_touch',
  progressNote: 'progress_note',
} as const)

/** 票的六种状态。 */
export const TICKET_STATUSES = Object.freeze(['open', 'running', 'waiting', 'blocked', 'done', 'dropped'] as const)

/** 探路/排队相位；`queued` 专指等资源，`status=blocked` 专指等人。 */
export const TICKET_PHASES = Object.freeze(['planning', 'planned', 'queued', 'running'] as const)

/**
 * 写类工具：探路窗口与「被挡停手」共用同一份名单，顺序固定。
 *
 * `bash` 也算写：一条 `sed -i` 就改盘了，跟 `write` 没有区别。
 */
export const WRITE_TOOLS = Object.freeze(['bash', 'edit', 'write'] as const)
