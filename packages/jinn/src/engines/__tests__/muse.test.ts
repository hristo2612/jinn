import fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EngineResult, StreamDelta } from "../../shared/types.js";
import { makeFakeProc, flush, type SpawnCall } from "./support/pi-spawn-harness.js";

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

import { MuseEngine } from "../muse.js";

const UUID_RE = /^[0-9a-f-]{36}$/;
const outputDelta = (text: string) => JSON.stringify({
  payload_type: "run.output.delta",
  payload: { kind: "run_output_delta", text },
});

async function startRun(overrides: Partial<Parameters<MuseEngine["run"]>[0]> = {}): Promise<{
  engine: MuseEngine;
  promise: Promise<EngineResult>;
  call: SpawnCall;
}> {
  const engine = new MuseEngine();
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    sessionId: "jinn-muse-1",
    model: "muse-wonder-full-1.0",
    ...overrides,
  });
  await flush();
  const call = spawnCalls[spawnCalls.length - 1]!;
  expect(call).toBeDefined();
  return { engine, promise, call };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("MuseEngine lifecycle", () => {
  it("accumulates run.output.delta text and resolves only after the process closes", async () => {
    const { promise, call } = await startRun();
    let settled = false;
    void promise.then(() => { settled = true; });

    call.proc.emitStdout(outputDelta("final ") + "\n");
    call.proc.emitStdout(outputDelta("answer") + "\n");
    await flush();
    expect(settled).toBe(false);

    call.proc.close(0);
    const result = await promise;
    expect(result.result).toBe("final answer");
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toMatch(UUID_RE);
  });

  it("treats exit 0 with no output delta as an error", async () => {
    const { promise, call } = await startRun();
    call.proc.close(0);

    const result = await promise;
    expect(result.result).toBe("");
    expect(result.error).toMatch(/without a final assistant response/);
  });

  it("does not return partial text as the result when interrupted", async () => {
    const { engine, promise, call } = await startRun();
    call.proc.emitStdout(outputDelta("partial") + "\n");
    await flush();

    engine.kill("jinn-muse-1", "Interrupted: user stopped");
    call.proc.close(null);
    const result = await promise;
    expect(result.result).toBe("");
    expect(result.error).toBe("Interrupted: user stopped");
  });

  it("ignores lifecycle chatter and unparseable lines", async () => {
    const { promise, call } = await startRun();
    call.proc.emitStdout("not json\n");
    call.proc.emitStdout(JSON.stringify({ payload_type: "task.lifecycle.started", payload: { kind: "task_lifecycle" } }) + "\n");
    call.proc.emitStdout(outputDelta("ok") + "\n");
    await flush();
    call.proc.close(0);

    const result = await promise;
    expect(result.result).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("correlates a successful MCP receipt with the tool id", async () => {
    const deltas: StreamDelta[] = [];
    const { promise, call } = await startRun({ onStream: (d) => deltas.push(d) });
    call.proc.emitStdout(JSON.stringify({
      payload_type: "tool.result",
      payload: { kind: "tool_result", tool_name: "update_work_item", tool_id: "call-1", output: '{"activityReceiptId":"todo:wi_release"}' },
    }) + "\n");
    call.proc.emitStdout(outputDelta("done") + "\n");
    await flush();
    call.proc.close(0);
    await promise;

    expect(deltas).toContainEqual({
      type: "tool_result",
      content: '{"activityReceiptId":"todo:wi_release"}',
      toolName: "update_work_item",
      toolId: "call-1",
      activityReceiptId: "todo:wi_release",
    });
  });
});

describe("MuseEngine argv", () => {
  it("keeps the prompt off argv, in a prompt file, and passes model + effort", async () => {
    const { promise, call } = await startRun({ prompt: "-p dashy prompt", effortLevel: "xhigh" });

    expect(call.args).not.toContain("-p dashy prompt");
    expect(call.args[0]).toBe("exec");
    expect(call.args).toContain("--json");
    expect(call.args).toContain("--trust-workspace");
    expect(call.args).toContain("--disable-sandbox");
    const flagValue = (flag: string) => call.args[call.args.indexOf(flag) + 1];
    expect(flagValue("--approval-mode")).toBe("never");
    expect(flagValue("--model")).toBe("muse-wonder-full-1.0");
    expect(flagValue("--reasoning-effort")).toBe("xhigh");
    expect(flagValue("--workspace")).toBe("/tmp");
    expect(flagValue("--session-id")).toMatch(UUID_RE);
    expect(fs.readFileSync(flagValue("--prompt-file")!, "utf8")).toBe("-p dashy prompt");

    call.proc.emitStdout(outputDelta("ok") + "\n");
    await flush();
    call.proc.close(0);
    await promise;
  });

  it("reuses a UUID resume id verbatim and mints fresh for a non-UUID one", async () => {
    const resumeId = "11111111-2222-7333-8444-555555555555";
    const first = await startRun({ resumeSessionId: resumeId });
    expect(first.call.args[first.call.args.indexOf("--session-id") + 1]).toBe(resumeId);
    first.call.proc.emitStdout(outputDelta("ok") + "\n");
    await flush();
    first.call.proc.close(0);
    expect((await first.promise).sessionId).toBe(resumeId);

    const second = await startRun({ resumeSessionId: "jinn-legacy-id" });
    const minted = second.call.args[second.call.args.indexOf("--session-id") + 1]!;
    expect(minted).toMatch(UUID_RE);
    expect(minted).not.toBe("jinn-legacy-id");
    second.call.proc.emitStdout(outputDelta("ok") + "\n");
    await flush();
    second.call.proc.close(0);
    await second.promise;
  });

  it("wires the built-in jinn MCP server via -c and child env identity", async () => {
    const { promise, call } = await startRun({
      resolvedMcp: {
        mcpServers: {
          jinn: {
            command: "node",
            args: ["/opt/jinn/server-entry.js"],
            env: { JINN_HOME: "/home/node/.jinn", JINN_SESSION_ID: "jinn-muse-1", JINN_SESSION_CAPABILITY: "cap-123" },
          },
        },
      },
    });

    const cIndex = call.args.indexOf("-c");
    expect(cIndex).toBeGreaterThan(-1);
    const assignment = call.args[cIndex + 1]!;
    expect(assignment.startsWith("mcpServers.jinn=")).toBe(true);
    const spec = JSON.parse(assignment.slice("mcpServers.jinn=".length));
    expect(spec.command).toBe("node");
    expect(spec.env.JINN_SESSION_CAPABILITY).toBe("cap-123");
    const env = (call.opts as { env: Record<string, string> }).env;
    expect(env.JINN_SESSION_CAPABILITY).toBe("cap-123");

    call.proc.emitStdout(outputDelta("ok") + "\n");
    await flush();
    call.proc.close(0);
    await promise;
  });
});
