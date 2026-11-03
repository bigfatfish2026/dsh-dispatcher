# Changelog

## 未发布 - 2026-11-03

### Added

2026-11-03 — 票的 owner 拆成两栏：`owner` 是人话标签（屏幕上显示的就是它，「t4 查qqbot PR」这种），新增可选 `ownerId` 存 spawn 返回的会话 id（uuid，`session-` 前缀也行）。背景是旧规矩：巡检只能从自由文本 owner 里抽 ≥6 位 hex 片段去活表比对，主会话写中文标签就抽不出来，`worker-gone` 永远不触发，票只能等 20 分钟 `silent`。

`dispatch_open` 带 `ownerId` 时开票前先查一次活表：不在表里直接拒绝开票（提示「ownerId 不在活表，可能是填错了或小鱼已经结束」），一个事件都不写；查不到 agents 服务（没 get、或活表空着）时放行并记一条 warn。巡检那侧 `agentAlive` 多一个 `exact` 档：`ownerId` 存在就只按 `idVariants` 的几种写法精确比对，扫完没有就是 `false`，不再受 `hasIdFragment` 那道门限制；`worker-gone` 的其它条件（2 分钟新建宽限）原样。`subagent/end` 对票、以及把排队消息递回 worker 也优先用 `ownerId`。老票没有这个字段，`foldEvents` 读到就是 undefined，完全走旧路径。巡检仍然只推提醒、绝不写票状态。

Tests: 新增 `tests/owner-id.test.ts` 10 条（fold 认字段、ownerId 命中活表开票、带前缀、不在活表拒开票且不落盘、没有 get 时放行并记日志、3 分钟 worker-gone、命中不推、老票中文标签仍 silent、老票短 hex 仍 worker-gone、subagent/end 按 ownerId 落 waiting）。全量 19 个文件 216 条全绿，typecheck 干净。

2026-11-03 — worker subagent 的提示词也过一遍剪枝。原来只有主会话走 `bindPromptFilter`（`bindWorkerDeny` 那条分支没装），所以各插件无条件写进提示词的工具说明段（`tool:*`、`mcp:*`、`mcp-resource-servers`）在每条小鱼会话里都吃满：browser 329 字、bilibili 370、bili_notify 379、jobs 384、goal 530、workflow 327、mcp-resource-servers 165、mcp:github 1828，合计 4312 字 ≈ 940 token。

口径跟主会话反着：worker 手上有什么工具由档位决定，静态清单一定对不上，所以**整族全剪**，不判断某个工具还在不在。判据没另写一套，`pruneToolSections` / `sectionToolFamily` 原样复用，只加一个 `dropAllToolSections` 开关；persona、plan policy、手递手规程这些非工具段照旧不碰。剪枝一次装、不跟着 `tools/change` 重装（结论跟 deny 名单无关），disposer 挂在 agent scope 上（`dsh-dispatcher.worker-prompt`），跟 `bindWorkerDeny` 一样撤得干净。

新增配置 `workerPromptPrune`（boolean，默认 `true`），关掉就回退到插件自己装配的原样；它跟 `workerToolDeny` 独立，一个管手上有什么工具，一个管提示词里还写不写。主会话路径一个字没改。

Tests: `tests/prompt.test.ts` 加 3 条（全剪、非工具段留着、无可剪时原样返回），`tests/router.test.ts` 加 worker prompt prune 一组 5 条（全剪、只装一次并随 scope 撤掉、没 deny 名单也剪、`pruneWorkerPrompt: false` 不剪、主会话同一份 assembly 仍旧只剪被藏起来的段），`tests/apply.test.ts` 加 2 条把开关独立性钉在 `apply` 那层（`workerToolDeny: false` 时提示词照样剪、`workerPromptPrune: false` 时 deny 照装但提示词不碰）。全量 16 个文件 185 条全绿，typecheck 干净。

### Changed

2026-11-03 — 主会话白名单里不再写死别的插件注册的工具名。`DEFAULT_ROUTER_TOOLS` 摘掉四项（一个发文件的、三个小屏的），32 项；`qqPrefsPath` 的默认值也从一串路径改成空字符串。这个仓库只讲自己的口径：谁家的工具该留在主会话、会话映射文件放在哪，都由 operator 在 cordis.yml 里点名。

新的 `extraRouterTools`（string[]，默认空）接在 `routerTools` 后面，两段由 `routerAllowList()` 合并成一个 allow 表：顺序保留、重复丢掉、空串跳过，名字原样透传，没注册的仍旧是 router 丢掉并告警。`qqPrefsPath` 为空时不读盘，`resolveOwnerSession()` 直接给空，主人会话只能由 `ownerSessionId` 明确指定——这是缺省语义，不是坏掉。

行为等价靠配置：装它的那份 profile 的 `cordis.patch.yml` 里，dispatcher 那块补上 `extraRouterTools` 四项和 `qqPrefsPath` 的原路径，主会话拿到的工具和以前一样。

