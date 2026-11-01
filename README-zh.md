# dsh-dispatcher

给 DeepSeek Harness 用的派活插件：主会话负责回话，活交给 worker 子代理去做。

初衷很简单——人在 QQ 里问一句，希望马上有回应。可主会话一旦自己埋头干活，回话就慢了。这个插件让主会话多一件可做的事：把活登记成「票」，派给子代理，然后立刻回来接着聊；票的进展单独记，随时可查。

思路来自官方原型 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，但只取了其中三件：

| 原型 | dsh-dispatcher |
| --- | --- |
| Source / Trigger / Thread / Subscription | 不做事件源，消息本来就在主会话里 |
| Eval 双层判定 + 版本化 Policy | 不做，主会话自己判断要不要派活 |
| 独立 DSH 会话当 Executor | 用 subagent，共享工作目录 |
| 票的生命周期 + 面板 + 重试 | 只留票、状态、超时标记 |
| Input queue + report delivery | 两条队列都记在日志里，巡检负责送 |

## Compatibility

| 项目 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.2.1-rc.5`（peer 依赖 `>=0.1.2-rc.1 <0.3.0`，`package.json` 里拆成多条区间用 OR 拼） |
| Node | `^22.19.0 \|\| >=24.0.0` |
| 平台 | 全部（纯 ESM，无原生代码、无网络） |

## 装

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-dispatcher-0.3.1.tgz
dsh --profile <name> --dump-config | grep 'dsh-dispatcher'
```

装完要重启对应的 dsh 实例才会加载。票默认记在 `$DSH_HOME/dispatcher/tickets.jsonl`，一行一个事件，只追加不改写；读到半截行会跳过。

## Configuration

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `stateFile` | string | `dispatcher/tickets.jsonl` | 票的日志路径，相对路径按 `DSH_HOME` 解析 |
| `staleMinutes` | number | `30` | 多久没更新算「卡住」 |
| `maxOpen` | number | `4` | 同时开着的票上限 |
| `handoffPolicy` | boolean | `true` | 把派活规矩拼进主会话系统提示词；subagent 会话不注入 |
| `sweepMinutes` | number | `5` | 巡检间隔；`0` 关掉定时巡检 |
| `notifyOwner` | boolean | `true` | 卡住的票要不要叫醒主人会话 |
| `quietSweep` | boolean | `false` | 巡检时不叫醒主会话；报告只入票日志，由外部脚本直发 QQ |
| `ownerSessionId` | string | 空 | 叫醒哪个会话；空则从 QQ 偏好文件里认 c2c 会话 |
| `qqPrefsPath` | string | `''` | 会话映射文件 |
| `ownerOpenId` | string | 空 | 主人 openid，多个 c2c 会话时用来挑对的那个 |
| `noWaitGuard` | boolean | `true` | 拦下会让主会话干等的调用；worker 不受影响 |
| `maxCommandMs` | number | `30000` | 单条命令最多占用主会话多久 |
| `maxWaitMs` | number | `5000` | `job_output` 最多占用主会话多久 |
| `routerRestrict` | boolean | `true` | 给每个非 worker 会话装 `routerTools` 白名单 |
| `routerEscapeFile` | string | `~/.dsh/no-restrict` | 这个文件存在时，任何会话都不装白名单 |
| `routerTools` | string[] | 36 个名字 | 主会话保留的全局工具名 |

```yaml
- id: dsh-dispatcher
  name: dsh-dispatcher
  config:
    staleMinutes: 20
    maxOpen: 3
```

## 工具

| 工具 | 作用 |
|---|---|
| `dispatch_open` | 开一张票。派完 worker 立刻调，然后才回话 |
| `dispatch_touch` | 改状态，可附一行进展说明（`status` 必填） |
| `dispatch_list` | 列票，`!` 是卡住的，`»n` 是 worker 还没收到的消息，`«n` 是没读的报告 |
| `dispatch_send` | 往票里追加一条给 worker 的消息 |
| `dispatch_report` | 记一份报告，不结束这张票 |
| `dispatch_close` | 交付了就关票 |
| `dispatch_sweep` | 立刻跑一次巡检，不等定时器 |

状态只有六个：`open`、`running`、`waiting`、`blocked`、`done`、`dropped`。前四个算「还开着」，占 `maxOpen` 名额。

## 两条队列

一张票带两条队列，都是日志里的行，重启也丢不了：等 worker 收的消息（`dispatch_send`）和 worker 交回来的报告（`dispatch_report`）。每条有自己的 id 和一个 `delivered` 标记。

`dispatch_send` 在 worker 会话活着且空闲时当场送达，否则留在队列。`dispatch_report` 不叫醒任何人，主会话下一轮或下次巡检读到。巡检会把没送到的消息推给活着的 worker、把没读的报告合成一条消息交给主人会话，还会把「已经 `done` 却又收到新消息」的票重新打开——这就是原型的 `tickets.wake`；`dropped` 是人叫停的，不再开。

## 给主会话的用法

一句话：**先开票，再派活，马上回话。** 票是写给半小时后的自己看的——回头 `dispatch_list` 一眼就知道哪些还没消息，不必翻聊天记录。

