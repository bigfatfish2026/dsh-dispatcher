import { describe, expect, it } from 'vitest'
import {
  composeCriteria,
  createPresetCatalog,
  globMatches,
  labelsFromAllow,
  normalizeWhitespace,
  presetToolsOf,
  scanPresetEntries,
} from '../src/tickets/preset-catalog'
import type {
  CriteriaConfig,
  CriteriaLabel,
  LoaderEntryLike,
  PresetCatalogDeps,
} from '../src/tickets/preset-catalog'

const toolset = (config: unknown) => ({ name: 'dsh-preset-toolset', config })

function presetEntry(id: string, plugins: unknown[] = [], extra: Record<string, unknown> = {}): LoaderEntryLike {
  return {
    options: {
      name: '@deepseek-ai/dsh-agent-preset',
      config: { id, plugins, ...extra },
    },
  }
}

const CRITERIA: CriteriaConfig = {
  labels: [
    { label: '执行命令', match: ['bash'] },
    { label: '改文件', match: ['write', 'edit'] },
    { label: '记忆', match: ['memory_recall', 'memory_list'] },
    { label: 'GitHub MCP 全组工具', match: ['mcp__github__*'] },
    { label: '媒体', match: ['mikan_*', 'jellyfin_*'] },
  ],
  required: {
    names: ['read', 'glob', 'grep', 'dispatch_report', 'send_message'],
    onMissing: 'warn',
  },
  silent: ['dispatch_declare', 'dispatch_touch'],
}

function catalogOf(entries: () => LoaderEntryLike[], over: Partial<PresetCatalogDeps> = {}) {
  const warnings: string[] = []
  const infos: string[] = []
  const catalog = createPresetCatalog({
    entries,
    criteria: CRITERIA,
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
    ...over,
  })
  return { catalog, warnings, infos }
}

describe('glob：只认 *，整名锚定，区分大小写', () => {
  it('* 通配任意长度，含空', () => {
    expect(globMatches('mcp__github__*', 'mcp__github__search_code')).toBe(true)
    expect(globMatches('mcp__github__*', 'mcp__github_')).toBe(false)
    expect(globMatches('mikan_*', 'mikan_')).toBe(true)
    expect(globMatches('*', 'anything')).toBe(true)
  })

  it('整名锚定：前缀像不算命中', () => {
    expect(globMatches('mcp__github__*', 'xmcp__github__foo')).toBe(false)
    expect(globMatches('mcp__github__*', 'mcp__github__x__extra')).toBe(true)
  })

  it('不含 * 就是全等；只认 * 不认 ? / []', () => {
    expect(globMatches('bash', 'bash')).toBe(true)
    expect(globMatches('bash', 'bash2')).toBe(false)
    expect(globMatches('bash?', 'bashX')).toBe(false)
    expect(globMatches('bash?', 'bash?')).toBe(true)
    expect(globMatches('[ab]', 'a')).toBe(false)
  })

  it('区分大小写', () => {
    expect(globMatches('bash', 'Bash')).toBe(false)
  })
})

describe('labelsFromAllow：顺序、多标签、未知名字', () => {
  it('标签按 labels 数组顺序输出，不按 allow 顺序', () => {
    const result = labelsFromAllow(['mikan_x', 'bash'], CRITERIA.labels)
    expect(result.have).toEqual(['执行命令', '媒体'])
    expect(result.lack).toEqual(['改文件', '记忆', 'GitHub MCP 全组工具'])
  })

  it('一条工具可以命中多个标签都出；同标签命中多次只留一个', () => {
    const labels: CriteriaLabel[] = [
      { label: '执行命令', match: ['bash'] },
      { label: 'SBI 语料', match: ['sbi_query'] },
    ]
    expect(labelsFromAllow(['bash', 'sbi_query'], labels).have).toEqual(['执行命令', 'SBI 语料'])
    // write / edit 同属「改文件」，只出一次。
    expect(labelsFromAllow(['write', 'edit'], CRITERIA.labels).have).toEqual(['改文件'])
  })

  it('unknown：没被任何 label 命中的工具名，按 allow 顺序去重', () => {
    expect(labelsFromAllow(['bash', 'zzz', 'bash', 'yyy'], CRITERIA.labels).unknown).toEqual(['zzz', 'yyy'])
  })

  it('labels 空数组：全都没有', () => {
    expect(labelsFromAllow(['bash'], [])).toEqual({ have: [], lack: [], unknown: ['bash'] })
  })
})

