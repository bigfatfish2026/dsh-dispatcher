# Internals

The footnotes to the README: the full config table, the event model, sweeps, and tool surfaces. For everyday use, read the [README](../README.en.md).

## Full configuration

```yaml
- id: dsh-dispatcher
  name: dsh-dispatcher
  config:
    defaultPreset: t1
    maxOpen: 3
    allowedPresets: [t0, t1, t2, t3, t4, t5]
```

**Restart after changing it.** Values in `cordis.patch.yml` are read once when the plugin loads. Hot reload does not reliably push new values into sessions that are already running, and per-session restrictions (whitelists, deny lists) are especially prone to lagging behind. Expect a restart.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `stateFile` | string | `dispatcher/tickets.jsonl` | Ticket log path; relative paths resolve against `DSH_HOME` |
| `store.backend` | string | `jsonl` | Log backend. `jsonl` is the only implementation; `redis` / `sqlite` fail loud at load instead of quietly falling back |
| `snapshotFile` | string | empty | Read-only snapshot path; empty means "next to the log" |
| `snapshotEnabled` | boolean | `true` | Rewrite the snapshot atomically after every ticket commit |
| `snapshotRecentClosed` | number | `20` | Closed tickets included in the snapshot; `counts` still covers the whole log |
| `defaultPreset` | string | empty | Default preset, supplied by the profile; if neither profile nor registry gives one, opening a ticket is refused |
| `presetStrategy` | `llm` \| `static` | `llm` | `llm` asks a small model once; `static` uses the default preset |
| `classifyModel` | string | `deepseek/deepseek-flash` | Model for preset selection, as `provider/model` |
| `classifyEffort` | string | `off` | Reasoning level for that call; empty means the route default |
| `classifyTimeoutMs` | number | `8000` | How long selection may take before falling back to the default preset |
| `allowedPresets` | string[] | `[]` | Mirror of the presets this deployment may pick; empty disables the check. Copy `allowedAgentPresets` from the profile |
| `commandKeywords` | string[] | 17 built-ins | Fallback keywords meaning "this needs commands"; editable |
| `rejectOnMismatch` | boolean | `true` | Master switch for the preset consistency guard |
| `provider` | string | `spawn` | Provider name passed to `startActivation` |
| `maxDepth` | number | `2` | Subagent depth; `1` means a worker cannot dispatch further |
| `maxOpen` | number | `8` | Open tickets allowed at once; `done` / `dropped` do not count |
| `briefMaxColumns` | number | `34` | Display width cap for `brief`; a 汉字 counts as 2 |
| `sweepMs` | number | `10000` | Sweep interval in ms, minimum 500; `0` disables the timer |
| `sweepMinutes` | number | — | Obsolete; use `sweepMs`. If set, it wins at `×60000` and logs a warning |
| `waitingMinutes` | number | `20` | How long a ticket may sit in `waiting` before one reminder |
| `blockedMinutes` | number | `60` | Same for `blocked` |
| `runningReminderMinutes` | number | `0` | Reminder interval for `running`; `0` disables |
| `freshMinutes` | number | `2` | Grace period after `disposed` before a worker counts as gone |
| `autoReport` | boolean | `true` | When a round ends without a report, record its last output as one |
| `noReportSignal` | boolean | `true` | When a round ends with no report at all, push a "missing report" note |
| `repeatWindowMinutes` | number | `10` | Opening the same request again inside this window counts as a duplicate |
| `handoffPolicy` | boolean | `true` | Append the hand-off rules to the main session prompt; workers are untouched |
| `handoffPolicyText` | string | built-in block | The rules themselves; rewrite the whole block to change the wording |
| `noWaitGuard` | boolean | `true` | Refuse calls that would park the main session; workers unaffected |
| `maxCommandMs` | number | `30000` | Longest a command may hold the main session |
| `maxWaitMs` | number | `5000` | Longest a job wait may hold the main session |
| `routerRestrict` | boolean | `true` | Install the router whitelist on every non-worker session |
| `routerEscapeFile` | string | `~/.dsh/no-restrict` | While this file exists, no whitelist is installed |
| `routerTools` | string[] | 33 names | Global tool names the main session keeps; see `DEFAULT_ROUTER_TOOLS` in `src/config.ts` |
| `extraRouterTools` | string[] | `[]` | Extra global names to keep (MCP and friends), named one by one |
| `workerToolDeny` | boolean | `true` | Strip `workerDenyTools` from every worker's tool schema |
| `workerDenyTools` | string[] | 7 names | Memory-write tools a worker cannot see; see `DEFAULT_WORKER_DENY_TOOLS` |
| `workerPromptPrune` | boolean | `true` | Drop every `tool:*` / `mcp:*` section from worker prompts |
| `notifyScript` | string | `notify.sh` from the install | Push script used by `progress_note` |
| `notifyTimeoutMs` | number | `5000` | Hard cap on one push |

