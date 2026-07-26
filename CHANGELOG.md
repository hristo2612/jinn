# Changelog

## [0.28.8]

### 🔒 Security
- **The instance directory is restricted to you, and says so when it is not.** `~/.jinn` holds the gateway token, connector secrets and every session transcript, and was protected with a `0600` file mode. Windows has no such mode — `chmod` there only toggles the read-only flag — so the protection was a no-op and the directory kept whatever access it inherited from the user profile; on one machine that meant every file readable by an unrelated account group. Permissions are now expressed in each platform's own model, identified by security identifier rather than by name so that a non-English Windows is handled correctly, and `jinn setup` restricts the directory once so everything written later inherits it. Local device pairing also worked again on Windows, where it had required a file mode no Windows file can report.

  **Existing macOS and Linux instances are affected.** A directory created before this release is group- and world-readable (`0755`), so the gateway now tightens it to `0700` once, at startup, and logs that it did. Widen it again deliberately and the gateway reports the exposure on each start instead of overriding you. Windows is never repaired automatically: doing so means dropping inherited access an operator may have granted on purpose, such as a sandboxed engine account that needs to read configuration.

## [0.28.7] - 2026-07-27

### 🐛 Fixes
- **No-op upgrades stay quiet.** A release that intentionally has no instance migration bundle is now treated as already complete instead of making the dashboard repeatedly show and hide “The migration service is temporarily unavailable.” The check is also one-shot, so a transient failure cannot become a polling loop.
- **No-op migrations work on filesystems without symlink support.** Completing an upgrade no longer requires materializing snapshot symlinks, keeping Windows and restricted filesystems on the supported migration path.
- **The upgrade lab handles no-bundle releases without overflowing its process check.** Release verification now recognizes when no migration handoff is required, uses authenticated lab probes, and filters temporary process candidates before Node buffers the result instead of reading every AI process's full command line.
- **Windows source builds and port checks are reliable.** POSIX-only assertions are scoped to POSIX systems, and gateway ownership checks respect the configured bind address rather than confusing a listener on another interface for the Jinn instance.
- **Windows skill commands preserve trailing backslashes.** Command-line quoting no longer lets a final backslash escape the closing quote and corrupt the argument.

## [0.28.6] - 2026-07-25

### 🐛 Fixes
- **Claude models show their real names again.** Claude Code stores its credentials in the macOS login Keychain and writes no `~/.claude/.credentials.json`, but model discovery only read the file and the environment variable. On a stock macOS install it therefore found no token, returned zero models, and silently fell back to the hardcoded offline catalog — so the picker offered "Opus (Latest)" instead of "Opus 5". Discovery now reads the Keychain, using the same reader as the usage screen rather than a second copy that had drifted. A discovery that yields no models is also logged as a warning instead of passing for a healthy catalog.
- **The engine menu shows the context meter again.** The offline fallback models carry no context window, and merging discarded the configured value along with the stale label, so a failed discovery left the meter with no denominator and it disappeared entirely. A configured context window now fills that gap while live discovery still wins on names and effort levels.
- **Attaching an image no longer hangs the turn.** Claude Code's terminal UI auto-attaches any pasted path that resolves to a real image file and discards keystrokes while it encodes the file — including the Enter that submits the message, which was sent on a fixed 150 ms delay. Any real screenshot takes longer than that to encode, so the message sat in the input box with no response and no error. Attachment paths are now passed in a form the UI does not try to auto-attach, removing the race rather than waiting on it.
- **A turn that loses its completion signal now ends instead of hanging forever.** Recovering a turn whose completion hook was lost requires the engine's session id to locate its transcript. On a session's first turn that id can be missing too, leaving no way to recover and nothing to end the turn — the session stayed "thinking" indefinitely and every message queued behind it was never delivered. Such a turn now settles with a clear error once it has been idle long enough that recovery has demonstrably failed.
- **Compaction summaries are dropped before they are stored.** The gate meant to discard them decided on the first piece of each message, which is always usage metadata, so it passed every message through and never dropped anything. The summary was still streamed and saved, leaving a phantom message in the transcript that only the interface hid.
- **Sessions started from the web record their turns and cost.** The web session runner never accumulated either, so those sessions always reported zero. Because employee budgets are enforced from total spend and most turns are web-sourced, budget caps were effectively unenforced. Both runners now share one accounting path. Claude turn cost is also measured per turn rather than from the start of the session, which previously counted long conversations several times over.
- **A gateway started in the foreground can be stopped and restarted.** Ownership was determined by reading the running process's environment, which only a background daemon carries, so `jinn stop` and `jinn restart` refused to manage a foreground gateway and reported that the port belonged to another instance. Ownership now also accepts the gateway record written inside the instance's own home, while still refusing a genuinely foreign instance.
- **The workspace switcher leads with the workspaces you can use.** Every entry ever registered was listed, so on a machine with many past sandboxes the running workspaces were buried among dozens of offline ones. Offline workspaces are now collapsed behind a count you can expand, on both desktop and mobile; starting one still works as before.

### 🪄 Docs
- Added a testing guide for the gateway package covering the isolated-home invariant, so a test run cannot write into a live instance's data.

## [0.28.5] - 2026-07-25

### ⚡ Performance
- **Claude sessions really do run to the model's full context window now.** Every Claude session is routed through a per-session loopback proxy that forwards requests to the Anthropic API unchanged, which means `ANTHROPIC_BASE_URL` points at `127.0.0.1`. Claude Code decides whether a session is first-party by matching that host name, so the loopback address failed the check and the session silently fell back to a 200K context window even on a model whose real window is 1M. Because the auto-compact budget is clamped to the model window, this also neutralized the 1M request added in 0.28.4 — that change could never take effect. The engine now asserts first-party for its own proxy, restoring the true ceiling: a verified session reached 323K tokens in a single request with no compaction, where the same session previously compacted at 170K.

### 🐛 Fixes
- **A gateway launched from inside another Claude session no longer inherits a dead API endpoint.** `ANTHROPIC_BASE_URL` is now stripped from the environment handed to Claude processes, so a nested launch cannot point a new session at the parent's proxy port.

## [0.28.4] - 2026-07-25