describe('composeCriteria：promptSuffix + 工具面', () => {
  it('空白归一：连续空白（含换行）折成一个空格', () => {
    expect(normalizeWhitespace('  a\n\n b\t c  ')).toBe('a b c')
    expect(composeCriteria('  第一行\n第二行  ', [], { ...CRITERIA, labels: [] }).text).toBe('第一行 第二行')
  })

  it('拼成「suffix + 换行 + 工具面（由 allow 生成）：有 …；无 …。」', () => {
    const composed = composeCriteria('你是只读勘察。\n', ['read', 'bash', 'dispatch_report'], CRITERIA)
    expect(composed.text).toBe(
      '你是只读勘察。\n工具面（由 allow 生成）：有 执行命令；无 改文件、记忆、GitHub MCP 全组工具、媒体。',
    )
    expect(composed.have).toEqual(['执行命令'])
    expect(composed.lack).toEqual(['改文件', '记忆', 'GitHub MCP 全组工具', '媒体'])
  })

  it('先扣 deny 再判有/无：扣完名单里没 bash 就不出「执行命令」', () => {
    const tools = presetToolsOf([toolset({ allow: ['bash', 'read', 'write'] }), toolset({ deny: ['bash'] })])
    const composed = composeCriteria('', [...(tools?.names ?? [])], CRITERIA)
    expect(composed.have).toEqual(['改文件'])
    expect(composed.lack).toContain('执行命令')
  })

  it('名字优先级：required / silent 不出标签，也不算 unknown', () => {
    const composed = composeCriteria('', ['read', 'glob', 'dispatch_declare', 'bash'], CRITERIA)
    expect(composed.text).toContain('有 执行命令')
    expect(composed.unknown).toEqual([])
    expect(composed.missingRequired).toEqual(['grep', 'dispatch_report', 'send_message'])
  })

  it('required 缺项照算：onMissing 只控制打不打 warn', () => {
    const composed = composeCriteria('', ['bash'], { ...CRITERIA, required: { names: ['read'], onMissing: 'ignore' } })
    expect(composed.missingRequired).toEqual(['read'])
  })

  it('labels 没配：只留 promptSuffix，unknown 不再报，labelsMissing=true', () => {
    const composed = composeCriteria('前缀\n', ['bash', 'zzz'], { ...CRITERIA, labels: [] })
    expect(composed.text).toBe('前缀')
    expect(composed.unknown).toEqual([])
    expect(composed.labelsMissing).toBe(true)
  })

  it('suffix 为空时只留工具面那一行', () => {
    expect(composeCriteria('   ', ['bash'], CRITERIA).text).toMatch(/^工具面（由 allow 生成）：/)
  })

  it('空集合不占位：have 空不写「有 …；」，lack 空不写「无 …。」，两边都空整行省略', () => {
    // 只有 required 名，没命中任何标签：没有「有 …；」半句。
    const noHave = composeCriteria('', ['read'], CRITERIA)
    expect(noHave.have).toEqual([])
    expect(noHave.text).toBe('工具面（由 allow 生成）：无 执行命令、改文件、记忆、GitHub MCP 全组工具、媒体。')

    // 只命中部分标签：缺的那半句照出。
    const partial = composeCriteria('', ['bash', 'write'], CRITERIA)
    expect(partial.lack).toEqual(['记忆', 'GitHub MCP 全组工具', '媒体'])
    const allLabels = composeCriteria('', ['bash', 'write', 'memory_recall', 'mcp__github__x', 'mikan_y'], CRITERIA)
    expect(allLabels.lack).toEqual([])
    expect(allLabels.text).toBe('工具面（由 allow 生成）：有 执行命令、改文件、记忆、GitHub MCP 全组工具、媒体。')

    // 标签表只剩空白项：have / lack 都空，整行省略，只留 suffix。
    const blank = composeCriteria('前缀', ['bash'], { ...CRITERIA, labels: [{ label: '   ', match: ['bash'] }] })
    expect(blank.have).toEqual([])
    expect(blank.lack).toEqual([])
    expect(blank.text).toBe('前缀')
  })
})

