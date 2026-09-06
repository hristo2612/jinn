import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { WorkflowRepository } from "../../workflows/repository.js";
import type { WorkflowDefinition, WorkflowNode } from "../../workflows/model.js";

const inheritedHome = process.env.JINN_HOME!;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-gw-todo-recovery-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../../work-items/store.js");
type Runs = typeof import("../../work-items/runs.js");
type Approvals = typeof import("../../work-items/approvals.js");
type Recovery = typeof import("../todo-recovery.js");
type Transitions = typeof import("../../work-items/transitions.js");
type Controller = typeof import("../../work-items/recovery-controller.js");
type Detect = typeof import("../../work-items/anomaly-detect.js");
type Rows = typeof import("../../work-items/recovery-rows.js");

let store: Store;
let runs: Runs;
let approvals: Approvals;
let recovery: Recovery;
let transitions: Transitions;
let controller: Controller;
let detect: Detect;
let rows: Rows;
let db: import("better-sqlite3").Database;
let workflowDb: import("better-sqlite3").Database;
let workflowRepository: WorkflowRepository;

beforeAll(async () => {
  const { openWorkflowDatabase } = await import("../../workflows/repository-migrations.js");
  const { WorkflowRepository } = await import("../../workflows/repository.js");
  store = await import("../../work-items/store.js");
  runs = await import("../../work-items/runs.js");
  approvals = await import("../../work-items/approvals.js");
  transitions = await import("../../work-items/transitions.js");
  recovery = await import("../todo-recovery.js");
  controller = await import("../../work-items/recovery-controller.js");
  detect = await import("../../work-items/anomaly-detect.js");
  rows = await import("../../work-items/recovery-rows.js");
  db = (await import("../../shared/db.js")).initDb();
  workflowDb = openWorkflowDatabase(path.join(tmp, "workflows.db"));
  workflowRepository = new WorkflowRepository(workflowDb);
});

afterAll(async () => {
  workflowDb?.close();
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}

function createWorkflowRun(todoId: string, state: "running" | "completed" | "failed"): { workflowId: string; runId: string } {
  const workflowId = `recovery-${todoId.toLowerCase()}`;
  const created = workflowRepository.createDefinition({ id: workflowId, title: workflowId });
  const nodes: WorkflowNode[] = [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "gate", type: "approval", name: "Gate", config: { description: "Land?", operatorOnly: true } },
    { id: "land", type: "employee", name: "Land", config: {
      employee: { source: "fixed", value: "platform-worker" }, prompt: "Land.",
      output: { fields: {}, allowAdditionalFields: true },
    } },
    { id: "done", type: "end", name: "Done", config: { result: "success" } },
  ];
  const definition = workflowRepository.saveDefinition({ ...created, inputs: [], nodes, edges: [
    edge("start-gate", "start", "success", "gate"),
    edge("gate-land", "gate", "approved", "land"),
    edge("land-done", "land", "success", "done"),
  ] } as WorkflowDefinition, created.revision);
  const run = workflowRepository.createRun({ workflowId, input: {}, trigger: {
    nodeId: "start", kind: "manual", payload: {}, ...{ todoId },
  } });
  const at = new Date().toISOString();
  workflowRepository.mutateRun(run.id, run.revision, (tx) => {
    tx.setNodeStatus("start", "completed", { activated: true, endedAt: at });
    tx.setNodeStatus("gate", "completed", { activated: true, endedAt: at });
    tx.putApproval({ nodeId: "gate", status: "approved", requestedAt: at,
      decidedAt: at, decidedBy: "operator", decision: "approve" });
    if (state === "completed") {
      tx.setNodeStatus("land", "completed", { activated: true, endedAt: at });
      tx.setNodeStatus("done", "completed", { activated: true, endedAt: at });
      tx.setRunStatus("completed", { endedAt: at });
    } else if (state === "failed") {
      tx.setNodeStatus("land", "failed", { activated: true, endedAt: at });
      tx.setRunStatus("failed", { endedAt: at });
    } else {
      tx.setRunStatus("running");
    }
  });
  return { workflowId: definition.id, runId: run.id };
}

function tick(mode: "classify-only" | "auto" = "classify-only"): void {
  controller.sweepTodoRecovery({ mode, rearm: () => ({ status: "assigned" }) });
  detect.detectTodoAnomalies({ persist: true,
    approvedLandingComplete: (todoId) => recovery.approvedLandingComplete(todoId, workflowRepository),
    closeApprovedLanded: (todoId) => recovery.closeApprovedLanded(todoId, workflowRepository) });
}

describe("recovery fixture isolation", () => {
  it("opens the registry in its own home", () => {
    expect(db.name).toBe(path.join(tmp, "sessions", "registry.db"));
  });

  it("keeps approval writes independent of another fixture's commit", () => {
    const item = store.createWorkItem({ title: "isolated approval" });
    const peerPath = path.join(inheritedHome, "sessions", "registry.db");
    fs.mkdirSync(path.dirname(peerPath), { recursive: true });
    const peer = new Database(peerPath);
    peer.pragma("journal_mode = WAL");
    peer.exec("CREATE TABLE IF NOT EXISTS isolation_probe (value TEXT)");
    try {
      db.transaction(() => {
        db.prepare("SELECT id FROM work_items WHERE id = ?").get(item.id);
        // Reproduce a competing fixture committing after the reader's snapshot.
        peer.prepare("INSERT INTO isolation_probe VALUES (?)").run("peer commit");
        approvals.requestApproval(item.id, { request: "Approve isolated work?" });
      })();
      expect(store.getWorkItem(item.id)!.approvalState).toBe("pending");
      expect(peer.prepare("SELECT name FROM sqlite_master WHERE name = 'work_items'").get())
        .toBeUndefined();
    } finally {
      peer.close();
    }
  });
});

