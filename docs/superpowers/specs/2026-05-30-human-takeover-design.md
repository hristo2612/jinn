# Human-in-the-loop Browser/Desktop Takeover — Design

**Date:** 2026-05-30
**Author:** jinn-dev
**Status:** Approved (brainstorm), pending plan review
**Branch:** `feat/human-takeover`

## Problem

The gateway and the Chrome that Claude-in-Chrome drives both run on the Mac mini
(`jimmys-mac-mini.tail0b18b3.ts.net`). Hristo accesses the web UI from another Mac
over Tailscale. When an agent hits a roadblock it cannot pass — captcha, login,
2FA, a native macOS dialog — it currently has no way to ask for help. We want the
agent to **pause and ask**, let Hristo **take control of the mini's screen inside a
window in the chat**, fix the problem, and click **Resume** so the agent continues.
Zero SSH, zero typing.

## Key topology insight

The gateway runs **on the same machine** as the screen being controlled. The screen
stream therefore rides the **existing authenticated web-UI WebSocket** (already only
reachable over Tailscale): `browser ⟷ gateway (over Tailscale) → localhost:5900`.
No second Tailscale hop, no separate login.

## Verified facts (from recon, 2026-05-30)

- `screensharingd` is `RFB 003.889` and offers security types **`[30, 33, 36, 35]`**.
  **Type 2 (legacy VNC password) is NOT offered by default** — vanilla noVNC cannot
  authenticate as-is. (Decision D1 addresses this.)
- `*.5900` is `LISTEN` on tcp4+tcp6 → screensharingd is bound to **0.0.0.0** (reachable
  over the tailnet). Hardening (D4) restricts it to localhost.
- The gateway has **no application-layer auth** today: `/ws` and `/ws/pty/:sessionId`
  upgrades (`server.ts:762-780`) and all HTTP routes rely solely on Tailnet network
  privacy. There is no Bearer/token middleware to match. The VNC upgrade will be gated
  by **active-pending-assist + reqId token**, making it *strictly stronger* than the
  existing token-less `/ws/pty` terminal tunnel. True app-auth is a separate
  cross-cutting change — **out of scope, flagged.**
- `ws ^8.18.0` already a dep of `packages/jinn`; proxy needs only `net`. `@novnc/novnc`
  is the single new web dep (lazy-loaded in the modal).
- `--chrome` is hardcoded at `claude.ts:79`; **no change needed** — the agent is blocked
  in the help-request poll loop while the human acts, so Chrome is never driven
  concurrently. Conflict-free.

## Decisions (locked with COO)

- **D1 — VNC auth: Option B.** Enable legacy type-2 via a scripted one-time `kickstart`
  (sudo, no GUI). Store the 8-char password in gateway secrets. The **proxy performs the
  type-2 DES auth server-side** and presents security-type **None** to noVNC, so the
  password never reaches the browser. **Re-probe after kickstart to confirm type-2 appears
  before building the bridge.** Fallback if kickstart fails to add type-2: **Option A**
  (password client-side, WS is already Tailnet-private) as interim — **not** Apple auth-30.
- **D2 — Storage: in-memory `Map`.** A gateway restart kills the blocked agent's poll
  anyway, so there is nothing to resume. The card survives reload via chat history +
  a `GET /api/assist/:reqId` reconcile on mount. No DB migration.
- **D3 — Blocking: polling.** Agent polls `GET /api/assist/:reqId` every ~4s, ~10min
  timeout. On timeout the card enters a **`timed_out` ("re-request")** state (does not
  vanish); the skill returns a clear "timed out, no human response" so the agent decides
  whether to retry or report.
- **D4 — Hardening: apply (not just flag) the pf rule** restricting `5900` to localhost,
  made reversible (documented revert) and persistent across reboot (LaunchDaemon-loaded
  anchor). If persistence proves fragile, fall back to flagging and tell the COO. Keep the
  VNC-upgrade gate regardless.

## Architecture

Two layers. **Layer 1 is shippable on its own** (the reusable assist signal); Layer 2
adds the visual takeover.

### Layer 1 — assist-request signal (reusable core)

**Server — `AssistRegistry`** (new, `packages/jinn/src/gateway/assist.ts`):
in-memory `Map<reqId, AssistRecord>`.

