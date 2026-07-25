import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  buildSearchTools,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_DEFAULT,
  SNIPPET_CHAR_CAP,
  SESSION_SEARCH_LIMIT_MAX,
  SESSION_SEARCH_LIMIT_DEFAULT,
  CONTEXT_RADIUS_MAX,
  QUERY_CHAR_CAP,
} from "../search-tools.js";
import { buildTools } from "../server.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

/**
 * GRS-020a — the company-reference search tool group.
 *
 * Three tiers (the GRS-015/017 pattern):
 *   1. UNIT — every tool against a stub fetch: exact route/query-string, local
 *      validation refusals (role/status enums, ISO timestamps, at-least-one-
 *      filter), caps + clamps, decision-shaped hints, structured error
 *      pass-through, privileged-read capability binding.
 *   2. INJECTION SAFETY — hostile FTS/SQL input driven through the REAL route +
 *      registry: never a MATCH syntax error, never SQL injection, tables intact.
 *   3. INTEGRATION — the operator headline against the real gateway routes +
 *      registry (temp JINN_HOME): seed history → search messages (anchored
 *      hits) → get context (radius + caps) → search sessions by
 *      employee/status/needsAttention; route negatives (400/404 shapes).
 */

// Isolated registry DB for the integration tier. Set BEFORE the dynamic api import.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-search-home-"));

/* ── Unit-tier stub fetch ───────────────────────────────────────────────────── */

interface SeenCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function stub(
  responder: (call: SeenCall) => { status: number; body: unknown },
  callerSessionId: string | null = "session-test",
  sessionCapability = callerSessionId ? "cap-test" : undefined,
) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: JinnMcpContext = {
    gatewayUrl: "http://127.0.0.1:7777",
    fetchFn,
    ...(callerSessionId ? { callerSessionId } : {}),
    ...(sessionCapability ? { sessionCapability } : {}),
  };
  return { calls, ctx };
}

function tool(name: string): JinnMcpTool {
  const t = buildSearchTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("search tools — registry + schemas", () => {
  it("exposes the 3 reference tools with flat schemas and correct required args", () => {
    const tools = buildSearchTools();
    expect(tools.map((t) => t.name)).toEqual([
      "search_messages",
      "search_sessions",
      "get_message_context",
    ]);
    expect(tool("search_messages").inputSchema.required).toEqual(["query"]);
    expect(tool("search_sessions").inputSchema.required).toBeUndefined();
    expect(tool("get_message_context").inputSchema.required).toEqual(["sessionId", "messageId"]);
    // Flat schemas only: every property is a primitive type.
    for (const t of tools) {
      for (const prop of Object.values(t.inputSchema.properties) as Array<{ type?: string }>) {
        expect(["string", "number", "boolean"]).toContain(prop.type);
      }
    }
  });

  it("the belt registers the search group — 53 tools total", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).toContain("search_messages");
    expect(names).toContain("search_sessions");
    expect(names).toContain("get_message_context");
    expect(names).toContain("cancel_workflow_run");
    expect(names).toHaveLength(63);
  });

  it("domain teaching lives on search_messages; the others stay short", () => {
    expect(tool("search_messages").description).toMatch(/own session excluded/i);
    expect(tool("search_messages").description).toMatch(/snippets only/i);
    expect(tool("get_message_context").description).toMatch(/search_messages hit/i);
  });
});

