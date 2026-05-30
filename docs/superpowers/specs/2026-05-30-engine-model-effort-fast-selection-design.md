# Engine / Model / Effort / Fast Selection — Investigation + Plan

**Date:** 2026-05-30
**Author:** Jinn Dev
**Status:** Investigation + plan only (no code changed)
**Repo:** `~/Projects/jinn` (gateway daemon + CLI in `packages/jinn`, web dashboard in `packages/web`)

---

## 1. Current architecture summary (selection flow)

### Data model — what exists today

| Concept | Config (`config.yaml`) | API `POST /api/sessions` | DB (sessions) | Engine spawn flag | Mid-chat change |
|---|---|---|---|---|---|
| **Engine** | `engines.default: claude` | `body.engine` | `sessions.engine` | (selects adapter) | ❌ fixed at creation |
| **Model** | `engines.<eng>.model` | `body.model` | `sessions.model` | `--model <m>` | ✅ via `sessionManager.route` (`manager.ts:169`) |
| **Effort** | `engines.<eng>.effortLevel` | `body.effortLevel` | `sessions.effort_level` | Claude `--effort`; Codex `-c model_reasoning_effort="…"` | ❌ fixed at creation |
| **Fast** | — | — | — | — | ❌ **does not exist anywhere** |

### Selection flow (UI → API → spawn)
- **New session:** `POST /api/sessions` handler at `packages/jinn/src/gateway/api.ts:762-832`. Accepts `engine` (default `config.engines.default`, `api.ts:770`), `model` (`:787`), `employee` (`:779`), `effortLevel` (`:781`). Persisted via `createSession` into the SQLite registry (`sessions/registry.ts:12-31`; `effort_level` column added by migration at `:169`).
- **Engine resolution priority:** `body.engine` → `employee.engine` → `config.engines.default` (`manager.ts:145`).
- **Model resolution:** `body.model` → `session.model ?? engineConfig.model` (`api.ts:2010`) → cron `job.model || employee?.model || config.engines[eng].model` (`cron/runner.ts:67`).
- **Effort resolution:** `shared/effort.ts:17-49`. For child sessions: `childEffortOverride` → `session.effortLevel` → `employee.effortLevel` → `engine.effortLevel`. For top-level sessions: engine config directly. Fallback `"medium"`. `VALID_EFFORTS = {low, medium, high}` (`effort.ts:4`).
- **Spawn (Claude):** `engines/claude.ts:83-84` and `engines/claude-interactive.ts:99` push `--model` and `--effort`.
- **Spawn (Codex):** `engines/codex.ts:206-226` push `--model` and `-c model_reasoning_effort="<level>"`.

### Web UI state today
- Framework confirmed: Next.js 15 App Router, Radix + shadcn (`components/ui/`), Tailwind 4, React 19, TanStack Query. No global store — React hooks only.
- **Chat view:** `components/chat/chat-messages.tsx` (render), `chat-input.tsx` (input), `chat-pane.tsx` (container; owns `selectedEmployee`, loads session meta, emits `onSessionMetaChange`).
- **New chat:** `+ New` → `routes/chat/page.tsx:264 handleNewChat()` → ChatPane with `sessionId=null` → `ChatEmployeePicker`. First message builds params via `new-chat-helpers.ts buildNewSessionParams()` which currently sends only `source, prompt, employee, attachments`. **No engine/model/effort/fast selector in the new-chat flow or in-chat.**
- **Settings page:** `routes/settings/page.tsx` — this is the *only* place with model/effort dropdowns, and they set the **global** `config.engines.<eng>.model` / `.effortLevel`. The options are **hardcoded** (`page.tsx:953-1006`).
- **API client:** `lib/api.ts` — `createSession`, `sendMessage`, `getSession`, `getConfig` (the last is fetched in settings only). Base URL from `window.location.origin`.
- Reusable selector primitives available: `DropdownMenu`, `Command` (cmdk combobox), `Dialog`, `Tabs`, `Button`. **No plain `Select`.**

---

## 2. Codex bug — root cause + fix

**This is an environment corruption, NOT a code bug. No change to the jinn repo is required to restore Codex.**

