/**
 * 「这条会话自己挂了档吗」的唯一判据。
 *
 * 有档的会话，工具面由档里的 toolset 决定，dispatcher 不再拿 router allow /
 * worker deny 兜底；没档的会话保持老行为（主会话装 allow，worker 挂 deny）。
 * 这里不认具体档名：只看注册表里这条会话绑没绑上，`main` / `t1` / 别的档
 * 都一样走这条通用判定。
 *
 * `agentPresets.composedPreset()` 收的是会话的 scoped Agent ctx（不是 Agent
 * 对象）：registry 的 lib/index.js 用 `scopeOf(ctx)` 找绑定，传 Agent 对象
 * 只会拿到 undefined。
 */

/** `agentPresets` 服务里这条判定要用的最小形状。 */
export interface PresetRegistryLike {
  composedPreset?: (agentCtx: unknown) => string | undefined
}

/** cordis Context 的最小取服务形状；老宿主 / 测试替身可能没有 get。 */
interface ServiceGetter {
  get?: (name: string) => unknown
}

/** 从插件 ctx 取 `agentPresets` 服务；服务没就绪、取不到都返回 undefined。 */
export function presetRegistryOf(ctx: ServiceGetter | undefined): PresetRegistryLike | undefined {
  const getter = ctx?.get
  if (typeof getter !== 'function') return undefined
  try {
    const found = getter.call(ctx, 'agentPresets')
    return found !== null && typeof found === 'object' ? (found as PresetRegistryLike) : undefined
  } catch {
    // 服务正在收尾 / 还没 provide：当没挂档，退回 dispatcher 的兜底。
    return undefined
  }
}

/** 这条会话挂的档 id；没挂、服务不在、composedPreset 抛错都当没有。 */
export function composedPresetOf(
  agent: { ctx?: unknown } | undefined,
  registry: PresetRegistryLike | undefined,
): string | undefined {
  if (typeof registry?.composedPreset !== 'function' || agent?.ctx === undefined) return undefined
  try {
    const id = registry.composedPreset(agent.ctx)
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    // 会话还没 compose 出档：当没挂档。
    return undefined
  }
}

/** 会话自带档 -> dispatcher 的工具面兜底退位（allow 与 worker deny 都不装）。 */
export function hasComposedPreset(
  ctx: ServiceGetter | undefined,
  agent: { ctx?: unknown } | undefined,
): boolean {
  return composedPresetOf(agent, presetRegistryOf(ctx)) !== undefined
}
