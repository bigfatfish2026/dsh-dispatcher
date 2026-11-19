/**
 * 「主会话」判据：巡检文字与唤醒只往主会话发。
 *
 * 宿主 `SessionHeader` 里没有渠道 / 群聊字段，只有 `origin`（子会话才有，值
 * `subagent`）和 `agentPreset`（见 `@deepseek-ai/dsh-session` 的
 * `SessionHeader` 定义）。光看 header 分不出 c2c 和群聊。
 *
 * qqbot 侧把渠道编进了会话键 `qqbot:<appId>:<c2c|group>:<peerId>`
 * （`dsh-qqbot/lib/session/session-manager.js` 的 `sessionKey()`），
 * 会话键 → sessionId 的映射落在全局服务 `qqbot/prefs` 的
 * `payload().sessionIds`（`dsh-qqbot/lib/model/prefs-readout.js`）。所以这里按
 * sessionId 反查会话键，键里是 `group` 的跳过，是 `c2c` 的放行。
 *
 * 判不出来一律按主会话放行，只有两件事会拦：
 * - header 明说是子会话（`origin === 'subagent'`）；
 * - qqbot 的会话键明说是群聊（`qqbot:<appId>:group:<peerId>`）。
 * 非 qqbot 部署（headless / TUI）没有这个服务，不能因此把巡检整个关掉。
 *
 * 跳过的原因要留痕（debug 一行），同一会话同一原因只记一次，别每个 step 刷屏。
 */
export interface SessionLike {
  session?: { id?: string; header?: { origin?: string } }
}

/** 巡检出口共用的一把闸：装配钩子与唤醒各拿同一只。 */
export interface MainSessionFilter {
  verdict(agent: SessionLike | undefined): MainSessionVerdict
  allows(agent: SessionLike | undefined): boolean
}

/** `qqbot/prefs` 服务的最小形状（只读出口，`payload()` 给全量快照）。 */
export interface QqbotPrefsLike {
  payload?: () => { sessionIds?: Record<string, string> } | undefined
}

export type MainSessionReason =
  | 'main'
  | 'qqbot-c2c'
  | 'qqbot-group'
  | 'subagent'
  | 'no-session'

export interface MainSessionVerdict {
  main: boolean
  reason: MainSessionReason
  sessionId?: string
}

export interface MainSessionDeps {
  /** 宿主服务 `qqbot/prefs`；没有这个服务就不是 qqbot 部署。 */
  prefs?: () => QqbotPrefsLike | undefined
  /** 跳过时的 debug 一行；不给就不记。 */
  debug?: (message: string) => void
}

const QQ_BOT_KEY_PREFIX = 'qqbot:'

/**
 * 从会话键里读渠道：`qqbot:<appId>:<kind>:<peerId>`。
 *
 * 只认三段之后的第一段；`appId` 里不会有冒号（QQ 的 appId 是纯数字），
 * peerId 里可能有，所以不能简单 split 完看最后一段。
 */
export function qqbotScopeOfSessionKey(key: string): 'c2c' | 'group' | undefined {
  if (!key.startsWith(QQ_BOT_KEY_PREFIX)) return undefined
  const parts = key.split(':')
  if (parts.length < 4) return undefined
  const kind = parts[2]
  return kind === 'c2c' || kind === 'group' ? kind : undefined
}

/** 按 sessionId 反查会话键里的渠道；查不到返回 undefined。 */
function scopeOfSessionId(
  sessionIds: Record<string, string> | undefined,
  sessionId: string,
): 'c2c' | 'group' | undefined {
  if (!sessionIds) return undefined
  for (const [key, id] of Object.entries(sessionIds)) {
    if (id === sessionId) return qqbotScopeOfSessionKey(key)
  }
  return undefined
}

/** 跳过原因翻成人话：写日志用，别让日志只有代码里的字符串。 */
function skipText(reason: MainSessionReason): string {
  switch (reason) {
    case 'subagent':
      return '子会话不收票台近况'
    case 'qqbot-group':
      return '群聊会话不收票台近况'
    default:
      return '这个会话不收票台近况'
  }
}

export function createMainSessionFilter(deps: MainSessionDeps = {}): MainSessionFilter {
  /** 已经记过的跳过原因：同一会话同一原因只记一行。 */
  const noted = new Map<string, string>()

  const note = (verdict: MainSessionVerdict): void => {
    if (!deps.debug) return
    const key = verdict.sessionId ?? '(no-session)'
    if (noted.get(key) === verdict.reason) return
    // 会话表不落盘、只做去重：超了直接清，别为了省一行日志把表撑大。
    if (noted.size >= 64) noted.clear()
    noted.set(key, verdict.reason)
    deps.debug(`[dispatcher] 巡检跳过会话 ${key}：${skipText(verdict.reason)}（${verdict.reason}）`)
  }

  const verdict = (agent: SessionLike | undefined): MainSessionVerdict => {
    const session = agent?.session
    // 宿主装配时一定带 agent；测试或老宿主没带就没法判，按主会话放行。
    if (!session) return { main: true, reason: 'no-session' }
    const sessionId = session.id
    if (session.header?.origin === 'subagent') {
      return { main: false, reason: 'subagent', ...(sessionId ? { sessionId } : {}) }
    }
    if (!sessionId) return { main: true, reason: 'main' }
    let sessionIds: Record<string, string> | undefined
    try {
      sessionIds = deps.prefs?.()?.payload?.()?.sessionIds
    } catch {
      // 服务正在重载 / 出口形状变了：当没有 qqbot 信息，别把巡检卡死。
      sessionIds = undefined
    }
    if (!sessionIds) return { main: true, reason: 'main', sessionId }
    const scope = scopeOfSessionId(sessionIds, sessionId)
    if (scope === 'group') return { main: false, reason: 'qqbot-group', sessionId }
    if (scope === 'c2c') return { main: true, reason: 'qqbot-c2c', sessionId }
    // qqbot 里有映射表却没这张会话：不是 qqbot 建的（终端 / headless），按主会话。
    return { main: true, reason: 'main', sessionId }
  }

  return {
    verdict,
    allows(agent) {
      const judged = verdict(agent)
      if (!judged.main) note(judged)
      return judged.main
    },
  }
}