worker 需要人拍板时，让它把问题写进 `note`、状态改 `blocked`，由主会话决定自己答、来问人，还是拒掉。

## 别在中枢等

提示词里写的是请求，不是保证：主会话还是能卡在一个 `bash` 里两分钟，主人在那头等着回话。所以每个会话创建时都会挂一道 `tools.guard`，worker 除外，它拦三种形状——跑 `sleep` 的命令、`timeoutMs` 超过 `maxCommandMs` 的命令、`job_output` 等超过 `maxWaitMs` 的等待；没给 `timeoutMs` 的前台命令也拦，拒绝理由里直接写两条出路。插件加载时已经存在的会话同样补挂，不然热重载只保护下一个会话。

这套是原型 `noWait` 守卫的移植——它把 router 的 shell 上限压到五秒，拦的也是这三样。不一样的是「谁有资格等」怎么判：那边靠 agent preset，这边靠 `session.header.origin === 'subagent'`。

## 主会话白名单

等待守卫是拦住「一次调用卡太久」，白名单是干脆不给它这个工具。`routerRestrict` 开着（默认）时，每个不是 worker 的会话一出现就挂上 `tools.restrict({ allow: routerTools })`：主会话留着票、派活、记忆、跟人说话的那几样，加只读文件工具（`read`、`grep`、`glob`）和只读的机器检查，写盘、shell 和等待类全没了——「派出去」于是不再跟「在这儿干」抢，长活也卡不住回话。worker 一个字不动，subagent 照样是全套工具，重活才有地方去。

默认 36 个名字，写在 `src/config.ts` 的 `DEFAULT_ROUTER_TOOLS` 里。名字必须跟注册的全局工具名对得上：`tools.restrict` 遇到不认识的名字会抛错，而 `ctx.effect` 把回调里的异常交给 cordis 的错误处理、不会送回调用方，所以插件先对着注册表核一遍——把没人认的名字 warn 出来，只从白名单里剔掉那几个。写错一个名字的代价是一行日志，不是整份白名单。

光把工具藏起来只做了一半。每个工具插件还会注册一段 `tool:<组名>` 的提示段，教模型怎么用它；这段提示是由提示登记表装配出来的，跟工具 schema 列表不是一条路——所以主会话以前会读到「Use browser_navigate…」，去调一个已经被白名单收走的工具。于是装上白名单的同时，这个会话还挂一个 scoped 的 `system-prompt/assemble` 钩子，只删「它讲的工具一个都看不见了」的段。判据收得很窄：只有 `tool:` 开头的段进候选，persona、plan policy、手递手规程和其它所有说明段一概不碰；组名本身就是可见工具的就留（`tool:bash`，因为 `bash` 在白名单里），或者段文本里还提到可见工具才留（`tool:goal` 靠 `create_goal` 留下来）。前缀同源不算证据：`read` 和 `read_image` 是两个工具，谁可见都不能替对方那段作主——两个都在白名单里时，`tool:read` 靠的只是 `read` 自己。两个判断都看 `assembly.tools`，也就是模型这一轮真要收到的 schema 列表——白名单里有但没注册的名字撑不住一段提示。子代理有自己的提示作用域，根本看不到这个钩子；escape 文件在的时候压根没装白名单，也就没有可删的。

两条退路。`mkdir -p ~/.dsh && touch ~/.dsh/no-restrict`，任何会话都不装白名单；删掉文件就恢复。`routerRestrict: false` 是彻底关掉。escape 文件每个会话读一次，所以改它要重启（已经存在的会话则是重载插件）。

## 巡检

每 `sweepMinutes` 分钟看一遍票，按顺序做四件事：把「结束后又收到消息」的票重开、把排队消息推给还活着的 worker、把没读的报告和卡住的票合成一条 `followup` 交给主人会话（`source.kind` 标 `dsh-dispatcher`，跟真人的话区分开）、给送出去的打上已读。会话正忙就跳过，下一轮再来，一样不丢——队列在日志里，不在内存里。同一张票没动过只叫一次，动过了才再叫。

`quietSweep: true` 把第三步整个省掉。一次 `followup` 就是主会话带着全部上下文重跑一整轮，太贵；开了这个开关，巡检照旧重开票、给活着的 worker 推消息、把报告标已读、刷新卡住快照，但不叫醒任何会话，报告留在日志里等脚本来读。本仓库不带那个脚本——那是几行脚本加一个定时器（比如 `~/.dsh/dispatcher-notify.sh` 配 systemd timer），退避节奏跟进度心跳同一套，有新报告就推出去。

这一段借的是原型的 `Passes` 心跳加 `evaluateDue`，投递那部分留下，评估整个省掉——巡检一次不向模型问任何问题。

## Development

```sh
pnpm install
pnpm test       # vitest
pnpm run typecheck
pnpm run build  # tsdown → lib/
```

测试不碰网络，也不碰 DSH 运行时，只测事件折叠、状态判定、日志读写、两条队列，以及守卫拦不拦。

## License

[Apache License 2.0](LICENSE) © 2026 dsh-dispatcher contributors.
