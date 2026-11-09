/**
 * 票事件 → dsh-events 的桥：事件名映射、类型注册、publish 适配。
 *
 * 这一层只做「名字」和「调用」，不碰库、不碰投影：落库归 dsh-events，
 * 投影归 `store/log.ts`。宿主没挂 dsh-events（或挂的是不提供 `events` 服务
 * 的版本）时，这个文件整个不参与，dispatcher 照老路直写，行为一个字节不变。
 *
 * 事件名按现有 `kind` 一一对应，前缀统一 `dispatcher.ticket.`。老日志里没有
 * `kind` 的行回放时不会重新 publish；真有人再写一条，归到 `.legacy`。
 */
import type { TicketEvent } from './events'

/** 单个事件类型的注册项；字段跟 dsh-events 的 `defineEvent` 入参对齐。 */
export interface TicketEventDefinition {
  name: string
  version: number
  durability: 'durable' | 'volatile'
  maxBytes: number
}

/** 带命名空间的事件名。dsh-events 拒绝裸名，所以每个都得有点。 */
export const TICKET_EVENT_NAMES = {
  published: 'dispatcher.ticket.published',
  spawned: 'dispatcher.ticket.spawned',
  'spawn-failed': 'dispatcher.ticket.spawn-failed',
  ended: 'dispatcher.ticket.ended',
  idled: 'dispatcher.ticket.idled',
  resumed: 'dispatcher.ticket.resumed',
  queued: 'dispatcher.ticket.queued',
  delivered: 'dispatcher.ticket.delivered',
  reported: 'dispatcher.ticket.reported',
  blocked: 'dispatcher.ticket.blocked',
  closed: 'dispatcher.ticket.closed',
  'legacy/status': 'dispatcher.ticket.status',
  legacy: 'dispatcher.ticket.legacy',
} as const

/**
 * 启动时注册的全部票事件类型。票事件都是 durable：丢了等于业务数据丢，
 * 跟 tick 那种 volatile 不是一回事。
 *
 * 上限统一 1 MiB：票报告是整条日志里最长的东西，正常几 KB，长报告也就几十
 * KB；1 MiB 够放，又不至于让事件表变成内容仓库——再大就该在业务侧拒绝。
 * dsh-events 的默认 64KB 是给普通事件的，票事件不能按那个卡。
 */
export const TICKET_EVENT_DEFS: readonly TicketEventDefinition[] = Object.freeze(
  Object.values(TICKET_EVENT_NAMES).map((name) =>
    Object.freeze({ name, version: 1, durability: 'durable' as const, maxBytes: 1024 * 1024 }),
  ),
)

/**
 * 一条事件在 bus 上的名字。不认识的 kind 不准把票写挂：归到 `.legacy`，
 * payload 原样带着，读的人至少拿得到整条事件。
 */
export function ticketEventName(event: TicketEvent): string {
  const kind = (event as { kind?: unknown }).kind
  if (typeof kind !== 'string') return TICKET_EVENT_NAMES.legacy
  return (TICKET_EVENT_NAMES as Record<string, string>)[kind] ?? TICKET_EVENT_NAMES.legacy
}

/**
 * dispatcher 眼里 dsh-events 服务的最小面。只认三个成员：注册、发布、
 * 以及查重时用的 registry.get。多的不碰，服务换实现也不用改这里。
 */
export interface TicketEventsService {
  defineEvent(def: TicketEventDefinition): unknown
  publish(input: { name: string; payload: unknown }): { seq?: number | null; eventId?: string }
  registry?: { get(name: string, version?: number): unknown }
}

/** `TicketLog.commit` 认的发布器：返回事件落库后的 seq。 */
export interface TicketEventPublisher {
  publish(event: TicketEvent): number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把 dsh-events 服务包成发布器；注册不成就返回 undefined，让调用方走直写。
 *
 * 注册失败分两种：重复注册（热重载、上一份 fiber 已经注册过）不算失败，
 * 只要注册表里查得到这个名字就继续；查不到（注册表已冻结、版本不对）就
 * 老实退回直写，不拿一个 publish 必炸的发布器硬撑。
 */
export function createTicketEventPublisher(
  events: TicketEventsService,
  warn: (message: string) => void,
): TicketEventPublisher | undefined {
  for (const def of TICKET_EVENT_DEFS) {
    try {
      events.defineEvent(def)
    } catch (error) {
      const registered = events.registry?.get?.(def.name) !== undefined
      if (registered) continue
      warn(`[dispatcher] 注册事件类型 ${def.name} 失败，票事件退回直写：${messageOf(error)}`)
      return undefined
    }
  }

  return {
    publish(event: TicketEvent): number {
      const result = events.publish({ name: ticketEventName(event), payload: event })
      const seq = result?.seq
      if (typeof seq !== 'number') {
        throw new Error(`dsh-events 没给 ${ticketEventName(event)} 返回 seq，票事件没落库`)
      }
      return seq
    },
  }
}
