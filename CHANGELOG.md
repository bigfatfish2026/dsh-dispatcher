# Changelog

## 1.0.0 — 2026-11-01

First public release, cut from one development line; the 0.x entries below record how it got here.

- The main-session whitelist. `routerRestrict` gives every session that is not a worker `tools.restrict({ allow: routerTools })`: the main session keeps the ticket tools, delegation, memory, the ways it talks to the person and the read-only host checks, and loses everything that reads, writes or waits. Workers keep the full surface, which is the point — heavy work has somewhere to go. `routerEscapeFile` (default `~/.dsh/no-restrict`) skips the whitelist on every session while it exists, and `routerRestrict: false` turns it off outright.
- Ticket-based delegation. An append-only log per ticket behind `dispatch_open` / `dispatch_touch` / `dispatch_list` / `dispatch_send` / `dispatch_report` / `dispatch_close` / `dispatch_sweep`: work goes out to a worker, queued messages and reports come back through the same log, a `done` ticket that receives more mail reopens, and a ticket that went quiet is announced once.
- `quietSweep`. A sweep still keeps the log honest — reopens, steers live workers, marks reports delivered, refreshes the stale snapshot — but never wakes the owner session, so an outside script can deliver the reports instead of paying a main-session turn for each one.
- Load order fix: the whitelist installs after this plugin's own tools register. On a hot reload the old registrations are already released and the new ones had not landed, so the self-test dropped all seven `dispatch_*` names and the main session answered "unknown tool"; sessions that appear later still get the list through `agent/created`.
- Prompt pruning for hidden tools. While the whitelist is installed the session also gets a scoped `system-prompt/assemble` listener that drops exactly the `tool:` sections whose tools are all hidden. The judgement reads `assembly.tools` and uses no prefix heuristics, so a whitelisted `read_image` does not spare the `tool:read` section; prose sections are never touched.

Also in the box: the waiting guard (`noWaitGuard`, `maxCommandMs`, `maxWaitMs`) that refuses main-session calls which would sit and wait, the hand-off policy prompt section, and a sweep that never asks a model anything.

## 0.6.0 — 2026-11-01

The whitelist now prunes the prompt too. `tools.restrict` only removed tools from the schema list; every tool plugin still registered a `tool:<group>` prompt section, so the main session kept reading "Use the browser tools …" and "Use bilibili_search …" for tools it no longer had. Installing the whitelist now also installs a scoped `system-prompt/assemble` listener that drops exactly the tool sections whose tools are all hidden. Only `tool:` sections are candidates — persona, plan policy, the hand-off rules and every other prose section are never touched. A section survives when its group name is itself a visible tool or when its text still names one (`tool:goal` on `create_goal`); no prefix heuristic, so a whitelisted `read_image` does not spare the `tool:read` section. Visibility is read from `assembly.tools`, the schemas the model is about to receive. Subagents are unaffected (their prompt scope is their own, and they never get the listener) and the escape file still turns the whole thing off. Section naming was checked against the host before it was relied on: first-party contributions are `tool:bash`, `tool:session-query`, the third-party ones `tool:bilibili` and `tool:browser`.

## 0.5.0 — 2026-11-01

The router whitelist: `routerRestrict` (on by default) gives every session that is not a worker `tools.restrict({ allow: routerTools })`, so the main session keeps the ticket tools, delegation, memory, QQ and the little screen, and loses the reading, writing and waiting ones; workers are untouched. The default list is 32 names. It is checked against the registry when it is installed — a name nothing answers to is warned about and dropped, because `tools.restrict` throws on an unknown name and `ctx.effect` hands that throw to cordis instead of the caller, so a typo would otherwise show up only as "the whitelist never installed". `routerEscapeFile` (default `~/.dsh/no-restrict`) skips the whitelist on every session while it exists, and `routerRestrict: false` turns it off outright.

## 0.4.0 — 2026-11-01

`quietSweep` (default `false`): a sweep no longer wakes the owner session. Every `followup` costs a full main-session turn with all of its context, so when an outside script delivers the reports — on this machine `dispatcher-notify.sh` plus a systemd timer pushing to QQ — the sweep keeps the log honest instead: it still reopens a `done` ticket that received more mail, steers live idle workers, marks reports delivered and refreshes the stale snapshot, then returns with `reason: 'quiet'`. Also fixes the README text that still described the old four-step sweep as unconditional.

## 0.3.1 — 2026-11-01

Repository tidy-up, no behaviour change: the locale files describe the plugin instead of the generator that scaffolded it, `tsdown` and `typescript` moved to `devDependencies`, the bundle patch and README text were corrected, and the stale 0.1.0 tarball is gone. Adds a CI workflow.

## 0.3.0 — 2026-11-01

Two queues per ticket, both lines in the same append-only log, so a crash loses nothing: `dispatch_send` queues a message for a worker (and steers it straight to a live, idle one), `dispatch_report` records a report without ending the ticket. The sweep delivers both and reopens a `done` ticket that received more mail, which is the prototype's `tickets.wake`.

## 0.2.0 — 2026-11-01

The waiting guard: every session except a worker gets a `tools.guard` that refuses a command running `sleep`, a `timeoutMs` over `maxCommandMs`, a foreground command with no timeout, and a `job_output` wait over `maxWaitMs`. A prompt section asks the main session not to sit on long work; the guard makes it hold. Port of the upstream `noWait` guard.

## 0.1.0 — 2026-11-01

First version: an append-only ticket log, `dispatch_open` / `dispatch_touch` / `dispatch_list` / `dispatch_close` / `dispatch_sweep`, the hand-off policy section, and a sweep that wakes the owner session about tickets that went quiet.
