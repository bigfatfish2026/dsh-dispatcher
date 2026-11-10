# 可撤回账本

路线 3 的落地说明：开票时说清「这一票会碰什么、能不能撤、撤不回来怎么退」，干活时每一步都记一笔，结票后 按天巡检缺口。目标是让 ego 和主会话派活前有得看、出事时有得查，而不是事后凭记忆。

设计原文在 `/home/user/fatfish/docs/dispatcher-revert-design.md`，这里是它在 dsh-dispatcher 里的样子。

## published 上的两个新字段

两张票的日志格式只加可以缺省的字段：老票不写这两个键，读出来和以前一模一样。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `origin` | `'main' \| 'ego'` | `'main'` | 谁提的。主会话/子会话派活都算 `main`；ego 自主发起的才写 `ego`。缺省一律按人提的算 |
| `intent.impact.paths` | `string[]` | 空 | 这一票会写到的路径；只读的别写 |
| `intent.impact.services` | `string[]` | 空 | 会重启/改配置的服务 |
| `intent.impact.remotes` | `string[]` | 空 | 会 push / 会发消息的远端（`git@…`、QQ 群号这种） |
| `intent.reversibility` | `'auto' \| 'manual' \| 'none'` | 缺省 `auto` | `auto` 一条命令能退；`manual` 能退但得人看着；`none` 撤不回来 |
| `intent.dryRun.ok` | `boolean` | 缺省视为没跑过 | 预演结果。`false` 会把票压成 `waiting` |
| `intent.dryRun.detail` | `string` | 空 | 预演失败的具体原因，会原样进票的 note 和工具回执 |
| `intent.undo.kind` | `string` | 空 | 撤回动作的类别：`file` / `git` / `service` / `message` / `db` |
| `intent.undo.ref` | `string` | 空 | 具体对象：备份文件、commit sha、群号 |
| `intent.undo.howto` | `string` | 空 | 照着能敲的撤回命令或路径。`manual` 时必填 |

`origin` 和 `intent` 只在显式传了的时候才写进事件行；reducer 在读的时候补默认值（`origin: 'main'`、`intent: undefined`、`actions: []`）。所以老日志、老调用方、老测试的行为都不变。

## action-logged：每一步一记

新的 `dispatch_log_action` 工具往票上追加 `action-logged` 事件：

| 字段 | 说明 |
|---|---|
| `ticketId` | 往哪张票上记 |
| `actor` | `main` / `worker`（按调用会话的 origin 自动判定） |
| `step` | 站内序号，从 1 开始；省略时接在已有最大序号后面 |
| `summary` | 这一步干了什么，≤300 字 |
| `undo` | 和 `intent.undo` 同形：`{kind, ref?, howto}`，`howto` 必须过校验 |
| `at` | 事件时间 |

投影里折成票的 `actions` 数组，只追加、不改 `status`、不改 `closedAt`、不影响 `isTerminal`。收工以后补记也合法——最该补的就是「当时来不及记、事后退不回去」的那一步。

**什么时候必须记**：写文件、跑 git 操作、改配置、发消息、动服务。工具描述里也写了这一句，别等审计来问。

### undo.howto 怎么算合格

校验在 `src/tickets/revert.ts` 的 `checkUndoHowto`，顺序是：

1. 空 → `empty`；
2. 去掉空白后命中空话词表（`回滚即可`、`自行处理`、`见文档`、`同上`、`tbd`、`todo`…）→ `vague`；
3. 不足 12 字 → `short`；
4. 整句没有一个「能照着敲」的锚点（`/`、`~`、`git `、`systemctl`、`journalctl`、`sqlite3`、`cp`、`mv`、`rm`、`kill`、`curl`、`npm`、`pnpm`、`node`、`dispatch_`、`gh`、`ssh`）→ `no-anchor`。

合格的样子：

