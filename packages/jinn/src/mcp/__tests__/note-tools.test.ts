import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildNoteTools } from "../note-tools.js";
import { buildTools } from "../server.js";
import { ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-notes-registry-"));

interface SeenCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function stub(
  responder: (call: SeenCall) => { status: number; body: unknown },
  bound = true,
): { calls: SeenCall[]; ctx: JinnMcpContext } {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    const response = responder(call);
    return {
      status: response.status,
      text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    ctx: {
      gatewayUrl: "http://gateway.test",
      fetchFn,
      ...(bound ? { callerSessionId: "session-test", sessionCapability: "cap-test" } : {}),
    },
  };
}

function tool(name: string): JinnMcpTool {
  const found = buildNoteTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("note tool contracts", () => {
  it("exposes exactly four flat schemas with exact required arguments", () => {
    const tools = buildNoteTools();

    expect(tools.map((candidate) => candidate.name)).toEqual([
      "list_notes",
      "read_note",
      "create_note",
      "update_note",
    ]);
    expect(Object.fromEntries(tools.map((candidate) => [candidate.name, candidate.inputSchema.required ?? []]))).toEqual({
      list_notes: [],
      read_note: ["path"],
      create_note: ["title"],
      update_note: ["path", "expectedRevision"],
    });
    for (const candidate of tools) {
      expect(candidate.inputSchema).not.toHaveProperty("$defs");
      for (const property of Object.values(candidate.inputSchema.properties) as Array<{ type?: string }>) {
        expect(property.type).toBe("string");
      }
    }
  });

  it("registers only those four new verbs on the full belt", () => {
    const names = buildTools({ notesEnabled: true }).map((candidate) => candidate.name);
    expect(names.filter((name) => name.endsWith("_note") || name.endsWith("_notes"))).toEqual([
      "list_notes",
      "read_note",
      "create_note",
      "update_note",
    ]);
    expect(names).toHaveLength(63);
  });

  it("omits Notes verbs from the full belt when the feature is disabled", () => {
    const names = buildTools({ notesEnabled: false }).map((candidate) => candidate.name);

    expect(names.filter((name) => name.endsWith("_note") || name.endsWith("_notes"))).toEqual([]);
    expect(names).toHaveLength(59);
  });

  it("teaches read-before-update in the list result hint", async () => {
    const { ctx } = stub(() => ({ status: 200, body: { notes: [], folders: [] } }));

    const result = await tool("list_notes").handler({}, ctx) as { hint: string };

    expect(result.hint).toContain("read_note");
    expect(result.hint).toContain("expectedRevision");
  });

  it("requires a bound caller for every Notes tool before HTTP", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }), false);
    const args: Record<string, Record<string, unknown>> = {
      list_notes: {},
      read_note: { path: "knowledge/a.md" },
      create_note: { title: "A" },
      update_note: { path: "knowledge/a.md", expectedRevision: "a".repeat(64), body: "B" },
    };

    for (const candidate of buildNoteTools()) {
      await expect(candidate.handler(args[candidate.name], ctx)).rejects.toThrow(/caller identity unavailable/i);
    }
    expect(calls).toEqual([]);
  });

  it("refuses raw control bytes and unsafe paths before HTTP", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));

    for (const unsafe of [
      `knowledge/a.md${String.fromCharCode(0)}`,
      "knowledge/../a.md",
      "/tmp/a.md",
      "knowledge\\a.md",
    ]) {
      await expect(tool("read_note").handler({ path: unsafe }, ctx)).rejects.toThrow(/path|control/i);
    }
    expect(calls).toEqual([]);
  });

  it("requires expectedRevision and rejects body plus append before HTTP", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));

    await expect(tool("update_note").handler({ path: "knowledge/a.md", body: "B" }, ctx)).rejects.toThrow(/expectedRevision/);
    await expect(tool("update_note").handler({
      path: "knowledge/a.md",
      expectedRevision: "a".repeat(64),
      body: "B",
      append: "C",
    }, ctx)).rejects.toThrow(/mutually exclusive/);
    expect(calls).toEqual([]);
  });

  it("uses the exact Notes routes and methods", async () => {
    const { calls, ctx } = stub((call) => {
      if (call.method === "GET" && new URL(call.url).pathname === "/api/notes") return { status: 200, body: { notes: [], folders: [] } };
      return { status: call.method === "POST" ? 201 : 200, body: { note: { path: "knowledge/a.md", revision: "a".repeat(64) } } };
    });

    await tool("list_notes").handler({ query: "launch plan" }, ctx);
    await tool("read_note").handler({ path: "knowledge/a.md" }, ctx);
    await tool("create_note").handler({ title: "A", body: "One", folder: "product" }, ctx);
    await tool("update_note").handler({ path: "knowledge/a.md", expectedRevision: "a".repeat(64), append: "Two" }, ctx);

    expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ["GET", "/api/notes"],
      ["GET", "/api/notes/read"],
      ["POST", "/api/notes"],
      ["PUT", "/api/notes"],
    ]);
    expect(new URL(calls[0].url).searchParams.get("q")).toBe("launch plan");
    expect(calls[2].body).toEqual({ title: "A", body: "One", folder: "product" });
    expect(calls[3].body).toEqual({ path: "knowledge/a.md", expectedRevision: "a".repeat(64), append: "Two" });
  });

  it("surfaces revision conflicts with the current revision", async () => {
    const { ctx } = stub(() => ({
      status: 409,
      body: { error: "the note changed", currentRevision: "b".repeat(64) },
    }));

    await expect(tool("update_note").handler({
      path: "knowledge/a.md",
      expectedRevision: "a".repeat(64),
      body: "B",
    }, ctx)).rejects.toThrow(new RegExp(`conflict.*${"b".repeat(64)}`, "i"));
  });
});

type Api = typeof import("../../gateway/api.js");
type Registry = typeof import("../../sessions/registry.js");
let api: Api;
let registry: Registry;
let callerSessionId: string;
const integrationHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-notes-data-"));

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

const apiContext = {
  getConfig: () => ({ gateway: { notesEnabled: true }, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  jinnHome: integrationHome,
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../../gateway/api.js").ApiContext;

function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers: Record<string, string> = { host: url.host };
    for (const [key, value] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[key.toLowerCase()] = value;
    const req = Object.assign(Readable.from(typeof init?.body === "string" ? [Buffer.from(init.body)] : []), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const capture = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], capture.res, apiContext);
    return { status: capture.status, text: async () => capture.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  fs.mkdirSync(path.join(integrationHome, "knowledge"), { recursive: true });
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
  callerSessionId = registry.createSession({
    engine: "codex",
    source: "web",
    sourceRef: "notes-caller",
    employee: "notes-caller",
  }).id;
});

describe("note tools against real routes", () => {
  const context = (): JinnMcpContext => ({
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId,
    sessionCapability: ensureSessionCapability(callerSessionId),
  });

  it("reads then appends through the bound note tools", async () => {
    const created = await tool("create_note").handler({ title: "Ideas", body: "One" }, context());
    const note = (created as { note: { path: string; revision: string } }).note;
    const read = await tool("read_note").handler({ path: note.path }, context());
    const updated = await tool("update_note").handler({
      path: note.path,
      expectedRevision: note.revision,
      append: "Two",
    }, context());

    expect(read).toMatchObject({ note: { title: "Ideas", body: "One" } });
    expect(updated).toMatchObject({ note: { title: "Ideas", body: "One\n\nTwo" } });
  });
});
