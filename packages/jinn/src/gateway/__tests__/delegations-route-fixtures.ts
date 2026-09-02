/**
 * The delegation-route harness: temp JINN_HOME, stubbed engine and queue, and
 * the helpers every suite in this folder drives the real handleApiRequest with.
 *
 * Split out of delegations-route.test.ts so neither file carries the other's
 * weight past the size ratchet. The vi.mock of the work-item store stays in the
 * test files, where Vitest hoists it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { expect, beforeAll, afterAll, vi, type Mock } from "vitest";
export const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-delegations-route-"));
process.env.JINN_HOME = tmpHome;
export const dbModule = await import("../../shared/db.js");

// A real employee for the employee-path assertions (scanOrg requires name+persona).
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmpHome, "org", "qa-emp.yaml"),
  ["name: qa-emp", "displayName: QA Employee", "department: qa", "rank: employee", "reportsTo: qa-manager", "engine: codex", "model: gpt-5.5", "persona: QA employee for route tests", ""].join("\n"),
);
fs.writeFileSync(
  path.join(tmpHome, "org", "qa-manager.yaml"),
  ["name: qa-manager", "displayName: QA Manager", "department: qa", "rank: manager", "reportsTo: org-root", "engine: codex", "model: gpt-5.5", "persona: QA manager for route tests", ""].join("\n"),
);
fs.writeFileSync(
  path.join(tmpHome, "org", "org-root.yaml"),
  ["name: org-root", "displayName: Org Root", "department: operations", "rank: executive", "engine: codex", "model: gpt-5.5", "persona: Root coordinator for route tests", ""].join("\n"),
);
// GRS-017f: an employee whose CONFIGURED model this gateway doesn't register
// (only gpt-5.5 is known for codex here) — the misconfig the clear error targets.
fs.writeFileSync(
  path.join(tmpHome, "org", "stale-emp.yaml"),
  ["name: stale-emp", "department: qa", "engine: codex", "model: legacy-sonnet", "persona: employee pinned to an unregistered model", ""].join("\n"),
);
fs.writeFileSync(
  path.join(tmpHome, "org", "codex-model-emp.yaml"),
  ["name: codex-model-emp", "department: platform", "engine: codex", "model: gpt-5.6-sol", "persona: Employee pinned to a Codex-only model", ""].join("\n"),
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Approvals = typeof import("../../work-items/approvals.js");
export let api: Api;
export let reg: Reg;
export let store: Store;
export let approvals: Approvals;
export const processFetch = globalThis.fetch;
export const routeFetchStub: Mock = vi.fn().mockResolvedValue({ ok: true });

export function makeRes() {
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
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

// Engine availability is a per-test switch: flipping it OFF is the spawn-failure
// injection the mint-before-spawn ordering test needs.
/** Mutable across module boundaries: an imported `let` is read-only at the
 *  import site, so the flag travels in a holder the suites can set. */
export const engine = { available: true };
// Every engine.run invocation is captured so tests can assert what the web
// dispatch path actually hands the engine (the identity-stamped resolvedMcp).
export const engineRuns: Array<Record<string, unknown>> = [];
export const emittedEvents: Array<{ event: string; payload: any }> = [];
export const engineStub = {
  name: "stub",
  run: async (opts: Record<string, unknown>) => {
    // Snapshot the DB link AT TURN START — the codex finding-1 pin: the work
    // item ↔ session link must already be durable when the worker runs.
    const row = dbModule
      .initDb()
      .prepare("SELECT work_item_id FROM sessions WHERE id = ?")
      .get(String(opts.sessionId)) as { work_item_id: string | null } | undefined;
    engineRuns.push({ ...opts, workItemIdAtRunStart: row?.work_item_id ?? null });
    return { result: "ok" };
  },
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
export const queueStub = {
  // Unlike the 017a harness (which never runs enqueued turns), this suite
  // EXECUTES them: the identity-seam tests must observe what runWebSession
  // hands engine.run. The engine itself is still the stub above.
  enqueue: async (_key: string, fn: () => Promise<void>) => {
    await fn();
  },
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
export const apiCtx = {
  // mcp.gateway enabled so the dispatch path resolves the builtin jinn server —
  // the identity-seam test below asserts the session id is stamped onto it. The
  // codex engine mapping must exist for runWebSession to reach engine.run.
  getConfig: () => ({
    gateway: {},
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus" }] },
      codex: {
        default: "gpt-5.5",
        models: [{ id: "gpt-5.5" }, { id: "gpt-5.6-sol" }],
      },
    },
    sessions: {},
    mcp: { gateway: { enabled: true } },
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: unknown) => emittedEvents.push({ event, payload }),
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => (engine.available ? engineStub : undefined),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

export async function call(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token", ...headers },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return { status: cap.status, body: cap.body };
}

export async function createOperatorSession(prompt: string): Promise<string> {
  const resp = await call("POST", "/api/sessions", { prompt, engine: "codex" });
  expect(resp.status).toBe(201);
  return resp.body.id as string;
}

export function createEmployeeSession(employee: string, suffix: string): string {
  return reg.createSession({
    engine: "codex",
    source: "web",
    sourceRef: `web:${employee}:${suffix}`,
    sessionKey: `web:${employee}:${suffix}`,
    connector: "web",
    employee,
    prompt: `${employee} coordination session`,
    title: `${employee} coordination`,
  }).id;
}

export function managerVisibilityRequests(fetchSpy: ReturnType<typeof vi.fn>, managerSessionId: string) {
  return fetchSpy.mock.calls.filter(([url, opts]) => {
    if (url !== `http://127.0.0.1:7777/api/sessions/${managerSessionId}/message`) return false;
    const body = JSON.parse(opts.body);
    return body.role === "notification" && body.meta?.kind === "manager-visibility";
  });
}

export function workItemCount(): number {
  return store.listWorkItems().length;
}

beforeAll(async () => {
  // This route dispatches fire-and-forget parent/manager callbacks. Keep the
  // route suite fully in-process: no callback may inherit the process fetch and
  // contact an installed gateway while the test harness is running.
  globalThis.fetch = routeFetchStub as unknown as typeof fetch;
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  approvals = await import("../../work-items/approvals.js");
  // GRS-017e-fix: jinn attachment requires the armed-ok smoke gate (unarmed
  // fails closed). A booted gateway arms it at boot; this suite drives the
  // dispatch path without a boot, so arm it here — the identity-seam tests
  // below assert the jinn server (with the stamped session id) reaches the
  // engine, which needs a positive attach decision.
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterAll(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.fetch = processFetch;
});
