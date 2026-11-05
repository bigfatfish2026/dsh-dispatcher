# 内部说明

README 的脚注：配置全表、事件模型、巡检与工具面。日常用法看 [README](../README.md)。

## 配置全表

```yaml
- id: dsh-dispatcher
  name: dsh-dispatcher
  config:
    defaultPreset: t1
    maxOpen: 3
    allowedPresets: [t0, t1, t2, t3, t4, t5]
```

**改完配置要重启。** `cordis.patch.yml` 里的值在插件加载时读一次，热加载不一定把新值送到已经在跑的会话上；白名单和反向名单这类按会话装的东西尤其如此。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `stateFile` | string | `dispatcher/tickets.jsonl` | 票日志路径，相对路径按 `DSH_HOME` 解析 |
| `store.backend` | string | `jsonl` | 票日志后端。`jsonl`（默认）一行一个事件、只追加；`sqlite` 把同一套事件存在 SQLite 文件里（`node:sqlite`，WAL，事务保证一次 append 整条可见）；`redis` 只留名字，选了在装载时报错，不会悄悄退回文件 |
| `store.file` | string | 空 | sqlite 库文件；空 = 跟着 `stateFile` 换后缀（`tickets.jsonl` → 同目录 `tickets.db`）。相对路径按 `DSH_HOME` 解析，`jsonl` 后端不看这一栏 |
| `snapshotFile` | string | 空 | 只读快照文件；空 = 跟日志同目录 |
| `snapshotEnabled` | boolean | `true` | 每次票变化后原子重写快照 |
| `snapshotRecentClosed` | number | `20` | 快照里额外带多少张已结票；`counts` 仍按全量算 |
| `defaultPreset` | string | 空 | 默认档，由 profile 给；配了空串且注册表也不给就拒绝开票 |
| `presetStrategy` | `llm` \| `static` | `llm` | `llm` 问一次小模型选档；`static` 直接用默认档 |
| `classifyModel` | string | `deepseek/deepseek-flash` | 选档模型，写成 `provider/model` |
| `classifyEffort` | string | `off` | 选档推理档；空串 = 路由默认 |
| `classifyTimeoutMs` | number | `8000` | 选档最多等多久，超时回落默认档 |
| `allowedPresets` | string[] | `[]` | 允许档位镜像，空 = 不校验；正常部署抄 profile 的 `allowedAgentPresets` |
| `commandKeywords` | string[] | 内置 17 词 | 「要跑命令」关键词兜底表，可改 |
| `rejectOnMismatch` | boolean | `true` | 选档一致性校验总开关 |
| `provider` | string | `spawn` | 传给 `startActivation` 的 provider 名 |
| `maxDepth` | number | `2` | 子会话深度；`1` = 小鱼不能再派小鱼 |
| `maxOpen` | number | `8` | 同时开着的票上限，`done` / `dropped` 不占名额 |
| `briefMaxColumns` | number | `34` | `brief` 显示列宽上限，汉字算 2 列 |
| `sweepMs` | number | `10000` | 巡检间隔，毫秒，最小 500；`0` 关定时器 |
| `sweepMinutes` | number | — | 已过时，改用 `sweepMs`；显式配了按 `×60000` 折算并 warn |
| `waitingMinutes` | number | `20` | `waiting` 满多久提醒一次 |
| `blockedMinutes` | number | `60` | `blocked` 满多久提醒一次 |
| `runningReminderMinutes` | number | `0` | `running` 隔多久提醒；`0` = 不提醒 |
| `freshMinutes` | number | `2` | `disposed` 后宽限多久才认小鱼真没了 |
| `autoReport` | boolean | `true` | 一轮干完没报告时，把最后一段输出自动记成报告 |
| `noReportSignal` | boolean | `true` | 一轮干完一条报告都没有时，推一句「缺报告」 |
| `repeatWindowMinutes` | number | `10` | 同人同事在这个窗口内再开票视为重复 |
| `handoffPolicy` | boolean | `true` | 把派活规矩拼进主会话系统提示词；subagent 不注入 |
| `handoffPolicyText` | string | 内置那段 | 派活规矩原文，整段重写即可改口径 |
| `noWaitGuard` | boolean | `true` | 拦下会让主会话干等的调用；worker 不受影响 |
| `maxCommandMs` | number | `30000` | 单条命令最多占用主会话多久 |
| `maxWaitMs` | number | `5000` | `job_output` 最多占用主会话多久 |
| `routerRestrict` | boolean | `true` | 给每个非 worker 会话装 `routerTools` 白名单 |
| `routerEscapeFile` | string | `~/.dsh/no-restrict` | 这个文件存在时不装白名单 |
| `routerTools` | string[] | 33 个名字 | 主会话保留的全局工具名，见 `src/config.ts` 的 `DEFAULT_ROUTER_TOOLS` |
| `extraRouterTools` | string[] | `[]` | 额外保留的全局工具名（MCP 之类），逐条点名 |
| `workerToolDeny` | boolean | `true` | 把 `workerDenyTools` 从 worker 的工具 schema 里摘掉 |
| `workerDenyTools` | string[] | 7 个名字 | worker 看不见写记忆工具，见 `DEFAULT_WORKER_DENY_TOOLS` |
| `workerPromptPrune` | boolean | `true` | 剪掉 worker 提示词里所有 `tool:*` / `mcp:*` 段 |
| `notifyScript` | string | 安装环境的 `notify.sh` | `progress_note` 用的推送脚本 |
| `notifyTimeoutMs` | number | `5000` | 一次推送最多等多久 |

