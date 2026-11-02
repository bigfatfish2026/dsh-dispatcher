# dsh-dispatcher

[中文](README.md) · English

A dispatch plugin for DeepSeek Harness: the main session keeps talking, worker subagents do the work.

The point is responsiveness. Someone asks a question over QQ and expects an answer now; the main session cannot give one while it is buried in a task. So instead it writes the task down as a ticket, hands it to a worker, and goes straight back to the conversation. The ticket records where the work stands, and it is still there when the main session looks back later.

The design follows the official prototype, [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), and keeps three of its parts:

| Prototype | dsh-dispatcher |
| --- | --- |
| Source / Trigger / Thread / Subscription | Dropped: messages already arrive in the main session |
| Two-layer Eval + versioned Policy | Dropped: the main session decides whether to delegate |
| Dedicated DSH session as Executor | A `subagent`, sharing the working directory |
| Ticket lifecycle + panel + retries | Tickets, status, and a staleness mark |
| Input queue + report delivery | Two queues in the log; a sweep delivers the input queue only, reports are read by the main session |

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.2.1-rc.5` (peer dep `>=0.1.2-rc.1 <0.3.0`, spelled as several OR'd ranges in `package.json`) |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | All (plain ESM; no native code, no network) |

## Install

```sh
pnpm pack
dsh plugin --profile <name> add ./dsh-dispatcher-1.2.0.tgz
dsh --profile <name> --dump-config | grep 'dsh-dispatcher'
```

Restart the instance afterwards; the plugin only loads on startup. Tickets default to `$DSH_HOME/dispatcher/tickets.jsonl`: one event per line, append-only, and a half-written trailing line is skipped on read.

## Configuration

| Key | Type | Default | Meaning |
|---|---|---|---|
| `stateFile` | string | `dispatcher/tickets.jsonl` | Ticket log path; a relative path resolves against `DSH_HOME` |
| `staleMinutes` | number | `30` | Silence after which a ticket counts as stale in `dispatch_list` (the `!` mark). It no longer drives any announcement |
| `maxOpen` | number | `4` | Cap on concurrently open tickets; `done` / `dropped` do not take a slot |
| `handoffPolicy` | boolean | `true` | Append the hand-off rules to the main session prompt; subagent sessions are skipped |
| `handoffPolicyText` | string | the shipped block | The hand-off rules themselves; rewrite the whole block to change the wording, an empty string (or whitespace only) means "do not inject" |
| `sweepMinutes` | number | `5` | Sweep interval; `0` turns the timer off and leaves only the manual `dispatch_sweep` |
| `zombieMinutes` | number | `20` | Silence after which an `open` / `running` ticket is reported once as a suspected zombie. An owner whose agent is gone from the live registry is `worker-gone` regardless of this value |
| `notifyOwner` | boolean | `true` | Wake the owner session about tickets that went quiet |
| `quietSweep` | boolean | `false` | Never wake the main session on a sweep, not even for a zombie ticket; tickets are still reopened, queued messages still reach live workers and closed tickets' reports are still cleared, and the main session reads reports itself |
| `ownerSessionId` | string | empty | Session to wake; empty picks the c2c session from the QQ prefs file |
| `qqPrefsPath` | string | `''` | Conversation-key to session-id map |
| `ownerOpenId` | string | empty | Owner openid, used when more than one c2c session exists |
| `noWaitGuard` | boolean | `true` | Refuse main-session calls that would wait; workers are unaffected |
| `maxCommandMs` | number | `30000` | Longest a single command may hold the main session |
| `maxWaitMs` | number | `5000` | Longest a `job_output` wait may hold the main session |
| `routerRestrict` | boolean | `true` | Give every non-worker session the `routerTools` whitelist |
| `routerEscapeFile` | string | `~/.dsh/no-restrict` | While this file exists the whitelist is not installed on any session |
| `routerTools` | string[] | 36 names | Global tool names the main session keeps; the default list is `DEFAULT_ROUTER_TOOLS` in `src/config.ts` |
| `workerToolDeny` | boolean | `true` | Take `workerDenyTools` out of every worker subagent's tool schema; independent of `routerRestrict` |
| `workerDenyTools` | string[] | 7 names | Tool names a worker does not see: the seven write-side memory tools, `DEFAULT_WORKER_DENY_TOOLS` in `src/config.ts` |
| `notifyScript` | string | the `notify.sh` on the host | Script `progress_note` runs to push one line to QQ; it owns the openid, the plugin keeps no second copy |
| `notifyTimeoutMs` | number | `5000` | Hard cap on one progress push; on timeout the child is killed and the call returns `sent: false` |

```yaml
- id: dsh-dispatcher
  name: dsh-dispatcher
  config:
    staleMinutes: 20
    maxOpen: 3