```
cp /home/user/dev/dsh-dispatcher/cordis.patch.yml.bak /home/user/dev/dsh-dispatcher/cordis.patch.yml
git revert abc1234
systemctl --user restart dsh-example
```

不合格的样子：`回滚即可`、`把刚才那个东西恢复原样就行了`、`见文档`。

## 分级闸：开票时就拦

`desk.open` 在写任何字节之前跑 `checkRevertIntent`，判定顺序固定：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | 没有 `intent` | 放行（老调用方原样走） |
| 2 | `origin` 不是 `main`/`ego` | 拒 `bad-origin` |
| 3 | `reversibility` 不是三档之一 | 拒 `bad-reversibility` |
| 4 | `reversibility === 'none'` 且 `origin === 'ego'` | 拒 `ego-irreversible` |
| 5 | `reversibility === 'manual'` 且 undo 缺省/空白/空话 | 拒 `manual-without-undo` / `undo-vague` |
| 6 | 传了 `undo` 但指南不合格 | 拒（同样走上面的校验） |
| 7 | `dryRun.ok === false` | 降级：票建出来停在 `waiting`，不派子会话 |
| 8 | 其余 | 放行 |

拒是抛 `RevertRejectedError`，带人话理由；工具层把理由原样交给调用方，不是裸 `false`。降级不抛错：`published` 之后紧跟一条 `gated`，票的 `note` 记原因，回执里带 `reason`，等人拍板以后再 `dispatch_send` 或者关掉。

`main` 提 `none` 是允许的——人知道自己要干什么，审计会把这些票单独列出来，不在这里拦。

## 谁怎么用

**ego**：只能提 `auto` 或 `manual` 的活，`manual` 必须自带具体撤回指南。碰不可撤的东西（删库、强推、发不可撤回的消息）直接会被拒，别试。

**子会话**：动手前看票上的 `intent`，照着 `impact.paths` 别越界；每干完一步就 `dispatch_log_action` 记一笔，`undo.howto` 写下一步真能执行的退路。子会话不能改票的状态，记账不在此列。

**主会话**：开票时把 `intent` 填全，尤其 `impact` 和 `reversibility`；预演不过就让它停在 `waiting`，先看原因再决定。收工前补上没收的账。

## 天生不可撤的动作

这些 `reversibility` 只能写 `none`，ego 提了会被拒；主会话提了要心里有数：

- 删库/删表、`git push --force` 覆盖远端历史；
- 给外部发出去的消息（群里的话、邮件）——撤回窗口之外就是没有退路；
- 停掉或重启线上服务并丢掉内存状态；
- 覆盖没有备份的文件；
- 已经把凭据轮换或撤销掉的授权。

反过来，`auto` 的意思是「一条命令能退」：改文件前有 `.bak`、代码落在新 commit 上、配置改了留 diff。`manual` 是「能退但得人跟着」：要重启服务、要人核对输出、要动好几处。

## 结票审计

`maintain()` 跑完在途票的巡检后，按 `closedAt` 扫最近 N 天的 `done` 票，产出两类缺口：动作缺撤回指南（`missing-undo` / `vague-undo`）、整票标了 `reversibility: none`（`irreversible`）。只读，不改票、不发手机推送，结果挂 `dispatcher/revert-audit` 事件，也可以手动 `desk.auditRevert({days})` 拿文本。

| 配置 | 默认 | 说明 |
|---|---|---|
| `revertAuditDays` | `3` | 往回扫几天；只算 `done`，`dropped` 是人的决定，不算账 |
| `revertAuditMs` | `3600000` | 两次审计的最小间隔；`0` 关掉自动审计 |

窗口按 `closedAt >= now - days` 算，边界那天算在内。文本长这样：

```
撤回审计：最近 3 天 done 票 6 张，缺口 2 处
- t-xxx 动作 2「改了 profile」缺撤回指南：undo.howto 是空的
- t-yyy 整票标了不可撤（reversibility=none）
```

没有缺口就是一句「最近 3 天 done 票 N 张，没有缺口」。