## 票的存储与事件

一张票是一串 JSONL 事件，只追加、不改写。`status` 不是某条记录里的可变字段，而是某次 append 的 payload，读的时候由 `foldEvents` 折出最后那个值。事件种类：`published`、`spawned`、`spawn-failed`、`ended`、`idled`、`resumed`、`queued`、`delivered`、`reported`、`blocked`、`closed`，老日志的纯状态行按 `legacy/status` 读。读到半截行会跳过。

写入者只有 desk 一个（`serialize` 串行队列），所以同一张票不会两路同时改。`desk` 之上分三层：`store/`（后端、日志、折叠）、`tickets/`（票的语义：开、关、报告、投递、巡检）、`index.ts`（插件接线与工具）。

## 状态与写入者

六个状态：`open`、`running`、`waiting`、`blocked`、`done`、`dropped`。前四个算还开着，占 `maxOpen`。

- `dispatch_open`：建票写 `open`，起完小鱼写 `running`
- `dispatch_block`：挂起，等人拍板（仅主会话有）
- `dispatch_close`：写 `done` 或 `dropped`，终态
- 插件订 `subagent/end`：票还挂在 `open` / `running` 上的，落成 `waiting`，`note` 记 `stopReason` 和报告条数——**绝不写 `done`**

worker 手上只有 `dispatch_report`，只往票里追加一行，改不了任何状态。所以「这张票怎么还挂在 running」要问主会话、问事件，别问小鱼。

`waiting` 只说明「那个会话停了」，不说明交活。交没交活看票里有没有报告：一条都没有的 `waiting`，巡检按 `noReportSignal` / `waitingMinutes` 那档催。

## 两条队列

一张票带两条队列，都是日志里的行，重启丢不了：等 worker 收的消息（`dispatch_send`）和 worker 交回来的报告（`dispatch_report`）。每条有自己的 id 和 `delivered` 标记。

`dispatch_send` 在小鱼活着且空闲时当场送达，否则排队，下一次空闲或巡检接着投。`dispatch_report` 不叫醒任何人、不推送：`dispatch_list` 只显示 `«n`（未读报告条数），正文由主会话用 `dispatch_read` 取，取走的当场记 `delivered`。

## 巡检

每 `sweepMs` 毫秒（默认 10 秒）看一遍未结票，按状态和停留时长发信号：

- `waiting` 满 `waitingMinutes`（默认 20）
- `blocked` 满 `blockedMinutes`（默认 60）
- `running` 满 `runningReminderMinutes`（默认 0，关）

节流指纹是 `票号:原因:statusSince`，同一轮只发一次；状态翻过一轮再回来能再来一次。巡检**只提醒、不改票**：不写 status、不写 note，也不替主会话收报告。

