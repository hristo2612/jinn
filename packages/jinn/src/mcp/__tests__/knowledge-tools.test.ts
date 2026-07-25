import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildKnowledgeTools, KNOWLEDGE_QUERY_CHAR_CAP } from "../knowledge-tools.js";
import { buildTools } from "../server.js";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

/**
 * GRS-020b — the knowledge tool group. Two tiers (the GRS-020a pattern):
 *   1. UNIT (stub fetch) — exact routes/query strings, tool-side caps with
 *      structured refusals BEFORE any HTTP call, hints, error pass-through,
 *      privileged-read capability binding.
 *   2. INTEGRATION (real handleApiRequest + temp home via the fetchFn seam) —
 *      the slice acceptance: search a seeded term → read the hit by its
 *      relative path; and the containment surface refuses traversal + symlink
 *      escapes with readable errors, never content.
 */

// Isolated home BEFORE the api import (registry reads JINN_HOME at load).
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-knowledge-home-"));

type Api = typeof import("../../gateway/api.js");
let api: Api;
type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;
let integrationCallerId: string;

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-knowledge-data-"));

function seed(rel: string, content: string): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/* ── Unit-tier stub fetch ───────────────────────────────────────────────────── */

interface SeenCall {
  url: string;
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
  const t = buildKnowledgeTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("knowledge tools — registry + schemas", () => {
  it("exposes the 2 knowledge tools with flat schemas and required args", () => {
    const tools = buildKnowledgeTools();
    expect(tools.map((t) => t.name)).toEqual(["search_knowledge", "read_knowledge"]);
    expect(tool("search_knowledge").inputSchema.required).toEqual(["query"]);
    expect(tool("read_knowledge").inputSchema.required).toEqual(["path"]);
    for (const t of tools) {
      for (const prop of Object.values(t.inputSchema.properties) as Array<{ type?: string }>) {
        expect(prop.type).toBe("string");
      }
    }
  });

  it("the belt registers the knowledge group — 53 tools total", () => {
    const names = buildTools().map((t) => t.name);
    expect(names).toContain("search_knowledge");
    expect(names).toContain("read_knowledge");
    expect(names).toContain("cancel_workflow_run");
    expect(names).toHaveLength(63);
  });

  it("domain teaching lives on search_knowledge; read names the instance scope", () => {
    expect(tool("search_knowledge").description).toMatch(/knowledge\/ and docs\//);
    expect(tool("search_knowledge").description).toMatch(/snippets only/i);
    expect(tool("read_knowledge").description).toMatch(/instance file/i);
  });
});

describe("knowledge tools — unit (stub gateway)", () => {
  it("search_knowledge GETs the search route with the encoded query", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { results: [] } }));
    await tool("search_knowledge").handler({ query: "pricing tiers?" }, ctx);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/knowledge/search");
    expect(url.searchParams.get("q")).toBe("pricing tiers?");
  });

  it("refuses an over-long query with a structured error BEFORE any HTTP call", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));
    await expect(
      tool("search_knowledge").handler({ query: "x".repeat(KNOWLEDGE_QUERY_CHAR_CAP + 1) }, ctx),
    ).rejects.toThrow(/too long/);
    expect(calls).toHaveLength(0);
  });

  it("read_knowledge accepts any relative instance path and leaves containment to the gateway", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));
    for (const accepted of ["knowledge/nested/foo.md", "secrets/api-keys.json", "config.yaml"]) {
      await expect(tool("read_knowledge").handler({ path: accepted }, ctx)).resolves.toBeDefined();
    }
    expect(calls).toHaveLength(3);
  });

  it("read_knowledge refuses a control-byte path locally (no HTTP call) — GRS-020b-fix", async () => {
    // A trailing NUL survives .trim(); pre-fix the gateway's free-text cleaner
    // stripped it and read the repaired path. The tool now rejects control
    // bytes on the raw arg BEFORE any HTTP call — mirrored at route + store.
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));
    const NUL = String.fromCharCode(0);
    const CTRL = String.fromCharCode(1);
    await expect(tool("read_knowledge").handler({ path: `knowledge/a.md${NUL}` }, ctx)).rejects.toThrow(/control bytes/);
    await expect(tool("read_knowledge").handler({ path: `knowledge/a${CTRL}b.md` }, ctx)).rejects.toThrow(/control bytes/);
    expect(calls).toHaveLength(0);
  });

  it("passes gateway 4xx bodies through as readable errors", async () => {
    const { ctx } = stub(() => ({ status: 403, body: { error: "resolves outside the knowledge/ root" } }));
    await expect(tool("read_knowledge").handler({ path: "knowledge/escape.md" }, ctx)).rejects.toThrow(
      /refused \(403\).*outside/,
    );
  });

  it("read tier: requires a bound caller capability and returns hints when bound", async () => {
    const anon = stub(() => ({ status: 200, body: { results: [] } }), null);
    await expect(tool("search_knowledge").handler({ query: "a" }, anon.ctx)).rejects.toThrow(/caller identity unavailable/i);
    expect(anon.calls).toHaveLength(0);

    const { ctx } = stub(() => ({ status: 200, body: { results: [{ path: "knowledge/a.md", title: "A", snippet: "«a»", matchCount: 1 }] } }));
    const out = (await tool("search_knowledge").handler({ query: "a" }, ctx)) as { results: unknown[]; hint: string };
    expect(out.results).toHaveLength(1);
    expect(out.hint).toMatch(/read_knowledge/);
  });
});

