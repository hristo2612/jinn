import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as realSetImmediate } from "node:timers";

interface FakePty {
  pid: number;
  cols: number;
  rows: number;
  _exitCode: number | null;
  writes: string[];
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onExit: (cb: (event: { exitCode: number; signal: number }) => void) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  kill: (signal?: string) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  emitData: (data: string) => void;
}

interface SpawnCall {
  proc: FakePty;
}

const spawnCalls: SpawnCall[] = [];

function makeFakePty(): FakePty {
  const dataCallbacks = new Set<(data: string) => void>();
  const proc: FakePty = {
    pid: 4242,
    cols: 120,
    rows: 40,
    _exitCode: null,
    writes: [],
    onData: (callback) => {
      dataCallbacks.add(callback);
      return { dispose: () => dataCallbacks.delete(callback) };
    },
    onExit: () => {},
    on: () => {},
    kill: () => { proc._exitCode = -1; },
    resize: (cols, rows) => { proc.cols = cols; proc.rows = rows; },
    write: (data) => { proc.writes.push(data); },
    emitData: (data) => { for (const callback of dataCallbacks) callback(data); },
  };
  return proc;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const proc = makeFakePty();
    spawnCalls.push({ proc });
    return proc as unknown as import("node-pty").IPty;
  }),
}));

const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "agy-startup-test-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import { AntigravityEngine } from "../antigravity.js";
import { transcriptPathFor } from "../antigravity-protocol.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

const VERIFICATION_BANNER = [
  "\u001b[33mVerifying your account...\u001b[0m",
  "We're finishing verifying your account eligibility.",
  "Please try again shortly.",
].join("\r\n");

const engines: AntigravityEngine[] = [];

function makeEngine(): AntigravityEngine {
  const engine = new AntigravityEngine(new PtyLifecycleManager({ maxLivePtys: 2 }));
  engines.push(engine);
  return engine;
}

function brainDir(): string {
  return path.join(osMockState.home, ".gemini", "antigravity-cli", "brain");
}

function createAnswer(convId: string, answer: string): void {
  const transcriptPath = transcriptPathFor(convId);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: answer,
  })}\n`);
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise<void>((resolve) => realSetImmediate(resolve));
}

// Virtual time is free; the reads waiting on it are not. transcriptTail() awaits three
// real fs operations per poll (fsp.stat → fsp.open → fh.read), and each advance() yields
// exactly one real macrotask turn — so a fixed count of advances can run out with that
// chain still in flight. The 200ms poll interval then never fires again and the turn hangs
// until vitest's 30s timeout rather than failing an assertion, which is what a loaded
// windows-latest runner produced. Step until the turn settles instead of guessing a budget.
async function settleTurn<T>(turn: Promise<T>, stepMs = 100, maxSteps = 40): Promise<T> {
  let settled = false;
  const tracked = turn.then(
    (value) => { settled = true; return value; },
    (error: unknown) => { settled = true; throw error; },
  );
  tracked.catch(() => { /* re-thrown by the await below */ });
  for (let step = 0; step < maxSteps && !settled; step++) await advance(stepMs);
  if (!settled) throw new Error(`turn did not settle within ${maxSteps * stepMs}ms of virtual time`);
  return tracked;
}

async function reachFirstSubmit(proc: FakePty): Promise<void> {
  proc.emitData("ready");
  await advance(1_500);
  expect(proc.writes).toHaveLength(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  spawnCalls.length = 0;
  engines.length = 0;
  fs.rmSync(brainDir(), { recursive: true, force: true });
  fs.mkdirSync(brainDir(), { recursive: true });
});

afterEach(async () => {
  for (const engine of engines) engine.killAll();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe("AntigravityEngine cold-start retry", () => {
  it("re-submits after account verification and completes from the discovered transcript", async () => {
    const engine = makeEngine();
    const resultPromise = engine.run({
      prompt: "Reply with ready",
      cwd: osMockState.home,
      sessionId: "cold-retry",
    });
    const proc = spawnCalls[0]!.proc;

    await reachFirstSubmit(proc);
    proc.emitData(VERIFICATION_BANNER);
    await advance(5_000);
    expect(proc.writes).toHaveLength(2);

    createAnswer("conversation-a", "ready");

    await expect(settleTurn(resultPromise)).resolves.toMatchObject({
      sessionId: "conversation-a",
      result: "ready",
    });
  });

  it("never re-submits a blocker emitted after conversation discovery", async () => {
    const engine = makeEngine();
    const resultPromise = engine.run({
      prompt: "one turn",
      cwd: osMockState.home,
      sessionId: "discovery-guard",
    });
    const proc = spawnCalls[0]!.proc;

    await reachFirstSubmit(proc);
    proc.emitData(VERIFICATION_BANNER);
    await advance(5_000);
    expect(proc.writes).toHaveLength(2);

    fs.mkdirSync(path.join(brainDir(), "conversation-b"), { recursive: true });
    await advance(500);
    proc.emitData(VERIFICATION_BANNER);
    await advance(5_000);

    expect(proc.writes).toHaveLength(2);
    engine.kill("discovery-guard");
    await resultPromise;
  });

  it("does not retry a resumed conversation", async () => {
    const engine = makeEngine();
    const resultPromise = engine.run({
      prompt: "resume once",
      cwd: osMockState.home,
      sessionId: "resumed-turn",
      resumeSessionId: "existing-conversation",
    });
    const proc = spawnCalls[0]!.proc;

    await reachFirstSubmit(proc);
    proc.emitData(VERIFICATION_BANNER);
    await advance(5_000);

    expect(proc.writes).toHaveLength(1);
    engine.kill("resumed-turn");
    await resultPromise;
  });

  it("reports the last startup blocker after exhausting two retries", async () => {
    const engine = makeEngine();
    const resultPromise = engine.run({
      prompt: "will remain blocked",
      cwd: osMockState.home,
      sessionId: "blocked-timeout",
    });
    const proc = spawnCalls[0]!.proc;

    await reachFirstSubmit(proc);
    for (let attempt = 0; attempt < 3; attempt++) {
      proc.emitData(VERIFICATION_BANNER);
      await advance(5_000);
    }
    expect(proc.writes).toHaveLength(3);
    await advance(60_000);

    const result = await resultPromise;
    expect(result.error).toContain("finishing verifying your account eligibility");
    expect(result.error).toContain("try again shortly");
    expect(result.error).not.toBe("Antigravity: no conversation transcript appeared");
  });
});
