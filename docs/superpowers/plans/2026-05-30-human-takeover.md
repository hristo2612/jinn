# Human-in-the-loop Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a blocked agent pause and request human help, and let Hristo take control of the Mac mini's screen inside a window in the Jinn chat over the existing Tailnet-private web-UI WebSocket, then click Resume to continue.

**Architecture:** Two layers. Layer 1 is a reusable in-memory assist-request signal (HTTP routes + WS events + persisted chat card + a skill the agent polls). Layer 2 adds an inline noVNC takeover: a Node WS↔TCP proxy to `127.0.0.1:5900` that performs Apple `screensharingd` legacy type-2 DES auth **server-side** and presents security-type None to noVNC, gated by an active pending assist + reqId token.

**Tech Stack:** TypeScript (ES2022), `ws ^8.18.0` + `net` (server), `des.js` (pure-JS DES for VNC auth — Node 24/OpenSSL 3 removed legacy DES), Vitest, React 19 + Radix Dialog + `@novnc/novnc` (web), macOS `kickstart`/`pf`/LaunchDaemon (ops).

**Spec:** `docs/superpowers/specs/2026-05-30-human-takeover-design.md`

**Verified inputs (do not re-derive):**
- `screensharingd` = `RFB 003.889`, offers security types `[30, 33, 36, 35]` (no type 2 until kickstart enables legacy).
- VNC DES known-answer vector: password `"secret12"` → bit-reversed key `cea6c64ea62e8c4c`; challenge `000102030405060708090a0b0c0d0e0f` → response `adcd997f8e16fee575e973f93c2b62b4`. `des.js` (DES-ECB, no padding, block-by-block) reproduces this exactly.
- Gateway has **no app-auth**; `/ws` + `/ws/pty/:id` upgrades (`server.ts:762-780`) are token-less, Tailnet-only. VNC gate (pending-assist + reqId) is strictly stronger.
- Connector send: `context.connectors.get('slack')?.sendMessage({ channel: '#work-items' }, text)`.

---

## File Structure

**New (server):**
- `packages/jinn/src/gateway/assist.ts` — `AssistRegistry` (in-memory Map, lifecycle).
- `packages/jinn/src/gateway/rfb-auth.ts` — pure VNC type-2 DES response fn.
- `packages/jinn/src/gateway/vnc-proxy.ts` — RFB auth bridge + WS↔TCP pipe.
- `__tests__/` next to each.

**Edit (server):**
- `packages/jinn/src/shared/types.ts` — `AssistRecord`, `MessageMedia` union extension.
- `packages/jinn/src/sessions/registry.ts:588` — extend persisted media union + fields.
- `packages/jinn/src/gateway/api.ts` — 3 assist routes (clone attachments block @ L952).
- `packages/jinn/src/gateway/server.ts` — instantiate registry, pass to context, add `/api/assist/:id/vnc` upgrade branch + resolve-teardown wiring.

**New (web):**
- `packages/web/src/components/chat/assist-request-card.tsx`
- `packages/web/src/components/chat/takeover-modal.tsx`

**Edit (web):**
- `packages/web/src/lib/conversations.ts` — extend `MediaAttachment` type.
- `packages/web/src/components/chat/message-media.tsx:143` — dispatch `assist-request` type.
- `packages/web/package.json` — add `@novnc/novnc`.

**New (workspace/ops):**
- `~/.jinn/skills/request-human-help/SKILL.md`
- `packages/jinn/scripts/enable-vnc-legacy.sh` (kickstart + re-probe)
- `packages/jinn/scripts/pf-restrict-5900.sh` + `com.jinn.pf-5900.plist` (LaunchDaemon)

**Run all server tests:** `cd ~/Projects/jinn && pnpm --filter jinn test`
**Run all web tests:** `cd ~/Projects/jinn && pnpm --filter web test`
**Typecheck:** `pnpm typecheck`

---

## PHASE A — Layer 1: assist-request signal (shippable on its own)

### Task 1: `AssistRecord` type + extend persisted media union

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/sessions/registry.ts:588-594`

- [ ] **Step 1: Add types** to `packages/jinn/src/shared/types.ts` (append near other gateway types):

```ts
export type AssistStatus = 'pending' | 'resolved' | 'timed_out';