describe('presetToolsOf / scanPresetEntries：结构化 plugins', () => {
  it('allow / deny / 无 toolset', () => {
    expect(presetToolsOf([toolset({ allow: ['read', 'bash'] })])).toEqual({
      mode: 'allow',
      names: new Set(['read', 'bash']),
    })
    expect(presetToolsOf([toolset({ deny: ['bash'] })])).toEqual({ mode: 'deny', names: new Set(['bash']) })
    expect(presetToolsOf([{ name: 'dsh-other', config: {} }])).toBeUndefined()
  })

  it('scope 前缀、两行交集、写坏的声明一律抛', () => {
    expect(presetToolsOf([{ name: '@deepseek-ai/dsh-preset-toolset', config: { allow: ['read'] } }])).toEqual({
      mode: 'allow',
      names: new Set(['read']),
    })
    expect(presetToolsOf([toolset({ allow: ['bash', 'read'] }), toolset({ allow: ['read'] })])).toEqual({
      mode: 'allow',
      names: new Set(['read']),
    })
    expect(() => presetToolsOf([toolset({ allow: [] })])).toThrow('空数组')
    expect(() => presetToolsOf([toolset({ allow: 'read' })])).toThrow('不是数组')
    expect(() => presetToolsOf([toolset({})])).toThrow('既没有 allow 也没有 deny')
  })

  it('读 id/name/description/order；非档位 entry 与 disabled 跳过', () => {
    const rows = scanPresetEntries([
      presetEntry('t1', [toolset({ allow: ['bash'] })], { name: '常规', description: '写代码', order: 3 }),
      { options: { name: '@deepseek-ai/dsh-tools', config: { foo: 1 } } },
      { ...presetEntry('t9', [toolset({ allow: ['read'] })]), disabled: true },
    ])
    expect([...rows.keys()]).toEqual(['t1'])
    expect(rows.get('t1')).toMatchObject({ name: '常规', description: '写代码', order: 3 })
  })
})

