import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { TurnReceipt, TurnSurface } from "../../sessions/turn/types.js";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-reconciler-"));
process.env.JINN_HOME = tmp;

// The sweep now settles through settleTurn, which wakes the parent. Stub only
// that one export so the wake is observable without a real delivery.
const notifyParentSession = vi.fn();
vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return {
    ...actual,
    notifyParentSession: (...args: unknown[]) => notifyParentSession(...args),
    notifyParentSessionAndWait: (...args: unknown[]) => notifyParentSession(...args),
  };
});

type Reg = typeof import("../../sessions/registry.js");
type Rec = typeof import("../status-reconciler.js");
let reg: Reg;
let rec: Rec;
let db: import("better-sqlite3").Database;

function insert(id: string, status: string, lastActivity: string, engine = "claude", parent?: string) {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity, parent_session_id)
     VALUES (?, ?, 'web', ?, ?, ?, ?, ?)`,
  ).run(id, engine, `web:${id}`, status, lastActivity, lastActivity, parent ?? null);
}

const NOW = new Date("2026-06-10T12:00:00.000Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const STUCK_ERROR = "Interrupted: engine turn ended without a terminal result";

/** The transport seam the sweep reports through, recorded rather than emitted. */
const receipts: TurnReceipt[] = [];
const surface: TurnSurface = {
  started: async () => {},
  delta: () => {},
  notice: async () => {},
  reply: async () => {},
  waiting: async () => {},
  settled: async (receipt) => { receipts.push(receipt); },
};
const surfaceFor = () => surface;

function fakeEngine(turnRunning: boolean) {
  return { name: "claude", run: async () => ({ sessionId: "", result: "" }), isTurnRunning: () => turnRunning } as any;
}

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  rec = await import("../status-reconciler.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM sessions").run();
  receipts.length = 0;
  notifyParentSession.mockClear();
});

describe("status reconciler sweepOnce", () => {
  it("resets a stale running session whose engine reports no turn", async () => {
    insert("stuck-1", "running", iso(120_000));
    const fixed = await rec.sweepOnce({
      engines: new Map([["claude", fakeEngine(false)]]),
      surfaceFor,
      now: () => NOW,
    });
    expect(fixed).toBe(1);
    expect(reg.getSession("stuck-1")).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
    expect(receipts).toMatchObject([{ session: { id: "stuck-1" } }]);
  });

  it("leaves a running session with a FRESH heartbeat alone", async () => {
    insert("live-1", "running", iso(10_000)); // heartbeat 10s ago — turn in flight
    const fixed = await rec.sweepOnce({ engines: new Map([["claude", fakeEngine(false)]]), surfaceFor, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("live-1")?.status).toBe("running");
  });

  it("leaves a stale running session alone when the engine still reports a turn", async () => {
    insert("working-1", "running", iso(120_000));
    const fixed = await rec.sweepOnce({ engines: new Map([["claude", fakeEngine(true)]]), surfaceFor, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("working-1")?.status).toBe("running");
  });

  it("ignores idle sessions and unknown engines", async () => {
    insert("idle-1", "idle", iso(999_000));
    insert("ghost-1", "running", iso(120_000), "no-such-engine");
    const fixed = await rec.sweepOnce({ engines: new Map(), surfaceFor, now: () => NOW });
    // Unknown engine → no live turn possible → unstick it too.
    expect(fixed).toBe(1);
    expect(reg.getSession("idle-1")?.status).toBe("idle");
    expect(reg.getSession("ghost-1")).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
  });

  it("leaves a stale 'waiting' session untouched (rate-limit wait)", async () => {
    insert("waiting-1", "waiting", iso(999_000));
    const fixed = await rec.sweepOnce({ engines: new Map([["claude", fakeEngine(false)]]), surfaceFor, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("waiting-1")?.status).toBe("waiting");
  });

  it("isAlive fallback: headless engine without isTurnRunning", async () => {
    insert("headless-live", "running", iso(120_000), "codex");
    insert("headless-dead", "running", iso(120_000), "codex");
    const aliveEngine = { name: "codex", run: async () => ({ sessionId: "", result: "" }), isAlive: (id: string) => id === "headless-live" } as any;
    const fixed = await rec.sweepOnce({ engines: new Map([["codex", aliveEngine]]), surfaceFor, now: () => NOW });
    expect(fixed).toBe(1);
    expect(reg.getSession("headless-live")?.status).toBe("running");
    expect(reg.getSession("headless-dead")).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
  });

  it("isTurnRunning wins over isAlive (warm-but-idle PTY must be unstuck)", async () => {
    insert("warm-idle", "running", iso(120_000));
    const warmIdle = { name: "claude", run: async () => ({ sessionId: "", result: "" }), isTurnRunning: () => false, isAlive: () => true } as any;
    const fixed = await rec.sweepOnce({ engines: new Map([["claude", warmIdle]]), surfaceFor, now: () => NOW });
    expect(fixed).toBe(1);
    expect(reg.getSession("warm-idle")).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
  });

  it("two-sweep confirmation: first sweep marks, second sweep fixes, recovery clears the mark", async () => {
    insert("boundary-1", "running", iso(120_000));
    const pendingStuck = new Set<string>();
    const deps = { engines: new Map([["claude", fakeEngine(false)]]), surfaceFor, now: () => NOW, pendingStuck };
    expect(await rec.sweepOnce(deps)).toBe(0); // first observation — candidate only
    expect(reg.getSession("boundary-1")?.status).toBe("running");
    expect(await rec.sweepOnce(deps)).toBe(1); // second consecutive observation — fixed
    expect(reg.getSession("boundary-1")).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });

    // A candidate that recovers (fresh heartbeat) is cleared, not fixed later.
    insert("boundary-2", "running", iso(120_000));
    expect(await rec.sweepOnce(deps)).toBe(0); // marked
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(iso(1_000), "boundary-2");
    expect(await rec.sweepOnce(deps)).toBe(0); // fresh — mark cleared
    db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(iso(120_000), "boundary-2");
    expect(await rec.sweepOnce(deps)).toBe(0); // stale again — needs re-confirmation
    expect(await rec.sweepOnce(deps)).toBe(1); // now fixed
  });

  it("records an interruption error and restamps lastActivity on fix", async () => {
    insert("stuck-meta", "running", iso(120_000));
    db.prepare("UPDATE sessions SET last_error = 'boom' WHERE id = ?").run("stuck-meta");
    await rec.sweepOnce({ engines: new Map(), surfaceFor, now: () => NOW });
    const s = reg.getSession("stuck-meta");
    expect(s?.lastError).toBe(STUCK_ERROR);
    // settleTurn stamps the receipt from the wall clock, so deps.now() no longer reaches lastActivity.
    expect(new Date(s!.lastActivity).getTime()).toBeGreaterThanOrEqual(NOW);
  });

  it("T1: the settled receipt carries the reason, not a null error", async () => {
    insert("stuck-reason", "running", iso(120_000));
    await rec.sweepOnce({ engines: new Map(), surfaceFor, now: () => NOW });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ session: { id: "stuck-reason" }, result: null, error: STUCK_ERROR });
  });

  it("T2: a stuck child wakes its parent with the reason", async () => {
    insert("parent-1", "idle", iso(1_000));
    insert("stuck-child", "running", iso(120_000), "claude", "parent-1");
    await rec.sweepOnce({ engines: new Map(), surfaceFor, now: () => NOW });
    expect(notifyParentSession).toHaveBeenCalledTimes(1);
    const [child, report] = notifyParentSession.mock.calls[0] as [{ id: string }, { error: string }];
    expect(child.id).toBe("stuck-child");
    expect(report.error).toBe(STUCK_ERROR);
  });

  it("T3: settles a token-less row by minting an attempt, and a token-bearing one through the fence", async () => {
    insert("no-token", "running", iso(120_000));
    insert("with-token", "running", iso(120_000));
    const token = reg.beginSessionAttempt("with-token")?.attemptToken;
    expect(token).toBeTruthy();
    expect(reg.getSession("no-token")?.attemptToken).toBeNull();
    expect(await rec.sweepOnce({ engines: new Map(), surfaceFor, now: () => NOW })).toBe(2);
    expect(reg.getSession("no-token")).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted" });
    expect(reg.getSession("with-token")).toMatchObject({ status: "interrupted", attemptOutcome: "interrupted", attemptToken: token });
  });
});
