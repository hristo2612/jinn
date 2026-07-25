import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). Keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-reconcile-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Reconcile = typeof import("../reconcile.js");
type Reg = typeof import("../../sessions/registry.js");

let store: Store;
let reconcile: Reconcile;
let reg: Reg;
let db: import("better-sqlite3").Database;

type SessionStatus = "idle" | "running" | "error" | "waiting" | "interrupted";
type AttemptOutcome = "succeeded" | "failed" | "interrupted" | null;

function evidence(status: SessionStatus, outcome: AttemptOutcome = status === "idle" ? "succeeded" : status === "error" ? "failed" : status === "interrupted" ? "interrupted" : null) {
  return { status, outcome };
}

/** Insert a session in a given status and link it to a work item. `at` sets last_activity
 *  so newest-first ordering in listSessionsByWorkItem is deterministic. */
function linkedSession(id: string, workItemId: string, status: SessionStatus, at: string, outcome: AttemptOutcome = evidence(status).outcome): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, attempt_outcome, work_item_id, created_at, last_activity)
     VALUES (?, 'claude', 'cron', ?, ?, ?, ?, ?, ?)`,
  ).run(id, `cron:${id}`, status, outcome, workItemId, at, at);
}

let transitionsModule: typeof import("../transitions.js");
/** The guarded transition module, loaded after JINN_HOME is redirected. */
function transitionsFor(): typeof import("../transitions.js") {
  return transitionsModule;
}

beforeAll(async () => {
  store = await import("../store.js");
  reconcile = await import("../reconcile.js");
  reg = await import("../../sessions/registry.js");
  transitionsModule = await import("../transitions.js");
  db = reg.initDb();
});

describe("deriveWorkItemStatus — pure truth table (GRS-021a elevated vocabulary)", () => {
  const D = () => (
    current: Parameters<Reconcile["deriveWorkItemStatus"]>[0],
    statuses: SessionStatus[],
    source?: Parameters<Reconcile["deriveWorkItemStatus"]>[2],
  ) => reconcile.deriveWorkItemStatus(current, statuses.map((status) => evidence(status)), source);

  it("keeps sticky terminals (done/cancelled/ESCALATED) regardless of session evidence", () => {
    expect(D()("done", ["running"])).toBe("done");
    expect(D()("done", ["error", "interrupted"])).toBe("done");
    expect(D()("cancelled", ["idle"])).toBe("cancelled");
    expect(D()("escalated", ["running"])).toBe("escalated"); // operator queue never silently drained
    expect(D()("escalated", ["idle"])).toBe("escalated");
  });

  it("leaves an item with NO linked sessions untouched (no evidence — backlog/assigned safe)", () => {
    expect(D()("backlog", [])).toBe("backlog");
    expect(D()("assigned", [])).toBe("assigned");
    expect(D()("executing", [])).toBe("executing");
    expect(D()("blocked", [])).toBe("blocked");
  });

  it("is executing when any linked session is in flight (running/waiting)", () => {
    expect(D()("backlog", ["running"])).toBe("executing");
    expect(D()("assigned", ["running"])).toBe("executing");
    expect(D()("blocked", ["waiting"])).toBe("executing");
    expect(D()("backlog", ["interrupted", "running"])).toBe("executing");
    expect(D()("blocked", ["error", "waiting"])).toBe("executing");
  });

  it("does not regress a reviewed Todo to executing because a linked session is active", () => {
    expect(D()("in_review", ["running"], "delegation")).toBe("in_review");
    expect(D()("in_review", ["waiting", "idle"], "delegation")).toBe("in_review");
  });

  it("derives IN_REVIEW when the NEWEST attempt settled idle (the vision's settle ≠ done)", () => {
    // Arrays are newest-first: idle is the latest attempt, the older error is superseded.
    expect(D()("backlog", ["idle"])).toBe("in_review");
    expect(D()("blocked", ["idle", "error"])).toBe("in_review");
    expect(D()("executing", ["idle", "interrupted"])).toBe("in_review");
    // Never done from derivation alone — the TRUST hook / a reviewer decides.
    expect(D()("executing", ["idle", "idle"])).toBe("in_review");
  });

  it("does not treat conversational idle without a successful terminal receipt as completed work", () => {
    expect(reconcile.deriveWorkItemStatus("executing", [evidence("idle", null)])).toBe("executing");
    expect(reconcile.deriveWorkItemStatus("assigned", [evidence("idle", null)])).toBe("assigned");
  });

  it("is blocked when the NEWEST attempt failed, even if an older attempt settled idle", () => {
    expect(D()("executing", ["error", "idle"])).toBe("blocked");
    expect(D()("executing", ["interrupted", "idle"])).toBe("blocked");
    expect(D()("executing", ["interrupted"])).toBe("blocked");
    expect(D()("backlog", ["error", "interrupted"])).toBe("blocked");
  });

  it("in-flight anywhere trumps a newer terminal state", () => {
    expect(D()("backlog", ["error", "running"])).toBe("executing");
    expect(D()("blocked", ["interrupted", "waiting"])).toBe("executing");
  });

  it("gives historical Workflow provenance no special lifecycle semantics", () => {
    expect(D()("executing", ["running"], "workflow")).toBe("executing");
    expect(D()("backlog", ["running"], "workflow")).toBe("executing");
    expect(D()("executing", ["idle"], "workflow")).toBe("in_review");
    expect(D()("executing", ["interrupted"], "workflow")).toBe("blocked");
    expect(D()("backlog", ["idle"], "workflow")).toBe("in_review");
  });
});

describe("reconcileWorkItem — integration against real store + registry", () => {
  it("returns undefined for an unknown id", () => {
    expect(reconcile.reconcileWorkItem("JIN-999")).toBeUndefined();
  });

  it("treats a historical Workflow Todo as audit-only in direct reconciliation", () => {
    const wi = store.createWorkItem({
      title: "historical workflow audit",
      status: "executing",
      source: "workflow",
      sourceRef: "workflow:legacy:run-1",
    });
    linkedSession("s-workflow-direct", wi.id, "idle", "2026-07-01T00:00:00.000Z");
    const beforeEvents = store.listWorkItemEvents(wi.id);

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({
      changed: false,
      item: { status: "executing", source: "workflow" },
    });
    expect(store.listWorkItemEvents(wi.id)).toEqual(beforeEvents);
  });

  it("never TRUST-closes a historical Workflow Todo already sitting in review", () => {
    const wi = store.createWorkItem({
      title: "historical workflow review",
      status: "in_review",
      source: "workflow",
      sourceRef: "workflow:legacy:run-2",
    });
    linkedSession("s-workflow-review", wi.id, "idle", "2026-07-01T00:00:00.000Z");

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: false, item: { status: "in_review" } });
    expect(store.getWorkItem(wi.id)?.status).toBe("in_review");
  });

  it("continues normal reconciliation after an operator manually starts an item", async () => {
    const transitions = await import("../transitions.js");
    const wi = store.createWorkItem({ title: "manual start", status: "backlog", source: "human" });
    transitions.transition(wi.id, "executing", "operator", { human: true, manual: true });
    linkedSession("s-manual-start", wi.id, "running", "2026-07-01T00:00:00.000Z");

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: false, item: { status: "executing" } });

    db.prepare("UPDATE sessions SET status = 'idle', attempt_outcome = 'succeeded' WHERE id = ?").run("s-manual-start");
    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: true, item: { status: "in_review" } });
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.kind === "status_change").map((event) => ({
      from: event.fromStatus,
      to: event.toStatus,
      actor: event.actor,
    }))).toEqual([
      { from: "backlog", to: "executing", actor: "operator" },
      { from: "executing", to: "in_review", actor: "reconciler" },
    ]);
  });

  it("moves executing → blocked when its only session was interrupted (the split-brain case)", () => {
    const wi = store.createWorkItem({ title: "delegated fix", status: "executing", source: "delegation", sourceRef: "delegate:j1:1" });
    linkedSession("s-int-1", wi.id, "interrupted", "2026-07-01T00:00:00.000Z");

    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.changed).toBe(true);
    expect(r?.item.status).toBe("blocked");
    // The derived move is event-audited through the guarded transitions.
    const last = store.listWorkItemEvents(wi.id).at(-1)!;
    expect(last).toMatchObject({ kind: "status_change", fromStatus: "executing", toStatus: "blocked", actor: "reconciler" });
  });

  it("VERIFY-tier settle lands in in_review and STAYS (a reviewer closes it, not the reconciler)", () => {
    const wi = store.createWorkItem({ title: "delegation settled", status: "executing", source: "delegation", sourceRef: "delegate:j2:1" });
    linkedSession("s-ok-2", wi.id, "idle", "2026-07-01T01:00:00.000Z");

    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.changed).toBe(true);
    expect(r?.item.status).toBe("in_review");
    // A second pass is a no-op: verify-tier items wait for their reviewer.
    expect(reconcile.reconcileWorkItem(wi.id)?.changed).toBe(false);
    expect(store.getWorkItem(wi.id)?.status).toBe("in_review");
  });

  it("keeps a delegated in_review Todo in review while its linked callback session is running", () => {
    const wi = store.createWorkItem({
      title: "review callback",
      status: "in_review",
      source: "delegation",
      sourceRef: "delegate:reviewer:callback",
    });
    linkedSession("s-review-callback", wi.id, "running", "2026-07-01T01:30:00.000Z");

    const result = reconcile.reconcileWorkItem(wi.id);
    expect(result?.changed).toBe(false);
    expect(result?.item.status).toBe("in_review");
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.toStatus === "executing")).toHaveLength(0);
  });

  it("TRUST-tier settle auto-closes: executing → in_review → done in ONE pass, both event-audited", () => {
    const wi = store.createWorkItem({ title: "cron fire", status: "executing", source: "cron", sourceRef: "cron:j3:1" });
    linkedSession("s-ok-3", wi.id, "idle", "2026-07-01T01:00:00.000Z");

    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.changed).toBe(true);
    expect(r?.item.status).toBe("done");
    expect(r?.item.closedAt).not.toBeNull();
    const kinds = store.listWorkItemEvents(wi.id).map((e) => `${e.fromStatus}→${e.toStatus}:${e.actor}`);
    expect(kinds).toContain("executing→in_review:reconciler");
    expect(kinds).toContain("in_review→done:policy:trust");
  });

  it("an explicit verify policy OVERRIDES the trust provenance default (cron item held for review)", () => {
    const wi = store.createWorkItem({
      title: "reviewed cron",
      status: "executing",
      source: "cron",
      sourceRef: "cron:j3b:1",
      verifyPolicy: { mode: "verify" },
    });
    linkedSession("s-ok-3b", wi.id, "idle", "2026-07-01T01:00:00.000Z");
    expect(reconcile.reconcileWorkItem(wi.id)?.item.status).toBe("in_review");
  });

  it("a pre-existing in_review TRUST item closes on the next sweep pass (hook fires on sitting items too)", () => {
    const wi = store.createWorkItem({ title: "stranded trust", status: "in_review", source: "cron", sourceRef: "cron:j3c:1" });
    linkedSession("s-ok-3c", wi.id, "idle", "2026-07-01T01:00:00.000Z");
    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.item.status).toBe("done");
  });

  it("moves executing → blocked when a NEWER attempt failed after an older idle (recency wins)", () => {
    const wi = store.createWorkItem({ title: "regressed", status: "executing", source: "delegation", sourceRef: "delegate:j4:1" });
    linkedSession("s-ok-4", wi.id, "idle", "2026-07-01T00:00:00.000Z");
    linkedSession("s-int-4", wi.id, "interrupted", "2026-07-01T01:00:00.000Z");

    expect(reconcile.reconcileWorkItem(wi.id)?.item.status).toBe("blocked");
  });

  it("is a no-op when derived status already matches (no write, no updated_at churn)", () => {
    const wi = store.createWorkItem({ title: "steady", status: "executing", source: "cron", sourceRef: "cron:j5:1" });
    linkedSession("s-run-5", wi.id, "running", "2026-07-01T00:00:00.000Z");
    const before = store.getWorkItem(wi.id)!.updatedAt;

    const r = reconcile.reconcileWorkItem(wi.id);
    expect(r?.changed).toBe(false);
    expect(store.getWorkItem(wi.id)?.updatedAt).toBe(before);
  });

  it("keeps done sticky even though its session errored; keeps ESCALATED sticky through churn", () => {
    const done = store.createWorkItem({ title: "finished", status: "done", source: "cron", sourceRef: "cron:j6:1" });
    linkedSession("s-err-6", done.id, "error", "2026-07-01T00:00:00.000Z");
    expect(reconcile.reconcileWorkItem(done.id)?.changed).toBe(false);
    expect(store.getWorkItem(done.id)?.status).toBe("done");

    const esc = store.createWorkItem({ title: "with operator", status: "escalated", source: "delegation", sourceRef: "delegate:j7:1" });
    linkedSession("s-idle-7", esc.id, "idle", "2026-07-01T00:00:00.000Z");
    expect(reconcile.reconcileWorkItem(esc.id)?.changed).toBe(false);
    expect(store.getWorkItem(esc.id)?.status).toBe("escalated");
  });

  it("leaves an item with no linked sessions untouched (backlog/assigned never clobbered)", () => {
    const wi = store.createWorkItem({ title: "unlinked", status: "assigned", source: "human" });
    expect(reconcile.reconcileWorkItem(wi.id)?.changed).toBe(false);
    expect(store.getWorkItem(wi.id)?.status).toBe("assigned");
  });

});

describe("reconcileActiveWorkItems / startup sweep — the recoverStaleSessions moment", () => {
  it("keeps historical Workflow Todos audit-only during startup reconciliation", () => {
    const wi = store.createWorkItem({
      title: "workflow startup audit",
      status: "executing",
      source: "workflow",
      sourceRef: "workflow:legacy:startup",
    });
    linkedSession("s-workflow-startup", wi.id, "interrupted", "2026-07-01T01:59:00.000Z");

    reconcile.reconcileWorkItemsOnStartup();

    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.actor === "reconciler")).toHaveLength(0);
  });

  it("sweeps non-sticky items (incl. in_review) and skips done/cancelled/escalated", () => {
    const dying = store.createWorkItem({ title: "sweep-dying", status: "executing", source: "cron", sourceRef: "cron:sw1:1" });
    linkedSession("s-sw-int", dying.id, "interrupted", "2026-07-01T02:00:00.000Z");
    const closed = store.createWorkItem({ title: "sweep-closed", status: "done", source: "cron", sourceRef: "cron:sw2:1" });
    linkedSession("s-sw-err", closed.id, "error", "2026-07-01T02:00:00.000Z");

    const result = reconcile.reconcileActiveWorkItems();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    expect(result.changed).toBeGreaterThanOrEqual(1);

    expect(store.getWorkItem(dying.id)?.status).toBe("blocked");
    expect(store.getWorkItem(closed.id)?.status).toBe("done"); // sticky, untouched
  });

  it("reconcileWorkItemsOnStartup returns the change count and never throws", () => {
    const changed = reconcile.reconcileWorkItemsOnStartup();
    expect(typeof changed).toBe("number");
    expect(changed).toBeGreaterThanOrEqual(0);
  });

  it("startWorkItemReconciler ticks a sweep and stops cleanly", async () => {
    const wi = store.createWorkItem({ title: "periodic", status: "executing", source: "cron", sourceRef: "cron:tick:1" });
    linkedSession("s-tick-1", wi.id, "idle", "2026-07-01T03:00:00.000Z");
    const stop = reconcile.startWorkItemReconciler(20);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    // trust-tier cron item settled → the periodic sweep closed it without a boot.
    expect(store.getWorkItem(wi.id)?.status).toBe("done");
  });

  it("keeps historical Workflow Todos audit-only during periodic reconciliation", async () => {
    const wi = store.createWorkItem({
      title: "workflow periodic audit",
      status: "executing",
      source: "workflow",
      sourceRef: "workflow:legacy:periodic",
    });
    linkedSession("s-workflow-periodic", wi.id, "idle", "2026-07-01T03:30:00.000Z");
    const stop = reconcile.startWorkItemReconciler(20);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();

    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
    expect(store.listWorkItemEvents(wi.id).filter((event) => event.actor === "reconciler" || event.actor === "policy:trust")).toHaveLength(0);
  });
});

describe("ICI-570 — live todo events from the reconciler", () => {
  it("emits one event when reconcile changes status, none when it no-ops", async () => {
    const live = await import("../live-events.js");
    const events: Array<Record<string, unknown>> = [];
    live.setTodoLiveEmitter((event) => events.push(event as unknown as Record<string, unknown>));
    try {
      const item = store.createWorkItem({ title: "live reconcile item" });
      linkedSession("live-rec-1", item.id, "running", "2026-07-24T10:00:00.000Z");
      const first = reconcile.reconcileWorkItem(item.id);
      expect(first?.changed).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ entity: "todo", action: "reconciled", id: item.id }));
      expect(events).toHaveLength(1);

      events.length = 0;
      const second = reconcile.reconcileWorkItem(item.id);
      expect(second?.changed).toBe(false);
      expect(events).toEqual([]);
    } finally {
      live.setTodoLiveEmitter(null);
    }
  });
});

describe("declared blocks survive derivation", () => {
  it("pure: a DECLARED block stays blocked even with an in-flight session", () => {
    expect(
      reconcile.deriveWorkItemStatus("blocked", [evidence("running")], undefined, { blockDeclared: true }),
    ).toBe("blocked");
  });

  it("pure: a DERIVED block still re-derives to executing (unchanged behaviour)", () => {
    expect(
      reconcile.deriveWorkItemStatus("blocked", [evidence("running")], undefined, { blockDeclared: false }),
    ).toBe("executing");
    // Absent options behaves exactly as before this change.
    expect(reconcile.deriveWorkItemStatus("blocked", [evidence("running")])).toBe("executing");
  });

  it("pure: a declared block does not block the STICKY terminals or review", () => {
    expect(reconcile.deriveWorkItemStatus("done", [evidence("running")], undefined, { blockDeclared: true })).toBe("done");
    expect(reconcile.deriveWorkItemStatus("in_review", [evidence("running")], undefined, { blockDeclared: true })).toBe("in_review");
  });

  it("integration: an agent-declared block survives a sweep and writes NO event", () => {
    const wi = store.createWorkItem({ title: "declared block holds", status: "executing", source: "delegation" });
    linkedSession("s-declared-hold", wi.id, "running", "2026-07-02T00:00:00.000Z");
    transitionsFor().transition(wi.id, "blocked", "engineering-verifier", {
      detail: { declared: true, unblockCondition: "operator must authorize the production env write" },
    });
    const before = store.listWorkItemEvents(wi.id);

    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: false, item: { status: "blocked" } });
    expect(store.getWorkItem(wi.id)?.status).toBe("blocked");
    expect(store.listWorkItemEvents(wi.id)).toEqual(before);
  });

  it("integration: a reconciler-DERIVED block still clears when work resumes", () => {
    const wi = store.createWorkItem({ title: "derived block clears", status: "executing", source: "delegation" });
    linkedSession("s-derived-fail", wi.id, "interrupted", "2026-07-02T01:00:00.000Z");

    // Transport failure derives the block...
    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: true, item: { status: "blocked" } });
    expect(store.listWorkItemEvents(wi.id).at(-1)?.actor).toBe("reconciler");

    // ...and a fresh in-flight attempt clears it, exactly as before.
    linkedSession("s-derived-retry", wi.id, "running", "2026-07-02T02:00:00.000Z");
    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: true, item: { status: "executing" } });
  });

  it("integration: a pre-`declared` historical block falls back to actor provenance", () => {
    const wi = store.createWorkItem({ title: "legacy block provenance", status: "executing", source: "delegation" });
    linkedSession("s-legacy-block", wi.id, "running", "2026-07-02T03:00:00.000Z");
    // A caller-written block with NO `declared` marker — the shape of every one
    // of the 46 blocks already in the live ledger.
    transitionsFor().transition(wi.id, "blocked", "session:abc123", { detail: { note: "external need" } });

    expect(store.isBlockDeclared(wi.id)).toBe(true);
    expect(reconcile.reconcileWorkItem(wi.id)).toMatchObject({ changed: false, item: { status: "blocked" } });
  });

  it("regression: repeated declare→sweep yields ONE block, not a flap per sweep", async () => {
    const wi = store.createWorkItem({ title: "declared block under an active sweep", status: "executing", source: "delegation" });
    linkedSession("s-jin44", wi.id, "running", "2026-07-02T04:00:00.000Z");

    transitionsFor().transition(wi.id, "blocked", "session:abc123", {
      detail: { declared: true, unblockCondition: "fresh production env authority" },
    });

    // Before this change the sweep flipped a declared block straight back,
    // so the block never survived long enough to be seen.
    const stop = reconcile.startWorkItemReconciler(10);
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();

    const blockEvents = store.listWorkItemEvents(wi.id).filter((e) => e.toStatus === "blocked");
    const reconcilerWrites = store.listWorkItemEvents(wi.id).filter((e) => e.actor === "reconciler");
    expect(blockEvents).toHaveLength(1);
    expect(reconcilerWrites).toHaveLength(0);
    expect(store.getWorkItem(wi.id)?.status).toBe("blocked");
  });
});