```ts
interface AssistRecord {
  id: string;          // reqId
  sessionId: string;
  reason: string;
  url?: string;
  status: 'pending' | 'resolved' | 'timed_out';
  createdAt: number;
  resolvedAt?: number;
}
```

Methods: `create({sessionId, reason, url})`, `get(reqId)`, `resolve(reqId)`,
`markTimedOut(reqId)`, `findPendingBySession(sessionId)`, `hasActivePending(sessionId, reqId)`.

**HTTP routes** (in `api.ts`, cloned from the attachments block at L952):
- `POST /api/sessions/:id/assist/request` `{reason, url?}` →
  `AssistRegistry.create`, `insertMessage` an `assist-request` card into chat history,
  `emit('session:assist-requested', record)`, fire Slack ping to `#work-items`.
  Returns `{ reqId, status }`.
- `POST /api/assist/:reqId/resolve` → `resolve`, `emit('session:assist-resolved', {reqId, sessionId})`,
  tear down any open VNC tunnel for that reqId. Returns `{ status }`.
- `GET /api/assist/:reqId` → `{ status, reason, url, sessionId }` (the agent's poll + card reconcile).

**Chat card persistence:** extend the persisted media union (`registry.ts:588`) from
`'image' | 'audio' | 'file'` to add `'assist-request'`, with extra fields
`{ reqId, reason, status }` (url reuses existing optional fields or a new `assistUrl`).
The persisted card stores the *baseline* (status `pending`); the component reconciles
live status via WS events and a `GET` on mount.

**Skill — `~/.jinn/skills/request-human-help/SKILL.md`:** any employee/COO invokes it →
`curl POST …/assist/request` → poll `GET …/assist/:reqId` every 4s up to ~10min →
return `"resolved — re-check the page and continue"` or `"timed out — no human response"`.
Also fires the Slack `#work-items` ping (belt-and-suspenders with the server-side ping).

**Web — `AssistRequestCard`** (new `components/chat/assist-request-card.tsx`, dispatched
from `message-media.tsx:143`): shows reason + url + **[Take control]** + **[Resume]**.
Subscribes to `session:assist-requested` / `session:assist-resolved` via the existing
`createGatewaySocket` event stream; reconciles status with `GET /api/assist/:reqId` on
mount. **[Resume]** calls `POST /api/assist/:reqId/resolve`.

### Layer 2 — inline noVNC takeover

**Step 0 — enable legacy VNC (one-time, scripted):**
`kickstart` enables type-2 + sets the 8-char password; re-probe confirms type-2 appears.
Documented in the skill/spec; password stored in gateway secrets.

**Server — WS↔TCP VNC proxy** (`packages/jinn/src/gateway/vnc-proxy.ts`, wired into the
`server.on('upgrade')` handler at `server.ts:762`):
- Path `^/api/assist/:reqId/vnc$`.
- **Gate:** upgrade allowed only if `AssistRegistry.hasActivePending(sessionId, reqId)`
  resolves (reqId maps to a *pending* record). Else `socket.destroy()`.
- On accept: `net.connect(5900, '127.0.0.1')`, run the **RFB auth bridge** (below), then
  pipe both directions transparently.
- Auto-close the TCP socket + WS when the assist resolves (registry emits a teardown hook).

**RFB auth bridge (R1 — the unit to scrutinize):** stateful through both handshakes,
then transparent. Server-side it authenticates to screensharingd with type-2 DES using
the secret password; client-side it offers noVNC security-type **None**.

```
Real-server side (proxy as RFB client to 127.0.0.1:5900):
  1. read "RFB 003.889\n"            → write "RFB 003.008\n"
  2. read security-type list         → choose 2
  3. read 16-byte challenge          → write DES(challenge, key=bitrev(password[:8]))
  4. read SecurityResult (==0 ok)
  5. write ClientInit (shared=1)
  6. read ServerInit (w,h,pixelfmt,name)  ── hold it

Client side (proxy as RFB server to noVNC):
  1. write "RFB 003.008\n"           → read client version
  2. write [count=1][type=1 None]    → read chosen type (1)
  3. write SecurityResult 0
  4. read ClientInit (shared flag)   ── ignored / merged
  5. write the held ServerInit
  6. transparent bidirectional pipe
```

VNC type-2 crypto: DES-ECB, key = first 8 password bytes with **each byte's bits
reversed** (the classic VNC quirk), encrypt the 16-byte challenge in two 8-byte blocks.

**Web — noVNC modal** (`components/chat/takeover-modal.tsx`): Radix `Dialog` opened by
**[Take control]**; lazy-`import('@novnc/novnc/core/rfb')`; `new RFB(container,
wss://<gateway>/api/assist/:reqId/vnc)` (URL derived as in `ws.ts:7-12`); `scaleViewport=true`,
keyboard/mouse/clipboard forwarding. **[Resume agent]** resolves + closes. No password in
client (server-side auth → None).

**Hardening (D4):** pf anchor restricting `5900` to `lo0`/127.0.0.1, loaded by a
LaunchDaemon so it survives reboot; documented revert. VNC-upgrade gate kept regardless.

## Data flow

```
agent blocked → skill → POST assist/request
   → AssistRegistry.create + insertMessage(card) + emit(assist-requested) + Slack #work-items
   → web: card appears live (and after reload via history)
   → agent: poll GET assist/:reqId every 4s
Hristo clicks [Take control]
   → modal opens wss /api/assist/:reqId/vnc
   → upgrade gate checks hasActivePending → ok
   → proxy RFB-auth-bridges to 127.0.0.1:5900 → live screen
Hristo fixes it, clicks [Resume]
   → POST assist/:reqId/resolve → status resolved → emit(assist-resolved)
   → proxy tears down tunnel; modal closes
   → agent's next poll sees resolved → returns "re-check page and continue"
```

## Error handling

- **Timeout (10min):** skill marks record `timed_out` (via `POST resolve` variant or a
  `markTimedOut`), card shows "timed out — re-request", agent gets a clear timeout string.
- **Upgrade with no pending assist / wrong reqId:** `socket.destroy()` — tunnel never opens.
- **VNC auth failure (wrong password / type-2 missing):** proxy closes WS with a code; modal
  surfaces "screen sharing unavailable — check setup". Triggers D1 fallback investigation.
- **Resolve while tunnel open:** registry teardown hook closes TCP + WS immediately.
- **Gateway restart mid-assist:** record gone; agent poll 404s → treated as resolved/aborted;
  card on reload shows resolved/unknown (reconcile GET 404 → "ended").

## Testing (TDD)

- **`assist.ts` registry** — unit tests: create/get/resolve/timeout/findPending/hasActivePending,
  status transitions, no-double-resolve.
- **RFB auth bridge (R1)** — TDD against a **fake RFB server** (a `net.Server` that scripts the
  003.889 handshake: version → `[30,33,36,35,2]` types → challenge → SecurityResult): assert the
  proxy selects type 2, returns the correct DES response for a known password/challenge vector,
  forwards ServerInit, and offers the client `None` then goes transparent. Known-answer DES vector
  pinned so the bit-reversal quirk is verified deterministically.
- **DES type-2 response** — pure-function unit test with a canonical VNC test vector.
- **HTTP routes** — request/resolve/get happy paths + the no-pending upgrade rejection.
- **Web** — `AssistRequestCard` renders pending/resolved/timed_out; `[Resume]` posts resolve;
  reconcile-on-mount. (React Testing Library, jsdom.)
- **Verify pass** — trigger a real assist from a test session, confirm card + tunnel + resume
  cycle end-to-end against real `screensharingd`.

## File touch list

**New (server):** `packages/jinn/src/gateway/assist.ts`,
`packages/jinn/src/gateway/vnc-proxy.ts`, `packages/jinn/src/gateway/rfb-auth.ts` (+ `__tests__`).
**Edit (server):** `api.ts` (3 routes), `server.ts` (upgrade branch + registry wiring),
`registry.ts` (media union + fields), `shared/types.ts` (interfaces).
**New (web):** `components/chat/assist-request-card.tsx`, `components/chat/takeover-modal.tsx`.
**Edit (web):** `message-media.tsx` (dispatch new type), `package.json` (`@novnc/novnc`).
**New (workspace):** `~/.jinn/skills/request-human-help/SKILL.md`.
**New (ops):** kickstart enable script + pf anchor + LaunchDaemon (documented in skill/spec).

## Out of scope (YAGNI)

- App-layer auth across all gateway endpoints (separate cross-cutting change — flagged).
- Multi-user / concurrent takeovers (single operator, single mini).
- Audio, file transfer, multi-monitor selection (start with primary display).
- Apple auth-30 implementation (rejected in D1).
- Persisting assist records to SQLite (D2).