提醒分两条路。未读报告、一轮干完没交报告、干完或跑太久没收工，记成巡检事实，挂到 `system-prompt/assemble` 上作为动态上下文（`dispatcher:sweep`，`interpolate: false`）：宿主把它渲染成 runtime-context 快照，模型看见的是票台近况，不是主人在说话。时间只写到五分钟粒度，同一状态反复渲染一字不差，KV 前缀缓存不跟着抖；`dispatch_list` / `dispatch_read` / `dispatch_close` 见过这张票之后，对应条目摘掉，没读的继续挂着。只有 `blocked` 超阈值才真去 `followup`，开头 `[sweep] `，并明说不是主人在说话。

事实表只在内存里：进程重启后由巡检重新发现，过期提醒不会被读回来。worker 会话收不到这段上下文。

## 工具面：白名单与 worker 限制

`routerRestrict` 开着时，每个不是 worker 的会话一出现就挂 `tools.restrict({ allow: routerTools + extraRouterTools })`：票、派活、记忆、跟人说话的工具留着，写盘和 shell 全没了。名字必须跟注册的全局工具名一对一，`tools.restrict` 遇到不认识的名字会抛错，所以插件先对着注册表核一遍，把没人认的名字 warn 出来再剔掉。

MCP 工具不在默认名单里，也不会被通配：要留在主会话，得把每个注册名逐条写进 `extraRouterTools`，写错只换一行日志，不会带崩白名单。`~/.dsh/no-restrict` 存在时任何会话都不装白名单，删掉恢复；`routerRestrict: false` 是彻底关掉。

`workerToolDeny` 从 worker 的 schema 里摘掉写记忆的七个工具（`memory_save`、`memory_archive`、`memory_merge`、`memory_reflect`、`memory_split`、`memory_consolidate`、`memory_sleep`），`memory_recall` 和检索类照留。用 deny 而不是反向白名单，是因为 `tools.schemas()` 只投影全局层，按它算 allow 会把 preset 注册在 agent 层的工具一起摘掉，worker 直接残废。

`workerPromptPrune` 再剪掉 worker 提示词里所有 `tool:*` / `mcp:*` / `mcp-resource-servers` 段：worker 的工具面由档位决定，静态写死的清单一定跟它对不上，留着只是白烧 token。persona、plan policy 这些非工具段一概不碰。

## 只读出口

桌宠、指令和脚本别各自解析 `tickets.jsonl`，统一从这里出：

```bash
dsh-dispatcher tickets --json                  # 全部票
dsh-dispatcher tickets --json --open-only      # 只要未结票
dsh-dispatcher tickets --json --id t-abc       # 单票，查不到退出码 1
dsh-dispatcher tickets --json --recent 20      # 未结票 + 最近 20 张结票
dsh-dispatcher tickets --json --backend sqlite --db ~/.dsh/dispatcher/tickets.db
```

不传参时按 profile 配置里的 `store.backend` / `store.file` 选后端，跟进程内一致；默认仍是 `jsonl`。`--backend <jsonl|sqlite>` 显式挑后端，`--db <路径>` 等价于 `--backend sqlite` 并指定库文件（相对路径按 `DSH_HOME` 解析），`--state <路径>` 显式走 jsonl。`--backend jsonl` 和 `--db` 同时给会报错退出码 2；`redis` 会报未实现退出码 2。

`--json` 的形状固定，`v` 是 schema 版本，`counts` 按全量日志算、不受过滤影响。字段：`id`、`brief`、`goal`、`status`、`owner`、`createdAt` / `updatedAt` / `closedAt` / `statusSince`、`workerAlive`、`pendingInputs` / `pendingReports`、`reportsCount`、`ageMinutes`、`stale`、`epoch` / `epochReports`、`preset` / `presetSource`、`dir` / `note` / `device`。时间一律 ISO 8601（UTC）。

进程内用：`ctx.get('dispatcher/tickets')` 拿 `TicketReadout`，`payload(selection)` 给同样的 JSON，`select()` 给带 `goal` 的 `TicketView`，`get(id)` 查单张。

桌宠读文件：每次票写完，插件原子重写 `$DSH_HOME/dispatcher/tickets.snapshot.json`，内容是全部未结票 + 最近 `snapshotRecentClosed` 张结票，字段与 `--json` 一致。临时文件 + `rename`，读方任何时刻都只会读到完整的一份。