describe("search tools — unit (stub gateway)", () => {
  it("search_messages GETs the search route with encoded params and clamps the limit", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { results: [] } }));
    await tool("search_messages").handler(
      { query: "budget approved?", employee: "Alpha-Dev", role: "assistant", since: "2026-07-01T00:00:00Z", limit: 999 },
      ctx,
    );
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/search/messages");
    expect(url.searchParams.get("q")).toBe("budget approved?");
    expect(url.searchParams.get("employee")).toBe("Alpha-Dev");
    expect(url.searchParams.get("role")).toBe("assistant");
    expect(url.searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe(String(SEARCH_LIMIT_MAX));
    expect(url.searchParams.has("sessionId")).toBe(false);
  });

  it("SELF-EXCLUSION default (finding 1): with caller identity the URL carries excludeSessionId; explicit sessionId or includeOwnSession opts out", async () => {
    // Identity present, no explicit scope → exclude own session.
    const withId = stub(() => ({ status: 200, body: { results: [] } }), "my-sess");
    await tool("search_messages").handler({ query: "x" }, withId.ctx);
    expect(new URL(withId.calls[0].url).searchParams.get("excludeSessionId")).toBe("my-sess");

    // includeOwnSession: true → no exclusion.
    await tool("search_messages").handler({ query: "x", includeOwnSession: true }, withId.ctx);
    expect(new URL(withId.calls[1].url).searchParams.has("excludeSessionId")).toBe(false);

    // Explicit sessionId (even the caller's own) → explicit scope wins, no exclusion param.
    await tool("search_messages").handler({ query: "x", sessionId: "my-sess" }, withId.ctx);
    const explicit = new URL(withId.calls[2].url);
    expect(explicit.searchParams.get("sessionId")).toBe("my-sess");
    expect(explicit.searchParams.has("excludeSessionId")).toBe(false);

    const anon = stub(() => ({ status: 200, body: { results: [] } }), null);
    await expect(tool("search_messages").handler({ query: "x" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(anon.calls).toHaveLength(0);
  });

  it("the zero-hit hint teaches the own-session exclusion when it applied", async () => {
    const { ctx } = stub(() => ({ status: 200, body: { results: [] } }), "my-sess");
    const excluded = (await tool("search_messages").handler({ query: "x" }, ctx)) as { hint: string };
    expect(excluded.hint).toContain("includeOwnSession");
    const notExcluded = (await tool("search_messages").handler({ query: "x", includeOwnSession: true }, ctx)) as { hint: string };
    expect(notExcluded.hint).not.toContain("includeOwnSession");
  });

  it("LENGTH CAPS (finding 3): an over-long query/text is a structured tool error BEFORE any HTTP call — never a raw 431", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { results: [], sessions: [] } }));
    await expect(tool("search_messages").handler({ query: "z".repeat(QUERY_CHAR_CAP + 1) }, ctx)).rejects.toThrow(
      /query is too long \(513 chars, max 512\).*shorten/,
    );
    await expect(tool("search_sessions").handler({ text: "z".repeat(10_000) }, ctx)).rejects.toThrow(/text is too long/);
    await expect(tool("search_messages").handler({ query: "ok", employee: "e".repeat(300) }, ctx)).rejects.toThrow(
      /employee is too long/,
    );
    expect(calls).toHaveLength(0);
    // At the cap is fine.
    await tool("search_messages").handler({ query: "z".repeat(QUERY_CHAR_CAP) }, ctx);
    expect(calls).toHaveLength(1);
  });

  it("search_messages defaults the limit and refuses bad role / bad ISO locally (no round trip)", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { results: [] } }));
    await tool("search_messages").handler({ query: "x" }, ctx);
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe(String(SEARCH_LIMIT_DEFAULT));

    await expect(tool("search_messages").handler({ query: "x", role: "notification" }, ctx)).rejects.toThrow(/role must be/);
    await expect(tool("search_messages").handler({ query: "x", since: "not-a-date" }, ctx)).rejects.toThrow(/ISO-8601/);
    expect(calls).toHaveLength(1); // the two refusals never reached the gateway
  });

  it("search_messages caps runaway snippets defensively and hints the context hop", async () => {
    const { ctx } = stub(() => ({
      status: 200,
      body: {
        results: [
          { messageId: "m1", sessionId: "s1", role: "assistant", timestamp: 5, employee: "e", engine: "codex", snippet: "y".repeat(1000) },
        ],
      },
    }));
    const out = (await tool("search_messages").handler({ query: "y" }, ctx)) as {
      results: Array<{ snippet: string }>;
      hint: string;
    };
    expect(out.results[0].snippet.length).toBeLessThanOrEqual(SNIPPET_CHAR_CAP + 1);
    expect(out.hint).toContain("get_message_context");
  });

  it("search_sessions refuses an empty filter locally and validates the status enum", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { sessions: [] } }));
    await expect(tool("search_sessions").handler({}, ctx)).rejects.toThrow(/at least one filter/i);
    await expect(tool("search_sessions").handler({ status: "zombie" }, ctx)).rejects.toThrow(/status must be one of/);
    expect(calls).toHaveLength(0);
  });

  it("search_sessions builds the query string (incl. needsAttention) and returns compact summaries", async () => {
    const { calls, ctx } = stub(() => ({
      status: 200,
      body: {
        sessions: [
          {
            id: "s1", title: "T", employee: "e", engine: "codex", status: "error",
            lastActivity: "2026-07-05T00:00:00.000Z", parentSessionId: null,
            messages: [{ role: "user", content: "MUST NOT LEAK" }], promptExcerpt: "secret-ish",
          },
        ],
      },
    }));
    const out = (await tool("search_sessions").handler({ needsAttention: true, engine: "codex", limit: 999 }, ctx)) as {
      sessions: Array<Record<string, unknown>>;
    };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/search/sessions");
    expect(url.searchParams.get("needsAttention")).toBe("true");
    expect(url.searchParams.get("engine")).toBe("codex");
    expect(url.searchParams.get("limit")).toBe(String(SESSION_SEARCH_LIMIT_MAX));
    expect(out.sessions[0]).toEqual({
      id: "s1", title: "T", employee: "e", engine: "codex", status: "error",
      lastActivity: "2026-07-05T00:00:00.000Z", parentSessionId: null,
    }); // summaries only — no message bodies, no excerpt
  });

  it("search_sessions zero-match hint teaches self-correction (valid statuses + where to look next)", async () => {
    const { ctx } = stub(() => ({ status: 200, body: { sessions: [] } }));
    const out = (await tool("search_sessions").handler({ employee: "tpyo-dev" }, ctx)) as { hint: string };
    expect(out.hint).toMatch(/idle, running, error, waiting, interrupted/);
    expect(out.hint).toContain("find_employees");
  });

  it("get_message_context GETs the context route with the anchor + clamped radius and passes 404s through readable", async () => {
    const { calls, ctx } = stub(() => ({
      status: 200,
      body: { session: { id: "s1", engine: "codex" }, anchorMessageId: "m7", messages: [{ id: "m7", isAnchor: true }] },
    }));
    const out = (await tool("get_message_context").handler({ sessionId: "s/1", messageId: "m7", radius: 999 }, ctx)) as {
      anchorMessageId: string;
    };
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/sessions/s%2F1/context"); // id is URL-encoded
    expect(url.searchParams.get("message")).toBe("m7");
    expect(url.searchParams.get("radius")).toBe(String(CONTEXT_RADIUS_MAX));
    expect(out.anchorMessageId).toBe("m7");

    const notFound = stub(() => ({ status: 404, body: { error: 'message "mX" not found in session "s1" — anchors come from message-search results' } }));
    await expect(tool("get_message_context").handler({ sessionId: "s1", messageId: "mX" }, notFound.ctx)).rejects.toThrow(
      /anchors come from message-search results/,
    );
  });

  it("READ TIER: all three tools require a bound capability and every gateway call carries the marker + capability", async () => {
    const anon = stub(() => ({ status: 200, body: { results: [], sessions: [], messages: [] } }), null);
    await expect(tool("search_messages").handler({ query: "q" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    await expect(tool("search_sessions").handler({ engine: "codex" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    await expect(tool("get_message_context").handler({ sessionId: "s", messageId: "m" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(anon.calls).toHaveLength(0);

    const withId = stub(() => ({ status: 200, body: { results: [] } }), "sess-9");
    await tool("search_messages").handler({ query: "q" }, withId.ctx);
    expect(withId.calls[0].headers[TOOL_CALL_HEADER]).toBe(TOOL_CALL_HEADER_VALUE);
    expect(withId.calls[0].headers[CALLER_SESSION_HEADER]).toBe("sess-9");
    expect(withId.calls[0].headers[CALLER_SESSION_CAPABILITY_HEADER]).toBe("cap-test");
  });
});

/* ── Integration: the tools drive the REAL search routes + registry ─────────── */

type Api = typeof import("../../gateway/api.js");
let api: Api;
type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;
let integrationCallerId: string;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../../gateway/api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? [Buffer.from(init.body)] : [];
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const req = Object.assign(Readable.from(body), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

function ctxFor(callerSessionId = integrationCallerId): JinnMcpContext {
  return { gatewayUrl: "http://gateway.test", fetchFn: apiFetch(), callerSessionId, sessionCapability: ensureSessionCapability(callerSessionId) };
}

/** Seed a session + return its id (registry-direct — engines are out of scope). */
function seedSession(fields: { employee?: string; engine?: string; status?: string; title?: string; prompt?: string }): string {
  const s = registry.createSession({
    engine: fields.engine ?? "codex",
    source: "web",
    sourceRef: `web:${Math.random().toString(36).slice(2)}`,
    employee: fields.employee ?? null,
    title: fields.title,
    prompt: fields.prompt,
  });
  if (fields.status && fields.status !== "idle") {
    registry.updateSession(s.id, { status: fields.status as never });
  }
  return s.id;
}

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
  integrationCallerId = seedSession({ employee: "search-caller", engine: "codex", title: "Search caller" });
});

describe("search tools — integration against the real routes/registry", () => {
  it("the operator headline: seed a decision in one session → find it → pull its context → find the session by employee+status", async () => {
    const ctx = ctxFor();
    const decisionSession = seedSession({ employee: "alpha-dev", engine: "codex", title: "Pricing decision" });
    registry.insertMessage(decisionSession, "user", "what did we decide on the axolotl pricing tier?");
    registry.insertMessage(decisionSession, "assistant", "the axolotl pricing tier was APPROVED at 19 euro");
    registry.insertMessage(decisionSession, "assistant", "next step: implement the checkout");
    seedSession({ employee: "gamma-dev", engine: "claude", title: "Unrelated" });

    // 1. Search finds the decision with an actionable anchor.
    const found = (await tool("search_messages").handler({ query: "axolotl pricing" }, ctx)) as {
      results: Array<{ messageId: string; sessionId: string; snippet: string; employee: string }>;
    };
    expect(found.results.length).toBe(2);
    expect(found.results.every((r) => r.sessionId === decisionSession)).toBe(true);
    expect(found.results.every((r) => r.employee === "alpha-dev")).toBe(true);
    const hit = found.results.find((r) => r.snippet.includes("APPROVED"))!;
    expect(hit.snippet).toContain("«axolotl»");

    // Narrowing by employee/role works through the real join.
    const narrowed = (await tool("search_messages").handler({ query: "axolotl", employee: "alpha-dev", role: "user" }, ctx)) as {
      results: Array<{ role: string }>;
    };
    expect(narrowed.results.map((r) => r.role)).toEqual(["user"]);

    // 2. The anchor expands into its surrounding context, anchor flagged.
    const context = (await tool("get_message_context").handler(
      { sessionId: hit.sessionId, messageId: hit.messageId, radius: 1 },
      ctx,
    )) as { anchorMessageId: string; messages: Array<{ content: string; isAnchor: boolean }>; session: { id: string } };
    expect(context.anchorMessageId).toBe(hit.messageId);
    expect(context.messages).toHaveLength(3);
    expect(context.messages[1].isAnchor).toBe(true);
    expect(context.messages[1].content).toContain("APPROVED at 19 euro");
    expect(context.session.id).toBe(decisionSession);

    // 3. Session search by employee finds the source session (summaries only).
    const sessions = (await tool("search_sessions").handler({ employee: "alpha-dev" }, ctx)) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(sessions.sessions.map((s) => s.id)).toContain(decisionSession);
    for (const s of sessions.sessions) expect(s).not.toHaveProperty("messages");
  });

  it("needsAttention surfaces error/interrupted sessions and text search matches the title", async () => {
    const ctx = ctxFor();
    const broken = seedSession({ employee: "qa-attn", status: "error", title: "Broken deploy kerfuffle" });
    seedSession({ employee: "qa-attn", status: "waiting", title: "Waiting on limits" });

    const attn = (await tool("search_sessions").handler({ employee: "qa-attn", needsAttention: true }, ctx)) as {
      sessions: Array<{ id: string; status: string }>;
    };
    expect(attn.sessions.map((s) => s.id)).toEqual([broken]);

    const byText = (await tool("search_sessions").handler({ text: "kerfuffle" }, ctx)) as {
      sessions: Array<{ id: string }>;
    };
    expect(byText.sessions.map((s) => s.id)).toEqual([broken]);
  });

  it("INJECTION SAFETY through the real route: hostile FTS/SQL input never errors and never mutates", async () => {
    const ctx = ctxFor();
    const sid = seedSession({ employee: "inj-qa", title: "Injection fixture" });
    registry.insertMessage(sid, "assistant", "the wombat ledger is safe");

    const hostile = [
      `wombat"; DROP TABLE messages; --`,
      `* NEAR( - "unbalanced`,
      `'; SELECT * FROM sessions; --`,
      `(a OR b) AND c*`,
      `"" ""`,
    ];
    for (const q of hostile) {
      // Tool-level: resolves (possibly zero hits) — never a MATCH/SQL error.
      const out = (await tool("search_messages").handler({ query: q, sessionId: sid }, ctx)) as { results: unknown[] };
      expect(Array.isArray(out.results)).toBe(true);
    }
    // A 10 KB query is refused by the finding-3 length cap with a STRUCTURED
    // error (never a raw HTTP 431) — that refusal IS the hardened behavior.
    await expect(tool("search_messages").handler({ query: "x".repeat(10_000), sessionId: sid }, ctx)).rejects.toThrow(
      /too long.*shorten/,
    );
    // The sanitizer phrases tokens: the honest word still matches…
    const ok = (await tool("search_messages").handler({ query: `wombat" ledger`, sessionId: sid }, ctx)) as {
      results: Array<{ snippet: string }>;
    };
    expect(ok.results).toHaveLength(1);
    // …and the tables survived the "DROP TABLE" text.
    expect(registry.getMessages(sid)).toHaveLength(1);
    // The %/_ literal contract holds through the real session-search route too.
    const like = (await tool("search_sessions").handler({ text: "%" }, ctx)) as { sessions: unknown[] };
    expect(like.sessions).toHaveLength(0); // no seeded title contains a literal %
  });

  it("route negatives: 400s for missing/invalid params, 404s for unknown session/message — all readable through the tools", async () => {
    const ctx = ctxFor();
    const sid = seedSession({ title: "Negatives" });
    registry.insertMessage(sid, "assistant", "present message");

    // Raw route: q is required; invalid role/since are 400s.
    const raw = apiFetch();
    expect((await raw("http://gateway.test/api/search/messages", {})).status).toBe(400);
    expect((await raw(`http://gateway.test/api/search/messages?q=x&role=tool`, {})).status).toBe(400);
    expect((await raw(`http://gateway.test/api/search/messages?q=x&since=garbage`, {})).status).toBe(400);
    expect((await raw(`http://gateway.test/api/search/sessions`, {})).status).toBe(400);
    expect((await raw(`http://gateway.test/api/search/sessions?status=zombie`, {})).status).toBe(400);

    // Context: unknown session vs unknown message are distinct readable 404s.
    await expect(tool("get_message_context").handler({ sessionId: "no-such", messageId: "m" }, ctx)).rejects.toThrow(/404/);
    await expect(tool("get_message_context").handler({ sessionId: sid, messageId: "no-such-msg" }, ctx)).rejects.toThrow(
      /anchors come from message-search results/,
    );
    // An anchor from ANOTHER session must not leak across.
    const otherSid = seedSession({ title: "Other" });
    const otherMsg = registry.getMessages(sid)[0].id;
    await expect(tool("get_message_context").handler({ sessionId: otherSid, messageId: otherMsg }, ctx)).rejects.toThrow(/404/);
  });

  it("FINDING 1 repro: an agent whose OWN prompt contains the term still gets the OTHER session's hit (self-exclusion default), and includeOwnSession opts back in", async () => {
    // The seeded historical decision lives in another session…
    const decisionSid = seedSession({ employee: "hist-owner", title: "Historical decision" });
    registry.insertMessage(decisionSid, "assistant", "the tamarin rollout was approved yesterday");
    // …and the CALLER's own session contains the search term in its prompt —
    // newer than the decision, so unexcluded it would be the top hit (the bug).
    const callerSid = seedSession({ employee: "searcher", title: "Caller" });
    registry.insertMessage(callerSid, "user", "please search for: tamarin rollout approved");
    const ctx = ctxFor(callerSid);

    const found = (await tool("search_messages").handler({ query: "tamarin rollout approved" }, ctx)) as {
      results: Array<{ sessionId: string }>;
    };
    expect(found.results.length).toBe(1);
    expect(found.results[0].sessionId).toBe(decisionSid); // NOT the caller's own prompt
    expect(found.results.every((r) => r.sessionId !== callerSid)).toBe(true);

    // Opt-in returns both (order under identical-ms timestamps is a tie —
    // assert membership, not order).
    const withOwn = (await tool("search_messages").handler({ query: "tamarin rollout approved", includeOwnSession: true }, ctx)) as {
      results: Array<{ sessionId: string }>;
    };
    expect(withOwn.results.map((r) => r.sessionId).sort()).toEqual([callerSid, decisionSid].sort());

    // Explicit own-session scope also works (explicit intent beats the default).
    const scoped = (await tool("search_messages").handler({ query: "tamarin", sessionId: callerSid }, ctx)) as {
      results: Array<{ sessionId: string }>;
    };
    expect(scoped.results.map((r) => r.sessionId)).toEqual([callerSid]);
  });

  it("FINDING 2 repro: %00 and control bytes through the REAL route → 200 normal result, never 500", async () => {
    const sid = seedSession({ title: "Nul fixture" });
    registry.insertMessage(sid, "assistant", "the alpaca-token is stored safely");
    const raw = apiFetch();

    // The reviewer's exact shape: q=<term>%00.
    const trailing = await raw(`http://gateway.test/api/search/messages?q=${encodeURIComponent("alpaca-token\u0000")}`, {});
    expect(trailing.status).toBe(200);
    expect((JSON.parse(await trailing.text()) as { results: unknown[] }).results.length).toBe(1);

    // NUL-only and scattered control bytes → 400 (q empty after cleaning) or 200 empty — never 500.
    const nulOnly = await raw(`http://gateway.test/api/search/messages?q=%00`, {});
    expect(nulOnly.status).toBe(400);
    const scattered = await raw(`http://gateway.test/api/search/messages?q=${encodeURIComponent("\u0001alpaca\u0000token\u001f")}`, {});
    expect(scattered.status).toBe(200);
    // Control bytes in filters are cleaned too.
    const inFilter = await raw(
      `http://gateway.test/api/search/messages?q=alpaca&employee=${encodeURIComponent("x\u0000y")}`,
      {},
    );
    expect(inFilter.status).toBe(200);
    // Session text search likewise.
    const inText = await raw(`http://gateway.test/api/search/sessions?text=${encodeURIComponent("Nul\u0000fixture")}`, {});
    expect(inText.status).toBe(200);
  });

  it("FINDING 3 route backstop: an over-long q/text is a clean 400, and the route caps sit above the tool caps", async () => {
    const raw = apiFetch();
    const long = "z".repeat(2000);
    const longQ = await raw(`http://gateway.test/api/search/messages?q=${long}`, {});
    expect(longQ.status).toBe(400);
    expect(await longQ.text()).toMatch(/too long/);
    const longText = await raw(`http://gateway.test/api/search/sessions?text=${long}`, {});
    expect(longText.status).toBe(400);
  });

  it("FINDING 4 through the real route: backslash is a literal in session text search", async () => {
    seedSession({ employee: "bs-owner", title: "config path C:\\jinn\\bin fixture" });
    const ctx = ctxFor();
    const hit = (await tool("search_sessions").handler({ text: "C:\\jinn\\bin" }, ctx)) as { sessions: Array<{ title: string }> };
    expect(hit.sessions).toHaveLength(1);
    expect(hit.sessions[0].title).toContain("C:\\jinn\\bin");
    const miss = (await tool("search_sessions").handler({ text: "C:\\jinn\\missing" }, ctx)) as { sessions: unknown[] };
    expect(miss.sessions).toHaveLength(0);
  });

  it("FINDING 5: the ROUTES themselves return only the compact documented fields — no full serialized session", async () => {
    const sid = seedSession({ employee: "compact-owner", title: "Compact fixture" });
    registry.insertMessage(sid, "assistant", "compact axolotl row");
    const raw = apiFetch();
    const COMPACT_KEYS = ["id", "title", "employee", "engine", "status", "lastActivity", "parentSessionId"].sort();

    const search = JSON.parse(await (await raw(`http://gateway.test/api/search/sessions?employee=compact-owner`, {})).text()) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(search.sessions).toHaveLength(1);
    expect(Object.keys(search.sessions[0]).sort()).toEqual(COMPACT_KEYS);

    const msgId = registry.getMessages(sid)[0].id;
    const context = JSON.parse(
      await (await raw(`http://gateway.test/api/sessions/${sid}/context?message=${msgId}`, {})).text(),
    ) as { session: Record<string, unknown> };
    expect(Object.keys(context.session).sort()).toEqual(COMPACT_KEYS);
  });

  it("caps hold through the real route: search limit ≤ 20 and context bodies carry the intentional-cap marker", async () => {
    const ctx = ctxFor();
    const sid = seedSession({ title: "Caps" });
    for (let i = 0; i < 30; i++) registry.insertMessage(sid, "assistant", `pangolin item ${i}`);
    const hits = (await tool("search_messages").handler({ query: "pangolin", limit: 999 }, ctx)) as { results: unknown[] };
    expect(hits.results).toHaveLength(SEARCH_LIMIT_MAX);

    registry.insertMessage(sid, "assistant", `capybara ${"z".repeat(6000)}`);
    const found = (await tool("search_messages").handler({ query: "capybara" }, ctx)) as {
      results: Array<{ messageId: string }>;
    };
    const context = (await tool("get_message_context").handler(
      { sessionId: sid, messageId: found.results[0].messageId, radius: 1 },
      ctx,
    )) as { messages: Array<{ content: string; isAnchor: boolean }> };
    const anchor = context.messages.find((m) => m.isAnchor)!;
    expect(anchor.content.length).toBeLessThan(2300);
    expect(anchor.content).toMatch(/intentional cap/);
  });
});