describe("closeApprovedLanded", () => {
  it("closes only when the exact approved Workflow run completed its success End", () => {
    const item = store.createWorkItem({
      title: "approved landing leftover", status: "assigned", assignee: "platform-worker",
    });
    transitions.transition(item.id, "in_review", "session:worker", { agent: true });
    const sessionId = `s-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const attempt = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(attempt.id, { outcome: "completed", endedAt: new Date().toISOString() });
    const run = createWorkflowRun(item.id, "completed");
    approvals.requestApproval(item.id, {
      request: "Land?", ref: `workflow:${run.workflowId}:${run.runId}:gate`, target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");

    expect(recovery.closeApprovedLanded(item.id, workflowRepository)).toBe(true);
    expect(store.getWorkItem(item.id)!.status).toBe("done");
  });

  it("does not let an unrelated completed Todo attempt stand in for a pending Workflow LAND", () => {
    const item = store.createWorkItem({
      title: "approved but not landed", status: "assigned", assignee: "platform-worker",
    });
    transitions.transition(item.id, "in_review", "session:worker", { agent: true });
    const sessionId = `s-pending-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const attempt = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(attempt.id, { outcome: "completed", endedAt: new Date().toISOString() });
    const run = createWorkflowRun(item.id, "running");
    approvals.requestApproval(item.id, {
      request: "Land?", ref: `workflow:${run.workflowId}:${run.runId}:gate`, target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });
    expect(recovery.closeApprovedLanded(item.id, workflowRepository)).toBe(false);
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");
  });

  it("does not interpret a failed Workflow plus an agent review claim as delivery", () => {
    const item = store.createWorkItem({
      title: "failed workflow claimed for review", status: "assigned", assignee: "platform-worker",
    });
    transitions.transition(item.id, "in_review", "session:worker", { agent: true });
    const sessionId = `s-failed-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const attempt = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(attempt.id, { outcome: "completed", endedAt: new Date().toISOString() });
    const run = createWorkflowRun(item.id, "failed");
    approvals.requestApproval(item.id, {
      request: "Land?", ref: `workflow:${run.workflowId}:${run.runId}:gate`, target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });

    expect(recovery.approvedLandingComplete(item.id, workflowRepository)).toBe(false);
    expect(recovery.closeApprovedLanded(item.id, workflowRepository)).toBe(false);
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");
  });

  it("treats a malformed legacy Workflow approval reference as unproven", () => {
    const item = store.createWorkItem({
      title: "legacy malformed approval", status: "in_review", assignee: "platform-worker",
    });
    approvals.requestApproval(item.id, {
      request: "Land?", ref: "workflow:pipeline:not-a-run-id:gate", target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });

    expect(recovery.approvedLandingComplete(item.id, workflowRepository)).toBe(false);
    expect(recovery.closeApprovedLanded(item.id, workflowRepository)).toBe(false);
  });

  it("keeps a refused open-child leftover on Manager attention across repeated ticks", () => {
    const item = store.createWorkItem({
      title: "approved landing with open child", status: "assigned", assignee: "platform-worker",
    });
    transitions.transition(item.id, "in_review", "session:worker", { agent: true });
    store.createWorkItem({
      title: "open child leftover", parentId: item.id, status: "assigned", assignee: "platform-worker",
    });
    const sessionId = `s-child-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const attempt = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(attempt.id, { outcome: "completed", endedAt: new Date().toISOString() });
    const run = createWorkflowRun(item.id, "completed");
    approvals.requestApproval(item.id, {
      request: "Land?", ref: `workflow:${run.workflowId}:${run.runId}:gate`, target: "operator",
    });
    approvals.decideWorkItemApprovalSync({ id: item.id, decision: "approve", decidedBy: "operator" });
    expect(recovery.closeApprovedLanded(item.id, workflowRepository)).toBe(false);
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");

    tick();
    tick();

    expect(store.getWorkItem(item.id)!.status).toBe("in_review");
    expect(rows.getWorkItemRecovery(item.id)).toMatchObject({ lane: "manager" });
    expect(store.listWorkItems({ needsAttentionFor: "operator" }).map((row) => row.id)).toContain(item.id);
  });

  it("keeps the classifier's verdict when the detector disagrees, across repeated ticks", () => {
    const item = store.createWorkItem({
      title: "failed pipeline attempt", status: "assigned", assignee: "platform-worker",
    });
    const sessionId = `s-disagree-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const attempt = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(attempt.id, {
      outcome: "crashed", endedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      error: "the build step exited with code 1",
    });
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "backlog", toStatus: "assigned",
      actor: "workflow:run", detail: { workflowId: "pipeline", runId: attempt.id }, versionEffect: "audit",
    });
    expect(detect.detectAnomalyFor(item.id)).toMatchObject({ kind: "assigned-without-run", lane: "recovering" });

    tick();
    const classified = rows.getWorkItemRecovery(item.id)!;
    tick();
    expect(rows.getWorkItemRecovery(item.id)).toEqual(classified);
    expect(classified).toMatchObject({ class: "code", lane: "manager", attempts: 0, incidentId: attempt.id, reason: "the attempt failed in the work itself" });

    tick("auto");
    expect(rows.getWorkItemRecovery(item.id)).toMatchObject({ incidentId: attempt.id, attempts: 1 });
    tick("auto");
    expect(rows.getWorkItemRecovery(item.id)).toMatchObject({ incidentId: attempt.id, attempts: 2 });
    expect(store.listWorkItemEvents(item.id)
      .filter((event) => event.kind === "recovery_classified")).toHaveLength(1);
  });
});
