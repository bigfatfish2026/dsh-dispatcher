# 切到 SQLite：操作 runbook

> 目标：把 `dsh-dispatcher` 的票日志从 `tickets.jsonl` 切到 `tickets.db`，切完 CLI、指令、桌宠快照读的都是同一份 sqlite。默认值仍然是 `jsonl`——这次只改 `~/.dsh/profiles/qqbot/cordis.patch.yml`，不改代码默认值、不合并 main、不 push。
>
> 红线：下面所有命令都是**先备份、后动手**；`tickets.jsonl` 全程只读，迁移脚本不会写它。真正改配置和重启只在 e/f 两步，由主会话点火。

先设两个变量，后面都按它们走：

```bash
REPO=/home/julia/dev/dsh-dispatcher
export DSH_HOME=${DSH_HOME:-$HOME/.dsh}
export DSH_PROFILE=${DSH_PROFILE:-qqbot}
export DSH_PROFILE_DIR=${DSH_PROFILE_DIR:-$DSH_HOME/profiles/$DSH_PROFILE}
TS=$(date +%Y%m%d-%H%M%S)
B="$DSH_HOME/backups/sqlite-switch-$TS"
mkdir -p "$B"
cd "$REPO"
npm run build        # 切换前必须构建；bin 和 migrate 都读 lib/
```

## a) 停派活，票台清零

关掉所有未结票，确认没有在跑的票再继续。主会话用 `dispatch_list` / `dispatch_close`，或者直接看：

```bash
node bin/tickets.mjs tickets --json --open-only
```

`counts.openTotal` 必须是 0。不是 0 就先让主会话把票关完；带票切换等于把在跑的活留在半路。

## b) 备份 jsonl、快照和切换前读数（带时间戳，报大小）

```bash
cp -a "$DSH_HOME/dispatcher/tickets.jsonl" "$B/tickets.jsonl"
if [ -f "$DSH_HOME/dispatcher/tickets.snapshot.json" ]; then
  cp -a "$DSH_HOME/dispatcher/tickets.snapshot.json" "$B/tickets.snapshot.json"
fi
node bin/tickets.mjs tickets --json --state "$B/tickets.jsonl" > "$B/tickets-before.json"
stat -c '%n  %s bytes' "$B/tickets.jsonl" "$B/tickets-before.json"
[ -f "$B/tickets.snapshot.json" ] && stat -c '%n  %s bytes' "$B/tickets.snapshot.json"
sha256sum "$B/tickets.jsonl" "$B/tickets-before.json" > "$B/tickets.sha256"
```

`tickets-before.json` 是 g 步逐票核对的对照物（全量票，不是只含未结票的快照）。
`tickets.snapshot.json` 只是桌宠读的那份，可能不存在；不存在就跳过。

## c) 全量导入 SQLite（先落 /tmp，再装进 dispatcher）

迁移脚本有硬护栏：`--out` 指到真实 `~/.dsh` 下会直接拒绝（`assertSafeOut`），所以**不能**直接 `--out ~/.dsh/dispatcher/tickets.db`。正确做法是先迁到 /tmp，核对通过后再原子装进去：

```bash
STAGE=$(mktemp -d /tmp/dsh-sqlite-switch.XXXXXX)
node lib/migrate.js --in "$B/tickets.jsonl" --out "$STAGE/tickets.db"
# 也可以：node scripts/migrate-to-sqlite.ts "$B/tickets.jsonl" --out "$STAGE/tickets.db"
```

先看计划可以先跑一遍 `--dry-run`：

```bash
node lib/migrate.js --in "$B/tickets.jsonl" --dry-run --out "$STAGE/tickets.db"
```

迁移是幂等的：同一个 seq 载荷一样就跳过；载荷不一样会整次回滚、rc=1，不会覆盖已存在的事件。

## d) 双向校验五项，rc 必须 0

c 步正常结束时会打印核对表，五项全 OK 且最后一行是 `核对全过`：

| 项目 | 期望 |
| --- | --- |
| 票数 | jsonl 折出的票数 = sqlite 折出的票数 |
| 每票终态 | 状态、关闭时刻、更新时刻、排队/报告条数、brief、goal 全一致 |
| 事件条数 | jsonl 有效事件数 = 库里 events 条数 |
| lastSeq / 行数 | 非空行数 = lastSeq |
| 投影行数 | tickets 表行数 = 票数 |

命令退出码也要看：

```bash
node lib/migrate.js --in "$B/tickets.jsonl" --out "$STAGE/tickets.db"
echo "migrate rc=$?"          # 必须是 0
```

`rc != 0` 就停在这里，别装库、别改配置。把输出贴进票里再查。

## e) 改配置 `store.backend: sqlite`（先备份配置）

先备份 profile 配置，再停服务、装库、改配置：

