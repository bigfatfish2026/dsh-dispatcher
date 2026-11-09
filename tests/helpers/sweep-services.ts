/**
 * dsh-events / dsh-timer 的最小假实现：只做「注册、订阅、分发」和「注册、注销」。
 *
 * 真服务的行为都抄自源码，不自己发明：`defineEvent` 重复注册抛 EV-001；注册表
 * 里查得到就算成功（跟 `store/bus.ts` 的容错一致）；订阅返回带 `stop()` 的把手；
 * `schedule.register` 的 id 重复抛 DUP_RULE_ID、`catchUp` 必须显式给、`every`
 * 不能小于 5000，注册前先查 topic 在不在（EV-006）。
 */
import type { SweepEventsService, SweepScheduleService } from '../../src/tickets/sweep-driver'

function errorWithCode(message: string, code: string): Error {
  const error = new Error(message)
  ;(error as { code?: string }).code = code
  return error
}

export interface FakeEvents {
  service: SweepEventsService
  defined: Map<string, unknown>
  subscriptions: Array<{ pattern: string; handler: (event: { payload?: unknown }) => unknown; stopped: boolean }>
  defineCalls: number
  subscribeCalls: number
  /** 分发一条事件给所有未停的订阅，返回真正投出去的条数。 */
  emit(payload: unknown): number
}

export function fakeEvents(): FakeEvents {
  const defined = new Map<string, unknown>()
  const subscriptions: FakeEvents['subscriptions'] = []
  const fake: FakeEvents = {
    defined,
    subscriptions,
    defineCalls: 0,
    subscribeCalls: 0,
    service: {
      defineEvent(def) {
        fake.defineCalls += 1
        if (defined.has(def.name)) throw errorWithCode(`事件类型 ${def.name} 已经注册过`, 'EV-001')
        defined.set(def.name, def)
        return def
      },
      subscribe(pattern, handler, options) {
        fake.subscribeCalls += 1
        void options
        const sub = { pattern, handler, stopped: false }
        subscriptions.push(sub)
        return {
          stop() {
            sub.stopped = true
            const index = subscriptions.indexOf(sub)
            if (index >= 0) subscriptions.splice(index, 1)
          },
        }
      },
      registry: {
        get(name) {
          return defined.get(name)
        },
      },
    },
    emit(payload) {
      let delivered = 0
      for (const sub of [...subscriptions]) {
        if (sub.stopped) continue
        sub.handler({ payload })
        delivered += 1
      }
      return delivered
    },
  }
  return fake
}

export interface FakeSchedule {
  service: SweepScheduleService
  rules: Map<string, { id: string; every?: number; cron?: string; topic: string; catchUp: string }>
  unregistered: string[]
  registerCalls: number
  /** 下一次 register 抛这个错（用完就清）；模拟 EV-006 / BAD_RULE / DUP_RULE_ID。 */
  failNext?: unknown
}

export function fakeSchedule(events?: FakeEvents): FakeSchedule {
  const rules = new Map<string, { id: string; every?: number; cron?: string; topic: string; catchUp: string }>()
  const unregistered: string[] = []
  const fake: FakeSchedule = {
    rules,
    unregistered,
    registerCalls: 0,
    service: {
      register(rule) {
        fake.registerCalls += 1
        if (fake.failNext !== undefined) {
          const error = fake.failNext
          fake.failNext = undefined
          throw error
        }
        if (rules.has(rule.id)) throw errorWithCode(`id 重复：${rule.id}`, 'DUP_RULE_ID')
        const catchUp = (rule as { catchUp?: string }).catchUp
        if (catchUp !== 'once' && catchUp !== 'skip') {
          throw errorWithCode(`catchUp 必须显式给`, 'BAD_RULE')
        }
        if (typeof rule.every !== 'number' || rule.every < 5000) {
          throw errorWithCode(`every 不能小于 5000`, 'BAD_RULE')
        }
        if (events && !events.defined.has(rule.topic)) {
          throw errorWithCode(`topic ${rule.topic} 没注册`, 'EV-006')
        }
        rules.set(rule.id, { ...rule })
        return { id: rule.id, topic: rule.topic, pending: false }
      },
      unregister(id) {
        unregistered.push(id)
        return rules.delete(id)
      },
      /** 后路探针查规则表用；真服务有这个面。 */
      list() {
        return [...rules.values()]
      },
    },
  }
  return fake
}
