import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-resume-"));
process.env.JINN_HOME = home;

const gatewayConfig: { resumeInterruptedSessions?: boolean } = {};
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: gatewayConfig })),
}));
vi.mock("../callback-connection.js", () => ({
  internalGatewayConnection: () => ({ baseUrl: "http://restart-fixture.invalid" }),
  internalGatewayHeaders: () => ({ "Content-Type": "application/json" }),
}));

type Registry = typeof import("../registry.js");
type RestartResume = typeof import("../restart-resume.js");
let registry: Registry;
let restartResume: RestartResume;
let db: import("better-sqlite3").Database;
let callbacks: typeof import("../callbacks.js");
const attempts: Promise<unknown>[] = [];
const respond: Array<() => void> = [];

beforeAll(async () => {
  registry = await import("../registry.js");
  restartResume = await import("../restart-resume.js");
  db = (await import("../../shared/db.js")).initDb();
  callbacks = await import("../callbacks.js");
});

beforeEach(() => {
  db.prepare("DELETE FROM callback_deliveries").run();
  db.prepare("DELETE FROM queue_items").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM sessions").run();
  delete gatewayConfig.resumeInterruptedSessions;
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
    respond.push(() => resolve(new Response(null, { status: 204 })));
  })));
  const deliver = callbacks.deliverClaimedSessionDelivery;
  vi.spyOn(callbacks, "deliverClaimedSessionDelivery").mockImplementation((id) => {
    const pending = deliver(id);
    attempts.push(pending);
    return pending;
  });
});

