import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { JsonValue, WorkflowDefinition } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

// The health store is gateway-wide; a suite that let it write would both leak
// records into whatever runs next and read whatever ran before.
const recordEngineUnavailableMock = vi.fn();
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  readEngineHealth: () => ({}),
  recordEngineUnavailable: (...args: unknown[]) => recordEngineUnavailableMock(...args),
}));

/**
 * PLA-149: an engine that has no allowance left never answered the question, so
 * the run asks the next engine in the chain rather than freezing on prose about
 * the provider. What it must NOT do is treat every failure that way, or keep
 * asking engines it has already asked.
 */

const QUOTA = "Interactive turn failed: usage limit reached";

const employee: Employee = { name: "worker", displayName: "Worker", department: "platform", rank: "employee",
  engine: "codex", model: "sol", persona: "Complete the work." };
const models: ModelRegistry = {
  codex: { name: "codex", available: true, defaultModel: "sol",
    models: [{ id: "sol", label: "Sol", supportsEffort: false, effortLevels: [] }] },
  claude: { name: "claude", available: true, defaultModel: "opus",
    models: [{ id: "opus", label: "Opus", supportsEffort: false, effortLevels: [] }] },
  grok: { name: "grok", available: true, defaultModel: "grok-4",
    models: [{ id: "grok-4", label: "Grok", supportsEffort: false, effortLevels: [] }] },
} as unknown as ModelRegistry;

class FakeExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: `session:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  attemptState(): { idle: boolean; runningChildren: number } { return { idle: true, runningChildren: 0 }; }

  async failTurn(nodeId: string, error: string): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    const event: WorkflowAttemptCompletion = {
      sessionId: `session:${nodeId}:${command.owner.attempt}`, owner: command.owner,
      terminalVersion: 1, turn: 1, completedAt: now.toISOString(), outcome: "failed", error,
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
  /** The engine each attempt of this node actually ran on, in order. */
  enginesFor(nodeId: string): (string | undefined)[] {
    return this.commands.filter((item) => item.owner.nodeId === nodeId).map((item) => item.engine);
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let service: WorkflowService;
/** What config.yaml currently says, re-read on every walk. */
let chains: Record<string, string[]>;
/** What the bound Todo currently says about where the next attempt runs. */
let override: { engine: string | null; model: string | null } | undefined;
const now = new Date("2026-08-19T10:00:00.000Z");

/** trigger → work → end, `work` carrying the DEFAULT single-attempt budget so a
 *  substitution has to happen without a retry budget to spend. */
function definitionWith(id: string, config: Record<string, JsonValue> = {}): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({
    ...created,
    inputs: [],
    nodes: [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "work", type: "employee", name: "Work", config: {
        employee: { source: "fixed", value: "worker" }, prompt: "Run the work.",
        output: { fields: {}, allowAdditionalFields: true }, ...config } },
      { id: "done", type: "end", name: "Done", config: { result: "success" } },
    ],
    edges: [
      { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
      { id: "work-done", from: { nodeId: "work", port: "success" }, to: { nodeId: "done", port: "input" } },
    ],
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-chain-walk-"));
  chains = { codex: ["claude"] };
  override = undefined;
  recordEngineUnavailableMock.mockClear();
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
    todoDispatch: { read: () => override },
    engineFallback: { chainFor: (engine) => chains[engine] ?? [] },
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Start `id`, let its first attempt die of quota, and let the runner's timer wake. */
async function quotaFailedRun(id: string, config: Record<string, JsonValue> = {}) {
  const definition = definitionWith(id, config);
  const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "PLA-1" });
  await executor.failTurn("work", QUOTA);
  await service.recover(now.toISOString());
  return { workflowId: definition.id, runId: run.id };
}

function attempts(workflowId: string, runId: string) {
  return service.getRun(workflowId, runId)!.attempts;
}

describe("an Employee node whose engine runs out of allowance", () => {
  it("finishes on another engine after the selected model is at capacity", async () => {
    const definition = definitionWith("capacity", { fallback: ["claude"],
      retry: { attempts: 3, delaySeconds: 60, backoff: "exponential" } });
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.failTurn("work", "Selected model is at capacity. Please try a different model.");
    await service.recover(new Date(now.getTime() + 60000).toISOString());

    expect(executor.enginesFor("work")).toEqual(["codex", "claude"]);
    expect(attempts(definition.id, run.id).at(-1)!.resolvedConfig.model).toBe("opus");
    await service.submitAttemptOutput({ sessionId: "session:work:2", outcome: "success", summary: "Resumed." });
    expect(service.getRun(definition.id, run.id)!.status).toBe("completed");
  });

  it("re-dispatches on the chain engine and the run completes", async () => {
    const { workflowId, runId } = await quotaFailedRun("chain-walk");

    expect(executor.enginesFor("work")).toEqual(["codex", "claude"]);
    await service.submitAttemptOutput({ sessionId: "session:work:2", outcome: "success", summary: "Done." });

    expect(service.getRun(workflowId, runId)!.status).toBe("completed");
  });

  it("substitutes on the default single-attempt budget — availability does not spend it", async () => {
    const { workflowId, runId } = await quotaFailedRun("no-budget");

    // retry.attempts defaults to 1, so a second attempt exists only because the
    // substitution is not a retry of the same request.
    expect(attempts(workflowId, runId).map((attempt) => attempt.resolvedConfig.retry.attempts)).toEqual([1, 1]);
    expect(attempts(workflowId, runId)).toHaveLength(2);
  });

  it("runs the substitute on that engine's own default model", async () => {
    const { workflowId, runId } = await quotaFailedRun("default-model");

    expect(attempts(workflowId, runId).at(-1)!.resolvedConfig).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("records what it substituted for, and why", async () => {
    const { workflowId, runId } = await quotaFailedRun("provenance");

    expect(attempts(workflowId, runId).map((attempt) => attempt.resolvedConfig.substitutedFrom))
      .toEqual([undefined, { engine: "codex", reason: "out of quota" }]);
  });

  it("freezes exactly as before when the node opted out", async () => {
    const { workflowId, runId } = await quotaFailedRun("opted-out", { fallback: "none" });

    expect(executor.enginesFor("work")).toEqual(["codex"]);
    expect(service.getRun(workflowId, runId)!.status).toBe("failed");
    expect(service.getRun(workflowId, runId)!.nodeRuns.find((node) => node.nodeId === "work")!.status).toBe("failed");
  });

  it("uses an explicit chain verbatim and ignores the configured one", async () => {
    const { workflowId, runId } = await quotaFailedRun("explicit-chain", { fallback: ["grok"] });

    expect(executor.enginesFor("work")).toEqual(["codex", "grok"]);
    expect(attempts(workflowId, runId).at(-1)!.resolvedConfig.engine).toBe("grok");
  });

  it("treats an explicit inherit exactly as an absent fallback", async () => {
    await quotaFailedRun("inherit", { fallback: "inherit" });

    expect(executor.enginesFor("work")).toEqual(["codex", "claude"]);
  });

  it("walks the chain of the engine a Todo override resolved to, not the node's pin", async () => {
    chains = { codex: ["grok"], claude: ["grok"] };
    override = { engine: "claude", model: null };
    const { workflowId, runId } = await quotaFailedRun("todo-override", { engine: { source: "fixed", value: "codex" } });

    expect(executor.enginesFor("work")).toEqual(["claude", "grok"]);
    expect(attempts(workflowId, runId).at(-1)!.resolvedConfig.substitutedFrom).toEqual({ engine: "claude", reason: "out of quota" });
  });

  it("skips members it already burned an attempt on, then freezes once they are gone", async () => {
    chains = { codex: ["claude", "grok"] };
    const { workflowId, runId } = await quotaFailedRun("exhausted");

    await executor.failTurn("work", QUOTA);
    await service.recover(now.toISOString());
    await executor.failTurn("work", QUOTA);
    await service.recover(now.toISOString());

    expect(executor.enginesFor("work")).toEqual(["codex", "claude", "grok"]);
    expect(service.getRun(workflowId, runId)!.status).toBe("failed");
  });

  it("terminates on a chain that names its way back", async () => {
    chains = { codex: ["claude"], claude: ["codex"] };
    const { workflowId, runId } = await quotaFailedRun("cycle");

    await executor.failTurn("work", QUOTA);
    await service.recover(now.toISOString());

    expect(executor.enginesFor("work")).toEqual(["codex", "claude"]);
    expect(service.getRun(workflowId, runId)!.status).toBe("failed");
  });

  it("records the engine that could not serve, so the next walk can prefer around it", async () => {
    await quotaFailedRun("records-health");

    expect(recordEngineUnavailableMock).toHaveBeenCalledWith("codex", "out of quota", undefined);
  });
});

describe("failures no other engine gets past", () => {
  it("never substitutes for a verdict the employee submitted, whatever prose it carries", async () => {
    const definition = definitionWith("submitted");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await service.submitAttemptOutput({
      sessionId: "session:work:1", outcome: "failure", summary: "Stopping: the upstream API is rate limited.",
    });
    await service.recover(now.toISOString());

    expect(executor.enginesFor("work")).toEqual(["codex"]);
    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
  });

  it("never substitutes for a credential, or for prose it does not recognise", async () => {
    for (const [id, failure] of [["auth", "Interactive turn failed: invalid api key"],
      ["terminal", "the tests did not pass"]] as const) {
      const definition = definitionWith(id);
      const run = await service.startManual({ workflowId: definition.id, input: {} });
      await executor.failTurn("work", failure);
      await service.recover(now.toISOString());

      expect(service.getRun(definition.id, run.id)!.attempts).toHaveLength(1);
      expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
    }
  });
});