export interface AssistRecord {
  id: string;          // reqId
  sessionId: string;
  reason: string;
  url?: string;
  status: AssistStatus;
  createdAt: number;
  resolvedAt?: number;
}
```

- [ ] **Step 2: Extend the persisted media union** in `packages/jinn/src/sessions/registry.ts` (the `MessageMedia` interface at L588):

```ts
export interface MessageMedia {
  type: 'image' | 'audio' | 'file' | 'assist-request';
  url: string;            // for assist-request: '' (unused) or the page url
  name?: string;
  mimeType?: string;
  size?: number;
  // assist-request fields:
  reqId?: string;
  reason?: string;
  status?: 'pending' | 'resolved' | 'timed_out';
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ~/Projects/jinn && pnpm --filter jinn typecheck`
Expected: PASS (no consumers break — fields are optional, union widened).

- [ ] **Step 4: Commit**

```bash
git add packages/jinn/src/shared/types.ts packages/jinn/src/sessions/registry.ts
git commit -m "feat(assist): add AssistRecord type and assist-request media variant"
```

---

### Task 2: `AssistRegistry`

**Files:**
- Create: `packages/jinn/src/gateway/assist.ts`
- Test: `packages/jinn/src/gateway/__tests__/assist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { AssistRegistry } from '../assist.js';

describe('AssistRegistry', () => {
  let reg: AssistRegistry;
  beforeEach(() => { reg = new AssistRegistry(); });

  it('creates a pending record with a unique id', () => {
    const r = reg.create({ sessionId: 's1', reason: 'captcha', url: 'http://x' });
    expect(r.status).toBe('pending');
    expect(r.sessionId).toBe('s1');
    expect(r.id).toMatch(/.+/);
    expect(reg.get(r.id)).toEqual(r);
  });

  it('resolves a pending record and fires the teardown hook', () => {
    let torndown = '';
    reg.onResolve((rec) => { torndown = rec.id; });
    const r = reg.create({ sessionId: 's1', reason: 'login' });
    const ok = reg.resolve(r.id);
    expect(ok).toBe(true);
    expect(reg.get(r.id)!.status).toBe('resolved');
    expect(torndown).toBe(r.id);
  });

  it('onResolve returns an unsubscribe that removes the hook (no leak)', () => {
    let calls = 0;
    const off = reg.onResolve(() => { calls++; });
    off();
    reg.resolve(reg.create({ sessionId: 's1', reason: 'x' }).id);
    expect(calls).toBe(0);
  });

  it('does not double-resolve', () => {
    const r = reg.create({ sessionId: 's1', reason: 'x' });
    expect(reg.resolve(r.id)).toBe(true);
    expect(reg.resolve(r.id)).toBe(false);
  });

  it('marks timed_out only when still pending', () => {
    const r = reg.create({ sessionId: 's1', reason: 'x' });
    expect(reg.markTimedOut(r.id)).toBe(true);
    expect(reg.get(r.id)!.status).toBe('timed_out');
    expect(reg.markTimedOut(r.id)).toBe(false);
  });

  it('hasActivePending matches only pending reqId for that session', () => {
    const r = reg.create({ sessionId: 's1', reason: 'x' });
    expect(reg.hasActivePending('s1', r.id)).toBe(true);
    expect(reg.hasActivePending('s2', r.id)).toBe(false);
    reg.resolve(r.id);
    expect(reg.hasActivePending('s1', r.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `pnpm --filter jinn test assist.test`
Expected: FAIL — cannot find module `../assist.js`.

- [ ] **Step 3: Implement** `packages/jinn/src/gateway/assist.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { AssistRecord } from '../shared/types.js';

export class AssistRegistry {
  private records = new Map<string, AssistRecord>();
  private resolveHooks: Array<(r: AssistRecord) => void> = [];

  /** Returns an unsubscribe fn — callers MUST call it to avoid hook accumulation. */
  onResolve(hook: (r: AssistRecord) => void): () => void {
    this.resolveHooks.push(hook);
    return () => {
      const i = this.resolveHooks.indexOf(hook);
      if (i >= 0) this.resolveHooks.splice(i, 1);
    };
  }

  create(input: { sessionId: string; reason: string; url?: string }): AssistRecord {
    const rec: AssistRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      reason: input.reason,
      url: input.url,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.records.set(rec.id, rec);
    return rec;
  }

  get(reqId: string): AssistRecord | undefined {
    return this.records.get(reqId);
  }

  resolve(reqId: string): boolean {
    const rec = this.records.get(reqId);
    if (!rec || rec.status !== 'pending') return false;
    rec.status = 'resolved';
    rec.resolvedAt = Date.now();
    for (const hook of this.resolveHooks) {
      try { hook(rec); } catch { /* teardown best-effort */ }
    }
    return true;
  }

  markTimedOut(reqId: string): boolean {
    const rec = this.records.get(reqId);
    if (!rec || rec.status !== 'pending') return false;
    rec.status = 'timed_out';
    rec.resolvedAt = Date.now();
    for (const hook of this.resolveHooks) {
      try { hook(rec); } catch { /* teardown best-effort */ }
    }
    return true;
  }

  hasActivePending(sessionId: string, reqId: string): boolean {
    const rec = this.records.get(reqId);
    return !!rec && rec.status === 'pending' && rec.sessionId === sessionId;
  }
}
```

- [ ] **Step 4: Run tests — confirm pass**

Run: `pnpm --filter jinn test assist.test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/gateway/assist.ts packages/jinn/src/gateway/__tests__/assist.test.ts
git commit -m "feat(assist): in-memory AssistRegistry with lifecycle + teardown hooks"
```

---

### Task 3: HTTP routes (request / resolve / get) + persisted card + Slack ping

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts` (clone attachments block @ L952; helpers `matchRoute` L381, `readJsonBody` L251, `json` L300, `getSession`, `notFound`)
- Modify: `packages/jinn/src/gateway/api.ts` `ApiContext` (L67) — add `assist: AssistRegistry`
- Test: `packages/jinn/src/gateway/__tests__/assist-routes.test.ts`

- [ ] **Step 1: Add `assist` to `ApiContext`** in `api.ts` (interface at L67):

```ts
  assist: import('./assist.js').AssistRegistry;
```

- [ ] **Step 2: Write the failing test** (drive the handler via a small dispatch helper). Create `packages/jinn/src/gateway/__tests__/assist-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AssistRegistry } from '../assist.js';
import { handleAssistRoutes } from '../assist-routes.js';

function mockRes() {
  return { statusCode: 200, body: '' as string,
    writeHead(s: number) { this.statusCode = s; return this; },
    end(b?: string) { if (b) this.body = b; return this; } } as any;
}

describe('assist routes', () => {
  let assist: AssistRegistry;
  let emit: ReturnType<typeof vi.fn>;
  let insertMessage: ReturnType<typeof vi.fn>;
  let slackSend: ReturnType<typeof vi.fn>;
  let ctx: any;
  beforeEach(() => {
    assist = new AssistRegistry();
    emit = vi.fn();
    insertMessage = vi.fn(() => 'msg1');
    slackSend = vi.fn(async () => 'ts');
    ctx = { assist, emit, insertMessage,
      connectors: new Map([['slack', { sendMessage: slackSend }]]) };
  });

  it('POST request creates record, persists card, emits, pings slack', async () => {
    const res = mockRes();
    const handled = await handleAssistRoutes('POST', '/api/sessions/s1/assist/request',
      { reason: 'captcha', url: 'http://x' }, res, ctx);
    expect(handled).toBe(true);
    const out = JSON.parse(res.body);
    expect(out.status).toBe('pending');
    expect(assist.get(out.reqId)).toBeTruthy();
    expect(insertMessage).toHaveBeenCalledWith('s1', 'assistant', expect.any(String),
      [expect.objectContaining({ type: 'assist-request', reqId: out.reqId, status: 'pending' })]);
    expect(emit).toHaveBeenCalledWith('session:assist-requested', expect.objectContaining({ id: out.reqId }));
    expect(slackSend).toHaveBeenCalled();
  });

  it('POST resolve flips status and emits', async () => {
    const rec = assist.create({ sessionId: 's1', reason: 'x' });
    const res = mockRes();
    const handled = await handleAssistRoutes('POST', `/api/assist/${rec.id}/resolve`, {}, res, ctx);
    expect(handled).toBe(true);
    expect(assist.get(rec.id)!.status).toBe('resolved');
    expect(emit).toHaveBeenCalledWith('session:assist-resolved', { reqId: rec.id, sessionId: 's1' });
  });

  it('GET returns status', async () => {
    const rec = assist.create({ sessionId: 's1', reason: 'login', url: 'http://y' });
    const res = mockRes();
    const handled = await handleAssistRoutes('GET', `/api/assist/${rec.id}`, undefined, res, ctx);
    expect(handled).toBe(true);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'pending', reason: 'login', sessionId: 's1' });
  });

  it('GET unknown reqId returns 404', async () => {
    const res = mockRes();
    await handleAssistRoutes('GET', '/api/assist/nope', undefined, res, ctx);
    expect(res.statusCode).toBe(404);
  });

  it('returns false for non-assist paths', async () => {
    const res = mockRes();
    expect(await handleAssistRoutes('GET', '/api/status', undefined, res, ctx)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it — confirm it fails**

Run: `pnpm --filter jinn test assist-routes`
Expected: FAIL — cannot find `../assist-routes.js`.

- [ ] **Step 4: Implement the handler** in a focused module `packages/jinn/src/gateway/assist-routes.ts` (keeps `api.ts` lean; api.ts just delegates). It takes parsed inputs so it is unit-testable without `http`:

```ts
import type { ServerResponse } from 'node:http';
import type { AssistRegistry } from './assist.js';
import type { MessageMedia } from '../sessions/registry.js';

export interface AssistRouteCtx {
  assist: AssistRegistry;
  emit: (event: string, payload: unknown) => void;
  insertMessage: (sessionId: string, role: string, content: string, media?: MessageMedia[]) => string;
  connectors: Map<string, { sendMessage: (t: { channel: string }, text: string) => Promise<unknown> }>;
}

function send(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function matchSegments(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/'); const a = pathname.split('/');
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

/** Returns true if it handled the route. */
export async function handleAssistRoutes(
  method: string, pathname: string, body: any, res: ServerResponse, ctx: AssistRouteCtx,
): Promise<boolean> {
  // POST /api/sessions/:id/assist/request
  let m = matchSegments('/api/sessions/:id/assist/request', pathname);
  if (m && method === 'POST') {
    const reason = String(body?.reason ?? '').trim() || 'Agent needs help';
    const url = typeof body?.url === 'string' ? body.url : undefined;
    const rec = ctx.assist.create({ sessionId: m.id, reason, url });
    const card: MessageMedia = { type: 'assist-request', url: url ?? '', reqId: rec.id, reason, status: 'pending' };
    ctx.insertMessage(m.id, 'assistant', `🙋 Help needed: ${reason}`, [card]);
    ctx.emit('session:assist-requested', rec);
    const slack = ctx.connectors.get('slack');
    if (slack) {
      slack.sendMessage({ channel: '#work-items' },
        `🙋 *Help needed* in session \`${m.id}\`\n> ${reason}${url ? `\n${url}` : ''}\nOpen the chat to take control.`)
        .catch(() => { /* alert best-effort */ });
    }
    send(res, { reqId: rec.id, status: rec.status }, 201);
    return true;
  }

  // POST /api/assist/:reqId/resolve
  m = matchSegments('/api/assist/:reqId/resolve', pathname);
  if (m && method === 'POST') {
    const rec = ctx.assist.get(m.reqId);
    if (!rec) { send(res, { error: 'not found' }, 404); return true; }
    ctx.assist.resolve(m.reqId);
    ctx.emit('session:assist-resolved', { reqId: m.reqId, sessionId: rec.sessionId });
    send(res, { status: 'resolved' });
    return true;
  }

  // GET /api/assist/:reqId
  m = matchSegments('/api/assist/:reqId', pathname);
  if (m && method === 'GET') {
    const rec = ctx.assist.get(m.reqId);
    if (!rec) { send(res, { error: 'not found' }, 404); return true; }
    send(res, { status: rec.status, reason: rec.reason, url: rec.url, sessionId: rec.sessionId });
    return true;
  }

  return false;
}
```

- [ ] **Step 5: Run tests — confirm pass**

Run: `pnpm --filter jinn test assist-routes`
Expected: PASS (5 tests).

- [ ] **Step 6: Wire into `api.ts`.** Near the top of the request dispatch (before the attachments block ~L952), add a delegation. `insertMessage` is imported in `api.ts` already via the sessions registry; if not, add `import { insertMessage } from '../sessions/registry.js';`. Insert:

```ts
// Assist (human-in-the-loop) routes
{
  const isAssist = pathname.includes('/assist/') || /^\/api\/assist\//.test(pathname);
  if (isAssist) {
    let parsedBody: unknown;
    if (method === 'POST') {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      parsedBody = parsed.body;
    }
    const handled = await handleAssistRoutes(method, pathname, parsedBody, res, {
      assist: context.assist,
      emit: context.emit,
      insertMessage,
      connectors: context.connectors as any,
    });
    if (handled) return;
  }
}
```

Add the import at the top of `api.ts`:

```ts
import { handleAssistRoutes } from './assist-routes.js';
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter jinn typecheck`
Expected: PASS. (If `ApiContext.assist` is unset anywhere it's constructed, Task 8 wires it — typecheck of server.ts may fail until then; that's expected and fixed in Task 8. Run `pnpm --filter jinn test` to confirm route tests stay green.)

- [ ] **Step 8: Commit**

```bash
git add packages/jinn/src/gateway/assist-routes.ts packages/jinn/src/gateway/__tests__/assist-routes.test.ts packages/jinn/src/gateway/api.ts
git commit -m "feat(assist): request/resolve/get HTTP routes + persisted card + slack ping"
```

---

### Task 4: `request-human-help` skill

**Files:**
- Create: `~/.jinn/skills/request-human-help/SKILL.md`

- [ ] **Step 1: Write the skill** (no test — it's a playbook; verified end-to-end in Phase C):

````markdown
---
name: request-human-help
description: Use when an agent is blocked by something only a human can clear — captcha, login, 2FA, a native macOS dialog, or anything requiring a person to look at or touch the screen. Posts an assist request to the Jinn chat (with an optional [Take control] screen-share), pings Slack #work-items, then blocks by polling until a human resolves it or ~10 min passes.
---

# Request Human Help

When you cannot proceed without a human (captcha / login / 2FA / native dialog):

## 0. Find your own session ID

Read it from your context: the **"## Current session"** section contains a line
`- Session ID: <uuid>`. That uuid is `SID` below. Every session — COO and spawned
employee child alike — has this line injected (it's an always-included, never-trimmed
context section). If for some reason it's absent, fall back to the newest non-idle
session: `curl -s http://0.0.0.0:7777/api/sessions | jq -r '.[0].id'` — but the
context line is authoritative; prefer it.

## 1. Fire the request

```bash
SID="<the Session ID from your Current session context section>"
REASON="Cloudflare captcha on checkout page"
URL="https://example.com/checkout"   # optional, the page that needs eyes
RESP=$(curl -s -X POST "http://0.0.0.0:7777/api/sessions/$SID/assist/request" \
  -H 'Content-Type: application/json' \
  -d "{\"reason\":$(printf '%s' "$REASON" | jq -Rs .),\"url\":$(printf '%s' "$URL" | jq -Rs .)}")
REQ=$(printf '%s' "$RESP" | jq -r .reqId)
echo "assist reqId=$REQ"
```

The server already persisted a chat card and pinged Slack. (If `#work-items`
doesn't exist, that's fine — the card in chat is the primary signal.)

## 2. Block by polling (4s interval, ~10 min cap)

```bash
for i in $(seq 1 150); do
  ST=$(curl -s "http://0.0.0.0:7777/api/assist/$REQ" | jq -r .status)
  if [ "$ST" = "resolved" ]; then echo "RESOLVED"; break; fi
  if [ "$ST" = "timed_out" ]; then echo "TIMED_OUT"; break; fi
  sleep 4
done
```

## 3. Return

- **resolved** → "Human resolved the block. Re-check the page state and continue."
- **timed_out** / loop exhausted → mark it: `curl -s -X POST "http://0.0.0.0:7777/api/assist/$REQ/resolve" >/dev/null` is NOT what you want for timeout; instead the card stays as `timed_out` server-side once the cap passes. Report: "No human responded within ~10 min. Reporting the blocker and stopping this attempt."

Never busy-wait faster than 4s. Never exceed ~10 min. Do not SSH or try to
click the native dialog yourself — that's exactly what the human is for.
````

- [ ] **Step 2: Verify the gateway syncs the skill symlink** (file watcher logs `Skills changed`):

Run: `ls -la ~/.claude/skills/request-human-help 2>/dev/null || echo "will sync on gateway reload"`
Expected: symlink appears after the skills watcher fires (or on next gateway start).

- [ ] **Step 3: Commit** (workspace repo `~/.jinn`):

```bash
cd ~/.jinn && git add skills/request-human-help/SKILL.md && git commit -m "feat: request-human-help skill"
cd ~/Projects/jinn
```

> Note: the skill's timeout handling relies on the server marking `timed_out`.
> Task 8 adds a sweep that flips pending→timed_out after 10 min so the card and
> `GET` status agree with the skill. Keep the skill copy and Task 8 sweep in sync.

---

### Task 5: Web `AssistRequestCard` + dispatch + reconcile

**Files:**
- Modify: `packages/web/src/lib/conversations.ts` — extend `MediaAttachment`
- Create: `packages/web/src/components/chat/assist-request-card.tsx`
- Modify: `packages/web/src/components/chat/message-media.tsx:143`
- Test: `packages/web/src/components/chat/__tests__/assist-request-card.test.tsx`

- [ ] **Step 1: Extend `MediaAttachment`** in `packages/web/src/lib/conversations.ts` (mirror the server union — add the variant + optional fields):

```ts
// within the MediaAttachment type:
//   type: 'image' | 'audio' | 'file' | 'assist-request'
//   plus optional: reqId?: string; reason?: string; status?: 'pending' | 'resolved' | 'timed_out'
```

- [ ] **Step 2: Write the failing test:**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AssistRequestCard } from '../assist-request-card';

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'pending' }) })) as any;
});

