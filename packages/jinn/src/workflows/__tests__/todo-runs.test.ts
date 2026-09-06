import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { JsonValue, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import { todoRunOutcome } from "../todo-run-ledger.js";

/* AC4: every terminal state of a Todo-bound attempt leaves exactly ONE settled
 * run row carrying the mapped outcome — run-cancel included — and a retry opens
 * a second row while the first attempt's evidence stays readable. Driven end to
 * end through the real ledger port, because the mapping being right in the
 * runner and the row never reaching the table would look identical from a
 * recording fake. */

// vitest.setup owns this file's home before any static runtime import.
const home = process.env.JINN_HOME!;

type Store = typeof import("../../work-items/store.js");
type Runs = typeof import("../../work-items/runs.js");
type Surface = typeof import("../../gateway/workflow-todo-runs.js");
let store: Store;
let runs: Runs;
let surface: Surface;

const employee: Employee = {
  name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete the task.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine", available: true, defaultModel: "test-model", effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

/** Session ids carry the workflow id so each case's rows are its own — the
 *  registry DB is shared across this file. */
function sessionIdFor(owner: WorkflowAttemptCommand["owner"]): string {
  return `session:${owner.workflowId}:${owner.nodeId}:${owner.attempt}`;
}

class FakeExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: sessionIdFor(command.owner) };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  attemptState(): { runningChildren: number } { return { runningChildren: 0 }; }

  succeed(nodeId: string, fields: Record<string, JsonValue>): Promise<void> {
    return this.emit(nodeId, {
      outcome: "succeeded",
      finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\``,
    });
  }
  crash(nodeId: string, error: string): Promise<void> {
    return this.emit(nodeId, { outcome: "failed", error });
  }
  private async emit(nodeId: string, outcome: Partial<WorkflowAttemptCompletion>): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    const event = {
      sessionId: sessionIdFor(command.owner), owner: command.owner, terminalVersion: 1, turn: 1,
      completedAt: "2026-07-21T10:05:00.000Z", ...outcome,
    } as WorkflowAttemptCompletion;
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let service: WorkflowService;
let todoSeq = 0;

function workNode(): WorkflowNode {
  return {
    id: "work", type: "employee", name: "work", config: {
      employee: { source: "fixed", value: "worker" }, prompt: "Do the work.", timeoutMinutes: 60,
      retry: { attempts: 2, delaySeconds: 0, backoff: "fixed" },
      output: {
        fields: {
          value: { type: "string", required: true },
          changed_files: { type: "string[]", required: false },
          verification: { type: "string", required: false },
        },
        allowAdditionalFields: false,
      },
    },
  };
}

/** trigger → work → end: one phase, so one attempt owns the whole run. */
function onePhaseDefinition(id: string): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({
    ...created,
    inputs: [],
    nodes: [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      workNode(),
      { id: "done", type: "end", name: "Done", config: { result: "success" } },
    ],
    edges: [
      { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
      { id: "work-done", from: { nodeId: "work", port: "success" }, to: { nodeId: "done", port: "input" } },
    ],
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

/** A live Todo plus a run bound to it, one pair per case so the ledger reads
 *  cleanly. */
async function boundRun(): Promise<{ todoId: string; workflowId: string; runId: string }> {
  const todoId = store.createWorkItem({ title: `run host ${(todoSeq += 1)}` }).id;
  const definition = onePhaseDefinition(`bound-${todoSeq}`);
  const run = await service.startManual({ workflowId: definition.id, input: {}, todoId });
  return { todoId, workflowId: definition.id, runId: run.id };
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  runs = await import("../../work-items/runs.js");
  surface = await import("../../gateway/workflow-todo-runs.js");
});

afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-runs-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models,
    now: () => "2026-07-21T10:00:00.000Z",
    todoSessions: surface.workflowTodoSessions(),
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("opens the Todo registry in the fixture home", async () => {
  const db = (await import("../../shared/db.js")).initDb();
  expect(db.name).toBe(path.join(home, "sessions", "registry.db"));
});

describe("the outcome a terminal attempt reads as", () => {
  it("maps every terminal attempt status, splitting a reported verdict from a transport fault", () => {
    expect(todoRunOutcome("completed")).toBe("completed");
    expect(todoRunOutcome("timed-out")).toBe("timed_out");
    expect(todoRunOutcome("cancelled")).toBe("abandoned");
    expect(todoRunOutcome("failed", "workflow-submitted-failure")).toBe("blocked");
    expect(todoRunOutcome("failed", "workflow-no-output")).toBe("crashed");
    expect(todoRunOutcome("failed")).toBe("crashed");
    // A quota window outranks the status: the attempt never got to fail at the work.
    expect(todoRunOutcome("failed", "workflow-no-output", "429 rate limit exceeded")).toBe("rate_limited");
    expect(todoRunOutcome("timed-out", undefined, "the provider is overloaded")).toBe("rate_limited");
  });
});

describe("a Todo-bound run's ledger", () => {
  it("opens one row when the attempt is dispatched", async () => {
    const { todoId, workflowId } = await boundRun();
    const ledger = runs.listWorkItemRuns(todoId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].sessionId).toBe(`session:${workflowId}:work:1`);
    expect(ledger[0].endedAt).toBeNull();
    expect(ledger[0].outcome).toBeNull();
  });

  it("opens nothing for a run that is not bound to a Todo", async () => {
    const definition = onePhaseDefinition("unbound");
    await service.startManual({ workflowId: definition.id, input: {} });
    expect(runs.findOpenWorkItemRunBySession(`session:${definition.id}:work:1`)).toBeUndefined();
    await executor.succeed("work", { value: "done" });
    expect(runs.findOpenWorkItemRunBySession(`session:${definition.id}:work:1`)).toBeUndefined();
  });

  it("settles a completed attempt with its summary and its structured handoff", async () => {
    const { todoId } = await boundRun();
    await executor.succeed("work", {
      value: "done", changed_files: ["src/a.ts"], verification: "pnpm test",
    });
    const ledger = runs.listWorkItemRuns(todoId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe("completed");
    expect(ledger[0].endedAt).not.toBeNull();
    expect(ledger[0].summary).toContain("Done.");
    expect(ledger[0].handoff).toEqual({ changedFiles: ["src/a.ts"], verification: "pnpm test" });
  });

  it("settles a timed-out attempt as timed_out", async () => {
    const { todoId } = await boundRun();
    // The repository stamps an attempt's start from its own clock, so the
    // recovery sweep is run from a moment beyond any real one.
    await service.recover("2099-01-01T00:00:00.000Z");
    const ledger = runs.listWorkItemRuns(todoId);
    // A timeout is retryable, so the node's second attempt dispatches and opens
    // its own row — the timed-out one stays settled and readable.
    expect(ledger.map((run) => run.outcome)).toEqual(["timed_out", null]);
    expect(ledger[1].endedAt).toBeNull();
  });

  it("settles a cancelled run's attempt as abandoned", async () => {
    const { todoId, workflowId, runId } = await boundRun();
    await service.cancelRun({ workflowId, runId, reason: "no longer needed" });
    const ledger = runs.listWorkItemRuns(todoId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe("abandoned");
    expect(ledger[0].endedAt).not.toBeNull();
  });

  it("settles an employee's reported failure as blocked, not crashed", async () => {
    const { todoId, workflowId } = await boundRun();
    await service.submitAttemptOutput({ sessionId: `session:${workflowId}:work:1`, outcome: "failure",
      summary: "the fixture is missing" });
    const ledger = runs.listWorkItemRuns(todoId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe("blocked");
    expect(ledger[0].summary).toBe("the fixture is missing");
  });

  it("keeps the handoff a reported failure carried, minus the keys the ledger does not know", async () => {
    const { todoId, workflowId } = await boundRun();
    await service.submitAttemptOutput({ sessionId: `session:${workflowId}:work:1`, outcome: "failure",
      summary: "the fixture is missing",
      fields: { changed_files: ["src/a.ts"], verification: "pnpm test — 1 failed", mood: "grim" } });
    const ledger = runs.listWorkItemRuns(todoId);
    expect(ledger[0].outcome).toBe("blocked");
    expect(ledger[0].handoff).toEqual({ changedFiles: ["src/a.ts"], verification: "pnpm test — 1 failed" });
  });

  it("leaves a failed attempt's handoff readable once a retry has opened the next row", async () => {
    const { todoId, workflowId, runId } = await boundRun();
    await service.submitAttemptOutput({ sessionId: `session:${workflowId}:work:1`, outcome: "failure",
      summary: "the fixture is missing",
      fields: { changed_files: ["src/a.ts"], retry_notes: "the fixture moved to fixtures/v2" } });
    await service.retryNode({ workflowId, runId, nodeId: "work", idempotencyKey: "retry-after-failure" });
    await executor.succeed("work", { value: "second time lucky" });

    const ledger = runs.listWorkItemRuns(todoId);
    expect(ledger.map((run) => run.outcome)).toEqual(["blocked", "completed"]);
    expect(ledger[0].handoff).toEqual({
      changedFiles: ["src/a.ts"], retryNotes: "the fixture moved to fixtures/v2",
    });
  });

  it("settles a transport fault as crashed", async () => {
    const { todoId } = await boundRun();
    await executor.crash("work", "the engine died");
    const ledger = runs.listWorkItemRuns(todoId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe("crashed");
    expect(ledger[0].error).toContain("the engine died");
  });

  it("opens a second row on retry and leaves the first attempt's evidence readable", async () => {
    const { todoId, workflowId, runId } = await boundRun();
    await executor.crash("work", "the engine died");
    await service.retryNode({ workflowId, runId, nodeId: "work", idempotencyKey: "retry-1" });
    await executor.succeed("work", { value: "second time lucky", changed_files: ["src/b.ts"] });

    const ledger = runs.listWorkItemRuns(todoId);
    expect(ledger).toHaveLength(2);
    expect(ledger.map((run) => run.outcome)).toEqual(["crashed", "completed"]);
    expect(ledger[0].error).toContain("the engine died");
    expect(ledger[1].sessionId).toBe(`session:${workflowId}:work:2`);
    expect(ledger[1].handoff).toEqual({ changedFiles: ["src/b.ts"] });
  });
});