Tests: `tests/router-allow-list.test.ts` 9 条——缺省时白名单等于 `DEFAULT_ROUTER_TOOLS`、配了 extras 原样接在后面、重复不出现两次、空串不进表、两段都空就是空、`Config({})` 的 `extraRouterTools` / `qqPrefsPath` 缺省值、给了值原样读进来。全量 15 个文件 164 条全绿，typecheck 干净。

### Fixed

2026-11-03 — 短标签 owner 的僵尸票不再得等满 20 分钟。原来 `zombie.ts` 先拿 `looksLikeSessionId` 卡一道：owner 不像 uuid 就连活表都不查，`worker-gone` 整条快路被跳过，`subagent 34b183b9` 这种短标签票只能退到 `silent` 慢路。

现在判活不看形态，看「owner 里有没有能拿去比对的东西」：`idVariants` / `matchesId` / `hexFragments` 从 `src/index.ts` 抽到新文件 `src/ids.ts`（`subagent/end` 收票和判活共用同一份，不再各留一套），`agentAlive` 拿 owner 逐个比对活表——先按 `session-` 前缀归一，再拿 ≥6 位 uuid 片段做前缀比对。扫完确实没有这个会话才判 `worker-gone`，短标签票也能立刻判死。慢路原样保留：匹配不上但长时间没动静的，照样按 `silent` 推。

「对不上」和「没有这个会话」分开：`hasIdFragment()` 抽不出片段的纯文字标签（`小丙`、`重启小鱼`、`fix-check-1`）不再当成 dead——活表里没有它只说明没法比，否则刚派出去的活当场变僵尸。`agentAlive` 在活表为空（服务还没就绪）时也返回 `undefined`，不判死。sweep 不写票 status 这条一个字没动。

Tests: 新增 `tests/ids.test.ts` 11 条（前缀归一、片段前缀、大小写、6 位阈值、纯中文不匹配、`hasIdFragment`），`tests/zombie-owner-match.test.ts` 10 条（短标签命中活会话不判、扫不到立刻 `worker-gone`、中文标签不误判、挂久了仍走 `silent`、full uuid 行为不变、新建 2 分钟宽限、活表空不判死、纯中文防住手滑的 `false`，外加两条 `apply` 端到端：sweep 只推该死的那张、活表里都在就一条不推）。全量 18 个文件 206 条全绿，`tsc --noEmit` 干净。README 中英两份和 `docs/worker-ticket-lifecycle` 图同步。

## 1.4.0 - 2026-11-03

### Changed

2026-11-03 — `dispatch_open` 的 `brief` 从可选改成**必填**。1.3.0 里它是可选的，不传就从 `goal` 首句派生一句；实际跑下来主会话开票时懒得写，几乎全走回落，小屏第二行于是又变回被截断、挂着省略号的 `goal`，这个字段等于白加。

两道关都拦：`parameters.brief` 进 `required` 列表，不传就在 schema 这层被拒（`missing required property "brief"`）；传了但只是空串、纯空白、纯标点或纯符号，`execute` 里用新增的 `store.ts` 导出 `briefIsBlank()`（`/^[\s\p{P}\p{S}]*$/u`）判掉，报错「brief 必填，写一句 34 列以内的短话（汉字按 2 列算，约 17 个汉字）」，列数和汉字数跟着 `briefMaxColumns` 走，票不落盘。这两条路径都不会再静默派生。

`briefOf()` 的派生回落**保留**，但它从此只服务读取侧：老 `tickets.jsonl` 里的票没有 `brief` 字段，`foldEvents` 折叠时字段仍然留空，`dispatch_list` / 小屏 / `toView` 靠 `briefOf()` 现算一句兜住。所以是「写入必填、读取回落」两套路径，`deriveBrief()` 的注释也改了，写明它只剩下 `briefOf()` 一个调用方。

超长策略不变，还是 1.3.0 那套：截断预算先扣掉「…」的 2 列，正文切到 32 列，总宽正好 34 列顶格——不是「切到 33 再补 …」，那样总宽会到 35，小屏把最后一个字裁掉一半。调用方传进来的 brief 依然按当前上限再截一次。

Tests: `tests/brief.test.ts` 17 条。新增/改写——不传 brief 报错且不落盘、空串 / 纯空白 / 纯标点（`。`、`…… ！？`、`—— 、`）全部报错且一个事件都没写、报错文案带上配置的列数与汉字数、正好 34 列原样保留不加省略号、35 列被切成 16 汉字 + 「…」且总宽正好 34、`briefMaxColumns` 调小后照样截得更短；老票那组不变（无字段折叠、派生兜底、`dispatch_list` 拿到派生值、后续事件补字段不丢）。全量 `npm test` 12 个文件 140 条全绿，`npm run typecheck` 干净。

## 1.3.0 - 2026-11-02

### Added