## Storage and events

A ticket is a stream of JSONL events, append-only. `status` is not a mutable field on a record: it is the payload of whichever append carried it, and `foldEvents` folds the latest value on read. Event kinds: `published`, `spawned`, `spawn-failed`, `ended`, `idled`, `resumed`, `queued`, `delivered`, `reported`, `blocked`, `closed`; bare status lines from old logs are read as `legacy/status`. A half-written trailing line is skipped.

`desk` is the only writer, through one `serialize` queue, so no two callers mutate a ticket at once. Above it sit three layers: `store/` (backend, log, fold), `tickets/` (ticket semantics: open, close, reports, delivery, sweeps), and `index.ts` (plugin wiring and tools).

## Statuses and who writes them

Six statuses: `open`, `running`, `waiting`, `blocked`, `done`, `dropped`. The first four are open and occupy `maxOpen`.

- `dispatch_open`: writes `open`, then `running` once the worker is up
- `dispatch_block`: parks the ticket while a person decides (main session only)
- `dispatch_close`: writes `done` or `dropped`; terminal
- The plugin listens for `subagent/end` and turns tickets still in `open` / `running` into `waiting`, recording `stopReason` and the report count in `note` — **it never writes `done`**

A worker only has `dispatch_report`, which appends a line and touches no status. So "why is this ticket still `running`" is a question for the main session and the event stream, not for the worker.

`waiting` means "that session stopped", not "the work was delivered". Delivery is measured by reports: a `waiting` ticket with none gets chased by the sweep.

## Queues

Each ticket carries two queues, both stored as log lines so they survive restarts: messages waiting for the worker (`dispatch_send`) and reports coming back (`dispatch_report`). Each entry has its own id and a `delivered` flag.

`dispatch_send` delivers immediately when the worker is alive and idle; otherwise it queues, and the next idle or sweep delivers it. `dispatch_report` wakes nobody and pushes nothing: `dispatch_list` only shows `«n` (unread reports), and the main session pulls the text with `dispatch_read`, which marks it delivered.

## Sweeps

Every `sweepMs` milliseconds (10 seconds by default) the plugin walks open tickets and emits signals based on status and age:

- `waiting` for `waitingMinutes` (20 by default)
- `blocked` for `blockedMinutes` (60)
- `running` for `runningReminderMinutes` (0, off)

The throttle fingerprint is `ticket:reason:statusSince`, so a given state signals once and can signal again after a round trip. The sweep **only reminds; it never edits tickets**: no status or note is written, and it does not collect reports on the main session's behalf.

