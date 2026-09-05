import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability, UNIDENTIFIED_TOOL_CALL_ERROR } from "../../mcp/identity.js";

/**
 * The heartbeat routes against the REAL gateway API and store (temp JINN_HOME):
 * the ownership boundary between two sessions, the fail-closed 403 for a caller
 * with no bound session identity, deletion disarming while a stop does not, and
 * a heartbeat delivery queueing into a running session instead of interrupting
 * its turn. The tool wrappers themselves are unit-tested in
 * mcp/__tests__/heartbeat-tools.test.ts.
 */

// Isolated registry DB. Set BEFORE the dynamic api import.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-heartbeat-routes-home-"));

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../heartbeats/store.js");

let api: Api;
let registry: Registry;
let store: Store;

function makeRes() {
  const chunks: Buffer[] = [];
  const cap = {
    status: 0,
    res: {
      writeHead(status: number) {
        cap.status = status;
        return cap.res;
      },
      setHeader() {},
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.from(chunk));
      },
      write(chunk: string | Buffer) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      headersSent: false,
    } as unknown as ServerResponse,
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
  return cap;
}

const killed: string[] = [];
const enqueued: Array<{ key: string }> = [];
const queueStub = {
  enqueue: async (key: string) => { enqueued.push({ key }); },
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {},
  hasInFlightItem: () => false,
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => true,
  isTurnRunning: () => true,
  kill: (id: string) => { killed.push(id); },
  killAll: () => {},
};
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", engineStub]]),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function request(
  method: string,
  pathAndQuery: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const raw = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url: pathAndQuery,
    headers: {
      host: "gateway.test",
      ...(raw ? { "content-type": "application/json" } : {}),
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  let body: unknown = cap.text;
  try {
    body = JSON.parse(cap.text);
  } catch { /* non-JSON body */ }
  return { status: cap.status, body };
}

/** The headers a bound MCP tool call carries. */
function asSession(sessionId: string): Record<string, string> {
  return {
    "x-jinn-tool-call": "jinn-mcp",
    "x-jinn-caller-session": sessionId,
    "x-jinn-session-capability": ensureSessionCapability(sessionId)!,
  };
}

function newSession(sourceRef: string): string {
  return registry.createSession({ engine: "codex", source: "web", sourceRef }).id;
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../heartbeats/store.js");
});