describe('AssistRequestCard', () => {
  it('renders reason + url and Take control / Resume buttons', async () => {
    render(<AssistRequestCard reqId="r1" reason="captcha" url="http://x" status="pending" />);
    expect(screen.getByText(/captcha/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /take control/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /resume/i })).toBeTruthy();
  });

  it('Resume posts resolve', async () => {
    const fetchMock = global.fetch as any;
    render(<AssistRequestCard reqId="r1" reason="x" status="pending" />);
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/assist/r1/resolve'), expect.objectContaining({ method: 'POST' })));
  });

  it('shows resolved state without action buttons', () => {
    render(<AssistRequestCard reqId="r1" reason="x" status="resolved" />);
    expect(screen.queryByRole('button', { name: /take control/i })).toBeNull();
    expect(screen.getByText(/resolved/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it — confirm it fails**

Run: `pnpm --filter web test assist-request-card`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** `packages/web/src/components/chat/assist-request-card.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { TakeoverModal } from './takeover-modal';

type Status = 'pending' | 'resolved' | 'timed_out';

export function AssistRequestCard(props: {
  reqId: string; reason: string; url?: string; status?: Status;
}) {
  const [status, setStatus] = useState<Status>(props.status ?? 'pending');
  const [open, setOpen] = useState(false);

  // Reconcile live status on mount (persisted card may be stale after reload).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/assist/${props.reqId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.status) setStatus(d.status); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [props.reqId]);

  async function resume() {
    await fetch(`/api/assist/${props.reqId}/resolve`, { method: 'POST' });
    setStatus('resolved');
    setOpen(false);
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div className="font-medium">🙋 Help needed</div>
      <div className="mt-1 opacity-80">{props.reason}</div>
      {props.url && <a className="mt-1 block truncate text-xs underline opacity-70" href={props.url} target="_blank" rel="noreferrer">{props.url}</a>}
      {status === 'pending' && (
        <div className="mt-2 flex gap-2">
          <button className="rounded bg-amber-600 px-3 py-1 text-white" onClick={() => setOpen(true)}>Take control</button>
          <button className="rounded border px-3 py-1" onClick={resume}>Resume agent</button>
        </div>
      )}
      {status === 'resolved' && <div className="mt-2 text-xs opacity-60">✅ Resolved</div>}
      {status === 'timed_out' && <div className="mt-2 text-xs opacity-60">⏱️ Timed out — agent will re-request if needed</div>}
      {open && <TakeoverModal reqId={props.reqId} onResume={resume} onClose={() => setOpen(false)} />}
    </div>
  );
}
```

- [ ] **Step 5: Add a stub `TakeoverModal`** so the card test compiles (real impl in Task 9). Create `packages/web/src/components/chat/takeover-modal.tsx`:

```tsx
export function TakeoverModal(_props: { reqId: string; onResume: () => void; onClose: () => void }) {
  return null; // replaced in Task 9 with the noVNC modal
}
```

- [ ] **Step 6: Dispatch the new type** in `message-media.tsx` (after the existing `files` block, before the lightbox). Add:

```tsx
  const assists = media.filter((m) => m.type === 'assist-request')
```

and in the returned JSX:

```tsx
      {assists.map((m, mi) => (
        <div key={`assist-${mi}`} className="mt-[var(--space-2)] max-w-[360px]">
          <AssistRequestCard reqId={m.reqId!} reason={m.reason ?? 'Help needed'} url={m.url || undefined} status={m.status} />
        </div>
      ))}
```

Add the import at the top of `message-media.tsx`:

```tsx
import { AssistRequestCard } from './assist-request-card'
```

- [ ] **Step 7: Run tests — confirm pass**

Run: `pnpm --filter web test assist-request-card`
Expected: PASS (3 tests).

- [ ] **Step 8: Wire live WS updates.** In the chat pane that owns `createGatewaySocket` (search `createGatewaySocket(` under `packages/web/src`), on `session:assist-resolved` / `session:assist-requested`, refetch or patch the message list for that session so the card flips without reload. Minimal approach: on either event, invalidate the conversation query for `payload.sessionId` (React Query `queryClient.invalidateQueries`). Add to the existing `onEvent` switch:

```tsx
      case 'session:assist-resolved':
      case 'session:assist-requested':
        queryClient.invalidateQueries({ queryKey: ['conversation', (payload as any).sessionId] });
        break;
```

(Match the actual query key used in this codebase — confirm by reading the chat pane's `useQuery` call.)

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/chat/assist-request-card.tsx packages/web/src/components/chat/takeover-modal.tsx packages/web/src/components/chat/message-media.tsx packages/web/src/lib/conversations.ts packages/web/src/components/chat/__tests__/assist-request-card.test.tsx
git commit -m "feat(web): assist-request chat card with live status + resume"
```

**✅ End of Phase A — Layer 1 is functional and shippable: an agent can request help, a card appears (and survives reload), Slack is pinged, and Resume resolves it. [Take control] is a no-op until Phase B.**

---

## PHASE B — Layer 2: inline noVNC takeover

### Task 6: VNC type-2 DES response (pure function)

**Files:**
- Create: `packages/jinn/src/gateway/rfb-auth.ts`
- Test: `packages/jinn/src/gateway/__tests__/rfb-auth.test.ts`
- Add dep: `des.js`

- [ ] **Step 1: Add the dep**

```bash
pnpm --filter jinn add des.js
```

- [ ] **Step 2: Write the failing test** (uses the verified known-answer vector):

```ts
import { describe, it, expect } from 'vitest';
import { vncDesResponse, reverseBits } from '../rfb-auth.js';

describe('vnc type-2 DES auth', () => {
  it('reverses bits in a byte', () => {
    expect(reverseBits(0x01)).toBe(0x80);
    expect(reverseBits(0xff)).toBe(0xff);
    expect(reverseBits(0x73)).toBe(0xce); // 's'
  });

  it('computes the canonical VNC response (known-answer vector)', () => {
    const challenge = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const resp = vncDesResponse('secret12', challenge);
    expect(resp.toString('hex')).toBe('adcd997f8e16fee575e973f93c2b62b4');
  });

  it('pads/truncates the password to 8 bytes', () => {
    // shorter password still yields a 16-byte response
    const challenge = Buffer.alloc(16, 0);
    expect(vncDesResponse('ab', challenge).length).toBe(16);
  });
});
```

- [ ] **Step 3: Run it — confirm it fails**

Run: `pnpm --filter jinn test rfb-auth`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** `packages/jinn/src/gateway/rfb-auth.ts`:

```ts
import DES from 'des.js';

export function reverseBits(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1);
  return r & 0xff;
}

/**
 * VNC "VNC Authentication" (security type 2) challenge response.
 * Key = first 8 bytes of password (NUL-padded), each byte bit-reversed.
 * Cipher = DES-ECB, no padding, applied to the 16-byte challenge (two blocks).
 * Node 24 / OpenSSL 3 removed legacy DES, so we use the pure-JS des.js.
 */
export function vncDesResponse(password: string, challenge: Buffer): Buffer {
  const pw = Buffer.from(password, 'latin1');
  const key = Buffer.alloc(8, 0);
  for (let i = 0; i < 8; i++) key[i] = reverseBits(i < pw.length ? pw[i] : 0);
  const des = DES.DES.create({ type: 'encrypt', key });
  // des.js processes ECB block-by-block with no padding; challenge is 16 bytes.
  return Buffer.from(des.update(challenge));
}
```

- [ ] **Step 5: Run tests — confirm pass**

Run: `pnpm --filter jinn test rfb-auth`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/jinn/src/gateway/rfb-auth.ts packages/jinn/src/gateway/__tests__/rfb-auth.test.ts packages/jinn/package.json
git commit -m "feat(vnc): pure-JS VNC type-2 DES response (des.js, known-answer tested)"
```

---

### Task 7: RFB auth bridge (server-side type-2 ⇄ client-side None)

**Files:**
- Create: `packages/jinn/src/gateway/vnc-proxy.ts`
- Test: `packages/jinn/src/gateway/__tests__/vnc-proxy.test.ts`

This is **R1 — the unit to scrutinize.** TDD it against a **fake RFB server** (a real `net.Server`) and a fake duplex "client". The bridge is a state machine; we test the handshake byte exchange, not a live screen.

- [ ] **Step 1: Write the failing test** — fake screensharingd + assert the bridge auths server-side and hands the client a None-auth + ServerInit, then goes transparent:

```ts
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { runRfbBridge } from '../vnc-proxy.js';
import { vncDesResponse } from '../rfb-auth.js';

const PW = 'secret12';
const CHALLENGE = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const SERVER_INIT = (() => {
  // width=2, height=2, 16-byte pixelformat, name "x"
  const b = Buffer.alloc(2 + 2 + 16 + 4 + 1);
  b.writeUInt16BE(2, 0); b.writeUInt16BE(2, 2);
  b.writeUInt32BE(1, 20); b.write('x', 24, 'ascii');
  return b;
})();

/** Fake screensharingd: 003.889 → types [30,33,36,35,2] → challenge → SecurityResult ok → read ClientInit → ServerInit. */
function fakeServer(): Promise<{ port: number; close: () => void; received: Buffer[] }> {
  const received: Buffer[] = [];
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let stage = 0;
      sock.write(Buffer.from('RFB 003.889\n', 'ascii'));
      sock.on('data', (d) => {
        received.push(d);
        if (stage === 0) { // got client version
          sock.write(Buffer.from([5, 30, 33, 36, 35, 2])); stage = 1; return;
        }
        if (stage === 1) { // got chosen type (expect 2)
          expectByte(d[0], 2);
          sock.write(CHALLENGE); stage = 2; return;
        }
        if (stage === 2) { // got DES response
          expectEqual(d.slice(0, 16), vncDesResponse(PW, CHALLENGE));
          sock.write(Buffer.from([0, 0, 0, 0])); stage = 3; return; // SecurityResult OK
        }
        if (stage === 3) { // got ClientInit (1 byte shared flag)
          sock.write(SERVER_INIT); stage = 4; return;
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close(), received }));
  });
}
function expectByte(got: number, want: number) { if (got !== want) throw new Error(`byte ${got}!=${want}`); }
function expectEqual(a: Buffer, b: Buffer) { if (Buffer.compare(a, b) !== 0) throw new Error('buf mismatch'); }

describe('runRfbBridge', () => {
  it('auths server-side type-2 and presents None + ServerInit to the client', async () => {
    const fake = await fakeServer();

    // Fake client side: two PassThroughs acting as the WS<->bridge duplex.
    const toBridge = new PassThrough();   // client -> bridge
    const fromBridge = new PassThrough(); // bridge -> client
    const clientReads: Buffer[] = [];
    fromBridge.on('data', (d) => clientReads.push(d));

    const done = runRfbBridge({
      clientReadable: toBridge,
      clientWritable: fromBridge,
      vncHost: '127.0.0.1', vncPort: fake.port, password: PW,
    });

    // Drive the client side of the protocol:
    await tick();
    // 1. bridge should have sent "RFB 003.008\n"
    expectEqual(Buffer.concat(clientReads).slice(0, 12), Buffer.from('RFB 003.008\n', 'ascii'));
    clientReads.length = 0;
    toBridge.write(Buffer.from('RFB 003.008\n', 'ascii')); // client version
    await tick();
    // 2. bridge offers [count=1, type=1 None]
    expectEqual(Buffer.concat(clientReads).slice(0, 2), Buffer.from([1, 1]));
    clientReads.length = 0;
    toBridge.write(Buffer.from([1])); // client chooses None
    await tick();
    // 3. bridge sends SecurityResult 0, then ServerInit
    const out = Buffer.concat(clientReads);
    expectEqual(out.slice(0, 4), Buffer.from([0, 0, 0, 0]));
    expectEqual(out.slice(4, 4 + SERVER_INIT.length), SERVER_INIT);
    toBridge.write(Buffer.from([1])); // client ClientInit (shared)
    await done;
    fake.close();
  });
});
function tick(ms = 30) { return new Promise((r) => setTimeout(r, ms)); }
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `pnpm --filter jinn test vnc-proxy`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `packages/jinn/src/gateway/vnc-proxy.ts`. The bridge: (a) connect to real server, do type-2 auth using `vncDesResponse`, capture ServerInit; (b) on the client side negotiate version → None → SecurityResult → consume ClientInit → forward ServerInit; (c) pipe transparently. Implement as a promise that resolves when both handshakes complete and piping is wired.

```ts
import net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { vncDesResponse } from './rfb-auth.js';

export interface RfbBridgeOpts {
  clientReadable: Readable;   // bytes from noVNC
  clientWritable: Writable;   // bytes to noVNC
  vncHost: string;
  vncPort: number;
  password: string;
}

/** Read exactly n bytes from a stream (buffers across chunks). */
function readN(stream: Readable, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let have = 0;
    const onData = (d: Buffer) => {
      chunks.push(d); have += d.length;
      if (have >= n) {
        stream.off('data', onData); stream.off('error', onErr);
        const all = Buffer.concat(chunks);
        if (all.length > n) stream.unshift(all.slice(n));
        resolve(all.slice(0, n));
      }
    };
    const onErr = (e: Error) => { stream.off('data', onData); reject(e); };
    stream.on('data', onData); stream.on('error', onErr);
  });
}

export async function runRfbBridge(opts: RfbBridgeOpts): Promise<void> {
  const server = net.connect(opts.vncPort, opts.vncHost);
  await new Promise<void>((res, rej) => { server.once('connect', res); server.once('error', rej); });

  // --- Server side: authenticate with type 2 ---
  await readN(server, 12);                                  // "RFB 003.889\n"
  server.write(Buffer.from('RFB 003.008\n', 'ascii'));
  const nTypes = (await readN(server, 1))[0];
  const types = await readN(server, nTypes);
  if (!types.includes(2)) throw new Error('server does not offer VNC type-2 auth');
  server.write(Buffer.from([2]));                            // choose type 2
  const challenge = await readN(server, 16);
  server.write(vncDesResponse(opts.password, challenge));
  const secResult = await readN(server, 4);
  if (secResult.readUInt32BE(0) !== 0) throw new Error('VNC server auth failed');
  server.write(Buffer.from([1]));                            // ClientInit shared=1
  const serverInit = await readN(server, 24);               // w,h,pixfmt(16),namelen(4)
  const nameLen = serverInit.readUInt32BE(20);
  const name = nameLen > 0 ? await readN(server, nameLen) : Buffer.alloc(0);
  const fullServerInit = Buffer.concat([serverInit, name]);

  // --- Client side: present version → None → SecurityResult → ServerInit ---
  opts.clientWritable.write(Buffer.from('RFB 003.008\n', 'ascii'));
  await readN(opts.clientReadable, 12);                      // client version
  opts.clientWritable.write(Buffer.from([1, 1]));            // one type: None(1)
  await readN(opts.clientReadable, 1);                       // client picks 1
  opts.clientWritable.write(Buffer.from([0, 0, 0, 0]));      // SecurityResult OK
  await readN(opts.clientReadable, 1);                       // client ClientInit (shared)
  opts.clientWritable.write(fullServerInit);

  // --- Transparent pipe both ways ---
  opts.clientReadable.on('data', (d) => server.write(d));
  server.on('data', (d) => opts.clientWritable.write(d));
  const teardown = () => { try { server.destroy(); } catch {} };
  server.on('close', teardown);
  server.on('error', teardown);
  opts.clientReadable.on('close', teardown);
  opts.clientReadable.on('error', teardown);
}
```

- [ ] **Step 4: Run tests — confirm pass**

Run: `pnpm --filter jinn test vnc-proxy`
Expected: PASS. If `readN`/`unshift` interleaving flakes, increase `tick()` to 50ms — the state machine is event-ordered, not timing-dependent, so a green run is deterministic.

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/gateway/vnc-proxy.ts packages/jinn/src/gateway/__tests__/vnc-proxy.test.ts
git commit -m "feat(vnc): RFB auth bridge — server-side type-2, client-side None (fake-server TDD)"
```

---

### Task 8: Wire registry + VNC upgrade + timeout sweep into `server.ts`

**Files:**
- Modify: `packages/jinn/src/gateway/server.ts` (construct registry ~L687 apiContext; upgrade handler L762; emit already in scope)

- [ ] **Step 1: Construct the registry and pass it to the context.** Before `const apiContext` (~L687):

```ts
const assist = new AssistRegistry();
```

Add to the `apiContext` object literal:

```ts
  assist,
```

Import at top of `server.ts`:

```ts
import { AssistRegistry } from './assist.js';
import { runRfbBridge } from './vnc-proxy.js';
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
```

- [ ] **Step 2: Add the VNC upgrade branch** inside `server.on("upgrade", ...)` (after the pty branch, before `socket.destroy()`):

```ts
    const vncMatch = reqUrl.split("?")[0].match(/^\/api\/assist\/([^/]+)\/vnc$/);
    if (vncMatch) {
      const reqId = decodeURIComponent(vncMatch[1]);
      const rec = assist.get(reqId);
      // Gate: must be an active PENDING assist (reqId is the token).
      if (!rec || rec.status !== 'pending') { socket.destroy(); return; }
      const password = loadVncPassword(currentConfig); // 8-char, from gateway secrets
      if (!password) { socket.destroy(); return; }
      vncWss.handleUpgrade(req, socket, head, (ws) => {
        const dup = createWebSocketStream(ws);
        runRfbBridge({
          clientReadable: dup, clientWritable: dup,
          vncHost: '127.0.0.1', vncPort: 5900, password,
        }).catch((err) => {
          logger.warn(`VNC bridge failed: ${err instanceof Error ? err.message : err}`);
          try { ws.close(); } catch {}
        });
        // Auto-close when THIS assist resolves. FIX 3: scope the hook to this
        // connection and remove it on ws close so resolveHooks never accumulates.
        const off = assist.onResolve((r) => { if (r.id === reqId) { try { ws.close(); } catch {} } });
        ws.on('close', off);
      });
      return;
    }
```

Add a dedicated WS server next to `wss`/`ptyWss` (~L745) and a binary-stream helper:

```ts
  const vncWss = new WebSocketServer({ noServer: true });
```

`createWebSocketStream` is from `ws`: import `{ WebSocketServer, createWebSocketStream }` (the existing import currently brings `WebSocketServer`; add `createWebSocketStream`).

- [ ] **Step 3: Implement `loadVncPassword`** (top-level fn in `server.ts` or a tiny `vnc-secret.ts`). Reads the 8-char password from gateway secrets; never sent to the browser:

```ts
function loadVncPassword(config: any): string | null {
  // Priority: env, then ~/.jinn/secrets/api-keys.json { "vncPassword": "8chars" }
  if (process.env.JINN_VNC_PASSWORD) return process.env.JINN_VNC_PASSWORD.slice(0, 8);
  try {
    const p = `${process.env.HOME}/.jinn/secrets/api-keys.json`;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return typeof j.vncPassword === 'string' ? j.vncPassword.slice(0, 8) : null;
  } catch { return null; }
}
```

- [ ] **Step 4: Add the 10-min timeout sweep** so server status agrees with the skill. After constructing `assist`:

```ts
const assistSweep = setInterval(() => {
  // Flip pending → timed_out after 10 min; UI + GET status stay truthful.
  const now = Date.now();
  // AssistRegistry exposes records via a sweep helper:
  assist.sweepTimeouts(now, 10 * 60 * 1000);
}, 30_000);
assistSweep.unref?.();
```

Add `sweepTimeouts` to `AssistRegistry` (and a unit test in `assist.test.ts`):

```ts
  sweepTimeouts(now: number, maxAgeMs: number): string[] {
    const flipped: string[] = [];
    for (const rec of this.records.values()) {
      if (rec.status === 'pending' && now - rec.createdAt > maxAgeMs) {
        this.markTimedOut(rec.id); flipped.push(rec.id);
      }
    }
    return flipped;
  }
```

Add the test to `assist.test.ts`:

```ts
  it('sweepTimeouts flips stale pending records', () => {
    const r = reg.create({ sessionId: 's1', reason: 'x' });
    (reg.get(r.id) as any).createdAt = Date.now() - 11 * 60 * 1000;
    expect(reg.sweepTimeouts(Date.now(), 10 * 60 * 1000)).toContain(r.id);
    expect(reg.get(r.id)!.status).toBe('timed_out');
  });
```

When a sweep flips a record, also emit so the card updates live. Wrap the interval body:

```ts
const flipped = assist.sweepTimeouts(now, 10 * 60 * 1000);
for (const id of flipped) {
  const rec = assist.get(id);
  if (rec) emit('session:assist-resolved', { reqId: id, sessionId: rec.sessionId, status: 'timed_out' });
}
```

- [ ] **Step 5: Typecheck + full server test run**

Run: `pnpm --filter jinn typecheck && pnpm --filter jinn test`
Expected: PASS (assist, assist-routes, rfb-auth, vnc-proxy, sweep test all green; server.ts typechecks with `assist` now provided to `ApiContext`).

- [ ] **Step 6: Commit**

```bash
git add packages/jinn/src/gateway/server.ts packages/jinn/src/gateway/assist.ts packages/jinn/src/gateway/__tests__/assist.test.ts
git commit -m "feat(vnc): gate /api/assist/:id/vnc upgrade on pending assist + timeout sweep + teardown"
```

---

### Task 9: noVNC takeover modal (real `TakeoverModal`)

**Files:**
- Modify: `packages/web/src/components/chat/takeover-modal.tsx` (replace the Task-5 stub)
- Modify: `packages/web/package.json` — add `@novnc/novnc`
- Test: `packages/web/src/components/chat/__tests__/takeover-modal.test.tsx`

- [ ] **Step 1: Add the dep**

```bash
pnpm --filter web add @novnc/novnc
```

- [ ] **Step 2: Write the failing test** (mock noVNC so jsdom doesn't need canvas/WebGL):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const rfbInstances: any[] = [];
vi.mock('@novnc/novnc/core/rfb', () => ({
  default: class { _events: any = {};
    constructor(public target: any, public url: string) { rfbInstances.push(this); }
    addEventListener(e: string, cb: any) { this._events[e] = cb; }
    disconnect() { this.disconnected = true; }
    disconnected = false;
  },
}));

import { TakeoverModal } from '../takeover-modal';

beforeEach(() => { rfbInstances.length = 0; });

describe('TakeoverModal', () => {
  it('builds a wss assist vnc url and connects', async () => {
    render(<TakeoverModal reqId="r9" onResume={() => {}} onClose={() => {}} />);
    // RFB constructed lazily on mount
    await Promise.resolve();
    expect(rfbInstances.length).toBe(1);
    expect(rfbInstances[0].url).toMatch(/\/api\/assist\/r9\/vnc$/);
    expect(rfbInstances[0].url).toMatch(/^wss?:\/\//);
  });

  it('Resume agent disconnects and calls onResume', async () => {
    const onResume = vi.fn();
    render(<TakeoverModal reqId="r9" onResume={onResume} onClose={() => {}} />);
    await Promise.resolve();
    fireEvent.click(screen.getByRole('button', { name: /resume agent/i }));
    expect(onResume).toHaveBeenCalled();
    expect(rfbInstances[0].disconnected).toBe(true);
  });
});
```

- [ ] **Step 3: Run it — confirm it fails**

Run: `pnpm --filter web test takeover-modal`
Expected: FAIL — stub renders null, no RFB.

- [ ] **Step 4: Implement** `packages/web/src/components/chat/takeover-modal.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

function vncUrl(reqId: string): string {
  const gw = process.env.NEXT_PUBLIC_GATEWAY_URL;
  if (gw) return `${gw.replace(/^http/, 'ws')}/api/assist/${reqId}/vnc`;
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/assist/${reqId}/vnc`;
  }
  return `ws://127.0.0.1:7777/api/assist/${reqId}/vnc`;
}

export function TakeoverModal(props: { reqId: string; onResume: () => void; onClose: () => void }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);

  useEffect(() => {
    let disposed = false;
    (async () => {
      const { default: RFB } = await import('@novnc/novnc/core/rfb');
      if (disposed || !screenRef.current) return;
      // Server-side auth presents security-type None → no credentials in the browser.
      const rfb = new RFB(screenRef.current, vncUrl(props.reqId));
      rfb.scaleViewport = true;
      rfb.clipViewport = false;
      rfb.focusOnClick = true;
      rfbRef.current = rfb;
    })();
    return () => {
      disposed = true;
      try { rfbRef.current?.disconnect(); } catch {}
    };
  }, [props.reqId]);

  function resume() {
    try { rfbRef.current?.disconnect(); } catch {}
    props.onResume();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <DialogContent className="max-w-[90vw]">
        <DialogHeader><DialogTitle>Screen takeover — Mac mini</DialogTitle></DialogHeader>
        <div ref={screenRef} className="h-[70vh] w-full overflow-hidden rounded bg-black" />
        <div className="mt-2 flex justify-end gap-2">
          <button className="rounded bg-green-600 px-4 py-1.5 text-white" onClick={resume}>Resume agent</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Run tests — confirm pass**

Run: `pnpm --filter web test takeover-modal`
Expected: PASS (2 tests).

- [ ] **Step 6: Vite build sanity** (ensure the dynamic import + dep resolve):

Run: `pnpm --filter web build`
Expected: build succeeds; `@novnc/novnc` lands in a lazy chunk (not the main bundle).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/chat/takeover-modal.tsx packages/web/package.json pnpm-lock.yaml packages/web/src/components/chat/__tests__/takeover-modal.test.tsx
git commit -m "feat(web): inline noVNC takeover modal (lazy-loaded, server-side auth)"
```

---

### Task 10: Ops — enable legacy VNC + harden 5900

**Files:**
- Create: `packages/jinn/scripts/enable-vnc-legacy.sh`
- Create: `packages/jinn/scripts/pf-restrict-5900.sh`
- Create: `packages/jinn/scripts/com.jinn.pf-5900.plist`

> These run on the mini with sudo during the verify phase. They are scripted +
> documented, not auto-run by the gateway.

- [ ] **Step 1: Write `enable-vnc-legacy.sh`** (enable type-2 + set 8-char password, then re-probe):

```bash
#!/usr/bin/env bash
set -euo pipefail
PW="${1:?usage: enable-vnc-legacy.sh <8-char-password>}"
[ "${#PW}" -le 8 ] || { echo "password must be <= 8 chars (VNC legacy limit)"; exit 1; }
KS="/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart"
echo ">> enabling ARD/VNC legacy with password..."
sudo "$KS" -activate -configure \
  -clientopts -setvnclegacy -vnclegacy yes \
  -clientopts -setvncpw -vncpw "$PW" \
  -restart -agent -privs -all
echo ">> storing password in gateway secrets..."
SECRETS="$HOME/.jinn/secrets/api-keys.json"
node -e "const fs=require('fs');const p=process.env.HOME+'/.jinn/secrets/api-keys.json';const j=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};j.vncPassword=process.argv[1];fs.writeFileSync(p,JSON.stringify(j,null,2));" "$PW"
echo ">> re-probing security types (expect a 2 to appear)..."
node packages/jinn/scripts/rfb-probe.mjs || true
echo ">> If type 2 is NOT listed, kickstart did not enable legacy VNC on this macOS version."
echo "   Fallback: System Settings → General → Sharing → Screen Sharing (i) →"
echo "   'VNC viewers may control screen with password' → set 8-char pw, re-run probe."
echo "   If still no type-2, fall back to D1-Option-A (client-side password)."
```

Also create `packages/jinn/scripts/rfb-probe.mjs` (the probe used in recon, reusable):

```js
import net from 'net';
const s = net.connect(5900, '127.0.0.1');
let stage = 0;
s.on('data', (buf) => {
  if (stage === 0) { s.write('RFB 003.008\n'); stage = 1; return; }
  const count = buf[0];
  console.log('security types:', Array.from(buf.slice(1, 1 + count)));
  console.log(buf.slice(1, 1 + count).includes(2) ? 'TYPE 2 PRESENT ✅' : 'TYPE 2 ABSENT ❌');
  s.destroy(); process.exit(0);
});
s.on('error', (e) => { console.log('probe error:', e.message); process.exit(1); });
```

- [ ] **Step 2: Write `pf-restrict-5900.sh` + LaunchDaemon** (restrict 5900 to localhost, reversible, reboot-persistent). The pf anchor blocks inbound 5900 on **non-loopback** interfaces so only the gateway (localhost → 127.0.0.1:5900) reaches screensharingd. **FIX 1:** the rule is scoped `on !lo0` — a bare `from any to any port 5900` would also match lo0 and sever the gateway's own loopback connection, breaking takeover. Tailscale arrives on `utun*`, so `!lo0` still blocks the tailnet while leaving loopback open.

`packages/jinn/scripts/pf-restrict-5900.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ANCHOR="/etc/pf.anchors/com.jinn.vnc"
# Block 5900 on every interface EXCEPT loopback (gateway reaches screensharingd via 127.0.0.1).
echo "block in quick on !lo0 proto tcp from any to any port 5900" | sudo tee "$ANCHOR" >/dev/null
if ! grep -q 'com.jinn.vnc' /etc/pf.conf; then
  echo 'anchor "com.jinn.vnc"' | sudo tee -a /etc/pf.conf >/dev/null
  echo 'load anchor "com.jinn.vnc" from "/etc/pf.anchors/com.jinn.vnc"' | sudo tee -a /etc/pf.conf >/dev/null
fi
sudo pfctl -f /etc/pf.conf -e 2>/dev/null || sudo pfctl -f /etc/pf.conf
echo ">> 5900 now blocked on non-loopback interfaces."
echo ">> REVERT: remove the two com.jinn.vnc lines from /etc/pf.conf, 'sudo rm $ANCHOR', 'sudo pfctl -f /etc/pf.conf'."
```

`packages/jinn/scripts/com.jinn.pf-5900.plist` (LaunchDaemon → reload anchor at boot so it persists):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jinn.pf-5900</string>
  <key>RunAtLoad</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>/sbin/pfctl</string><string>-f</string><string>/etc/pf.conf</string><string>-e</string>
  </array>
</dict></plist>
```

Install line (documented, run once): `sudo cp packages/jinn/scripts/com.jinn.pf-5900.plist /Library/LaunchDaemons/ && sudo launchctl load /Library/LaunchDaemons/com.jinn.pf-5900.plist`

> If pf persistence proves fragile on this macOS build (SIP / pf.conf reset on
> update), STOP and report to COO — fall back to flagging instead of forcing it.
> The VNC-upgrade gate is the primary control regardless of pf.

- [ ] **Step 3: Commit the scripts** (do NOT run them here — they need sudo + are part of Phase C verify):

```bash
chmod +x packages/jinn/scripts/enable-vnc-legacy.sh packages/jinn/scripts/pf-restrict-5900.sh
git add packages/jinn/scripts/
git commit -m "feat(ops): scripted VNC legacy enable (+ re-probe) and pf 5900 hardening"
```

---

## PHASE C — Verification (real end-to-end)

> Not a code task — a checklist run on the mini. Report results to COO before merge.

- [ ] **V1 — enable legacy VNC:** `bash packages/jinn/scripts/enable-vnc-legacy.sh <8charpw>` → probe must print `TYPE 2 PRESENT ✅`. If absent, follow the documented fallback / report (R2).
- [ ] **V2 — build + restart gateway:** `pnpm build && <restart gateway>`; confirm the `request-human-help` skill symlinked and the web bundle has the assist card.
- [ ] **V3 — trigger an assist from a test session:** `curl -s -X POST http://0.0.0.0:7777/api/sessions/<sid>/assist/request -d '{"reason":"verify takeover","url":"http://example.com"}'`. Confirm: card appears in chat live; reload page → card still there (persisted); Slack `#work-items` pinged (or noted absent).
- [ ] **V4 — take control:** click [Take control] → noVNC modal shows the mini's live screen; mouse/keyboard work. Confirm the tunnel only opens while pending (try the `wss` URL after resolve → upgrade rejected).
- [ ] **V5 — resume:** click [Resume agent] → card flips to ✅ Resolved; tunnel closes; a polling agent's `GET` returns `resolved`.
- [ ] **V6 — timeout path:** create an assist, wait >10 min (or temporarily lower the sweep window) → card shows ⏱️ timed out; `GET` returns `timed_out`.
- [ ] **V7 — hardening (BOTH must pass after pf is applied):**
  - (a) **Loopback still open:** trigger a takeover → noVNC modal still shows the live screen (gateway → `127.0.0.1:5900` not severed by the `!lo0` rule). If this fails, FIX 1 regressed — the rule is matching loopback.
  - (b) **Tailnet refused:** from the *other* Mac, `nc -vz jimmys-mac-mini.tail0b18b3.ts.net 5900` → connection refused/timed out. Direct VNC over the tailnet is blocked; takeover only works through the gateway WS.
- [ ] **V8 — full suite:** `pnpm test && pnpm typecheck && pnpm lint` all green.

---

## Self-Review (done)

- **Spec coverage:** L1 routes (T3) ✓, registry storage = Map (T2) ✓, persisted card (T1/T3/T5) ✓, skill + poll/timeout (T4/T8) ✓, web card + resume (T5) ✓, kickstart step-0 + re-probe (T10/V1) ✓, RFB bridge type-2↔None (T6/T7) ✓, upgrade gate + teardown (T8) ✓, noVNC modal server-side auth (T9) ✓, pf hardening + persistence (T10/V7) ✓, no-app-auth flagged (spec) ✓.
- **Placeholder scan:** none — every code step has real code; DES vector is verified; kickstart/pf have explicit fallbacks rather than TODOs.
- **Type consistency:** `AssistRecord`/`AssistStatus` (T1) used identically in T2/T3/T8; `MessageMedia` variant fields (`reqId`,`reason`,`status`) consistent T1↔T3↔T5; `runRfbBridge`/`vncDesResponse`/`reverseBits` signatures match across T6/T7/T8; `handleAssistRoutes` signature matches T3 test and api.ts wiring.
