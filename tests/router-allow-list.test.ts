import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_ROUTER_TOOLS, routerAllowList } from '../src/config'
import type { Config as ConfigShape } from '../src/config'

// 2026-11-03: 别的插件注册的工具名不写在这个仓库里。白名单由两段拼起来：
// 本包自己的 DEFAULT_ROUTER_TOOLS，加上 operator 在 cordis.yml 里点名的
// extraRouterTools。测试也只用中性名字，别把真名抄回来。
const EXTRAS = ['external_send_file', 'screen_say', 'screen_status', 'screen_power']

describe('routerAllowList', () => {
  it('缺省时就是本包自己的白名单，一项不多', () => {
    expect(routerAllowList({ routerTools: [...DEFAULT_ROUTER_TOOLS], extraRouterTools: [] })).toEqual([
      ...DEFAULT_ROUTER_TOOLS,
    ])
  })

  it('配了 extraRouterTools 就原样接在后面，不认得也照抄（由 router 丢并告警）', () => {
    const allow = routerAllowList({ routerTools: [...DEFAULT_ROUTER_TOOLS], extraRouterTools: EXTRAS })
    expect(allow).toEqual([...DEFAULT_ROUTER_TOOLS, ...EXTRAS])
    for (const name of EXTRAS) expect(allow).toContain(name)
    // 原样透传：不改大小写、不加前缀、不排序。
    expect(allow.slice(DEFAULT_ROUTER_TOOLS.length)).toEqual(EXTRAS)
  })

  it('配在 routerTools 里的名字不会因为叠加出现两次', () => {
    const allow = routerAllowList({
      routerTools: ['dispatch_open', 'yuyu_face'],
      extraRouterTools: ['yuyu_face', 'external_send_file'],
    })
    expect(allow).toEqual(['dispatch_open', 'yuyu_face', 'external_send_file'])
  })

  it('空字符串不进白名单', () => {
    expect(routerAllowList({ routerTools: ['dispatch_open', ''], extraRouterTools: [''] })).toEqual(['dispatch_open'])
  })

  it('两段都空就是空——不替谁补默认值', () => {
    expect(routerAllowList({ routerTools: [], extraRouterTools: [] })).toEqual([])
  })
})

// 宿主加载时走的就是这一步：只给 yml 里写的那几个键，别的全吃 schema 默认。
const parse = (input: Record<string, unknown>): ConfigShape => (Config as unknown as (i: unknown) => ConfigShape)(input)

describe('Config 缺省值', () => {
  const config = parse({})

  it('extraRouterTools 默认空：代码里不替别的插件点名', () => {
    expect(config.extraRouterTools).toEqual([])
  })

  it('routerTools 默认就是 DEFAULT_ROUTER_TOOLS', () => {
    expect(config.routerTools).toEqual([...DEFAULT_ROUTER_TOOLS])
    expect(routerAllowList(config)).toEqual([...DEFAULT_ROUTER_TOOLS])
  })

  it('qqPrefsPath 默认空：没配就不读映射文件', () => {
    expect(config.qqPrefsPath).toBe('')
  })

  it('配了 extraRouterTools 就原样读进来', () => {
    const given = parse({ extraRouterTools: EXTRAS, qqPrefsPath: '/tmp/prefs.json' })
    expect(given.extraRouterTools).toEqual(EXTRAS)
    expect(given.qqPrefsPath).toBe('/tmp/prefs.json')
    expect(routerAllowList(given)).toEqual([...DEFAULT_ROUTER_TOOLS, ...EXTRAS])
  })
})