```

**Changing the config needs a restart to take effect.** Values in `cordis.patch.yml` are read once, when the plugin loads, and a hot reload does not necessarily carry the new values to sessions that are already running — especially anything installed per session, like the whitelist and the deny list. Restart the instance after editing `dsh` config; do not expect a one-line yml edit to apply instantly. The bug fixed in 1.1.1 was exactly this: after a hot reload the plugin judged the wrong side of "who is allowed to say a tool does not exist".

## Tools

| Tool | Purpose |
|---|---|
| `dispatch_open` | Open a ticket. Call it right after spawning the worker, before replying |
| `dispatch_touch` | Change status, with an optional one-line note (`status` is required) |
| `dispatch_list` | List tickets; `!` marks one that has gone quiet, `»n` queued messages, `«n` unread reports |
| `dispatch_send` | Queue one more message for a ticket's worker |
| `dispatch_report` | Record a report on a ticket without ending it |
| `dispatch_close` | Close a ticket once the work is delivered |
| `dispatch_sweep` | Run a sweep now instead of waiting for the timer: reopen tickets, push queued messages to live 小鱼, clear reports left on closed tickets, judge the zombie tickets. It does not deliver reports |
| `progress_note` | Push one line of progress straight to the owner's QQ; wakes no session and writes nothing to disk — call it once per chunk on long work |

Six statuses: `open`, `running`, `waiting`, `blocked`, `done`, `dropped`. The first four count as open and take a `maxOpen` slot.

## Queues

A ticket carries two queues, both lines in the same log, so a restart loses nothing: messages waiting for the worker (`dispatch_send`) and reports the worker handed back (`dispatch_report`). Each entry has its own id and a `delivered` mark.

`dispatch_send` delivers at once when the worker session is alive and idle, and otherwise leaves the message queued. `dispatch_report` never wakes anyone; the main session reads reports on its next turn with `dispatch_list`, where a ticket's `«n` counts the reports it has not read. A sweep does not collect reports for the main session: it pushes queued messages to live workers and reopens a `done` ticket that received more mail (status only, nobody is woken) — the prototype's `tickets.wake`. A `dropped` ticket is a person's stop and stays shut. Reports left on a closed ticket have no reader left, so a sweep clears them silently by appending a `delivered` mark; it never pushes one.

## The ticket lifecycle

![worker / ticket lifecycle (English)](docs/worker-ticket-lifecycle.en.png)

The figure puts one ticket's whole life on one page: on the left M (the main session) opens the ticket, starts W and goes back to talking; in the middle W (the worker) does the work, reports and pings M; on the right the ticket walks `open → running → done`, and the far right column is how a sweep picks zombie tickets out.

A ticket ends on two facts only: W delivered, and M called `dispatch_close`. Whether M's session still exists changes nothing — `/new` replacing the session, a host restart, or M simply forgetting does not turn a ticket into `done` on its own. There is exactly one revive gate: new input arriving after `done`, which the sweep reopens. `dropped` is a person's stop and stays shut.

The figure is generated by `docs/worker-ticket-lifecycle-i18n.py`: after editing the wording run `python3 docs/worker-ticket-lifecycle-i18n.py en` (or `zh`), and `CHECK=1` runs the text-overflow self-check.

## How the main session should use it

Open the ticket, hand off, reply. That order. The ticket is a note to your future self: half an hour later `dispatch_list` says which jobs are still silent, without scrolling back through the conversation.

When a worker needs a decision, it writes the question into `note`, switches the ticket to `blocked`, and lets the main session answer it, ask the person, or drop the work.

Two things belong in every task you hand off: the ticket id (so the worker reports back with `dispatch_report`) and the progress duty (call `progress_note` once per chunk). Long work without progress notes leaves the person staring at a silent chat. Anything the person adds halfway through goes into the ticket with `dispatch_send`; do not paraphrase it away.

## The waiting guard

A prompt section is a request, not a guarantee: the main session can still sit in a `bash` call for two minutes while the person waits for an answer. So every session except a worker gets a `tools.guard` when it is created, and the guard refuses three shapes outright — a command that runs `sleep`, a `timeoutMs` over `maxCommandMs`, and a `job_output` wait over `maxWaitMs`. A foreground command with no `timeoutMs` is refused too, and the reason names the two ways out. Sessions that already exist when the plugin loads are covered as well, or a reload would only protect the next one.

This is upstream dsh-superagent's `noWait` guard, which caps the router shell at five seconds and refuses the same shapes. What differs is how a session earns the right to wait: there it is the agent preset, here it is `session.header.origin === 'subagent'`.

## The router whitelist

The waiting guard stops a session from blocking on one call; the whitelist stops it from having the call at all. With `routerRestrict` on — the default — every session that is not a worker gets `tools.restrict({ allow: routerTools })` when it appears. The main session keeps the ticket tools, delegation, memory, the ways it talks to the person, the read-only file tools (`read`, `glob`) and the read-only host checks; the writing, shell and waiting tools are gone, so "delegate it" stops competing with "just run it here". Workers keep the whole surface, so heavy work has somewhere to go; only the seven write-side memory tools are trimmed (see the next section).

The default list is 36 names and lives in `DEFAULT_ROUTER_TOOLS` in `src/config.ts`. `grep` is deliberately not one of them: a single `-rn` has no ceiling on output size, and the main session's long-context cost is almost entirely cache read (measured at 98.6%), so one uncapped search means paying for the whole log on every later turn. Searching is a worker's job — it brings back a few lines. Names must match the registered global tool exactly. `tools.restrict` throws on an unknown one, and `ctx.effect` hands a throw from its callback to cordis' error handling rather than back to the caller, so the plugin checks the list against the registry first: it warns with the names nothing answers to and drops just those from the filter. A typo costs a log line, not the whitelist.

Hiding a tool is only half of it. Every tool plugin also registers a `tool:<group>` prompt section saying how to use it, and that section is assembled from the prompt registry rather than from the schema list — so the main session used to read "Use `browser_navigate` …" for a tool the whitelist had already taken away. While the restriction is installed the session also gets a scoped `system-prompt/assemble` listener that drops exactly the tool sections whose tools are all hidden. The judgement is deliberately narrow: only `tool:` sections are candidates (persona, plan policy, the hand-off rules and every other prose section are never touched); a section stays when its group name is itself a visible tool (`tool:bash` while `bash` is whitelisted) or when its prose still names a visible tool (`tool:goal` survives on `create_goal`). Nothing is inferred from a shared prefix: `read` and `read_image` are two tools, so one being visible never decides the other's section — with both whitelisted, `tool:read` stays on `read` alone. Both checks read `assembly.tools`, the schemas the model is about to receive, so whitelisted-but-unregistered names cannot keep a section alive. Subagents have their own prompt scope and never see this listener; with the escape file present there is no restriction, so there is nothing to prune either.

### The worker deny list

Since 2026-11-01 the rule is that only the main session writes memory: a worker may recall, never save, archive, merge, reflect, split, consolidate or sleep the memory store. `dsh-memory` enforces it at execute time (`assertMayWrite`), and `workerToolDeny` adds the layer above it — with it on (the default) every worker subagent gets `tools.restrict({ deny: workerDenyTools })` when it appears, so the seven write-side names never reach its schema and the model cannot spend a turn on a call that would be refused. The list is `DEFAULT_WORKER_DENY_TOOLS` in `src/config.ts`: `memory_save`, `memory_archive`, `memory_merge`, `memory_reflect`, `memory_split`, `memory_consolidate`, `memory_sleep`.

It is a deny list and not the reverse whitelist on purpose. `restrict` checks an allow list against the scope's restrictable names, and the only public enumeration (`tools.schemas()`) projects the global layer alone — a worker also inherits whatever a preset registered on the agent plane, so an allow list built from that projection would hide those too and leave the worker with a handful of tools. Naming the seven cannot over-remove anything, and the failure mode of a bad config is a missing restriction rather than a crippled worker: names nothing registers are dropped with a warning, and a list that would cover every registered tool is refused instead of handed to `restrict`. `memory_recall`, `memory_entity` and the chat/search tools stay.

`workerToolDeny` is separate from `routerRestrict` because the two guard different things — one is what the main session can do, the other is who may rewrite what the house remembers — and turning one off must not silently turn the other off. The escape file still turns both off.

Two ways out. `mkdir -p ~/.dsh && touch ~/.dsh/no-restrict` and the whitelist is not installed on any session; delete the file to turn it back on. `routerRestrict: false` turns it off for good. The escape file is read once per session, so a change needs a restart (for a session that already exists, a plugin reload).

## Sweeps and zombie tickets

Every `sweepMinutes` (default 5; `0` turns the timer off and leaves only the manual `dispatch_sweep`) the plugin looks at its own tickets and does four things in order: reopen a `done` ticket that received more mail (status only, the owner is not woken), push queued messages to workers that are still alive, clear the reports left on closed tickets, and judge the zombie tickets — one `followup` message (`source.kind` is `dsh-dispatcher`, so it is distinguishable from a person talking) only when a zombie is found. Reports are never pushed: an open ticket's reports stay pending and the main session reads them with `dispatch_list`. A busy session is skipped and retried on the next sweep; nothing is lost, because the queue is in the log rather than in memory.

Only `open` and `running` tickets are zombie candidates. `waiting` / `blocked` mean a person is holding the ticket and are skipped; `done` / `dropped` are over. There are two judgements:

- `worker-gone`: when the owner is a uuid-shaped agent id (bare uuid or with a `session-` prefix) it is looked up in `AgentRegistry` — the registry keys on `agent.session.id`, the same id the ticket records. A missing agent is dead no matter how recently the ticket moved. A ticket younger than 2 minutes is spared, because `dispatch_open` writes the owner a few seconds before the subagent actually registers.
- `silent`: an owner that is a short label (`重启小鱼`, say) cannot be looked up at all — short labels are not in the live registry, so a lookup would always miss. Those tickets are reported only after `zombieMinutes` (default 20) without progress, and progress means the last report, not a mere `dispatch_touch`.

The throttle is an in-memory fingerprint, `${reports.length}|${lastActivity}|${status}`. It deliberately avoids `updatedAt`: a sweep's own writes (steering a queued message to a live worker, clearing a closed ticket) append events and refresh that field, so an `updatedAt` key would announce the same ticket again on the next round. The last report's time and the status only move on a real report or a status change. With no new report and no status change a ticket is announced once; a process restart costs at most one repeat.

A summary is pushed only when something is found. When nothing is found the sweep is completely silent — not a single character. The line carries the ticket id, how long it has been idle, which judgement fired, how many reports are unread, and the first 40 characters of the goal; at most three tickets are listed, and the rest are counted as "另有 N 张". Report bodies stay out: a sweep does not deliver reports, and folding one in would make this a second copy of it.

A sweep only reports; it never finishes a ticket for the main session. A ticket stays `running` even if its worker is dead, and nothing is closed on the ticket's behalf. With `quietSweep: true` the zombie step pushes nothing and remembers no fingerprints either, so a silent round cannot swallow the first real announcement. One `followup` costs a whole main-session turn with all of its context, so quiet mode still reopens tickets, steers live workers and clears the reports left on closed tickets; an open ticket's reports are left untouched, so an outside script can still read the log and push them — this repository ships none, it is a small script plus a timer (say `~/.dsh/dispatcher-notify.sh` on a `systemd` timer).

This is the prototype's `Passes` heartbeat plus `evaluateDue`, with the input delivery work kept and the evaluation dropped: nothing in a sweep asks a model anything.

## Development

```sh
pnpm install
pnpm test       # vitest
pnpm run typecheck
pnpm run build  # tsdown → lib/
```

Tests touch neither the network nor the DSH runtime: they cover event folding, status rules, log round-trips, both queues, and the waiting guard's refusal rules.

## License

[Apache License 2.0](LICENSE) © 2026 dsh-dispatcher contributors.