/* ── Integration tier: real handleApiRequest + temp home via fetchFn seam ──── */

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

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  jinnHome: home,
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as import("../../gateway/api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const req = Object.assign(Readable.from([]), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  seed("knowledge/q3-pricing.md", "# Q3 pricing\n\nThe zebrafish plan ships at 29 euro with annual billing.\n");
  seed("docs/billing.md", "# Billing\n\nInvoices reference the zebrafish plan id.\n");
  seed("secrets/api-keys.json", JSON.stringify({ secret: "TOPSECRET-mcp" }));
  seed("config.yaml", "gateway:\n  port: 7777\n");
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-mcp-outside-"));
  const outsideFile = path.join(outsideDir, "outside.md");
  fs.writeFileSync(outsideFile, "TOPSECRET-outside-mcp");
  fs.symlinkSync(outsideFile, path.join(home, "knowledge", "escape.md"));
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
  integrationCallerId = registry.createSession({ engine: "codex", source: "web", sourceRef: "knowledge-caller", employee: "knowledge-caller" }).id;
});

describe("knowledge tools — integration against the real routes/store", () => {
  const ctx = (): JinnMcpContext => ({
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId: integrationCallerId,
    sessionCapability: ensureSessionCapability(integrationCallerId),
  });

  it("the slice acceptance: search a seeded term → read the hit by its relative path", async () => {
    const found = (await tool("search_knowledge").handler({ query: "zebrafish" }, ctx())) as {
      results: Array<{ path: string; title: string; snippet: string; matchCount: number }>;
    };
    const paths = found.results.map((r) => r.path);
    expect(paths).toContain("knowledge/q3-pricing.md");
    expect(paths).toContain("docs/billing.md");
    const hit = found.results.find((r) => r.path === "knowledge/q3-pricing.md")!;
    expect(hit.snippet).toContain("«zebrafish»");
    expect(hit.snippet).not.toContain("29 euro with annual billing.\n");

    const read = (await tool("read_knowledge").handler({ path: hit.path }, ctx())) as {
      path: string;
      title: string;
      content: string;
      truncated: boolean;
    };
    expect(read.path).toBe("knowledge/q3-pricing.md");
    expect(read.title).toBe("Q3 pricing");
    expect(read.content).toContain("ships at 29 euro");
    expect(read.truncated).toBe(false);
  });

  it("reads a file outside knowledge and docs when it remains inside the instance", async () => {
    const read = (await tool("read_knowledge").handler({ path: "config.yaml" }, ctx())) as { content: string };
    expect(read.content).toContain("port: 7777");
  });

  it("refuses traversal through the real route with a readable 400 — never content", async () => {
    await expect(
      tool("read_knowledge").handler({ path: "knowledge/../secrets/api-keys.json" }, ctx()),
    ).rejects.toThrow(/rejected \(400\)/);
    let leaked = "";
    try {
      await tool("read_knowledge").handler({ path: "knowledge/../secrets/api-keys.json" }, ctx());
    } catch (e) {
      leaked = String(e);
    }
    expect(leaked).not.toContain("TOPSECRET-mcp");
  });

  it("refuses the symlink escape through the real route with a readable 403 — never content", async () => {
    let message = "";
    try {
      await tool("read_knowledge").handler({ path: "knowledge/escape.md" }, ctx());
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/refused \(403\)/);
    expect(message).toMatch(/outside/);
    expect(message).not.toContain("TOPSECRET-mcp");
  });

  it("hostile queries degrade to normal results through the real route (NUL, oversized)", async () => {
    const nul = (await tool("search_knowledge").handler({ query: "zebrafish\u0000" }, ctx())) as {
      results: Array<{ path: string }>;
    };
    expect(nul.results.map((r) => r.path)).toContain("knowledge/q3-pricing.md");
    await expect(
      tool("search_knowledge").handler({ query: "z".repeat(10_000) }, ctx()),
    ).rejects.toThrow(/too long/);
  });

  it("404s a missing file with the store's readable message", async () => {
    await expect(tool("read_knowledge").handler({ path: "knowledge/nope.md" }, ctx())).rejects.toThrow(
      /failed \(404\).*no such instance file/,
    );
  });
});