describe('createPresetCatalog：惰性重扫、缓存、降级', () => {
  it('apply 时 entries 为空 → 首次 tools 重扫拿到 → 第二次命中缓存（共扫 2 次）', async () => {
    let scans = 0
    let rows: LoaderEntryLike[] = []
    const { catalog, infos } = catalogOf(() => {
      scans += 1
      return rows
    })
    expect(scans).toBe(1)
    expect(infos.join('\n')).toContain('preset 目录首次扫描为空')
    rows = [presetEntry('t2', [toolset({ allow: ['read', 'glob'] })])]
    await expect(catalog.tools('t2')).resolves.toEqual({ mode: 'allow', names: new Set(['read', 'glob']) })
    expect(scans).toBe(2)
    await catalog.tools('t2')
    expect(scans).toBe(2)
  })

  it('首扫非空也重扫一次：首扫只有 t1，tools(t2) 触发重扫拿到 t2，之后命中缓存', async () => {
    let scans = 0
    let rows: LoaderEntryLike[] = [presetEntry('t1', [toolset({ allow: ['bash'] })])]
    const { catalog, infos } = catalogOf(() => {
      scans += 1
      return rows
    })
    expect(scans).toBe(1)
    expect(infos.join('\n')).not.toContain('crit_src=loader')
    rows = [presetEntry('t1', [toolset({ allow: ['bash'] })]), presetEntry('t2', [toolset({ allow: ['read'] })])]
    await expect(catalog.tools('t2')).resolves.toEqual({ mode: 'allow', names: new Set(['read']) })
    expect(scans).toBe(2)
    // 重扫到的实际档数（t1 + t2）写进 info，不写死档数。
    expect(infos.join('\n')).toContain('[dispatcher] preset 目录就绪 crit_src=loader presets=2')
    await catalog.tools('t1')
    expect(scans).toBe(2)
    expect(infos.filter((line) => line.includes('crit_src=loader'))).toHaveLength(1)
  })

  it('两扫都空：tools 回 undefined（不分档），warn 带 preset id 与原因', async () => {
    const { catalog, warnings, infos } = catalogOf(() => [])
    await expect(catalog.tools('t2')).resolves.toBeUndefined()
    // 目录为空时判据来源是降级：info 与 warn 成对出现。
    expect(infos.join('\n')).toContain('[dispatcher] crit_src=degraded')
    expect(infos.join('\n')).not.toContain('crit_src=loader')
    expect(warnings.join('\n')).toContain('preset 目录为空')
    expect(warnings.join('\n')).toContain('preset 目录取不到 t2 的工具面')
    expect(warnings.join('\n')).toContain('按不分档放行')
  })

  it('目录里没有这个档 / 没挂 toolset / 配置写坏：都回 undefined 并各留一行 warn', async () => {
    const { catalog, warnings } = catalogOf(() => [
      presetEntry('t1', [toolset({ allow: ['read'] })]),
      presetEntry('t2', []),
      presetEntry('bad', [toolset({ allow: [] })]),
    ])
    await expect(catalog.tools('missing')).resolves.toBeUndefined()
    await expect(catalog.tools('t2')).resolves.toBeUndefined()
    await expect(catalog.tools('bad')).resolves.toBeUndefined()
    expect(warnings.join('\n')).toContain('取不到 missing 的工具面（原因：loader 的 entries 里没有这个档的声明）')
    expect(warnings.join('\n')).toContain('取不到 t2 的工具面（原因：plugins 里没有 dsh-preset-toolset）')
    expect(warnings.join('\n')).toContain('取不到 bad 的工具面（原因：档 bad 的 toolset 声明读不出')
  })

  it('list 目录优先；目录空回落注册表并过滤空 id；注册表抛错只 warn', async () => {
    const local = catalogOf(() => [presetEntry('t1', [toolset({ allow: ['read'] })], { name: '常规', description: '写代码' })])
    await expect(local.catalog.list()).resolves.toEqual([{ id: 't1', name: '常规', description: '写代码' }])

    const fallback = catalogOf(() => [], {
      registryOf: () => ({
        list: async () => [{ id: 't1', name: '快', description: '能跑' }, { id: '' }, { id: 't2' }],
      }),
    })
    await expect(fallback.catalog.list()).resolves.toEqual([{ id: 't1', name: '快', description: '能跑' }, { id: 't2' }])

    const broken = catalogOf(() => [], {
      registryOf: () => ({
        list: async () => {
          throw new Error('boom')
        },
      }),
    })
    await expect(broken.catalog.list()).resolves.toEqual([])
    expect(broken.warnings.join('\n')).toContain('读不到档位注册表')
  })

  it('defaultId 来自注册表，空串与缺失都回 undefined', () => {
    expect(catalogOf(() => [], { registryOf: () => ({ defaultId: 't1' }) }).catalog.defaultId()).toBe('t1')
    expect(catalogOf(() => [], { registryOf: () => ({ defaultId: '' }) }).catalog.defaultId()).toBeUndefined()
    expect(catalogOf(() => []).catalog.defaultId()).toBeUndefined()
  })

  it('同 id 两条 entry：后者覆盖并 warn；缺 id / plugins 不是数组的跳过并 warn', async () => {
    const { catalog, warnings } = catalogOf(() => [
      presetEntry('t1', [toolset({ allow: ['bash'] })]),
      presetEntry('t1', [toolset({ allow: ['read'] })]),
      { options: { name: '@deepseek-ai/dsh-agent-preset', config: { plugins: [] } } },
      { options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 't3', plugins: 'nope' } } },
    ])
    await expect(catalog.tools('t1')).resolves.toEqual({ mode: 'allow', names: new Set(['read']) })
    expect(warnings.join('\n')).toContain('preset 档名重复：t1')
    expect(warnings.join('\n')).toContain('preset 声明不可用：entry (无 id) 缺 id')
    expect(warnings.join('\n')).toContain('preset 声明不可用：档 t3 的 plugins 不是数组')
  })

  it('tools 首次拿到工具面时顺手拼判据：crit_unknown_tool / crit_missing_required 不用等 criteria()', async () => {
    const { catalog, warnings } = catalogOf(() => [
      presetEntry('t2', [toolset({ allow: ['bash', 'mystery_tool'] })]),
    ])
    await catalog.tools('t2')
    expect(warnings.join('\n')).toContain('crit_unknown_tool preset=t2 tool=mystery_tool')
    expect(warnings.join('\n')).toContain('crit_missing_required preset=t2 tool=read')
  })

  it('invalidate：丢掉目录与缓存，下一次读重新扫', async () => {
    let rows: LoaderEntryLike[] = [presetEntry('t1', [toolset({ allow: ['bash', 'read'] })])]
    const { catalog } = catalogOf(() => rows)
    await expect(catalog.tools('t1')).resolves.toEqual({ mode: 'allow', names: new Set(['bash', 'read']) })
    rows = [presetEntry('t1', [toolset({ allow: ['read'] })])]
    await expect(catalog.tools('t1')).resolves.toEqual({ mode: 'allow', names: new Set(['bash', 'read']) })
    catalog.invalidate()
    await expect(catalog.tools('t1')).resolves.toEqual({ mode: 'allow', names: new Set(['read']) })
  })
})

