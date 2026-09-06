import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { ServerResponse } from "node:http";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-read-guard-home-"));
process.env.JINN_WORKFLOW_EVIDENCE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-read-guard-wf-"));

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Identity = typeof import("../../mcp/identity.js");
type Paths = typeof import("../../shared/paths.js");

let api: Api;
let registry: Registry;
let identity: Identity;
let paths: Paths;
let validCaller: import("../../shared/types.js").Session;
let otherCaller: import("../../shared/types.js").Session;
let deletedCallerId: string;
let deletedCapability: string;
const fileId = "guarded-file";

const READ_ROUTES = [
  { method: "GET", path: "/api/work-items", label: "work-items list" },
  { method: "GET", path: "/api/work-items/wi_missing", label: "work-item get" },
  { method: "GET", path: "/api/search/work-items?status=backlog", label: "work-items search" },
  { method: "GET", path: "/api/work-items/wi_missing/sessions", label: "work-item sessions" },
  { method: "GET", path: "/api/sessions", label: "sessions list" },
  { method: "GET", path: "/api/sessions/nope", label: "session read" },
  { method: "GET", path: "/api/sessions/nope/children", label: "session children" },
  { method: "GET", path: "/api/sessions/nope/context?message=msg", label: "message context" },
  { method: "GET", path: "/api/sessions/nope/transcript", label: "session transcript" },
  { method: "GET", path: "/api/search/sessions?employee=worker", label: "sessions search" },
  { method: "GET", path: "/api/search/messages?q=needle", label: "messages search" },
  { method: "GET", path: "/api/search/global?q=needle", label: "global search" },
  { method: "GET", path: "/api/knowledge/search?q=needle", label: "knowledge search" },
  { method: "GET", path: "/api/knowledge/read?path=knowledge/demo.md", label: "knowledge read" },
  { method: "GET", path: "/api/cost/report", label: "cost report" },
  { method: "GET", path: "/api/cron", label: "cron list" },
  { method: "GET", path: "/api/cron/daily/runs", label: "cron run history" },
  { method: "GET", path: "/api/org", label: "org list" },
  { method: "GET", path: "/api/org/employees/coo", label: "org employee get" },
  { method: "GET", path: "/api/workflows", label: "workflow visual list" },
  { method: "GET", path: "/api/workflows/demo", label: "workflow visual get" },
  { method: "GET", path: "/api/workflows/demo/runs", label: "workflow runs list" },
  { method: "GET", path: "/api/workflows/demo/runs/run_1", label: "workflow run get" },
] as const;

type RouteSpec = {
  method: "GET" | "POST";
  path: string;
  label: string;
  body?: string;
};

function stragglerReadRoutes(): RouteSpec[] {
  return [
    { method: "GET", path: `/api/sessions/${validCaller.id}/queue`, label: "session queue" },
    { method: "GET", path: "/api/skills", label: "skills list" },
    { method: "GET", path: "/api/skills/sample-skill", label: "skill read" },
    { method: "GET", path: "/api/engines", label: "engines" },
    { method: "GET", path: "/api/engine-limits", label: "engine limits" },
    { method: "GET", path: "/api/config", label: "config" },
    { method: "GET", path: "/api/logs", label: "logs" },
    { method: "GET", path: "/api/connectors", label: "connectors" },
    { method: "GET", path: "/api/onboarding", label: "onboarding" },
    { method: "GET", path: "/api/stt/status", label: "stt status" },
    { method: "GET", path: "/api/tts", label: "tts status" },
    { method: "GET", path: `/api/files/${fileId}/meta`, label: "file metadata" },
    { method: "GET", path: `/api/files/${fileId}`, label: "file content" },
    { method: "GET", path: "/api/auth/state", label: "auth state adjacent bootstrap metadata" },
    { method: "GET", path: "/api/instances", label: "instances random adjacent read" },
  ];
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = new class extends Writable {
    override _write(buf: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      callback();
    }

    writeHead(s: number) {
      status = s;
      return this;
    }

    setHeader() {
      return this;
    }
  }() as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get bodyText() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

function req(method: string, pathAndQuery: string, headers: Record<string, string> = {}, body = "") {
  return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method,
    url: pathAndQuery,
    headers: { host: "gateway.test", ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}), ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {}, portal: { portalName: "Jinn" } }),
  // Capability checks must not discover or probe gateways from the machine's instance registry.
  loadWorkspaceInstances: () => [],
  readWorkspaceAccessMappings: async () => [],
  connectors: new Map(),
  startTime: Date.now(),
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