### ⚡ Performance
- **Claude sessions run to the model's real context ceiling before compacting.** Claude Code decides when to auto-compact using a budget that is separate from the model's context window, resolved from an env var, a user setting, server-supplied client data, and finally a per-model default. Nothing set any of them, so long sessions on a 1M-window model such as Opus 5 compacted around 166K tokens — roughly five times more often than the model requires. The engine now asks for the 1M ceiling; Claude clamps the request down to whatever the active model actually supports, so smaller-window models are unaffected, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` still overrides it.

### 🐛 Fixes
- **A stale web bundle can no longer resurface after an upgrade.** Asset filenames are content-hashed, so each build wrote new files alongside the old ones instead of replacing them and the bundled web directory only ever grew. A browser that revalidated `index.html` but still held an older entry chunk could keep booting a months-old build out of the same directory. Files left over from previous builds are now pruned once the new index is in place and verified.

## [0.28.3] - 2026-07-25

### 🐛 Fixes
- **Windows installs no longer crash during setup.** The optional `skills` availability probe ran through a bare `npx`, which cannot be spawned on Windows without a shell and threw an unhandled `ENOENT`/`EINVAL` that took the whole process down. The probe now resolves the platform's executable and fails quietly when it is absent.
- **MCP servers survive a model or effort change.** Switching model or effort cold-respawns the Claude engine, and the per-session MCP config file had already been cleaned by the previous turn, so the new process started with no servers attached. The config is now re-materialized at the respawn boundary.
- **Compaction summaries stay out of the chat.** Claude Code runs auto-compaction as an ordinary API call with the main agent's tools and system prompt, so its summarizer output passed every stream gate and landed in the transcript as a huge `<analysis>…<summary>…` message. That one message is now dropped before it is persisted, and any already-stored `<analysis>` or `<summary>` block folds into a collapsed disclosure instead of rendering raw.
- **Gateway restarts stop claiming a free port is taken.** Port-ownership detection compared listeners without regard for the bind host, so an unrelated listener on another interface could make a cold start reject a genuinely free loopback port.
- **Long-lived gateways discover newly published models.** Engine model discovery ran only at boot, on config reload, and after a failed turn, so a gateway with multi-day uptime kept serving its boot-time catalog. It now refreshes periodically.

## [0.28.2] - 2026-07-24

### 🐛 Fixes
- **Migration checks stay available after patch upgrades.** Explicit empty v0.28.1 and v0.28.2 migration bridges keep the strict instance-migration chain aligned with the installed package, preventing the dashboard from repeatedly reporting that the migration service is unavailable.
- **Release CI no longer depends on a globally installed engine CLI.** The Workflow vertical test now uses the running Node executable for its injected fake engines' availability check, so clean GitHub runners exercise the fake engine instead of failing before dispatch.

## [0.28.1] - 2026-07-24

### 🐛 Fixes
- **The npm-installed `jinn` command starts normally.** The v0.28 CLI registration guard now resolves npm's executable symlink before deciding whether to parse arguments, preventing `jinn --help`, `jinn --version`, and every operational command from exiting silently.

## [0.28.0] - 2026-07-24

> Workflows become an explicit, observable execution contract; Todos grow into a collaborative hierarchy; and one Jinn installation can now launch and manage multiple isolated workspaces.

### ✨ Features
- **Workflows v2 with explicit completion.** The Workflow engine and editor were rebuilt around a durable node contract: employee nodes finish only by submitting schema-validated output, can request bounded deadline extensions, and receive escalating reminders that account for active child work. The read-only run canvas, inspector, live activity stream, workflow-session sidebar entries, and safe mid-run operator messages make long executions understandable and steerable without accidentally cancelling them.
- **Collaborative Todo hierarchy.** Todos now support department-scoped identifiers, three-level sub-tasks with roll-up gates, threaded comments, typed blocking/related links, labels, content-addressed attachments, richer provenance, manager-aware field authority, and approval history independent of a row's current state. The web ledger and MCP company surface expose the same durable model, including conflict-safe edits and bounded list operations.
- **Multiple isolated Jinn workspaces.** A workspace directory and launcher can discover, create, start, and open separate Jinn instances with their own homes, ports, access settings, and authentication. Offline workspaces can be started from the launcher, and workspace rows tolerate older registry entries that do not yet have ids.
- **Instance-wide file reads through MCP.** Authorized company tools can read files across the active Jinn instance instead of being limited to the knowledge directory, while preserving the existing path and authority checks.
- **Delegated work stays visible.** Parent chats now surface tracked work delegated into child sessions, keeping the operator's conversation connected to the underlying Todo.

### ⚡ Performance / Reliability
- **Secure, current connector and database dependencies.** The release updates the WhatsApp and Telegram connector stacks to patched releases and moves SQLite onto a Node 26-compatible native build, keeping fresh installs aligned with the advertised Node support.
- **Deterministic release test execution.** Package test suites now run sequentially at the monorepo gate, avoiding machine-contention timeouts while retaining the full CLI and web test coverage.
- **Safer fresh installs and workspaces.** New configurations require gateway authentication by default, workspace creation writes an owner-only token before startup, local browser bootstrap still pairs automatically, and proxied unauthenticated writes return an actionable pairing diagnosis.
- **Reliable macOS terminal startup after npm install.** The published package repairs executable permissions on node-pty's Darwin spawn helpers during postinstall, preventing terminals from failing because registry tarballs lost helper modes.
- **Workflow interaction survives active turns.** Operator messages sent while a workflow node is running are fenced as workflow interaction rather than generic interruption, so they stream into the attempt without cancelling it and remain restart-safe.

### 🐛 Fixes
- **Codex restores context and live usage limits.** Resumed Codex sessions recover their expected context while the UI continues receiving current limit telemetry.
- **Claude MCP identity remains narrowly scoped.** Claude's MCP bootstrap carries the bound session capability directly; the capability is no longer copied into the entire PTY child environment as a fallback.
- **Legacy Workflow upgrades fail safe instead of changing behavior.** Compatible v1 definitions import once as disabled v2 drafts, while scheduled, conditional, looping, gated, or otherwise non-equivalent definitions remain untouched. A durable import report records source hashes, outcomes, legacy run evidence, and active runs requiring review.
- **Migration reminders stay acknowledged.** Dismissing, copying, or successfully opening the instance-migration prompt now records the migration key in browser storage, so the dialog and mobile reminder pill stay hidden after a refresh while a newer migration still resurfaces normally.
- **v0.27 upgrades follow the complete migration chain.** An explicit empty v0.27 bridge preserves strict chain validation and lets both v0.26 and v0.27 installations apply every structured migration bundle through v0.28 without inventing user-file changes.

### 🛠️ Upgrade notes
- Drain active v1 Workflow runs before upgrading. v0.28 does not resume the retired v1 runtime.
- Review `<JINN_HOME>/workflows/legacy-v1-import-report.json` before enabling imported drafts. Legacy definition and run JSON remains under `<JINN_HOME>/workflow-evidence`; unsupported definitions and historical runs are preserved there rather than silently rewritten into v2 semantics.

## [0.27.0] - 2026-07-19

### ✨ Features
- **Model-scoped Claude usage buckets in the Limits tab.** The Limits view now surfaces per-model weekly windows (for example a separate weekly bucket for Fable-class models) next to the 5-hour and all-models weekly windows, so you can see a model budget approaching its cap instead of hitting it blind. These buckets only exist in Claude's OAuth usage API and never appear in the statusline payload, so limit collection now reads the local Claude Code OAuth token and queries that API, mapping every bucket generically so new server-side buckets show up without further changes. It falls back to the statusline snapshot when offline, and `JINN_CLAUDE_USAGE_API=off` disables the network path entirely. The token is never logged or persisted.

### 🐛 Fixes
- **Chat no longer drops messages after a turn in long sessions.** In sessions past the paged snapshot window (more than 150 messages), completing a turn could hide already-rendered messages and reorder media, because the turn-start marker was an index into the newest-150 snapshot but was applied to the full rendered list. The turn start is now anchored by stable message id, so long transcripts stay intact across turn completions.
- **Gateway no longer crashes on a broken pipe to the Codex app-server.** An EPIPE while writing to codex stdin is handled instead of taking down the whole process.
- **Concurrent first-boot migrations are tolerated.** The read-only Todo preflight no longer fails when a second instance on the same host is running its first-boot database migration at the same time.

## [0.26.0] - 2026-07-18

> Jinn becomes a full company operating system: employees now work through a native MCP company surface, Todos become the durable work ledger with a single company-prefixed identifier, Workflows become a real automation engine, and the web app gains first-class Skills, Cron, and activity receipts (plus opt-in Notes).

### ✨ Features
- **Company operations through MCP.** A built-in Jinn MCP now gives every supported engine a typed surface for employees and org structure, sessions and delegation, Todos, Workflows and Triggers, approvals, Notes and knowledge, cron and cost reads, connectors, attachments, and managed files. Tool discovery is compact and capability-scoped so employees get the right hands without carrying the whole platform manual in every turn.
- **Todos become the live work ledger.** Durable work items now support assignment, priorities, ranking, filters, pagination, manual start/cancel transitions, approval requests, archival, optimistic concurrency, conflict recovery, and manager visibility. Delegation is task-bound and completion is reviewer-driven instead of being treated as disposable session state.
- **`JIN-N` is the sole Todo identifier.** Every Todo is now referenced by one company-prefixed id (e.g. `JIN-42`). The 3-letter prefix is derived from your company name — word initials for 3+ words (`Build Sprint Labs` -> `BSL`), first-word fallback otherwise (`Jinn` -> `JIN`) — with an explicit `portal.companyPrefix` override that wins over derivation. The prefix freezes on the first allocation, and onboarding and settings preview the concrete sequence before it becomes permanent. No existing Todo data is rewritten on upgrade.
- **Archive and unarchive chats.** Sessions can be reversibly archived: archived chats drop out of the normal list, group, and unread counts while their transcript, engine snapshot, and Codex overlay stay fully intact and recoverable through search and a sidebar Unarchive action. Running or waiting chats cannot be archived.
- **A production Workflow engine.** Author reusable graph workflows with sequential, conditional, parallel, and switch paths; per-phase engine/model/effort and prompt overrides; invocation inputs; native approvals; idempotent runs; evidence; reporting; cancellation; and durable execution history. Triggers cover schedules, webhooks, polls, and Todo-status events with hardened validation and provenance.
- **Visual Workflow editor and execution view.** The web app adds an LTR canvas editor, node inspector, branch-aware geometry, run history, live status, approval controls, evidence links, and mobile-fitted navigation, backed by extensive layout and lifecycle verification.
- **Notes workspace (opt-in).** An Apple Notes-style workspace — folders, search, Markdown editing, microphone dictation, and MCP-backed note operations — ships behind a feature flag that is off by default in 0.26.0, so it appears only once you enable it. The existing knowledge base remains available as durable company context.
- **Skills and Cron become first-class documents.** Skills can be browsed and edited as raw `SKILL.md` documents, while Cron gains the shared Ledger list/detail language and clearer schedule descriptions.
- **Company activity receipts in Chat.** Delegations, callbacks, follow-ups, Todo mutations, and Workflow operations now render as structured, durable activity with previews and deep links. Live turn evidence folds cleanly into the final answer without losing what happened.
- **Version-aware migrations.** `jinn migrate` now discovers and composes only the migration guidance needed for the installed version, preserves customized instance files, safely stamps YAML, and warns about intentionally staged future migrations.
- **Durable terminal snapshots.** Interactive engine PTYs can restore serialized terminal state across reconnects and gateway restarts, including rebuilt xterm headless/serialization support in the shipped CLI.

### 🔒 Security / Reliability
- **Verified operator and capability authority.** Browser bootstrap, same-origin writes, session operations, approvals, and delegated attachments now enforce explicit authority boundaries. Third-party MCP engine environments are scrubbed so the gateway token is stripped before untrusted commands run, and config, logs, file-read content, and connector text are sanitized at the route level.
- **Per-instance auth isolation.** Session cookies are namespaced per gateway instance, so two instances on the same host (e.g. one direct plus one behind `tailscale serve`) no longer clobber each other's login. Browser pairing is instance-aware: the pairing screen and `jinn pair` name the exact instance and command, codes persist across a restart within their TTL, and pairing proves local filesystem control. The default `jinn` instance keeps its existing cookies, so upgrades don't force a re-pair.
- **Gateway no longer crash-loops on a full disk.** Fixed the disk/log leaks that could take the gateway down: `gateway.log` now rotates at a bounded size instead of growing without limit, orphaned per-session Codex home overlays are swept on boot rather than accumulating, and auth device-write throughput is throttled and tolerates a full disk.
- **Safer boot and upgrades.** A better-sqlite3 ABI mismatch now fails fast with an actionable message instead of a cryptic boot crash after a Node switch; the session DB gets a version-gated, idempotent pre-migration backup plus a free-disk preflight; and a corrupt session DB reports a clear recovery message instead of a misleading prerelease-data refusal.
- **Reliable callbacks and delivery.** Parent callbacks are persisted, deduplicated, retryable, and restart-safe; outbound follow-ups share the same delivery path; delegation contracts require explicit completion or blocking signals; and report retries are bounded and observable.
- **Workflow safety.** Trigger regexes run in isolated workers with timeouts and input caps, poll children receive allowlisted environments, mutations are atomic, parallel branches drain before settlement, and stale or cancelled executions cannot continue mutating state.
- **Engine continuity.** Codex keeps a per-session home so MCP configuration survives resume and duplication; MCP identity is preserved across engine environment filters; Hermes streaming deduplicates authoritative snapshots; and rate-limited sessions recover without parking new user messages behind stale timers.
- **Gateway lifecycle hardening.** Port takeovers are instance-verified, restart notices persist, proxy listeners shut down cleanly, queued attempt writes are guarded, and active turn evidence survives completion and reconnects.

### ⚡ Performance / UX
- **Faster boot and polling.** SQLite hot paths gained targeted indexes, startup reconciliation and FTS backfill yield until after listen, active runs use indexed lookups, and polled endpoints avoid hydrating entire session or activity tables.
- **Smaller initial web load.** Stable vendor chunks are split, heavy routes and syntax grammars load lazily, and shell widgets/onboarding no longer block the critical path.
- **Ledger-wide interface polish.** Todos, Workflows, Cron, Skills, Notes, Chat, Limits, and navigation now share a calmer responsive language with stronger mobile behavior, accessible contrast, preserved focus, URL-driven history, and resilient file previews.

### 🛠️ Upgrade notes
- Run **`jinn migrate`** after upgrading (or use the dashboard "Open with COO" handoff). It composes the canonical migration prompt, which your COO/engine applies to your customized instance — merging the company-autonomy doctrine, Todo/Workflow operating rules, MCP-first company surface, and updated management/migration skills without replacing your personal instructions — and then auto-marks the migration done once a verified completion receipt is present. (`--apply` is deprecated: it only prints the prompt with a warning and never stamps the version.)
- Workflows require no new config key; evidence defaults to `<JINN_HOME>/workflow-evidence` and can be relocated with `JINN_WORKFLOW_EVIDENCE_ROOT`.
- Hermes users may need to rebuild the Hermes 0.17.1 native binary/bridge after upgrading.

## [0.25.0] - 2026-07-07

### ✨ Features
- **Existing chats can switch engines in place.** Jinn now keeps per-engine native session refs, bridges recent transcript context when moving between engines, and restores the prior native session when switching back.

### 🐛 Fixes
- **Gateway restarts no longer replay the restart turn.** Chat-driven restarts now acknowledge the requesting session, complete its active queue item before shutdown, preserve healthy idle state during graceful cleanup, and avoid stale PID/port-owner hazards.
- **Rebuilds keep the web UI loadable.** The build now syncs web assets into `dist/web` without removing the live bundle mid-request, preventing blank pages from transient missing chunks.
- **Errored chats can recover by switching engines.** Terminal error/interrupted states are now switchable, while queued/running turns remain protected.
- **Engine picker label stays concise.** The model menu now shows `Switch engine…` as the row label instead of listing every installed engine inline.

## [0.24.0] - 2026-07-06

### ✨ Features
- **Seamless chat history paging.** Long chat sessions now hydrate the latest messages first, automatically load older history as you scroll upward, preserve scroll position while prepending, and lazy-load chat media/audio so large transcripts open faster.

### 🐛 Fixes
- **Jump-to-latest stays pinned and quiet.** The control now lives outside the scrollable transcript, animates in/out smoothly, uses a compact icon-only affordance, and no longer counts prepended history as unread.

## [0.23.6] - 2026-07-06

### 🐛 Fixes
- **Duplicate callback fix narrowed to duplicate-capable engines.** The platform context refresh now applies to Claude/Opus, Codex, and Hermes resumed turns only; Pi keeps its previous prompt behavior because it does not participate in Jinn's duplicate/fork flow.

## [0.23.5] - 2026-07-06

### 🐛 Fixes
- **Duplicated sessions keep child callbacks in the duplicate across engines.** Claude/Opus, Codex, Hermes, and Pi resumed turns now get the current Jinn session metadata in the positional prompt as a compact platform refresh, so delegated child sessions use the duplicate's session id as their parent instead of stale ids copied from the original transcript.

## [0.23.4] - 2026-07-06

### 🐛 Fixes
- **Duplicated Hermes sessions keep callbacks in the duplicate.** Resumed Hermes turns now receive a compact, authoritative Jinn platform context refresh with the current session id and gateway config, so a forked/duplicated session that delegates to an employee uses the duplicate as the child parent instead of stale ids copied from the original transcript.

## [0.23.3] - 2026-06-25

### 🐛 Fixes
- **Completed chats refresh from the final transcript.** Returning to a long-running session now replaces cached mid-turn progress and tool rows with the gateway's completed history instead of requiring a browser refresh.
- **New-chat sends stay visually continuous.** The optimistic first user message now survives the newly-created session hydration handoff, removing the brief loading flash after pressing send.
- **Chat header fade no longer covers message text.** The title keeps its soft scrim while the message list starts below the fade, balancing title legibility with readable chat content.

## [0.23.2] - 2026-06-25

### ⚡ Performance
- **Chat switching feels instant for recently opened sessions.** The web UI now reuses a bounded in-memory session snapshot cache so already-opened chats render immediately while still revalidating from the gateway, with automatic cleanup to avoid unbounded growth.

### 🐛 Fixes
- **Route navigation no longer blanks the app on stale or transient chunks.** Lazy route loads now show a lightweight spinner, retry once with a refresh on recoverable chunk failures, and fall back to a refresh prompt instead of leaving an empty page.
- **New-chat engine switching opens the real new-chat flow.** The existing-chat engine picker now routes to the employee picker instead of a blank starter surface, and cold chat switches show a loading spinner instead of flashing the new-chat template.

## [0.23.1] - 2026-06-25

### 🐛 Fixes
- **Completed chat turns collapse live noise immediately.** Chat Mode now removes mid-turn progress, tool rows, and task-list blocks from the visible transcript as soon as the turn completes, matching the cleaned final history without requiring a page refresh.

## [0.23.0] - 2026-06-25

> Chat Mode gets a lean structured activity layer while keeping durable history clean.

### ✨ Features
- **Lean Chat Mode BlockKit.** Chat sessions can now render validated structured task-list blocks from engine streams, with refresh-safe partial persistence during active turns and scoped block ids so later turns cannot rewrite older transcript rows.
- **Compact tool-call history UI.** Tool activity now groups into quiet, expandable inline rows instead of noisy side panels or speculative cards, keeping the chat transcript minimal while still making tool activity inspectable.

### 🐛 Fixes
- **Final chat history stays final.** Mid-turn text/tool rows are refresh-only again: after a turn completes, SQLite history collapses to the final assistant message instead of preserving every streamed tool call and partial text block.
- **Remote access pairing polish.** The pairing flow accordion now toggles correctly, avoiding a stuck expanded/collapsed state during browser pairing.
- **Employee session defaults.** New employee sessions now honor the configured default engine/model/effort instead of drifting from the selected employee defaults.
- **Engine streaming correctness.** Codex adjacent text blocks are separated without corrupting the final result, Grok transcript tests are race-hardened, and active Claude subagent StopFailure handling no longer reports premature turn failures.

## [0.22.0] - 2026-06-23

> Hermes joins the engine lineup, and the README is rebuilt to actually sell what Jinn is.

### ✨ Features
- **Hermes engine (NousResearch).** Jinn now drives the `hermes` CLI as a first-class, version- and path-agnostic engine with real token streaming. Chat Mode runs a warm per-session `hermes acp` process over the Agent Client Protocol (ndjson JSON-RPC), with live model discovery, resume, and full auto-approve; CLI Mode exposes the `hermes` TUI as a live terminal view. Like every engine, it appears only when its binary is on your `PATH`. Hermes is metered (pay-per-token on the provider configured in `~/.hermes`); see `docs/engines-hermes.md`.

### 🪄 Docs
- **Value-first README.** Rewritten to lead with what Jinn is and does — an orchestration layer that runs any agent CLI as a company of AI employees — with a corrected quickstart, an all-six-engines table, a persona example, and fresh dashboard screenshots (org map, kanban, chat). Removed the competitor comparison in favor of the value story.

## [0.21.3] - 2026-06-22

### 🐛 Fixes
- **Existing operators no longer get the onboarding prompt re-injected.** Configs that completed the setup wizard (`portal.onboarded`) are now treated as setup-complete, so the gateway stops emitting the onboarding directive and the setup-status API reports `setupComplete`/`conversationNeeded` correctly for legacy installs.

## [0.21.2] - 2026-06-22

### 🐛 Fixes
- **Connector-backed replies no longer hang after Homebrew/npm installs.** The npm publish manifest now includes `assets/hook-relay.mjs`, so gateway boot can restore `~/.jinn/hook-relay.mjs` and Claude Stop hooks can report completed Slack/Discord/Telegram turns.

## [0.20.0] - 2026-06-11

> Talk becomes a real delegation workspace: searchable session memory, server-owned delegation graphs, persistent conversation flow, and live work rails. The gateway also gets a stability pass for interactive engines, stuck-session recovery, restart safety, and context telemetry.

### ✨ Features
- **Talk delegation workspace.** Server-owned `POST /api/talk/delegate`, live `TalkGraph` snapshots/deltas, persisted prompt excerpts, attach/detach controls, session search, inline cards, and a WorkDock/work-tree that can follow nested employee sessions at any depth.
- **Conversation-first Talk UI.** Persistent transcript, pinned decision cards, focused stage modes, thread drawer breadcrumbs, real delegation hierarchy, live activity lines, completion excerpts, and a calmer orb/stage layout that keeps the conversation visible while work happens.
- **Talk voice flow upgrades.** Per-sentence TTS streaming removes whole-turn dead air, speech is sanitized server-side for URLs/UUIDs/machine tags, and the orchestrator persona now favors delegation-first behavior with search and attachment awareness.
- **Message search.** Sessions now have FTS5 full-text search over messages with chunked backfill and a fail-safe degrade path so search failures never take down the gateway.

### ⚡ Performance / Reliability
- **Interactive engine stability.** Shared PTY stream/tailer infrastructure, bounded stream maps, StopFailure grace windows, late-Stop recovery, Codex terminal-marker gating, and retry-aware SSE activity tracking reduce false failed turns and leaked process state.
- **Gateway resilience.** Status reconciliation unsticks stale `running` sessions, restart keeps the PID file until the process actually exits, config/job writes are atomic, cron reads are tail-based, connector stop intervals are cleaned up, and queue/session deletes purge related work items.
- **Context hygiene.** Employee prompts now use audience-scoped context, compact org rosters, deduped API references, cleaner chain-of-command slugs, and less repeated template text.

### 🐛 Fixes
- **Chat session state and context telemetry.** Background-agent indicators now reflect live engine activity, external CLI turns sync into the web session, the SSE idle window is 60 minutes, and Codex context meters use current-turn token telemetry instead of cumulative totals.
- **Claude onboarding hangs.** Trust seeding now also marks Claude Code's global onboarding and Claude-in-Chrome onboarding complete, preventing first-run interactive prompts from blocking gateway-launched Claude sessions.
- **Talk correctness.** Delegation cards survive reload, thread cards honor session renames and status vocabulary, stale notifications are preserved on rehydrate, label-based wake messages avoid leaking session ids, and card/thread accessibility edge cases were tightened.
- **Session/search safety.** FTS backfill failures disable search for the process instead of blocking boot; rate-limit retries preserve transport metadata; media messages survive reconcile age caps; and loopback checks/config writes are normalized.

### 🪄 Docs
- Added Talk redesign specs, implementation plans, and post-review notes for the delegation graph, stage layout, and conversation-first UI work.

## [0.19.0] - 2026-06-09

> Talk grows up: a calmer voice-first surface, a configurable orchestrator engine with seamless fallback (so Talk works on Codex/Antigravity, not just Claude), in-app mic setup, type-to-talk, and a silent/read mode. Plus a fresh-install hardening pass, org-map improvements, and a repository privacy scrub.

### ✨ Features
- **Talk — quieter, more usable voice surface.** The screen was reworked so the AURA orb dominates: collapsed/icon-only thread panel, one-word status, focused-only channel labels, a throttled level meter, and a Stop-speaking button. The orchestrator persona was rewritten ~50% leaner and voice-first.
- **Talk — configurable orchestrator engine + seamless fallback.** The voice orchestrator is no longer hardcoded to Claude. New `config.talk.engine` plus a resolver chain (`talk.engine → default engine → first available`) means a user with only **Codex** or only **Antigravity** gets a working Talk out of the box. A tucked-away gear picker switches engine + model live (applies next turn).
- **Talk — type-to-talk.** A keyboard toggle reveals a text input that routes through the same path as a voice turn — usable when you can't speak or the mic isn't set up. The main button is action-aware, morphing **Mic ↔ Send ↔ Stop**.
- **Talk — mute / silent-read mode.** Suppresses speech (both neural and browser fallback) and skips server-side synthesis entirely when muted; replies are read in the transcript. Persisted across reloads.
- **Talk — in-app mic setup.** Tapping the mic on a fresh install now opens the shared Whisper-model download flow (reused from chat) instead of dead-ending; `jinn setup` checks for `whisper-cli` + `ffmpeg` and prints install guidance.
- **Talk — focused card model.** The voice surface now shows only actionable/watchable cards (approval, choice, status, agent-activity, plus a rare text valve); richer card types are reserved for chat.
- **Org map.** Map-only `/org` view with a compact d3-hierarchy layout, an inline employee editor in the detail panel, a full employee-update API (`PATCH /api/org/employees/:name`), and chat deep-links to contactable roster employees.

### ⚡ Performance / Reliability
- **Kokoro neural TTS hardening.** The voice sidecar now recovers automatically if its Python venv is invalidated by a base-Python upgrade (a broken interpreter symlink is treated as "rebuild needed"), so neural voice doesn't silently degrade to the robotic browser fallback.

### 🐛 Fixes
- **Duplicate works for `.jinn` sessions** — the fork slug now handles `.` in the working-directory path.
- **Fresh-install hardening** — a missing/unauthenticated engine is surfaced clearly instead of failing silently; engine binary resolution is unified across Claude/Codex (thin-PATH safe); the onboarding rename is fixed; config reload is instant; the browser opens on first start; the seeded config now includes the MCP block.
- **Connector reply delivery** when a web-session turn completes; **Codex fallback** guarded on the engine actually being installed; **mid-turn stream blocks** persist so a refresh restores them; child turn text is recovered from the transcript when the Stop hook is lost.

### 🔒 Privacy
- **Repository privacy scrub.** Removed maintainer/third-party personal data that had been committed into shipped source (notably the default Talk persona), genericized examples, and **stopped shipping test files in the npm tarball**. The default persona and templates are now fully generic; anything personal lives only in a user's local `~/.jinn`.

## [0.18.1] - 2026-06-08

### 🐛 Fixes
- **Chat alignment.** The in-progress **"Thinking" indicator** now shares the same gutter as message text and tool cards (it was inset ~16px to the left). Completes the tool-card alignment from 0.18.0.
- **Mobile composer strip.** The Engine · Model · Effort · context selector row no longer wraps on phones (a grid spacer was stealing half the row, pushing "Opus 4.8" onto two lines). It's now mobile-first single-line with non-wrapping pills that scroll if needed, and the "· applies next message" hint is hidden on mobile (kept on desktop).

## [0.18.0] - 2026-06-04

> Big release: the voice-first **Talk** interface, the **Antigravity** engine (replacing Gemini CLI), a dynamic model registry with mid-chat switching, a race-free `jinn restart`, the **Ledger** web theme, and WebSocket reliability work.

### ✨ Features
- **Talk - voice-first COO interface at `/talk`.** A hands-on voice layer over the COO: the AURA avatar (state-reactive orb with channel-morphing), client-side Web Speech TTS with per-sentence playback and a sentence-synced transcript, and **decision-support cards** pushed over a dedicated card-action channel. A **thread panel** lets you see, switch, label, and dismiss child sessions by voice, and open any child session in a chat modal (from a thread chip or satellite orb). Voice state persists across route-switch, reload, and backgrounding; persona hot-reloads; iOS Web Speech is unlocked on first gesture.
- **Antigravity (`agy`) engine** - Google Antigravity replaces the removed Gemini slot as a PTY-interactive engine. agy has no headless/`--print` mode and no hook system, so turns are driven through a PTY (one instance both runs turns and backs the xterm view) and completion is detected by tailing agy's per-conversation transcript (`~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl`) for a `MODEL/PLANNER_RESPONSE/status:DONE` line. The conversation id becomes the engine session id; resume uses `agy --conversation <id>`. The binary is resolved **dynamically** (PATH + common dirs incl. `~/.local/bin`, optional `engines.antigravity.bin` override) - no hardcoded paths. Workspace trust is pre-seeded by realpath before spawn so the interactive trust gate never blocks; the cached Google credential is reused (no re-auth). Default model Gemini 3 Flash (agy ignores model flags today; `/model` injection deferred). Verified end-to-end against agy v1.0.x (May 2026).
- **Dynamic model + capability registry** - `models:` block in `config.yaml` (per-model `{id,label,supportsEffort,effortLevels}`, per-engine `effortMechanism`) is the single source of truth for which engines/models exist and what they support. New `GET /api/engines` exposes the resolved registry. When the block is absent it's **synthesized** from `engines.<name>.model`, so existing configs keep working. **Adding a new model is a config edit - zero code change.** Cache invalidates on config reload and `PUT /api/config`.
- **Mid-chat model & effort switching** - `PUT|PATCH /api/sessions/:id` accepts `{ model?, effortLevel? }`, validated against the registry for the session's engine, and applies **from the next turn** (in place - a resume spike confirmed `claude -p --resume --model <new>` honors the new model while preserving history, so no fork is needed). Engine is **new-chat-only** (not mutable mid-chat). Antigravity model changes persist but are a logged runtime no-op (agy ignores model flags).
- **Web composer selector row** - a compact **Engine · Model · Effort** pill row above the chat input, fully registry-driven (no hardcoded lists). Engine is editable on a new chat / read-only chip in an existing chat; Model + Effort editable in both; Effort is filtered to the model's levels and hidden for effort-less engines (antigravity). Pre-fills from the chosen employee's config (new chat) or the loaded session; in-chat changes PATCH the session with an "applies to next message" note. Settings-page model/effort dropdowns are now registry-driven too (kills stale `opus-4-6` labels).
- **`jinn restart` - detached, in-session-safe restart.** A new command that performs stop -> wait-for-port-free -> start from a reparented helper process, so it survives the gateway killing its own session PTYs (the reason a naive `stop && start` from inside a session used to leave the gateway down). `jinn start` now also auto-restarts cleanly when a gateway is already running, instead of racing the old one's shutdown into `EADDRINUSE`.
- **Ledger web theme** - the dashboard's production look: a Dock x Ledger layout in light and dark, fully tokenized colors, and a full-width document-style chat transcript.

### ⚡ Performance / Reliability
- **WebSocket resilience.** Gateway ping/pong heartbeat reaps half-open sockets; the web client reconnects with backoff plus a watchdog and resume listeners; the CLI terminal reconnects without disposing xterm; chat backfills on active turns; and loaded session pages are preserved across refetches.

### 🐛 Fixes / Changed
- **Interrupted sessions resume cleanly on reconnect.** After a gateway restart the web chat now reloads the interrupted session on WS reconnect and clears the stuck loading spinner, so the conversation is immediately usable instead of frozen until the next message.
- **Effort validation is registry-driven** - replaced the hardcoded `VALID_EFFORTS` set with per-engine+model `effortLevels` from the registry. This fixes the silent **`xhigh` rejection** for codex (now valid and passed through). Unknown/unsupported levels are dropped with a logged warning (graceful degradation), never a silent pass or a throw; effort-less engines default cleanly with no noise.
- **Talk polish** - the chat modal no longer hangs on a load failure; dismissed threads stay dismissed; `stripMarkdown` no longer mangles spoken code/math/URLs; the card validator fails closed on nested fields and is wrapped in an error boundary.
- **Streaming + proxy** - restored live streaming and persona injection via `--append-system-prompt`; the proxy retries corrupted-TLS-socket errors (bad record mac / decrypt error / EPROTO).
- **Tool cards** align their left edge with the message text column.

### 💥 Removed / Not supported
- **Removed the Gemini CLI engine.** Google is sunsetting Gemini CLI for individual/free and AI Pro/Ultra users on **2026-06-18**, directing them to Antigravity. The `gemini` engine option (`engines.gemini`, `engine: gemini`) is gone. **Gemini *API* usage is unaffected** - `GEMINI_API_KEY` features (deep-research, nano-banana) still work. Historical migration notes left intact.
- **Fast mode is explicitly NOT supported** (any engine). The real `claude` CLI has no `--fast` flag - `/fast` is an interactive, stateful TUI toggle (resets on model switch, org-disablable) with no headless/flag equivalent, and Jinn runs turns headless. Rather than carry dead infra, the concept was dropped end-to-end (no `supportsFast` in the registry, no UI control).

### 🪄 Docs
- README overhaul: Antigravity replaces Gemini throughout, the web stack is corrected to Vite (`:5173`), new features are documented (file attachments, in-app file viewer, per-session engine/model/effort, live context meter, `jinn restart`), and the obsolete `engines.claude.mode` headless opt-out was removed. Em dashes purged across all Markdown (except version-pinned migration records).

## [0.17.1] - 2026-05-31

### 🐛 Fixes
- **Slack reaction approvals work again on older messages.** The `reaction_added` handler gated on the *reacted-to message's* age via `ignoreOldMessagesOnBoot`, so any reaction on a message posted before the gateway's last boot was silently dropped. This broke human-in-the-loop approval flows where a card waits hours for a ✅ (and every gateway restart made all pending cards un-reactable). The boot-replay guard now checks the **reaction event's own `event_ts`**, so a fresh reaction on an old message is always honored while genuinely replayed-on-boot reactions are still skipped.
- **Instant `:eyes:` ack on reactions.** The connector now adds an `:eyes:` reaction the moment it accepts a user reaction, giving immediate visual confirmation the gateway heard it.

## [0.17.0] - 2026-05-31

### ✨ Features
- **Clickable file paths → in-app file viewer.** File paths mentioned in chat messages (e.g. `docs/superpowers/specs/2026-05-31-platform-support-design.md`) are now auto-detected and rendered as links - including the common case where agents wrap them in backticks. Clicking opens the file as a new **in-app tab** (the same VS Code-style tab bar as chats, labelled with the basename), rendering markdown via `react-markdown` + `remark-gfm` and code with Prism syntax highlighting. Lets you read any referenced artifact without leaving the dashboard - ideal over Tailscale where the file isn't directly reachable.
- **Standalone `/file?path=` route** - the same viewer as a full page, for opening files in a real browser tab (a subtle ⧉ button inside the in-app viewer pops it out) and for direct/remote access.
- **File-read endpoint** `GET /api/files/read?path=` - reads any file on disk (single-user/Tailscale threat model, no allowlist) with a 5 MB size cap and binary detection. Relative paths resolve `~/.jinn` first, then `~/Projects`, then gateway cwd, then literal; absolute/`~` paths used verbatim.
- **Mobile back button** in the embedded viewer that returns to the chat the link was opened from; sticky frosted control chips (back + pop-out) that stay reachable while scrolling.

### 🐛 Fixes
- File-viewer content wraps to the available width - no more horizontal scrollbar on long code lines or unbroken tokens (prose wraps, code blocks contain their own overflow).

## [0.16.1] - 2026-05-30

### 🐛 Fixes
- **User messages with attachments no longer render twice.** The v0.16.0 outbound-vanishing fix deduped reconciled history by message id only. A sent user message is appended optimistically with a client-side random id while the server persists it under a different canonical id, so on the next history refresh the optimistic copy was kept *alongside* the server copy - duplicating the whole message (text + every image/video). `reconcileMessages` now also matches on a content-identity key (role + content + media filenames, media-type-agnostic so videos work), collapsing the optimistic message into its server twin while still preserving genuinely-live agent attachments missing from a racing snapshot.

## [0.16.0] - 2026-05-30

### ✨ Features
- **File & image attachments in the web chat, both directions.** Attach any file type (images, PDFs, zip, docs, anything) from the composer via drag-drop, click, or paste - the bytes are stored locally under `~/.jinn/uploads/YYYY-MM-DD/<sessionId>/` and **only the file path** is injected into the engine prompt, so Claude/Codex/Gemini read it with their own tools instead of being fed raw bytes. First-message uploads are re-homed into the session bucket once it's created (no orphans).
- **Outbound attachments API** - a running session can push files/images back **into** the chat via `POST /api/sessions/:id/attachments` (accepts `multipart`, or JSON `{path|content|url}`), exactly like agents already curl `POST /api/sessions` to spawn children. Renders in the web chat view (documented limitation: the raw CLI/xterm stream can't render inline). Messages now persist a `media` column.
- **Rich file UX** - images render as inline thumbnails that open a full-screen lightbox (Esc/click to close, with download); non-image files render as download chips with name + size; multiple files in one message are handled without clobbering. Image loading uses a skeleton shimmer that cross-fades to the image (no layout shift) with a graceful broken-image fallback.

### ⚡ Performance
- **Immutable browser caching for file responses** - `GET /api/files/:id` now sends `Cache-Control: public, max-age=31536000, immutable` plus a strong `ETag` and `Last-Modified`, and answers conditional `If-None-Match`/`If-Modified-Since` requests with `304 Not Modified`. Re-opening a chat no longer re-downloads every image - a big win on slow connections.

### 🐛 Fixes
- **Pushed attachments no longer vanish from the chat** - the `session:completed` handler was popping the last assistant bubble (to swap the optimistic streaming text), which also ate a freshly-pushed attachment message until a page reload. It now never pops a message carrying `media`, uses the server's canonical message id, and merges (rather than replaces) on history refresh so the attachment shows exactly once.

## [0.15.1] - 2026-05-22

### 🐛 Fixes
- **`jinn --version` reported the wrong version** - the CLI reads its version from `dist/package.json` (emitted by tsc from the `import pkg from "../package.json"` in `bin/jinn.ts`). v0.15.0 was published with a stale `dist/` built before the version bump, so it reported `0.14.0` and the Homebrew formula's `--version` test would mismatch. Rebuilt after the bump; `dist/package.json` and `jinn --version` now match the package version.

## [0.15.0] - 2026-05-22

### ♻️ Refactor
- **Kill the legacy naming soup** - the repo, home dir, npm package, and binary all converged on **jinn**, but the project folder (`~/Projects/<legacy-name>`) and the inner package (`packages/<legacy-name>`) were the lone holdouts. Renamed the project root to `~/Projects/jinn`, `packages/<legacy-name>` → `packages/jinn`, and the CLI entry `bin/<legacy-name>.ts` → `bin/jinn.ts`. The published npm package (`jinn-cli`), the `jinn` binary, and the `~/.jinn` workspace are unchanged - no action needed for existing installs. All workspace/build/Formula/workflow/release-skill path references updated to match.

## [0.14.0] - 2026-05-21

### ✨ Features
- **Telegram voice/audio transcription** (#59) - `voice`, `audio`, and `video_note` messages are transcribed through the bundled `stt/stt.ts` (whisper.cpp) before reaching the engine, fixing the empty-`text` session-resume crash. Multi-language config → `auto`; concurrent voice notes are serialized to avoid OOM on small hosts, with a one-line "queued" ack. If STT is unavailable/empty, the message is dropped with a user-facing explanation instead of forwarding empty text.
- **Telegram file attachments** (#60) - documents, photos, videos, animations, and stickers are downloaded and surfaced via `msg.attachments` (UUID-named in `TMP_DIR` to avoid collisions), so the engine actually receives files instead of silently dropping them. `video_note` is routed to transcription (above), not attached, to avoid double-handling.

## [0.13.3] - 2026-05-20

### ✨ Features
- **Child-reply notification banner is back in the web UI** - when an employee (child) session replies, the parent session's chat shows a centered system banner again (live via the `session:notification` WS event, and on history reload). It was removed by the v0.13.0 "nuke notifications" cleanup along with the bell.

### 🪄 Polish
- **Dual-audience callback messages** - the child-reply notification is now decoupled: the parent **engine** (e.g. the COO) receives a full-context message with the child session id and API pointers to follow up, while the **web UI** shows a clean, simplified banner (`📩 <employee> replied` + a tidy preview) instead of the old noisy `GET /api/sessions/…?last=N` / `Preview:` blob. The gateway persists + emits the clean version for display and runs the engine on the full one.

## [0.13.2] - 2026-05-20

### 🪄 Docs
- **Align delegation guidance with restored callbacks** - the `template/CLAUDE.md`, `template/AGENTS.md`, and the runtime-injected delegation protocol (`context.ts`) disagreed about whether the gateway notifies a parent session: the templates still said "auto-notify, never poll" while `context.ts` (post-nuke) said "no callback, poll." Now that v0.13.1 restored the callback, all three describe the same **hybrid** model: the gateway wakes you on a child reply, with polling as a fallback so a missed callback never leaves a parent idle.

## [0.13.1] - 2026-05-20

### 🐛 Fixes
- **Restore parent-session callbacks** - the "nuke notifications" cleanup (v0.13.0) was meant to remove only the web notification bell, but it also stripped the backend mechanism that wakes a parent session when a child session replies. Child/employee sessions were finishing without ever notifying their parent/COO session, so delegated work returned silently and had to be polled for manually. Restores `notifyParentSession` and the `role:"notification"` message path (including the "don't interrupt a running parent turn" guard), `Employee.alwaysNotify`, `JinnConfig.notifications`, and the `PATCH /api/org/employees/:name` endpoint. The web bell UI stays removed.

## [0.11.0] - 2026-05-18

### ✨ Features
- **Interactive Claude engine** - every Claude turn (cron, connectors, web Chat, web CLI) now runs the real interactive `claude` TUI inside a node-pty pseudo-terminal. Bills as `cc_entrypoint=cli`, preserving Max subscription past Anthropic's June 15, 2026 cutoff that ends `claude -p` subsidy.
- **Hook-driven turn boundaries** - per-session `--settings` file registers Claude Code's SessionStart/Stop/StopFailure/PreToolUse/PostToolUse hooks; a tiny `hook-relay.mjs` POSTs each event back to the daemon over loopback so turn lifecycle is detected without screen-scraping.
- **Per-session KEEP ALIVE control** - toggle in web UI decides whether a PTY survives across turns (snappy follow-ups, warm context) or is reaped after the grace window. Orphan PTYs reaped on daemon restart.
- **Web Chat ↔ CLI toggle per session** - `xterm.js` view of the live PTY (CLI mode) or parsed delta stream (Chat mode), persisted per session. One process, one billing event for either view.
- **Recently-viewed chat keep-alive cache** - chats stay mounted in the web UI for instant switching.
- **GatewayProvider consolidation** - single WebSocket replaces 5–7 per page in the web UI.

### ⚡ Performance
- **8–20s daemon GET latency → <100ms** during active turns. Root causes fixed:
  - Ring-buffer PTY scrollback (was O(N) string realloc per data chunk → O(1) chunk-list ring)
  - Transcript backfill made async + transactional (was sync `readFileSync` + N inserts per GET)
  - Async transcript tail with long-lived `FileHandle` (was sync `statSync`+`openSync`+`readSync` per file-watch event)
- **Web event-storm fix** - `events` array narrowed to frames consumers actually filter on; high-frequency consumers migrated to direct `subscribe()` callbacks.
- **rAF-coalesced xterm window resize**, `hasOutput` short-circuit, static-import for hook endpoint.

### 🐛 Fixes
- **Tab status no longer goes stale** - chat tabs subscribe to session lifecycle events; blue "in progress" dot clears on completion and survives reload.
- **No more title flash on tab click** - `sessionMeta` now tagged with its owning sessionId; effect refuses to write stale meta onto the newly-selected tab.
- **Orphan tabs after sidebar delete** - `session:deleted` events now close matching tabs.
- **Reconcile persisted tabs on load** - drops orphans, normalizes stale `running` status against authoritative server state.
- **Rate-limit wait cancels on user stop** - was only catching `"error"` status, missed the `"idle"` user-initiated stop case.
- **Heartbeat clears after session delete** - no more `status:"running"` writes against deleted rows.
- **Hook endpoint hardening** - loopback check moved ahead of body read, 64 KB body cap, `crypto.timingSafeEqual` secret comparison, empty-secret bypass guard.
- **File-mode 0o600 on `gateway.json`, `--settings`, and `~/.claude.json`** - hook secret no longer world-readable on shared machines.
- **HookRegistry buffer GC** - periodic sweep evicts entries whose TTL expired; closes long-running memory leak.
- **`streams` map cleanup on PTY exit**, **kill-mid-paste race closed** (`turnStarted` before `injectPrompt`), **PTY-reset control frame** sent to xterm on respawn, **async-tailer fd nulled on read error**.

### 🪄 Docs
- New README section: **"How the Claude engine works under the hood"** - PTY, hooks, transcript tail, KEEP ALIVE, Chat/CLI duality, and why we moved off `claude -p` before the subscription cutoff.

## [0.10.0] - 2026-04-28

### ✨ Features
- **Full Telegram connector** - web UI configuration, employee routing, typing indicators, media support
- **`/models` command + Opus 4.7 support** in Telegram (#50)
- **Cron job latency alerting** - Slack warning when scheduled jobs exceed threshold

### 🐛 Fixes
- **Slack `app_mention` handler** - bot now responds to `@Bot` mentions in channels; root channel messages without mention are correctly ignored (#46, thanks @lisovet)
- **`crypto.randomUUID` polyfill** - web UI no longer crashes when accessed over plain HTTP on LAN/Tailscale (#47, thanks @lisovet)
- **`body.model` honored** in `POST /api/sessions` and `/stub` - per-employee model routing now works for MCP and API clients (#45, thanks @papajade55-debug, closes #38)
- **Slack unfurl crash** - skip unfurl events that crashed the Claude engine (#44, thanks @MarockNRoll)

## [0.7.0] - 2026-03-19

### ✨ Features - Project Phoenix
- **Chat tabs** - Cmd+W close, Cmd+Shift+[/] switch, draft persistence, status indicators
- **Command palette** - cmdk-powered Cmd+K with actions, recents, sessions, skills search
- **Breadcrumb navigation** - context-aware breadcrumbs on all pages
- **ChatPane extraction** - reusable chat component decoupled from page
- **Enhanced sidebar** - expandable employee groups, pin/unpin, context menu, hover actions
- **React Query data layer** - query key factory, hooks for all resources, WS→cache invalidation bridge

### 🔧 Improvements
- **Tailwind migration** - 640→120 inline styles (81% reduction), shadcn token system
- **Header consolidation** - single 40px tab bar replaces 3 stacked headers on chat
- **Mobile UX** - more menu in top header, clean tab bar, responsive sidebar
- **Session state sync** - tabs and selected session stay in sync
- **Instant tab switching** - no scroll flash, useLayoutEffect for immediate scroll

### 🏗️ Infrastructure
- Goals CRUD API + SQLite table (backend, for future use)
- Cost aggregation API + budget enforcement system
- Mock engine for E2E tests
- Vitest setup (api + web), Playwright config, GitHub Actions CI workflow

### 🧹 Cleanup
- Removed: split view, goals/costs pages (no backend yet), 14 unused shadcn components
- Fixed: dual-fetch anti-pattern in sidebar, session delete via mutations
- Net: 81 files changed, +5,608 / -8,723 lines

## [0.3.0] - 2026-03-10

### 🔧 Improvements
- Codex engine now runs with `--dangerously-bypass-approvals-and-sandbox` - prevents Jinn-managed Codex sessions from being constrained by CLI sandbox/approval defaults

## [0.2.0] - 2026-03-10

### ✨ Features
- Connector abstraction layer - connectors declare capabilities (threading, reactions, edits, attachments) and health status
- `replyMessage()` vs `sendMessage()` split - proper thread-aware message routing
- CronConnector - cron jobs are now message sources routed through SessionManager (unified flow)
- Slack config options - `shareSessionInChannel`, `allowFrom` whitelist, `ignoreOldMessagesOnBoot`
- Transport state tracking - new `transportState` field + queue depth visibility
- In-chat slash commands - `/cron list|run|enable|disable`, `/model <name>`, `/doctor`
- Runtime cron control - trigger/enable/disable jobs without restart
- Web UI: Slack settings toggles for new config options
- Web UI: Transport visibility - connector name, queue depth, transport state badges

### 🔧 Improvements
- Unified message routing - all sources flow through `SessionManager.route()` with uniform `IncomingMessage`
- Cron runner simplified - ~35% code reduction by delegating to SessionManager
- Capability-aware decorations - reactions/edits conditional on connector capabilities
- Config token masking - Slack tokens masked in `GET /api/config`
- Session queue monitoring - `getPendingCount()` and `getTransportState()`

### 🏗️ Infrastructure
- Build pipeline - web UI bundled into gateway dist
- Test suite - threads, queue, and registry tests using Node.js native test runner
- DB migration - auto-adds connector/transport columns, backfills from legacy fields

### 💥 Breaking Changes
- `Connector` interface expanded with new required methods: `replyMessage()`, `getCapabilities()`, `getHealth()`, `reconstructTarget()`
- `IncomingMessage` and `Session` types have new required fields
- `GET /api/connectors` response shape changed from `string[]` to objects with capabilities
- `startScheduler()` now takes `SessionManager` instead of engine map
- `sendMessage()` no longer posts to threads - use `replyMessage()`

## [0.1.1] - 2026-03-09

### 🐛 Bug Fixes
- Remove `@jinn/web` workspace dependency from published package - was causing `unsupported URL type "workspace:"` error on `npm i -g jinn-cli` (web UI is embedded as static files during build, not a runtime dependency)

### 🔧 Improvements
- Claude engine now runs with `--dangerously-skip-permissions` - prevents sessions from hanging on tool approval prompts in headless mode

## [0.1.0] - 2026-03-09

First release of the Jinn AI gateway platform.

### ✨ Core Platform
- Gateway server with HTTP REST API + WebSocket real-time events
- Session manager with context builder (32K char budget, progressive trimming)
- SQLite session registry with WAL mode
- Per-session serial execution queue
- File watchers for hot-reload (config, cron, org, skills)
- Daemon lifecycle management (start/stop/status as background process)
- Multi-instance support with dynamic home directory resolution

### ✨ Engines
- Claude Code CLI engine wrapper (spawn, JSON streaming, session resume)
- Codex SDK engine wrapper (in-process, streaming)
- Model/effort level passthrough and configuration

### ✨ CLI
- `jinn setup` - bootstrap ~/.jinn/ from templates
- `jinn start` / `stop` / `status` - daemon management
- `jinn create` / `list` / `remove` - instance management
- `jinn nuke` - permanent instance deletion with safety prompts
- `jinn migrate` - AI-assisted template migrations
- `jinn skills` - skill discovery + skills.sh integration
- `--port` flag for custom port binding

### ✨ Connectors
- Slack connector (Socket Mode via @slack/bolt)
- Thread/DM/channel source-ref mapping
- Reaction workflow (👀 → ✅/❌)
- Message splitting for long responses
- Attachment download support

### ✨ Organization System
- Employee personas (YAML) with departments, ranks, engine assignment
- Org scanner with @mention routing
- Department boards for inter-agent task tracking
- Rich employee identity + generic connector context
- Dynamic COO naming via onboarding

### ✨ Skills System
- Markdown-based skill playbooks (SKILL.md with YAML frontmatter)
- 10 built-in skills: management, cron-manager, skill-creator, self-heal, onboarding, migrate, sync, status, new, find-and-install
- Skill symlink syncing to .claude/skills/ and .agents/skills/
- skills.sh marketplace integration
- Skills directory watcher with WebSocket change events

### ✨ Cron System
- node-cron scheduler with hot-reloadable jobs.json
- Run logging to JSONL files
- Delegation pattern (cron → COO → employee → review → deliver)
- Optional delivery to connectors

### ✨ Web UI
- Full Next.js 15 static dashboard
- Chat interface with voice recording, file attachments, rich markdown
- Session browser with detail view
- Org map (React Flow) with grid/feed views + employee detail panels
- Kanban board with drag-drop, tickets, employee assignment
- Cron visualizations - weekly schedule heatmap, pipeline grid
- Cost dashboard with charts, anomaly detection, WoW comparison
- Activity console with log browser + floating live stream widget
- Global search (Cmd+K)
- Settings page + onboarding wizard
- 5-theme CSS system with accent color support
- shadcn/ui components

### ✨ Session Context
- Rich context injection (identity, CLAUDE.md, config, org, skills, cron, connectors, API reference)
- Local environment awareness
- Lazy onboarding (stub session)

### 🏗️ Infrastructure
- pnpm + Turborepo monorepo
- TypeScript throughout
- Web UI bundled into CLI package
- CI workflow (GitHub Actions)
- README, CONTRIBUTING guide, LICENSE