describe('createPresetCatalog.criteria：四种 warn 与档数', () => {
  const suffixOf = (id: string) => (id === 't2' ? '你是只读勘察。' : '')

  it('正常档：拼出标签，unknown 与缺项各一行 warn', () => {
    const { catalog, warnings } = catalogOf(
      () => [presetEntry('t2', [toolset({ allow: ['bash', 'read', 'glob', 'mystery_tool'] })], { name: '只读' })],
      { promptSuffixOf: suffixOf },
    )
    const snapshot = catalog.criteria()
    expect(snapshot.src).toBe('loader')
    expect(snapshot.presets).toEqual([{ id: 't2', name: '只读' }])
    expect(snapshot.rules.t2).toBe(
      '你是只读勘察。\n工具面（由 allow 生成）：有 执行命令；无 改文件、记忆、GitHub MCP 全组工具、媒体。',
    )
    expect(warnings.join('\n')).toContain('crit_unknown_tool preset=t2 tool=mystery_tool')
    expect(warnings.join('\n')).toContain('crit_missing_required preset=t2 tool=grep')
    expect(warnings.join('\n')).toContain('crit_missing_required preset=t2 tool=dispatch_report')
  })

  it('required 缺项在 onMissing=ignore 时不打 warn（缺项本身照算）', () => {
    const { catalog, warnings } = catalogOf(
      () => [presetEntry('t2', [toolset({ allow: ['bash'] })])],
      { criteria: { ...CRITERIA, required: { names: ['read'], onMissing: 'ignore' } } },
    )
    const snapshot = catalog.criteria()
    expect(snapshot.rules.t2).toContain('工具面（由 allow 生成）')
    expect(warnings.join('\n')).not.toContain('crit_missing_required')
  })

  it('labels 没配：只拼 promptSuffix，warn crit_labels_missing 一次', () => {
    const { catalog, warnings } = catalogOf(
      () => [presetEntry('t2', [toolset({ allow: ['bash', 'zzz'] })])],
      { criteria: { ...CRITERIA, labels: [] }, promptSuffixOf: suffixOf },
    )
    catalog.criteria()
    catalog.criteria()
    expect(catalog.criteria().rules.t2).toBe('你是只读勘察。')
    expect(warnings.filter((line) => line === '[dispatcher] crit_labels_missing preset=t2')).toHaveLength(1)
    expect(warnings.join('\n')).not.toContain('crit_unknown_tool')
  })

  it('档数：expectedPresets 只当阈值，少于它才打 crit_presets_short；不配不校验', () => {
    const rows = () => [
      presetEntry('t1', [toolset({ allow: ['read'] })]),
      presetEntry('t2', [toolset({ allow: ['read'] })]),
    ]
    const short = catalogOf(rows, { criteria: { ...CRITERIA, expectedPresets: 6 } })
    short.catalog.criteria()
    expect(short.warnings.join('\n')).toContain('crit_presets_short expected=6 got=2')

    const noAlarm = catalogOf(rows)
    noAlarm.catalog.criteria()
    expect(noAlarm.warnings.join('\n')).not.toContain('crit_presets_short')

    const enough = catalogOf(rows, { criteria: { ...CRITERIA, expectedPresets: 2 } })
    enough.catalog.criteria()
    expect(enough.warnings.join('\n')).not.toContain('crit_presets_short')
  })

  it('降级：目录空时 src=degraded、rules 为空、不误报 crit_presets_short', () => {
    const { catalog, warnings } = catalogOf(() => [], { criteria: { ...CRITERIA, expectedPresets: 6 } })
    const snapshot = catalog.criteria()
    expect(snapshot.src).toBe('degraded')
    expect(snapshot.presets).toEqual([])
    expect(snapshot.rules).toEqual({})
    expect(warnings.join('\n')).not.toContain('crit_presets_short')
  })

  it('没挂 toolset 的档列进 degraded，rules 只留 promptSuffix', () => {
    const { catalog } = catalogOf(() => [presetEntry('t2', [], { name: '只读' })], { promptSuffixOf: suffixOf })
    const snapshot = catalog.criteria()
    expect(snapshot.degraded).toEqual([{ preset: 't2', reason: 'plugins 里没有 dsh-preset-toolset' }])
    expect(snapshot.rules.t2).toBe('你是只读勘察。')
  })

  it('只有 deny 的档：只留 promptSuffix，并 warn crit_allow_empty（不许静默）', () => {
    const { catalog, warnings } = catalogOf(
      () => [presetEntry('t2', [toolset({ deny: ['bash'] })])],
      { promptSuffixOf: suffixOf },
    )
    expect(catalog.criteria().rules.t2).toBe('你是只读勘察。')
    expect(warnings.join('\n')).toContain('crit_allow_empty preset=t2 reason=deny-only')
  })

  it('allow 被 deny 扣空：判据只剩「无 …」，并 warn crit_allow_empty', () => {
    const { catalog, warnings } = catalogOf(
      () => [presetEntry('t2', [toolset({ allow: ['bash'] }), toolset({ deny: ['bash'] })])],
      { promptSuffixOf: suffixOf },
    )
    const snapshot = catalog.criteria()
    expect(snapshot.rules.t2).toBe(
      '你是只读勘察。\n工具面（由 allow 生成）：无 执行命令、改文件、记忆、GitHub MCP 全组工具、媒体。',
    )
    expect(warnings.join('\n')).toContain('crit_allow_empty preset=t2 reason=allow-emptied')
  })
})