async function read(pathAndQuery: string, headers: Record<string, string> = {}) {
  const cap = makeRes();
  await api.handleApiRequest(req("GET", pathAndQuery, headers), cap.res, apiCtx);
  return cap;
}

async function call(route: { method: string; path: string; label?: string; body?: string }, headers: Record<string, string> = {}) {
  const cap = makeRes();
  await api.handleApiRequest(req(route.method, route.path, headers, "body" in route ? route.body : ""), cap.res, apiCtx);
  return cap;
}

function toolMarkedNoCapabilityHeaders(): Record<string, string> {
  return { [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE };
}

function claimedNoCapabilityHeaders(): Record<string, string> {
  return { [identity.CALLER_SESSION_HEADER]: validCaller.id };
}

function crossSessionCapabilityHeaders(): Record<string, string> {
  return {
    [identity.CALLER_SESSION_HEADER]: validCaller.id,
    [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(otherCaller.id),
  };
}

function deletedSessionCapabilityHeaders(): Record<string, string> {
  return {
    [identity.CALLER_SESSION_HEADER]: deletedCallerId,
    [identity.CALLER_SESSION_CAPABILITY_HEADER]: deletedCapability,
  };
}

function validCapabilityHeaders(): Record<string, string> {
  return {
    [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
    [identity.CALLER_SESSION_HEADER]: validCaller.id,
    [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(validCaller.id),
  };
}

beforeAll(async () => {
  fs.mkdirSync(path.join(process.env.JINN_HOME!, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(process.env.JINN_HOME!, "docs"), { recursive: true });
  fs.mkdirSync(path.join(process.env.JINN_HOME!, "cron"), { recursive: true });
  fs.mkdirSync(path.join(process.env.JINN_HOME!, "skills", "sample-skill"), { recursive: true });
  fs.writeFileSync(path.join(process.env.JINN_HOME!, "cron", "jobs.json"), "[]");
  fs.writeFileSync(
    path.join(process.env.JINN_HOME!, "skills", "sample-skill", "SKILL.md"),
    "---\nname: sample-skill\ndescription: Generic sample skill.\n---\n\n# Sample\n",
  );
  fs.mkdirSync(path.join(process.env.JINN_WORKFLOW_EVIDENCE_ROOT!, "workflows"), { recursive: true });

  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  identity = await import("../../mcp/identity.js");
  paths = await import("../../shared/paths.js");
  (await import("../../shared/db.js")).initDb();
  const fileDir = path.join(paths.FILES_DIR, fileId);
  fs.mkdirSync(fileDir, { recursive: true });
  fs.writeFileSync(path.join(fileDir, "visible.txt"), "visible managed file");
  registry.insertFile({ id: fileId, filename: "visible.txt", size: "visible managed file".length, mimetype: "text/plain", path: null });
  validCaller = registry.createSession({ engine: "codex", source: "web", sourceRef: "valid-caller", employee: "worker" });
  otherCaller = registry.createSession({ engine: "codex", source: "web", sourceRef: "other-caller", employee: "other" });
  const deleted = registry.createSession({ engine: "codex", source: "web", sourceRef: "deleted-caller", employee: "gone" });
  deletedCallerId = deleted.id;
  deletedCapability = identity.ensureSessionCapability(deleted.id);
  registry.deleteSession(deleted.id);
});

describe("privileged read routes — uniform capability guard", () => {
  it.each(READ_ROUTES)("$method $path ($label) fails closed for tool-marked requests without a session capability", async (route) => {
    const res = await call(route, toolMarkedNoCapabilityHeaders());
    expect(res.status).toBe(403);
    expect(res.bodyText).toMatch(/caller identity unavailable/i);
  });

  it.each(READ_ROUTES)("$method $path ($label) fails closed for unmarked claimed caller identity without a capability", async (route) => {
    const res = await call(route, claimedNoCapabilityHeaders());
    expect(res.status).toBe(403);
    expect(res.bodyText).toMatch(/caller identity unavailable/i);
  });

  it.each(READ_ROUTES)("$method $path ($label) fails closed for cross-session capability spoofing", async (route) => {
    const res = await call(route, crossSessionCapabilityHeaders());
    expect(res.status).toBe(403);
    expect(res.bodyText).toMatch(/caller identity unavailable/i);
  });

  it.each(READ_ROUTES)("$method $path ($label) fails closed for deleted-session capability claims", async (route) => {
    const res = await call(route, deletedSessionCapabilityHeaders());
    expect(res.status).toBe(403);
    expect(res.bodyText).toMatch(/caller identity unavailable/i);
  });

  it("does not change the operator/web no-marker read path", async () => {
    await expect(read("/api/work-items")).resolves.toMatchObject({ status: 200 });
    await expect(read("/api/sessions")).resolves.toMatchObject({ status: 200 });
    await expect(read("/api/org")).resolves.toMatchObject({ status: 200 });
  });

  it("allows a verified capability-bearing tool caller through to the normal read handler", async () => {
    const res = await read("/api/work-items", validCapabilityHeaders());
    expect(res.status).toBe(200);
  });

  it("fails closed by default for adjacent and future API reads from tool-marked callers without a session capability", async () => {
    for (const route of stragglerReadRoutes()) {
      const res = await call(route, toolMarkedNoCapabilityHeaders());
      expect(res.status, route.label).toBe(403);
      expect(res.bodyText, route.label).toMatch(/caller identity unavailable/i);
    }
    const future = await read("/api/new-read-route-added-tomorrow", toolMarkedNoCapabilityHeaders());
    expect(future.status).toBe(403);
  });

  it("fails closed by default for adjacent and future API reads from unmarked caller-session spoofs", async () => {
    for (const route of stragglerReadRoutes()) {
      const res = await call(route, claimedNoCapabilityHeaders());
      expect(res.status, route.label).toBe(403);
      expect(res.bodyText, route.label).toMatch(/caller identity unavailable/i);
    }
    const future = await read("/api/new-read-route-added-tomorrow", claimedNoCapabilityHeaders());
    expect(future.status).toBe(403);
  });

  it("fails closed for present-but-empty identity headers", async () => {
    const malformedHeaders: Record<string, string>[] = [
      { [identity.TOOL_CALL_HEADER]: "" },
      { [identity.TOOL_CALL_HEADER]: "   " },
      { [identity.CALLER_SESSION_HEADER]: "" },
      { [identity.CALLER_SESSION_HEADER]: "   " },
    ];
    for (const headers of malformedHeaders) {
      const res = await read("/api/work-items", headers);
      expect(res.status).toBe(403);
      expect(res.bodyText).toMatch(/caller identity unavailable/i);
    }
  });

  it("leaves operator/web no-marker reads and valid capability callers on the normal handlers", async () => {
    for (const route of stragglerReadRoutes()) {
      expect((await call(route)).status, `operator ${route.label}`).toBe(200);
      expect((await call(route, validCapabilityHeaders())).status, `capability ${route.label}`).toBe(200);
    }
  }, 20_000);

  it("keeps the explicit public allowlist reachable without a session capability", async () => {
    expect((await read("/api/status", toolMarkedNoCapabilityHeaders())).status).toBe(200);
  });
});
