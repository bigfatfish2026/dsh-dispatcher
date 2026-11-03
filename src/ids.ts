/**
 * 票里的 owner 和真会话 id 的比对规则。
 *
 * 单独一个文件，是因为两处要用同一份：`subagent/end` 收票（index.ts）和僵尸巡检
 * 判活（zombie.ts）。两边各抄一份迟早会漂。
 *
 * 这些函数都是纯的：不碰 ctx、不碰票日志，测试可以直接 import。
 */

/**
 * owner / 子 session id 的前缀变体。票里的 owner 是主会话随手填的：可能裸
 * uuid、可能带 `session-` 前缀；`subagent/end` 给的 id 也可能是这两种写法。
 * 精确比对走这组变体，短标签兜底在 matchesId 里。
 */
export function idVariants(id: string): Set<string> {
  const bare = id.replace(/^session-/, '')
  return new Set([id, bare, `session-${bare}`])
}

/** id 里的 uuid 形态片段：去 `session-` 前缀后连续 [0-9a-f]、至少 6 位。 */
export function hexFragments(id: string): string[] {
  return id.replace(/^session-/, '').toLowerCase().match(/[0-9a-f]{6,}/g) ?? []
}

/**
 * owner 和子 session id 是不是同一路小鱼。判活和收票共用这一份。
 *
 * 先按 idVariants 一比一判；不中再走短标签兜底：主会话开票时可能只写
 * `subagent 34b183b9`（前缀 + 8 位 uuid 前缀），而 `subagent/end` 给的是完整
 * `34b183b9-5d77-...`。两边各抽出 uuid 形态的片段（连续 [0-9a-f]、至少 6 位），
 * 一方是另一方的前缀就算命中。
 *
 * 边界是有意的：只做前缀、不做任意子串（`deadbeef` 不该匹配到中间某段）；
 * 片段至少 6 位（`abc` 太容易撞）；两边都抽不到片段（`重启小鱼` 这种纯中文
 * 标签）就返回不匹配，交给静默阈值兜底，不报错。
 */
export function matchesId(a: string, b: string): boolean {
  const left = idVariants(a)
  for (const candidate of idVariants(b)) {
    if (left.has(candidate)) return true
  }
  const aliases = hexFragments(a)
  const ends = hexFragments(b)
  if (aliases.length === 0 || ends.length === 0) return false
  for (const alias of aliases) {
    for (const end of ends) {
      if (alias.startsWith(end) || end.startsWith(alias)) return true
    }
  }
  return false
}

/**
 * 这个 owner 里有没有能拿去活表比对的标识。
 *
 * 有标识（裸 uuid、`session-xxx`、`subagent aff73fb2` 这种带 uuid 前缀的短标签）
 * 才能说「活表里找不到 = 这个会话真没了」。`小丙`、`重启小鱼`、`fix-check-1`
 * 这类纯文字标签抽不出片段，查不到只能说明「没法比」，不是「不存在」——
 * 刚派出去就判僵尸是要出事的。
 */
export function hasIdFragment(id: string | undefined): boolean {
  if (!id) return false
  return hexFragments(id).length > 0
}
