# JAR-29 — Technical groundwork for the Memory & Archiving TRIAL

## Status

**DISABLED — technical groundwork only.**

- `MEMORY_TRIAL_ENABLED` is literally `false`.
- `runMemoryTrial` fails closed with `MemoryTrialDisabledError`.
- `registeredTriggers` is the immutable empty tuple `readonly []`.
- Nothing outside `memory-trial` imports the module; no startup path, trigger, cron, workflow or historical backfill is wired to it.
- The `session-end` and `session-start` flows are only marked `designed-not-active`.

Any activation, experiment, staging or production run, or real ingestion needs a separate mandate. This deliverable does not start the TRIAL.

## Data scope and provenance

The allowed corpus is exclusively `synthetic` or `public`. Canonical sources are validated and frozen with:

- a non-empty identifier and version;
- a public HTTPS canonical URI, with no local path and no loopback address;
- a canonical SHA-256 digest;
- a parseable capture date;
- a derived citation carrying the URI, the version and the digest.

The registry is a derived index: deterministic, and rebuildable from those canonical sources. Rollback empties that derived index only, and leaves the sources untouched.

## Security, isolation and AIR-12

- Deny-by-default ACL: without an exact principal, reads are refused.
- Runtime isolation: the agent **and** the project must both match; cross-agent and cross-project access are refused.
- Exclusions run before any derivation or indexing.
- Hostile content (jailbreak instructions, role tags, apparent secrets) is treated as untrusted data and rejected.
- AIR-12 mitigation: no authority granted to content, provenance cited, exact scope, minimal capped re-injection, and non-blocking failure.
- Checkpoints are immutable and idempotent; `pendingSources` allows resuming from the last durable checkpoint after an interruption.

## Budgets, metrics and rollback

Session-start re-injection enforces two non-negative budgets: a maximum number of entries and a maximum number of characters. The result states how much was actually kept and whether it was truncated. A preparation error yields an empty, non-blocking result. The available preparation metrics are `accepted`, `excluded`, `denied` and `resumed`; this module sends no external telemetry.

Local rollback is `rollbackDerivedIndex()`: it returns an empty derived index and preserves the canonical sources.

## T1-T16 matrix

| Test | Invariant checked |
|---|---|
| T1 | Disabled by default, and fails closed |
| T2 | No trigger, and two flows left inactive |
| T3 | Corpus exclusively synthetic or public |
| T4 | Canonical provenance and version, immutable source |
| T5 | Deterministic, rebuildable derived index |
| T6 | Refusal without a principal (deny-by-default) |
| T7 | Cross-agent refusal |
| T8 | Cross-project refusal |
| T9 | Authorisation limited to the exact agent/project pair |
| T10 | Hostile content excluded before indexing |
| T11 | Idempotent checkpoint |
| T12 | Resume after an interruption |
| T13 | Minimal, cited and capped re-injection |
| T14 | Budgets, and a non-blocking fallback |
| T15 | Index rollback without mutating the sources |
| T16 | AIR-12 mitigation by rejection, citation and isolation |

Test fixtures are synthetic or public only (`example.com`) and carry no private data.

## Local verification

From `packages/jinn`:

```bash
./node_modules/.bin/vitest run src/memory-trial/__tests__/preparation.test.ts
./node_modules/.bin/vitest run --coverage src/memory-trial/__tests__/preparation.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint src/memory-trial/preparation.ts src/memory-trial/__tests__/preparation.test.ts
```

Evidence observed during the groundwork:

- T1-T16: **16/16 passing**;
- targeted coverage: **90.38% statements**, **83.87% branches**, **100% functions**, **95.34% lines**;
- TypeScript `--noEmit`: passing;
- targeted ESLint: passing;
- search outside `src/memory-trial`: no import and no runtime wiring.

## Standing prohibitions

No deployment, staging, production, global or implicit activation, trigger, private data, historical backfill, spend, push or GitHub mutation is part of this groundwork.