There are two delivery paths. Unread reports, a finished round with no report, and tickets that finished or ran too long without closing become sweep facts, attached to `system-prompt/assemble` as a dynamic context (`dispatcher:sweep`, `interpolate: false`): the host renders it as a runtime-context snapshot, so the model reads ticket state rather than a message from the person. Time is rounded to five-minute buckets, so an unchanged state renders byte-identically and the KV prefix stays stable; once `dispatch_list` / `dispatch_read` / `dispatch_close` has seen a ticket, its entries are withdrawn, while unread ones stay. Only `blocked` past its threshold actually calls `followup`, prefixed with `[sweep] ` and stating plainly that the person is not speaking.

The fact table lives in memory only: after a restart the sweep rediscovers what matters, so stale reminders are never read back. Worker sessions never receive this context.

## Tool surfaces

With `routerRestrict` on, every non-worker session gets `tools.restrict({ allow: routerTools + extraRouterTools })` as it appears: ticket tools, delegation, memory, and conversation stay; file writes and shells go. Names must match registered global tool names one-to-one. `tools.restrict` throws on unknown names, and `ctx.effect` swallows that into the cordis error handler, so the plugin checks the registry first and warns about names nobody claims instead of letting one typo take down the whitelist.

MCP tools are not in the default list and are not matched by wildcard: to keep one on the main session, name it explicitly in `extraRouterTools`. A wrong name costs a log line, not the whitelist. While `~/.dsh/no-restrict` exists, no session gets a whitelist; `routerRestrict: false` turns the feature off entirely.

`workerToolDeny` strips the seven memory-write tools (`memory_save`, `memory_archive`, `memory_merge`, `memory_reflect`, `memory_split`, `memory_consolidate`, `memory_sleep`) from a worker's schema; `memory_recall` and the retrieval tools stay. A deny list is used instead of an inverse allow list because `tools.schemas()` only projects the global layer — computing `allow` from it would also strip preset-registered agent-layer tools and cripple the worker.

`workerPromptPrune` then drops every `tool:*` / `mcp:*` / `mcp-resource-servers` section from worker prompts: a worker's tool surface depends on its preset, so any statically written list is wrong for some preset and costs tokens. Persona, plan policy, and other non-tool sections are untouched.

## Read-only exit

Pets, commands, and scripts should not parse `tickets.jsonl` themselves:

```bash
dsh-dispatcher tickets --json                  # every ticket
dsh-dispatcher tickets --json --open-only      # open tickets only
dsh-dispatcher tickets --json --id t-abc       # one ticket; exit code 1 if absent
dsh-dispatcher tickets --json --recent 20      # open tickets plus the last 20 closed
dsh-dispatcher tickets --json --backend sqlite --db ~/.dsh/dispatcher/tickets.db
```

With no flags the CLI follows the profile's `store.backend` / `store.file`, exactly like the in-process runtime; the default is still `jsonl`. `--backend <jsonl|sqlite>` picks a backend explicitly, `--db <path>` implies `--backend sqlite` and names the database (relative paths resolve against `DSH_HOME`), and `--state <path>` explicitly uses jsonl. Passing `--backend jsonl` together with `--db` is an error (exit 2); `redis` reports not-implemented and exits 2.

The `--json` shape is fixed and `v` is the schema version. `counts` is computed over the whole log and is not affected by filters. Fields: `id`, `brief`, `goal`, `status`, `owner`, `createdAt` / `updatedAt` / `closedAt` / `statusSince`, `workerAlive`, `pendingInputs` / `pendingReports`, `reportsCount`, `ageMinutes`, `stale`, `epoch` / `epochReports`, `preset` / `presetSource`, `dir` / `note` / `device`. Times are ISO 8601 UTC.

In-process: `ctx.get('dispatcher/tickets')` returns a `TicketReadout`; `payload(selection)` gives the same JSON, `select()` gives `TicketView` objects with `goal`, and `get(id)` returns one ticket.

For cross-process readers, every commit atomically rewrites `$DSH_HOME/dispatcher/tickets.snapshot.json` with all open tickets plus the last `snapshotRecentClosed` closed ones, in the same shape as `--json`. A temp file plus `rename` means a reader always sees a complete document.
