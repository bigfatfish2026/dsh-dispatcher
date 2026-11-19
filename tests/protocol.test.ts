import { describe, expect, it } from 'vitest'
import {
  TICKET_EVENT_NAMES,
  TICKET_PHASES,
  TICKET_STATUSES,
  TOOL_NAMES,
  WRITE_TOOLS,
} from '../src/protocol'
import {
  BLOCKED_MINUTES,
  BRIEF_MAX_COLUMNS,
  MAX_EXEC,
  MAX_QUEUED,
  PROBE_TIMEOUT_MINUTES,
  PROBE_TIMEOUT_MS,
  WAITING_MINUTES,
} from '../src/defaults'
import { mountPlugin } from './helpers/plugin-harness'

describe('协议常量', () => {
  it('工具名唯一，就是这十一个', () => {
    const names = Object.values(TOOL_NAMES)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      'dispatch_open',
      'dispatch_send',
      'dispatch_read',
      'dispatch_close',
      'dispatch_block',
      'dispatch_list',
      'dispatch_log_action',
      'dispatch_report',
      'dispatch_declare',
      'dispatch_touch',
      'progress_note',
    ])
    expect(Object.isFrozen(TOOL_NAMES)).toBe(true)
  })

  it('status / phase / 写类名单唯一、内容固定、冻结', () => {
    expect(TICKET_STATUSES).toEqual(['open', 'running', 'waiting', 'blocked', 'done', 'dropped'])
    expect(TICKET_PHASES).toEqual(['planning', 'planned', 'queued', 'gated', 'running'])
    expect(WRITE_TOOLS).toEqual(['bash', 'edit', 'write'])
    for (const list of [TICKET_STATUSES, TICKET_PHASES, WRITE_TOOLS]) {
      expect(new Set(list).size).toBe(list.length)
      expect(Object.isFrozen(list)).toBe(true)
    }
  })

  it('事件名唯一、带命名空间，冲突与老日志的名字都在', () => {
    const names = Object.values(TICKET_EVENT_NAMES)
    expect(new Set(names).size).toBe(names.length)
    expect(names.every((name) => name.startsWith('dispatcher.ticket.'))).toBe(true)
    expect(TICKET_EVENT_NAMES['conflict-checked']).toBe('dispatcher.ticket.conflict-checked')
    expect(TICKET_EVENT_NAMES.gated).toBe('dispatcher.ticket.gated')
    expect(TICKET_EVENT_NAMES['legacy/status']).toBe('dispatcher.ticket.status')
    expect(TICKET_EVENT_NAMES.legacy).toBe('dispatcher.ticket.legacy')
    expect(Object.isFrozen(TICKET_EVENT_NAMES)).toBe(true)
  })

  it('协议常量不许被配置覆盖：改 routerTools 也换不掉工具名', async () => {
    const host = mountPlugin({ config: { routerTools: ['dispatch_open_renamed'] } })
    expect(host.names()).toContain(TOOL_NAMES.open)
    expect(host.names()).not.toContain('dispatch_open_renamed')
  })
})

describe('可配置默认值', () => {
  it('提醒 / brief / 探路 / 名额的默认值就是这一组', () => {
    expect(WAITING_MINUTES).toBe(20)
    expect(BLOCKED_MINUTES).toBe(60)
    expect(BRIEF_MAX_COLUMNS).toBe(34)
    expect(PROBE_TIMEOUT_MINUTES).toBe(2)
    expect(PROBE_TIMEOUT_MS).toBe(120_000)
    expect(MAX_EXEC).toBe(8)
    expect(MAX_QUEUED).toBe(4)
  })
})
