import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { TurnSurface } from "../turn/types.js";

// Isolate the DB: JINN_HOME must be set before importing the registry
// (SESSIONS_DB is resolved at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-settle-refused-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { settleRefusedTurn } = await import("../turn/settle.js");

/**
 * A refusal has to land from `waiting` as well as from `running`.
 *
 * The remote-host gate moves a session to `waiting` while a desktop boots — the
 * same status the rate-limit path uses. When that host never comes up the turn
 * is refused, and the receipt is written through the SAME fenced update that
 * makes a turn terminal. That fence defaults to `running` only, so the write
 * was silently rejected and `settleTurn` returned before notifying the parent
 * or the transport: no error row, no reply, and the session pinned at `waiting`
 * forever. For an unattended employee that is indistinguishable from a turn
 * still working, which is the exact failure this whole feature is built around.
 */

const settledCalls: unknown[] = [];
const replies: string[] = [];
const surface: TurnSurface = {
  started: async () => {},
  delta: () => {},
  notice: async () => {},
  reply: async (text: string) => { replies.push(text); },
  waiting: async () => {},
  settled: async (report: unknown) => { settledCalls.push(report); },
};

function refusalInput(id: string, attemptToken: string) {
  return { session: { id }, attemptToken, employee: undefined } as any;
}

describe("settleRefusedTurn", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
    settledCalls.length = 0;
    replies.length = 0;
  });

  it("settles a turn refused while the session sits at `waiting`", async () => {
    const created = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:remote-offline" });
    const started = reg.beginSessionAttempt(created.id)!;
    // What the remote-host gate does before it starts waiting for a desktop.
    reg.updateSessionForAttempt(started.id, started.attemptToken!, { status: "waiting" });
    expect(reg.getSession(started.id)!.status).toBe("waiting");

    await settleRefusedTurn(
      refusalInput(started.id, started.attemptToken!),
      surface,
      "Remote host unavailable: build-box did not come up within 240s",
      () => ({}),
    );

    const after = reg.getSession(started.id)!;
    expect(after.status).toBe("error");
    expect(after.attemptOutcome).toBe("failed");
    expect(after.lastError).toContain("did not come up");
    // settleTurn returns BEFORE notifying the parent and the transport when the
    // fenced write is rejected, so these two are the proof it was not rejected.
    expect(settledCalls).toHaveLength(1);
    expect(replies[0]).toContain("Remote host unavailable");
  });

  it("still settles the ordinary refusal from `running`", async () => {
    const created = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:preflight" });
    const started = reg.beginSessionAttempt(created.id)!;

    await settleRefusedTurn(refusalInput(started.id, started.attemptToken!), surface, "budget exceeded", () => ({}));

    expect(reg.getSession(started.id)!.status).toBe("error");
    expect(settledCalls).toHaveLength(1);
  });

  it("does not settle a turn another owner has already taken", async () => {
    // Widening the fence must not weaken it: an interrupted row stays immutable.
    const created = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:stopped" });
    const started = reg.beginSessionAttempt(created.id)!;
    reg.updateSessionForAttempt(started.id, started.attemptToken!, { status: "interrupted", attemptOutcome: "interrupted" });

    await settleRefusedTurn(refusalInput(started.id, started.attemptToken!), surface, "too late", () => ({}));

    expect(reg.getSession(started.id)!.status).toBe("interrupted");
    expect(settledCalls).toHaveLength(0);
  });
});