```bash
cp -a "$DSH_HOME/profiles/qqbot/cordis.patch.yml" "$B/cordis.patch.yml.before"

# 由主会话点火：不要在正在跑的 agent turn 里直接 stop 自己。
systemctl --user stop dsh-qqbot

# 装库；目标已有旧库先备份，并清掉旧 WAL/SHM（服务已停，安全）
if [ -f "$DSH_HOME/dispatcher/tickets.db" ]; then
  cp -a "$DSH_HOME/dispatcher/tickets.db" "$B/tickets.db.before"
fi
rm -f "$DSH_HOME/dispatcher/tickets.db-wal" "$DSH_HOME/dispatcher/tickets.db-shm"
install -m 600 "$STAGE/tickets.db" "$DSH_HOME/dispatcher/tickets.db"
ls -l "$DSH_HOME/dispatcher/tickets.db"
```

然后编辑 `$DSH_HOME/profiles/qqbot/cordis.patch.yml`，在 `- id: dsh-dispatcher` 的 `config:` 下**追加**（别删原有键，patch 是整行替换不是深合并）：

```yaml
    store:
      backend: sqlite
      file: dispatcher/tickets.db
```

`file` 相对路径按 `DSH_HOME` 解析；不写就按 `stateFile` 把 `.jsonl` 换成 `.db`，结果一样。代码里 `config.ts` 的默认值仍是 `jsonl`，这里只是 profile 覆盖。

## f) 重启 dsh-qqbot（由主会话点火）

```bash
systemctl --user start dsh-qqbot
# 如果前面没停过，用 restart：
# systemctl --user restart dsh-qqbot
```

改 patch 会触发 DSH 配置热重载。票台已经清零，最坏只打断当前这一轮；要稳就按上面先 stop 再改、再 start。

## g) 起来后验

先跑只读核对脚本，出一张表：

```bash
scripts/verify-after-switch.sh \
  --before "$B/tickets-before.json" \
  --db "$DSH_HOME/dispatcher/tickets.db" \
  --jsonl "$DSH_HOME/dispatcher/tickets.jsonl"
```

它核对：配置后端是 sqlite、库文件存在、CLI 默认读取 rc=0、票数/未结数/状态计数一致、逐票字段（除 `generatedAt`/`ageMinutes`/`stale` 这些时间派生字段）一致、events 条数 = jsonl 非空行数、`meta.lastSeq` 同步、重启后日志无 sqlite 报错。退出码 0 才算过。

再手工做两件脚本不代做的写入核对：

1. 让主会话派一张小票并关掉：
   ```bash
   node bin/tickets.mjs tickets --json --id <新票号>
   ```
   能看到 `status: done`（或 `dropped`）就算通。
2. 看日志没有 sqlite 报错：
   ```bash
   journalctl --user -u dsh-qqbot --since "$(systemctl --user show dsh-qqbot -p ActiveEnterTimestamp --value)" --no-pager \
     | grep -Ei 'sqlite.*(error|fail|报错|失败)|SQLITE_|database is locked|no such table'
   ```
   没有输出就是干净。

## h) 回滚

配置改回 jsonl，库留着不动，`tickets.jsonl` 全程只读未动：

```bash
systemctl --user stop dsh-qqbot
cp -a "$B/cordis.patch.yml.before" "$DSH_HOME/profiles/qqbot/cordis.patch.yml"
systemctl --user start dsh-qqbot
```

起来后 `node bin/tickets.mjs tickets --json` 应回到 jsonl 的读数。注意：**切换后新开的票只在 `tickets.db` 里**，回滚到 jsonl 会把它们藏起来；要保留就先导回 jsonl（当前没有反向迁移脚本，需要另做）。库文件不要删，留着还能再切回去。

## i) 抬重启验收基线

`/home/julia/pending_after_restart.sh`（切换当晚写的那份一次性验收脚本）把「切换那一刻的读数」写死成基线，重启后跑它比自己比、比库是否回退。**每次切换前后动过数据就得重算这几行**，否则要么误报 FAIL，要么放过真正的回退：

| 常量 | 从哪读 |
| --- | --- |
| `BASE_SEQ` | `SELECT max(seq) FROM events` |
| `JSONL_SIZE` / `JSONL_MTIME` | `stat -c '%s %Y' "$DSH_HOME/dispatcher/tickets.jsonl"`（冻结后这两个值不许再变） |
| `MEMBASE_ROWS` | `node scripts/memory-query.mjs --list --json \| jq length`（在 dsh-memory 目录里跑） |
| `MEMJSONL_SIZE` / `MEMJSONL_MTIME` | `stat -c '%s %Y' ~/fatfish/memory/memories.jsonl` |

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.HOME+'/.dsh/dispatcher/tickets.db',{readOnly:true});console.log(d.prepare('select max(seq) seq,count(*) n from events').get())"
stat -c '%s %Y' "$DSH_HOME/dispatcher/tickets.jsonl"
```

改完 `pending_after_restart.sh` 的 mtime 会挪到当下，脚本里 b 项（进程启动晚于脚本 mtime）在下次真重启前必然 FAIL，属预期——要连基线一起验就等重启之后再跑。基线和「为什么是这个数」的原因写进脚本头注释，别只留数字。
