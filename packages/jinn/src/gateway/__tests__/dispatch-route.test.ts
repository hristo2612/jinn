import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnConfig } from "../../shared/types.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

// Stub engines still settle real turns; their parent notifications must stay inside this fixture.
vi.mock("../../sessions/callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/callbacks.js")>()),
  notifyParentSessionAndWait: vi.fn(async () => {}),
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-dispatch-route-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "route-worker.yaml"),
  [
    "name: route-worker",
    "displayName: Route Worker",
    "department: platform",
    "rank: employee",
    "engine: codex",
    "model: gpt-5.6-sol",
    "persona: Completes bounded route work",
    "",
  ].join("\n"),
);

const dbModule = await import("../../shared/db.js");

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type WorkItems = typeof import("../../work-items/store.js");
type Org = typeof import("../org.js");

let api: Api;
let registry: Registry;
let workItems: WorkItems;
let org: Org;

const engineRuns: Array<Record<string, unknown>> = [];
const emitted: Array<{ event: string; payload: unknown }> = [];
let defaultEngine = "codex";

const engineStub = {
  name: "stub",
  run: async (opts: Record<string, unknown>) => {
    engineRuns.push(opts);
    if (registry.getSession(String(opts.sessionId))?.employee === "todo-dispatcher") {
      return new Promise(() => {});
    }
    return { result: "ok" };
  },
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};

const queueStub = {
  enqueue: async (_key: string, fn: () => Promise<void>) => fn(),
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

function config(): JinnConfig {
  return {
    gateway: { port: 7797, host: "127.0.0.1" },
    engines: {
      default: defaultEngine as JinnConfig["engines"]["default"],
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high" },
      ...(defaultEngine === "legacy" ? { legacy: { bin: "legacy", model: "legacy-model" } } : {}),
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: false }] },
      codex: {
        default: "gpt-5.6-sol",
        models: [
          { id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "gpt-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    mcp: { gateway: { enabled: true } },
  } as unknown as JinnConfig;
}

const context = {
  getConfig: config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => engineStub,
    getEngines: () => new Map(),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

function makeResponse() {
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
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const request = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers: {
        host: "localhost",
        authorization: "Bearer test-token",
        "content-type": "application/json",
        ...headers,
      },
    },
  );
  const captured = makeResponse();
  await api.handleApiRequest(
    request as unknown as Parameters<Api["handleApiRequest"]>[0],
    captured.res,
    context,
  );
  return { status: captured.status, body: captured.body };
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  org = await import("../org.js");
  dbModule.initDb();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterAll(async () => {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
});

describe("PATCH /api/org/employees/todo-dispatcher", () => {
  it("rejects protected fields but persists model overrides with the built-in persona intact", async () => {
    const builtInPersona = org.scanOrg(config()).get("todo-dispatcher")!.persona;

    const protectedUpdate = await call("PATCH", "/api/org/employees/todo-dispatcher", {
      persona: "Replace the system instructions",
    });
    expect(protectedUpdate.status).toBe(400);
    expect(protectedUpdate.body.error).toMatch(/persona/);

    const knobUpdate = await call("PATCH", "/api/org/employees/todo-dispatcher", {
      model: "gpt-5.5",
    });
    expect(knobUpdate.status).toBe(200);

    expect(org.scanOrg(config()).get("todo-dispatcher")).toMatchObject({
      model: "gpt-5.5",
      persona: builtInPersona,
      system: true,
    });
  });
});

describe("POST /api/work-items/:id/dispatch", () => {
  it("starts and links exactly one live Todo Dispatcher session, then reuses it", async () => {
    const item = workItems.createWorkItem({ title: "Review the bounded incident", body: "Check the evidence", source: "human" });
    const runsBefore = engineRuns.length;

    const first = await call("POST", `/api/work-items/${item.id}/dispatch`, {});
    expect(first.status).toBe(201);
    expect(first.body.sessionId).toEqual(expect.any(String));

    const linked = await call("GET", `/api/work-items/${item.id}/sessions`);
    expect(linked.status).toBe(200);
    expect(linked.body).toContainEqual(expect.objectContaining({
      id: first.body.sessionId,
      employee: "todo-dispatcher",
      status: "running",
    }));

    const second = await call("POST", `/api/work-items/${item.id}/dispatch`, {});
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ sessionId: first.body.sessionId, reused: true });
    expect(registry.listSessionsByWorkItem(item.id).filter((session) => session.employee === "todo-dispatcher")).toHaveLength(1);
    for (let attempt = 0; attempt < 20 && engineRuns.length === runsBefore; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(engineRuns).toHaveLength(runsBefore + 1);
  });

  it("returns 404 for an unknown Todo without creating or running a session", async () => {
    const sessionsBefore = registry.countSessions();
    const runsBefore = engineRuns.length;

    const response = await call("POST", "/api/work-items/ICI-999999/dispatch", {});

    expect(response.status).toBe(404);
    expect(registry.countSessions()).toBe(sessionsBefore);
    expect(engineRuns).toHaveLength(runsBefore);
  });

  it("lets the linked Dispatcher hand the same Todo to the selected employee", async () => {
    const item = workItems.createWorkItem({ title: "Hand this work off", source: "human" });
    const dispatched = await call("POST", `/api/work-items/${item.id}/dispatch`, {});
    const dispatcherSessionId = dispatched.body.sessionId as string;

    const delegated = await call(
      "POST",
      "/api/delegations",
      {
        workItemId: item.id,
        employee: "route-worker",
        task: "Complete the Todo acceptance criteria and report evidence.",
      },
      {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: dispatcherSessionId,
        [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(dispatcherSessionId),
      },
    );

    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({
      employee: "route-worker",
      parentSessionId: dispatcherSessionId,
      workItemId: item.id,
    });
  });

  it("names an incompatible engine and the setting to change before creating a session", async () => {
    const item = workItems.createWorkItem({ title: "Needs company tools", source: "human" });
    const sessionsBefore = registry.countSessions();
    defaultEngine = "legacy";

    try {
      const response = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(response.body.error).toMatch(/legacy/);
      expect(response.body.error).toMatch(/change|configure|setting/i);
      expect(registry.countSessions()).toBe(sessionsBefore);
    } finally {
      defaultEngine = "codex";
    }
  });
});