// The nudge API returns its claim before the transport finishes. Releasing the
// fixture first used to leave real HTTP responses logging after worker teardown.
afterEach(async () => {
  respond.splice(0).forEach((resolve) => resolve());
  try {
    const settled = await Promise.allSettled(attempts);
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(failures.map((result) => result.reason), "Restart delivery fixture failed");
    }
  } finally {
    attempts.length = 0;
    callbacks.__resetCallbackRetrySweepForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

afterAll(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function session(status: string, overrides: Record<string, unknown> = {}) {
  const created = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${status}` });
  db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, created.id);
  if (Object.keys(overrides).length > 0) registry.updateSession(created.id, overrides);
  return registry.getSession(created.id)!;
}

/** The shutdown path only stamps `running` sessions, so the boot side sees a
 *  candidate exactly when the previous process really did cut a turn short. */
function interruptedByRestart() {
  const running = session("running");
  restartResume.interruptRunningSessionsForShutdown();
  return registry.getSession(running.id)!;
}

describe("restart interruption marking", () => {
  it("stamps a session that was running at clean shutdown", () => {
    const marked = interruptedByRestart();

    expect(marked.status).toBe("interrupted");
    expect(marked.transportMeta?.[registry.RESTART_RESUME_META_KEY]).toEqual(expect.any(String));
    expect(restartResume.consumeRestartResumeCandidates().map((s) => s.id)).toEqual([marked.id]);
  });

  it("never stamps a session that was already idle, waiting or errored", () => {
    const untouched = ["idle", "waiting", "error"].map((status) => session(status));

    restartResume.interruptRunningSessionsForShutdown();

    for (const before of untouched) {
      expect(registry.getSession(before.id)?.transportMeta ?? null).toBeNull();
    }
    expect(restartResume.consumeRestartResumeCandidates()).toEqual([]);
  });

  it("leaves a restart-requesting session idle and unstamped", () => {
    const requester = session("running", { transportMeta: { [registry.RESTART_ACK_META_KEY]: new Date().toISOString() } });

    restartResume.interruptRunningSessionsForShutdown();

    expect(registry.getSession(requester.id)?.status).toBe("idle");
    expect(restartResume.consumeRestartResumeCandidates()).toEqual([]);
  });

  it("stamps a session the previous gateway never got to shut down cleanly", () => {
    const crashed = session("running");

    expect(registry.recoverStaleSessions()).toBe(1);

    expect(restartResume.consumeRestartResumeCandidates().map((s) => s.id)).toEqual([crashed.id]);
  });

  it("never makes a workflow attempt session a candidate, however it was interrupted", () => {
    const attempt = session("running");
    db.prepare("UPDATE sessions SET workflow_kind = 'phase' WHERE id = ?").run(attempt.id);

    restartResume.interruptRunningSessionsForShutdown();
    registry.recoverStaleSessions();
    // Workflow attempts have their own restart recovery; this is the one that owns them.
    expect(registry.recoverStaleWorkflowAttemptSessions()).toBe(1);

    expect(registry.getSession(attempt.id)?.status).toBe("interrupted");
    expect(restartResume.consumeRestartResumeCandidates()).toEqual([]);
  });

  it("holds a workflow attempt out of the candidates even when it carries the mark", () => {
    const attempt = session("running");
    db.prepare("UPDATE sessions SET workflow_kind = 'phase' WHERE id = ?").run(attempt.id);
    registry.updateSession(attempt.id, { transportMeta: { [registry.RESTART_RESUME_META_KEY]: new Date().toISOString() } });

    expect(restartResume.consumeRestartResumeCandidates()).toEqual([]);
  });
});

describe("consumeRestartResumeCandidates", () => {
  it("skips a session whose pending queue item is already being replayed", () => {
    const marked = interruptedByRestart();
    registry.enqueueQueueItem(marked.id, marked.sessionKey || marked.id, "resume me");

    expect(registry.listAllPendingQueueItems()).toHaveLength(1);
    expect(restartResume.consumeRestartResumeCandidates()).toEqual([]);
    // Its mark is still consumed, so it cannot resurface on a later restart.
    expect(registry.getSession(marked.id)?.transportMeta ?? null).toBeNull();
  });

  it("returns each candidate once and nothing on a second boot", () => {
    const marked = interruptedByRestart();

    expect(restartResume.consumeRestartResumeCandidates().map((s) => s.id)).toEqual([marked.id]);
    expect(restartResume.consumeRestartResumeCandidates()).toEqual([]);
  });
});

describe("notifyGatewayRestartResume", () => {
  it("claims exactly one delivery carrying the restart message", () => {
    const marked = interruptedByRestart();

    expect(restartResume.notifyGatewayRestartResume(marked, "0.31.0")).toBe(true);

    const deliveries = registry.listPendingSessionDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ targetSessionId: marked.id, deliveryKind: "gateway-restart-resume" });
    expect(deliveries[0].payload.message).toContain("[Gateway] Restart complete (v0.31.0)");
  });

  it("creates no second row when the same nudge is claimed twice", () => {
    const marked = interruptedByRestart();
    const fresh = registry.getSession(marked.id)!;

    expect(restartResume.notifyGatewayRestartResume(fresh, "0.31.0")).toBe(true);
    expect(restartResume.notifyGatewayRestartResume(registry.getSession(marked.id)!, "0.31.0")).toBe(false);

    expect(registry.listPendingSessionDeliveries()).toHaveLength(1);
  });

  it("persists the nudge as a notification, not as operator input", () => {
    const marked = interruptedByRestart();
    restartResume.notifyGatewayRestartResume(marked, "0.31.0");
    const [delivery] = registry.listPendingSessionDeliveries();

    registry.acceptSessionDelivery(delivery.id, marked.id, marked.sessionKey || marked.id);

    expect(registry.getMessages(marked.id)).toEqual([
      expect.objectContaining({ role: "notification", content: expect.stringContaining("[Gateway] Restart complete") }),
    ]);
  });
});

describe("resumeRestartInterruptedSessions", () => {
  it("nudges the candidates a restart interrupted", () => {
    vi.useFakeTimers();
    const marked = interruptedByRestart();

    restartResume.resumeRestartInterruptedSessions("0.31.0");
    vi.advanceTimersByTime(0);

    expect(registry.listPendingSessionDeliveries().map((d) => d.targetSessionId)).toEqual([marked.id]);
  });

  it("claims nothing for any candidate when resumeInterruptedSessions is off", () => {
    vi.useFakeTimers();
    interruptedByRestart();
    gatewayConfig.resumeInterruptedSessions = false;

    restartResume.resumeRestartInterruptedSessions("0.31.0");
    vi.advanceTimersByTime(10 * 60_000);

    expect(registry.listPendingSessionDeliveries()).toEqual([]);
  });
});