describe("heartbeat routes — integration against the real routes/store", () => {
  it("arms a heartbeat owned by the calling session, never by a body field", async () => {
    const sessionA = newSession("route-owner");
    const sessionB = newSession("route-other");
    const armed = await request("POST", "/api/heartbeats", {
      headers: asSession(sessionA),
      // A forged owner in the body must be ignored, not honoured.
      body: { message: "ping", everySeconds: 60, ownerSessionId: sessionB },
    });
    expect(armed.status).toBe(201);
    const id = (armed.body as { id: string }).id;
    expect(store.getHeartbeat(id)!.ownerSessionId).toBe(sessionA);
  });

  it("refuses a caller with no bound session identity with the fail-closed 403", async () => {
    const refused = await request("POST", "/api/heartbeats", {
      headers: { "x-jinn-tool-call": "jinn-mcp" },
      body: { message: "ping", everySeconds: 60 },
    });
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toBe(UNIDENTIFIED_TOOL_CALL_ERROR);
  });

  it("refuses the operator too — a heartbeat needs a session to own it", async () => {
    const refused = await request("POST", "/api/heartbeats", {
      headers: { authorization: "Bearer test-token" },
      body: { message: "ping", everySeconds: 60 },
    });
    expect(refused.status).toBe(403);
  });

  it("rejects a limit breach with 422 and the gateway's own words", async () => {
    const sessionA = newSession("route-limits");
    const refused = await request("POST", "/api/heartbeats", {
      headers: asSession(sessionA),
      body: { message: "ping", everySeconds: 30 },
    });
    expect(refused.status).toBe(422);
    expect((refused.body as { error: string }).error).toMatch(/below the 60-second floor/);
  });

  it("keeps session A from seeing or stopping session B's heartbeat", async () => {
    const sessionA = newSession("route-a");
    const sessionB = newSession("route-b");
    const armed = await request("POST", "/api/heartbeats", {
      headers: asSession(sessionB),
      body: { message: "B's business", everySeconds: 60 },
    });
    const theirId = (armed.body as { id: string }).id;

    const listedByA = await request("GET", "/api/heartbeats", { headers: asSession(sessionA) });
    expect(listedByA.status).toBe(200);
    expect((listedByA.body as { heartbeats: Array<{ id: string }> }).heartbeats.map((h) => h.id))
      .not.toContain(theirId);

    // 404, not 403 — existence must not leak to a session that does not own it.
    const stopByA = await request("DELETE", `/api/heartbeats/${theirId}`, { headers: asSession(sessionA) });
    expect(stopByA.status).toBe(404);
    expect(store.getHeartbeat(theirId)!.status).toBe("armed");

    const stopByB = await request("DELETE", `/api/heartbeats/${theirId}`, { headers: asSession(sessionB) });
    expect(stopByB.status).toBe(200);
    expect(store.getHeartbeat(theirId)!.status).toBe("disarmed");
  });

  it("disarms a session's heartbeats when the session is deleted", async () => {
    const doomed = newSession("route-doomed");
    const armed = await request("POST", "/api/heartbeats", {
      headers: asSession(doomed),
      body: { message: "outlives me?", everySeconds: 60 },
    });
    const id = (armed.body as { id: string }).id;

    const deleted = await request("DELETE", `/api/sessions/${doomed}`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(deleted.status).toBe(200);
    expect(store.getHeartbeat(id)!.status).toBe("disarmed");
    expect(store.getHeartbeat(id)!.disarmedReason).toBe("owner-session-deleted");
  });

  it("leaves heartbeats armed when the session is only stopped — a stop is recoverable", async () => {
    const paused = newSession("route-paused");
    const armed = await request("POST", "/api/heartbeats", {
      headers: asSession(paused),
      body: { message: "still mine", everySeconds: 60 },
    });
    const id = (armed.body as { id: string }).id;

    const stopped = await request("POST", `/api/sessions/${paused}/stop`, {
      headers: { authorization: "Bearer test-token" },
      body: {},
    });
    expect(stopped.status).toBe(200);
    expect(store.getHeartbeat(id)!.status).toBe("armed");
  });

  it("queues a heartbeat delivery into a running session without interrupting its turn", async () => {
    const busy = newSession("route-busy");
    registry.updateSession(busy, { status: "running", lastActivity: new Date().toISOString() });
    const text = "Heartbeat while you work.";
    const { delivery } = registry.claimSessionDelivery({
      targetSessionId: busy,
      sourceKind: "heartbeat",
      sourceId: "hb-busy",
      sourceAttempt: "fire-1",
      sourceOutcome: "fired",
      sourceVersion: 1,
      deliveryKind: "heartbeat",
      payload: { message: text, displayMessage: `⏰ ${text}` },
    });
    killed.length = 0;

    const posted = await request("POST", `/api/sessions/${busy}/message`, {
      headers: { authorization: "Bearer test-token" },
      body: {
        message: text,
        role: "notification",
        displayMessage: `⏰ ${text}`,
        callbackDeliveryId: delivery.id,
      },
    });

    expect(posted.status).toBe(200);
    // Not dropped: the outbox row is accepted and the tick is parked on the queue
    // behind the running turn, carrying the stored text verbatim as the prompt
    // the engine will read when the turn ahead of it finishes.
    const accepted = registry.getSessionDelivery(delivery.id)!;
    expect(accepted.status).toBe("accepted");
    expect(registry.getQueueItem(accepted.queueItemId!)!.prompt).toBe(text);
    // Not interrupting: the in-flight turn's engine was never killed.
    expect(killed).toEqual([]);
    expect(registry.getSession(busy)!.status).toBe("running");
  });
});
