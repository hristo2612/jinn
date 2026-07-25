import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry DB, resolved from JINN_HOME at module load (see reconcile.test.ts).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-bounce-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Reg = typeof import("../../sessions/registry.js");

let store: Store;
let transitions: Transitions;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  transitions = await import("../transitions.js");
  const reg: Reg = await import("../../sessions/registry.js");
  db = reg.initDb();
});

/** Insert a session row and link it to the item as an execution attempt. */
function linkedSession(id: string, workItemId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'cron', ?, 'idle', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
  ).run(id, `cron:${id}`, workItemId);
  store.linkSession(workItemId, id);
}

/**
 * The review BOUNCE and its round budget (design §1.3).
 *
 * These paths existed and were correct but had never once executed in
 * production: the only agent-reachable route (`POST /work-items/:id/status`)
 * sets `manual`, and `transition()` refuses a manual move into `executing` from
 * anything but backlog/assigned. So `in_review → executing` was unreachable,
 * `rounds` never incremented, `effectiveMaxRounds` never fired, and reviewers
 * expressed rejection as `in_review → blocked` instead — an uncounted edge that
 * lets a review loop run forever: `rounds` stays 0 for the item's whole life,
 * so `effectiveMaxRounds` never fires and a review can bounce indefinitely
 * without ever reaching the operator.
 *
 * The bar these tests hold: a rejection is COUNTED, and a bounded loop ENDS in
 * front of the operator rather than spinning.
 */
describe("review bounce — the round budget that had never fired", () => {
  it("increments rounds and records bounce provenance on the audit event", () => {
    const wi = store.createWorkItem({
      title: "bounce increments rounds",
      status: "in_review",
      source: "delegation",
      verifyPolicy: { mode: "thorough", maxRounds: 4 },
    });

    const result = transitions.transition(wi.id, "executing", "engineering-verifier", {
      bounce: true,
      detail: { verdict: "fail", findings: ["cache validation is lazy"] },
    });

    expect(result.item.status).toBe("executing");
    expect(result.item.rounds).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.event?.detail).toMatchObject({ bounce: true, rounds: 1, verdict: "fail" });
  });

  it("is refused as `manual` — the exact reason the bounce edge was unreachable", () => {
    const wi = store.createWorkItem({
      title: "manual cannot bounce",
      status: "in_review",
      source: "delegation",
    });

    // This is what POST /work-items/:id/status did with target `executing`.
    expect(() => transitions.transition(wi.id, "executing", "engineering-verifier", { manual: true }))
      .toThrow(/illegal transition|illegal manual transition/);
    expect(store.getWorkItem(wi.id)?.status).toBe("in_review");
    expect(store.getWorkItem(wi.id)?.rounds).toBe(0);
  });

  it("ESCALATES to the operator instead of looping once the budget is exhausted", () => {
    const maxRounds = 3;
    const wi = store.createWorkItem({
      title: "bounded loop ends at the operator",
      status: "in_review",
      source: "delegation",
      verifyPolicy: { mode: "thorough", maxRounds },
    });

    // Rounds 1..maxRounds-1 return the item to its producer.
    for (let round = 1; round < maxRounds; round += 1) {
      const back = transitions.transition(wi.id, "executing", "engineering-verifier", {
        bounce: true,
        detail: { verdict: "fail", findings: [`round ${round} defect`] },
      });
      expect(back.item.status).toBe("executing");
      expect(back.item.rounds).toBe(round);
      expect(back.escalated).toBe(false);
      transitions.transition(wi.id, "in_review", "pipeline-reliability-engineer", {});
    }

    // The exhausting rejection does NOT return to executing — it lands on the
    // operator's queue. This is the loop terminator that never ran.
    const final = transitions.transition(wi.id, "executing", "engineering-verifier", {
      bounce: true,
      detail: { verdict: "fail", findings: ["still not fixed"] },
    });

    expect(final.escalated).toBe(true);
    expect(final.item.status).toBe("escalated");
    expect(final.item.rounds).toBe(maxRounds);
    expect(final.event?.kind).toBe("escalated");
    expect(final.event?.detail).toMatchObject({ reason: "max-rounds-exhausted", maxRounds });
  });

  it("uses the verify-mode default budget when the item declares no maxRounds", () => {
    const wi = store.createWorkItem({
      title: "default budget applies",
      status: "in_review",
      source: "delegation",
      verifyPolicy: { mode: "verify" },
    });
    const budget = store.effectiveMaxRounds(store.getWorkItem(wi.id)!);
    expect(budget).toBeGreaterThan(0);

    let escalated = false;
    for (let round = 0; round < budget + 2 && !escalated; round += 1) {
      const r = transitions.transition(wi.id, "executing", "engineering-verifier", {
        bounce: true,
        detail: { verdict: "fail", findings: ["defect"] },
      });
      escalated = r.escalated;
      if (!escalated) transitions.transition(wi.id, "in_review", "producer", {});
    }
    expect(escalated).toBe(true);
    expect(store.getWorkItem(wi.id)?.status).toBe("escalated");
  });

  it("a non-bounce in_review → executing does NOT consume the budget", () => {
    const wi = store.createWorkItem({
      title: "plain reopen is free",
      status: "in_review",
      source: "delegation",
      verifyPolicy: { mode: "thorough", maxRounds: 2 },
    });

    transitions.transition(wi.id, "executing", "operator", {});
    expect(store.getWorkItem(wi.id)?.rounds).toBe(0);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
  });

  it("keeps the self-review ban on the closure path", () => {
    const wi = store.createWorkItem({
      title: "producer cannot close its own work",
      status: "in_review",
      source: "delegation",
    });
    const linked = "sess-executor-1";
    linkedSession(linked, wi.id);

    expect(() => transitions.transition(wi.id, "done", "engineering-verifier", { callerSessionId: linked }))
      .toThrow(/self-review/i);
    expect(store.getWorkItem(wi.id)?.status).toBe("in_review");
  });

  it("closes on a reviewer PASS and stamps closed_at — closure IS the verdict", () => {
    const wi = store.createWorkItem({
      title: "pass closes immediately",
      status: "in_review",
      source: "delegation",
    });
    linkedSession("sess-executor-2", wi.id);

    const closed = transitions.transition(wi.id, "done", "engineering-verifier", {
      callerSessionId: "sess-reviewer-2",
      detail: { verdict: "pass" },
    });

    expect(closed.item.status).toBe("done");
    expect(closed.item.closedAt).toBeTruthy();
    expect(closed.event?.detail).toMatchObject({ verdict: "pass" });
  });
});
