import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
vi.mock("node:child_process", () => ({ spawn: vi.fn((bin: string, args: string[], opts: unknown) => recordSpawn(bin, args, opts)) }));
import { CodexEngine } from "../codex.js";
import type { StreamDelta } from "../../shared/types.js";
import { agentMessage, flush, recordSpawn, resetSpawnCalls, sleep, spawnCalls, threadStarted, turnCompleted, turnFailed } from "./helpers/codex-run.js";
beforeEach(resetSpawnCalls);

function nativeActivity(kind: string, thread = "native-thread"): string {
  return JSON.stringify({ type: "event_msg", payload: {
    type: "item_completed", thread_id: thread, item: {
      type: "SubAgentActivity", kind, agent_thread_id: "native-worker", agent_path: "/root/research",
    },
  } }) + "\n";
}

describe("Codex native agent lifecycle", () => {
  it("surfaces native agents from rollout evidence omitted by the JSON stream", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-"));
    const file = path.join(root, "rollout-native-thread.jsonl");
    const engine = new CodexEngine({ codexSessionsDir: root });
    const deltas: StreamDelta[] = [];
    const promise = engine.run({ prompt: "Research", cwd: root, sessionId: "native-chat", onStream: (delta) => deltas.push(delta) });
    await flush();
    fs.writeFileSync(file, nativeActivity("started") + nativeActivity("completed") + nativeActivity("interacted"));
    const proc = spawnCalls.at(-1)!.proc;
    proc.emitStdout(threadStarted("native-thread") + "\n" + agentMessage("Research complete.") + "\n" + turnCompleted({}) + "\n");
    proc.close(0);
    await promise;
    expect(deltas.filter((delta) => delta.type === "block").at(-1)?.block).toMatchObject({
      block: { title: "Native Codex agents", status: "completed", payload: { items: [
        { text: "research: Completed", status: "completed" },
      ] } },
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["completed", "exit"])("keeps a terminal parent pending until native work has %s evidence", async (end) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-pending-"));
    const file = path.join(root, "rollout-native-thread.jsonl");
    const engine = new CodexEngine({ codexSessionsDir: root });
    const deltas: StreamDelta[] = [];
    let settled = false;
    const promise = engine.run({ prompt: "Research", cwd: root, sessionId: "native-chat", onStream: (delta) => deltas.push(delta) }).then((result) => { settled = true; return result; });
    await flush();
    fs.writeFileSync(file, nativeActivity("started"));
    const proc = spawnCalls.at(-1)!.proc;
    proc.emitStdout(threadStarted("native-thread") + "\n" + agentMessage("Parent answer.") + "\n" + turnCompleted({}) + "\n");
    await sleep(10);
    expect(settled).toBe(false);
    expect(deltas).toContainEqual({ type: "status", content: "Waiting for 1 native Codex agent(s)" });
    if (end === "completed") fs.appendFileSync(file, nativeActivity("completed"));
    else proc._handlers.exit?.(0);
    const result = await promise;
    expect(result.result).toBe("Parent answer.");
    expect(result.error).toBe(end === "exit" ? "Native agent work stopped before completion" : undefined);
    expect(deltas.filter((delta) => delta.type === "block").at(-1)?.block?.block.status).toBe(end === "exit" ? "error" : "completed");
    expect(engine.isAlive("native-chat")).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not replay native activity from a resumed turn or a different thread", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-resume-"));
    const file = path.join(root, "rollout-native-thread.jsonl");
    fs.writeFileSync(file, nativeActivity("started"));
    const engine = new CodexEngine({ codexSessionsDir: root });
    const deltas: StreamDelta[] = [];
    const promise = engine.run({ prompt: "Continue", cwd: root, resumeSessionId: "native-thread", onStream: (delta) => deltas.push(delta) });
    await flush();
    fs.appendFileSync(file, nativeActivity("started", "other-thread"));
    const proc = spawnCalls.at(-1)!.proc;
    proc.emitStdout(threadStarted("native-thread") + "\n" + agentMessage("Done.") + "\n" + turnCompleted({}) + "\n");
    await promise;
    expect(deltas.filter((delta) => delta.type === "block")).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["failed", "cancelled"])("settles a %s native wait without waiting for inherited pipes to close", async (end) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-stop-"));
    const file = path.join(root, "rollout-native-thread.jsonl");
    const engine = new CodexEngine({ codexSessionsDir: root });
    const promise = engine.run({ prompt: "Research", cwd: root, sessionId: "native-stop" });
    await flush();
    fs.writeFileSync(file, nativeActivity("started"));
    const proc = spawnCalls.at(-1)!.proc;
    proc.emitStdout(threadStarted("native-thread") + "\n" + (end === "failed" ? turnFailed("Native turn failed") : turnCompleted({})) + "\n");
    await sleep(10);
    if (end === "cancelled") {
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      engine.kill("native-stop", "Interrupted by user");
      kill.mockRestore();
    }
    fs.appendFileSync(file, nativeActivity("completed"));
    proc.exitCode = 0;
    proc._handlers.exit?.(0);
    expect((await promise).error).toBe(end === "failed" ? "Native turn failed" : "Interrupted by user");
    expect(engine.isAlive("native-stop")).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