### Repro
```
codex exec --model gpt-5.3-codex --json --color never \
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "say hi"
```
→ instant failure:
```
Error: spawn .../@openai/codex/vendor/aarch64-apple-darwin/codex/codex ENOENT (errno -2)
```
Even `codex --version` fails identically. Matches gateway log `~/.jinn/logs/gateway.log` 2026-05-29T22:38:41 — "Codex engine starting…" → "exited with code 1" after 66 ms (too fast for a model/API error; it's the launcher dying at spawn).

### Root cause
The npm launcher `@openai/codex/bin/codex.js` resolves the native binary to `vendor/<triple>/codex/codex` and spawns it. For this Mac (`aarch64-apple-darwin`) that directory is **empty** (mtime May 12). Every *other* platform's binary is intact (61 MB, Feb 10 install date). So the single arm64-macOS native binary was deleted/corrupted post-install. Disk is fine (81% full), no competing `codex` on PATH (`type -a codex` → only the nvm path), npm reports a healthy `@openai/codex@0.98.0`.

### Ruled out
- **Model id** — `gpt-5.3-codex` is valid (`~/.codex/models_cache.json`: `supported_in_api: true`). There's an advisory migration nudge to `gpt-5.4`, not a failure.
- **Auth** — `~/.codex/auth.json` present; not even reached (spawn fails first).
- **Adapter code** — `engines/codex.ts` is correct; flags match a working 0.98.0 CLI. Last codex-touching commit `d1f513b` (effort passthrough) is unrelated.

### Fix
```
npm install -g @openai/codex@latest
```
Then `codex --version` to verify and re-run the repro (should stream JSONL). **Optional hardening** (separate, low priority): in `engines/codex.ts` `proc.on("error")` (~`:197`), add an explicit ENOENT branch that tells the user to reinstall `@openai/codex`, since a missing vendor binary currently surfaces a cryptic path-not-found.

---

## 3. Gemini removal footprint (engine vs API)

**Boundary is clean.** Delete the *CLI engine* (spawns `gemini` child process). Keep the *API* (`GEMINI_API_KEY` → `generativelanguage.googleapis.com`, used by deep-research + nano-banana-pro). The two are independent; deleting the engine does not touch the API.

### ENGINE — DELETE / EDIT
| File | What | Action |
|---|---|---|
| `packages/jinn/src/engines/gemini.ts` | `GeminiEngine` class (372 lines) | delete file |
| `packages/jinn/src/engines/__tests__/gemini.test.ts` | engine tests | delete file |
| `packages/jinn/src/shared/types.ts:378,388` | `EngineType` union + `engines.gemini` config | remove gemini |
| `packages/jinn/src/gateway/server.ts:18,234-238` | import + instantiate + register | remove lines |
| `packages/jinn/src/gateway/api.ts:451,1970-1972` | `/api/health` + routing branch | remove branch |
| `packages/jinn/src/sessions/manager.ts:270,670` | gemini config/model resolution | remove cases |
| `packages/jinn/src/sessions/context.ts:640` | `defaultEngine === "gemini"` check | remove case |
| `packages/jinn/src/sessions/fork.ts:6,244-278,297-298,330-351` | `forkGeminiSession()` + switch case | delete function + case |
| `packages/jinn/src/cron/runner.ts:67` | engine union type | remove gemini |
| `packages/jinn/src/cli/migrate.ts:84-85` | gemini CLI args builder | remove case |
| `docs/.../2026-03-21-gemini-engine-design.md` | design spec | archive/delete |
| `template/migrations/0.8.0/MIGRATION.md` | v0.8.0 release notes | edit out gemini |
| `README.md`, `CHANGELOG.md` | marketing copy | edit out gemini-as-engine |

### API — KEEP (do not touch)
- `~/.jinn/skills/deep-research/SKILL.md`, `~/.jinn/scripts/run-deep-research.py` — Gemini API as one of 4 research engines.
- `~/.jinn/skills/nano-banana-pro/SKILL.md` + `scripts/generate_image.py` — image gen via `google-genai` SDK.
- `~/.jinn/skills/deep-research/secrets/credentials.json`, `~/.jinn/secrets/api-keys.json` — `GEMINI_API_KEY` stays (used by the API paths above).

### Flagged for confirmation
- `GEMINI_API_KEY` env var is referenced by both the engine (child-process env passthrough) and the API scripts — **keep the var**; only the engine's *use* of it disappears.
- Historical cron run log `~/.jinn/cron/runs/overnight-ici-419-gemini-cli.jsonl` — historical only, optional cleanup.

---

## 4. Dynamic model/capability registry (design)

### Current state (the problem)
- Model lists are **hardcoded** in `packages/web/src/routes/settings/page.tsx:953-1006` (Claude opus/sonnet/haiku, Codex gpt-5.4/5.3/5.2…). Labels are already **stale** (say "claude-opus-4-6" while Opus 4.8 ships) — proof the hardcoding rots.
- Effort levels hardcoded twice and inconsistently: backend `VALID_EFFORTS = {low,medium,high}` (`effort.ts:4`) but settings UI offers Codex **`xhigh`** (`page.tsx:1016-1021`) → **silently rejected** by the backend validator. (Bug worth noting.)
- No capability metadata anywhere (which model supports effort? which supports `/fast`?). Each engine hardcodes its own effort-flag format.

### Proposed: single source of truth in `config.yaml` + `/api/engines`
Add a `models:` registry to `config.yaml`, loaded + hot-reloaded by a new `packages/jinn/src/shared/models.ts`, exposed via a new `GET /api/engines`, consumed by gateway, CLI, and web (via a `use-model-registry` TanStack hook). Adding a newly-released model becomes a config edit — no code change, no rebuild.

```yaml
models:
  engines:
    claude:
      models:
        opus:   { id: claude-opus-4-8,  label: "Opus 4.8",  supportsEffort: true, effortLevels: [low,medium,high], supportsFast: true }
        sonnet: { id: claude-sonnet-4-6, label: "Sonnet 4.6", supportsEffort: true, effortLevels: [low,medium,high], supportsFast: false }
        haiku:  { id: claude-haiku-4-5,  label: "Haiku 4.5",  supportsEffort: true, effortLevels: [low,medium,high], supportsFast: false }
      effortSemantics: { flag: "--effort", default: medium }
    codex:
      models:
        gpt-5.3-codex: { label: "GPT-5.3 Codex", supportsEffort: true, effortLevels: [low,medium,high,xhigh], supportsFast: false }
      effortSemantics: { flag: "-c", flagFormat: 'model_reasoning_effort="{value}"', default: medium }
```

- **Backward compat:** if `models:` is absent, synthesize a minimal registry from `config.engines.<eng>.model` so existing configs keep working.
- **Engine integration:** Claude/Codex adapters read effort flag + format and `supportsFast` from the registry instead of hardcoding; unknown effort levels are dropped with a warning instead of silently passing.
- **Per-engine reality (to encode):** Claude `/fast` → Opus 4.8/4.7/4.6 only (system context); Claude effort → `--effort low|medium|high`. Codex reasoning effort → `low|medium|high|xhigh` via `-c model_reasoning_effort`. Gemini engine being dropped, so not in registry.

---

## 5. Proposed chat-UI UX

**Controls live in a compact selector row attached to the chat input (bottom toolbar), present in both new-chat and in-chat states.** All options are populated from `/api/engines` (dynamic).

```
┌─────────────────────────────────────────────────────────────┐
│  [ message input textarea …                                ] │
│  ⚙ Engine: Claude ▾   Model: Opus 4.8 ▾   Effort: High ▾   ⚡Fast │
└─────────────────────────────────────────────────────────────┘
```

- **Engine** dropdown — only at **new-chat** (engine is fixed once a session starts; show as read-only chip in-chat). Lists available engines from `activeEngines.available`.
- **Model** dropdown — editable **both** new-chat and in-chat. New-chat sets `body.model`; in-chat mid-conversation calls a small new `PATCH /api/sessions/:id` (or reuse `sendMessage`'s pass-through) that updates `sessions.model` — applies from the **next turn** (the running engine keeps its current model until then; we show a subtle "applies next message" hint).
- **Effort** dropdown — options filtered by the selected model's `effortLevels`; `default` plus the model's levels. New-chat = `body.effortLevel`. In-chat: requires adding effort to the mid-chat update path (effort is currently creation-only — see plan step).
- **Fast** toggle (⚡) — shown **only** when the selected model has `supportsFast: true`; greyed/hidden otherwise. Wires a new `fast` boolean end-to-end → `--fast` flag.
- **Defaults:** selectors pre-fill from the chosen employee's config (or global default), so the common path is zero-click.
- **Reuse:** `DropdownMenu` for engine/model/effort, `Switch`/`Button` for fast. Tab context menu shows the session's current engine/model (read from `sessionMeta`).

---

## 6. Implementation plan (ordered, with risk)

> **Quick win first (no repo change):** run `npm install -g @openai/codex@latest` to fix Codex. **LOW.**

**Step 1 — Codex restore.** Reinstall CLI (above) + optional ENOENT-branch hardening in `engines/codex.ts:~197`. **LOW.**

**Step 2 — Drop gemini engine.** Delete `engines/gemini.ts` + test, strip refs per §3 table, narrow `EngineType` union, edit docs/README/migration notes. Keep all API usage. Build + typecheck. **LOW–MED** (mechanical but touches many files; type-narrowing the union will surface every call site — that's the safety net).

**Step 3 — Model+capability registry (backend).** New `shared/models.ts` (loader, cache, `synthesizeFromEngineConfig` fallback, `invalidateModelCache` on config reload); registry types in `shared/types.ts`; optional `models:` block in `config.yaml`; new `GET /api/engines`; invalidate on `PUT /api/config`. **MED.**

**Step 4 — Wire effort validation to registry.** Replace hardcoded `VALID_EFFORTS` (`effort.ts:4`) with per-engine `effortLevels`; fixes the silent-`xhigh`-rejection bug. **LOW–MED.**

**Step 5 — Add `fast` end-to-end.** `fast?: boolean` on `EngineRunOpts`, `Session`, `CronJob`, `sessions` schema (migration), `POST /api/sessions` body, resolution path; Claude adapter pushes `--fast` only when model `supportsFast`. **MED** (schema migration + new field across layers).

**Step 6 — Mid-chat model (and effort) switching.** Add `PATCH /api/sessions/:id` (or extend `sendMessage` pass-through) to update `sessions.model`/`effort_level`; apply from next turn. **MED** (need to confirm engine-resume semantics — open question below).

**Step 7 — Web: dynamic registry + selector row.** `lib/api.ts getEngines()`; `hooks/use-model-registry.ts`; selector row component on the chat input (`chat-pane.tsx` / `chat-input.tsx`); extend `buildNewSessionParams` (`new-chat-helpers.ts`) with engine/model/effort/fast; convert settings dropdowns (`page.tsx:953-1006`) to registry-driven. **MED–HIGH** (most surface area; new UX).

**Step 8 — Verify.** `pnpm typecheck && pnpm build && pnpm test`; manual: new chat per engine, mid-chat model switch, fast toggle visibility, effort filtering, codex round-trip.

### Effort estimate per CEO ask
| Ask | Steps | Estimate |
|---|---|---|
| 1. Engine switch (new chats) | 7 | S |
| 2. Model switch (new + current) | 6, 7 | M |
| 3. Effort switch | 4, 7 | S–M |
| 4. /fast switch | 5, 7 | M |
| 5. Fix Codex | 1 | XS (env reinstall) |
| 6. Drop gemini engine | 2 | S–M |
| 7. Dynamic registry | 3, 4 | M |
| 8. Nice chat UX | 7 | M–L |

Rough total: ~2–3 focused days for 1–7; UX polish (8) on top.

---

## 7. Risks / open questions / clarifying questions for CEO

**Open questions (technical):**
1. **Mid-chat model switch semantics** — engines resume sessions (`engine_session_id`). Does Claude/Codex `--resume` honor a changed `--model` cleanly, or does it pin the original model? Need a spike before promising true mid-chat switching (Step 6). Fallback: "switch model" forks a new session from the current one.
2. **`/fast` flag truth** — confirm the actual `claude` CLI flag is `--fast` (system context implies a `/fast` toggle on Opus 4.8/4.7/4.6). Need to verify the real flag name before wiring Step 5.
3. **Codex effort `xhigh`** — confirm the codex CLI actually accepts `xhigh` for `model_reasoning_effort` (settings UI offers it; backend rejects it today).

**Clarifying questions for CEO:**
- A) For "current chat" model switching — is **fork-on-switch** acceptable if live re-model isn't clean, or do you require true in-place switching?
- B) Should engine be switchable **in-chat** at all, or is new-chat-only fine (my recommendation: new-chat only)?
- C) Do you want the per-employee default model/effort still respected as the selector's pre-fill, or a single global default?
- D) Confirm the gemini engine has **no** active sessions/crons depending on it before deletion (none found, but worth a CEO sign-off).

**Risks:** Step 2 union-narrowing touches ~10 files (mitigated by typecheck); Step 5/6 add a DB migration (need template migration entry); Step 7 is the largest UX surface.