2026-11-02 — 票多了一个可选字段 `brief`：给小屏桌宠第二行用的一句短摘要，因为完整的 `goal` 是一段任务书，屏上塞不下。

长度上限是显示列宽而不是字符数：一个汉字算 2 列、半角算 1 列，默认 34 列 = 17 个汉字，超出的部分截断并补一个「…」。这个数字是 `src/store.ts` 的 `BRIEF_MAX_COLUMNS` 常量，`briefMaxColumns` 配置项的默认值引用它，改一处就动全局。

这个默认值来自实测而不是估计：2026-11-02 小屏实测量出第二行是 10px 字号、可用宽 172px，能放 17 个汉字或 28 个 ASCII 字符。初版先按 20 列（10 个汉字）占位，量出结果后按汉字钉到 17×2=34 列；纯 ASCII 的 brief 在 28 列左右就自然结束了，顶不到 34。同一版还顺手把省略号的宽度算清了：截断预算给它留 2 列，`charColumns` 也必须按 2 列计，不然截完总宽会比上限少一列。

`dispatch_open` 新增 `brief` 参数，调用方可以直接给一句；不传就从 `goal` 派生——取首句、去掉首尾标点、压掉多余空格、按列宽截断。传进来的 `brief` 也按当前上限再截一次，所以上限调小以后老日志里的长句不会把第二行撑破。`TicketSnapshot`、`TicketEvent`、`TicketView` 与 `dispatch_list` 的输出都带上这个字段。

旧日志里没有 `brief` 的行照旧能读：`foldEvents` 折叠时字段留空、不报错，读取侧用 `briefOf(ticket)` 现算一遍当兜底，`dispatch_list` 返回的每一行都有一句能直接上屏的 `brief`。两份 README 各加了一节说明和配置项。

Tests: `tests/brief.test.ts` 13 条——首句提取与标点清理、短 goal 原样保留、17 汉字刚好顶格、超长截断成 16 汉字 + 省略号且总宽正好 34 列、半角文本按 1 列计、`briefMaxColumns` 变小时截得更短、`dispatch_open` 传了 `brief` 落盘、没传自动派生、传超了被截、老票无字段折叠不崩、老票派生兜底、老票通过 `dispatch_list` 拿到派生值、后续事件补字段不丢。

## 1.2.1 - 2026-11-02

### Fixed

2026-11-02 — a scheduled sweep replayed every ticket's backlog of reports to the main session as one enormous message. A worker hands its report back with `send_message`, so the sweep has never been the one delivering those entries: their `delivered` flag stays `false` for the life of the ticket, and the collection step did not look at status, so a finished ticket counted as "pending reports" forever. On this machine `sweepMinutes` had been set to 0 and was restored to 5 at 18:50; the first tick found 158 pending reports over 116 `done`/`dropped` tickets (oldest from 2026-11-01, longest single report 7,075 characters) and pushed all of them in one followup — a second copy of work the person had already read and closed.

The report path is gone from the sweep altogether. It no longer collects reports, no longer pushes them for either status, and no longer counts them; a report reaches the main session through `dispatch_list`, where `«n` is the ticket's unread report count. An open ticket's reports are left exactly as they are — pending, unread, untouched — so the person-facing queue stays visible to whoever looks. Reports already sitting on a closed ticket have no reader left, so the pass clears them with a `markDelivered` (no push, no notice); that keeps `dispatch_list` from reporting unread entries nobody will ever read and leaves the text in the log. Reopening still works and is also silent now: a `done` ticket that receives mail after its close goes back to `open`, logged, without waking anyone. The only thing that may wake the owner session is a zombie ticket — when the zombie judgement finds nothing fresh, the pass returns `woke: false` and sends not one character. `quietSweep` therefore keeps only the accounting half: the same closed-ticket clear, no announcement even for a zombie, and no fingerprint recorded.

`dispatch_sweep` reports two separate counters, so the log line cannot be read as "this many messages went to the owner": `delivered` is entries handed to a live worker, `cleared` is report entries cleared from closed tickets. The manual tool goes through the same function and follows the same rule, and the `quietSweep` descriptions in the READMEs were rewritten to match. `src/zombie.ts` needed no change beyond a comment: it only considers `open`/`running`, and its fingerprint still avoids `updatedAt` because a sweep's own writes (steering a queued message, clearing a closed ticket) refresh that field.

Tests: an `open` ticket and a `done` ticket each holding one unread report — nothing is injected, the done one is cleared and the open one is still pending — plus a `dropped` ticket that must not wake the owner, a reopen that only changes status, a zombie that does wake the owner with one line and no report body, and a second sweep both in the same process and in a fresh one (no repeat clear, no repeat announcement, the clear is on disk). Measured on a copy of the live `tickets.jsonl` restored to its state just before the 18:55 sweep: the old code pushed 159 reports and 248,578 characters in one followup; the new code pushes none (0 characters) and clears 158, leaving the 1 open-ticket report pending.

## 1.2.0 — 2026-11-02
