import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The submit confirmation, exercised through `engine.run` rather than by calling
 * `pasteAndSubmit` with a hand-stubbed `submitted()`.
 *
 * The mechanism is covered at the `pasteAndSubmit` level in claude-interactive.test.ts;
 * what is only reachable here is the wiring: that a real hook arriving on the
 * registry callback flips `promptSubmitted`, that `SessionStart` deliberately does
 * not, that the cold-spawn and native-command paths are exempt, and that a
 * settled turn writes no further CRs. Getting those wrong makes the confirmation
 * either useless (a false ack strands the prompt in the composer, the failure
 * this exists to catch) or actively harmful (CRs written into a PTY that has
 * moved on to a different turn).
 *
 * Every assertion here was mutation-checked against the production code, so none
 * of them passes vacuously. See the note at the end for the one guarantee that
 * cannot be pinned this way.
 */

interface FakePty {
  pid: number;
  _exitCode: number | null;
  _exitCb?: (e: { exitCode: number }) => void;
  writes: string[];
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: (signal?: string) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  fireExit: () => void;
}

const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 2000 + ptys.length,
    _exitCode: null,
    writes: [], // records instead of discarding — the CRs are the subject here
    onData() {},
    onExit(cb) { p._exitCb = cb; },
    kill() {},
    write(d: string) { p.writes.push(d); },
    resize() {},
    on() {},
    fireExit() { p._exitCode = 0; p._exitCb?.({ exitCode: 0 }); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => { const p = makeFakePty(); ptys.push(p); return p; }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41100; }
    stop() {}
  },
}));
vi.mock("../shared/claude-settings.js", () => ({
  writeSessionSettings: () => "/tmp/fake-settings.json",
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

const CR = "\r";
const crs = (p: FakePty) => p.writes.filter((w) => w === CR).length;

describe("InteractiveClaudeEngine — submit confirmation wiring", () => {
  let lifecycle: PtyLifecycleManager;
  let hookCb: ((h: any) => void) | undefined;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    ptys.length = 0;
    hookCb = undefined;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    const hookRegistry = {
      register: (_id: string, cb: (h: any) => void) => { hookCb = cb; },
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Turn 1 cold-spawns and completes via Stop, which leaves the PTY warm so the
   *  next turn takes the paste-and-submit path. */
  async function completeColdTurn(sessionId: string): Promise<FakePty> {
    const turn = engine.run({ sessionId, prompt: "first", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    const r = await turn;
    expect(r.error).toBeUndefined();
    const pty = ptys[0];
    expect(pty).toBeDefined();
    return pty;
  }

  it("takes UserPromptSubmit as the acknowledgement, and SessionStart as nothing", async () => {
    vi.useFakeTimers();
    const pty = await completeColdTurn("s-ack");
    expect(engine.hasWarmPty("s-ack")).toBe(true);

    void engine.run({ sessionId: "s-ack", prompt: "second", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);
    const before = crs(pty);

    // The initial submit CR, 150ms after the bracketed paste.
    await vi.advanceTimersByTimeAsync(200);
    expect(crs(pty)).toBe(before + 1);

    // A stale SessionStart — exactly what the idle spawn that warmed this PTY
    // emits. Accepting it would confirm a submit that never happened.
    hookCb!({ hook_event_name: "SessionStart", session_id: "c2" });
    await vi.advanceTimersByTimeAsync(1600);
    expect(crs(pty)).toBe(before + 2); // still retrying

    hookCb!({ hook_event_name: "UserPromptSubmit", prompt: "second" });
    const afterAck = crs(pty);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(crs(pty)).toBe(afterAck); // acknowledged: no further CRs

    expect(engine.turnProgress("s-ack")?.awaitingSubmit).toBe(false);
  });

  it("reports awaitingSubmit only while the prompt is unacknowledged", async () => {
    vi.useFakeTimers();
    await completeColdTurn("s-progress");

    void engine.run({ sessionId: "s-progress", prompt: "second", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);

    const pending = engine.turnProgress("s-progress");
    expect(pending?.awaitingSubmit).toBe(true);
    expect(pending?.activeTools).toBe(0);
    expect(pending?.activeUpstream).toBe(false);
    // lastProgressAt is the newest of turn start, last hook and last output, so
    // it must be a real instant at or before now even before anything happens.
    expect(pending?.lastProgressAt).toBeGreaterThan(0);
    expect(pending?.lastProgressAt).toBeLessThanOrEqual(Date.now());

    // A tool in flight is real work, so the gateway must not read this as quiet.
    hookCb!({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} });
    expect(engine.turnProgress("s-progress")?.activeTools).toBe(1);
    // ...and any in-turn hook proves the prompt is running.
    expect(engine.turnProgress("s-progress")?.awaitingSubmit).toBe(false);

    hookCb!({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(engine.turnProgress("s-progress")?.activeTools).toBe(0);
  });

  it("does not confirm a cold spawn, which carries its prompt in argv", async () => {
    vi.useFakeTimers();
    const turn = engine.run({ sessionId: "s-cold", prompt: "only", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);

    // Submitted by construction: nothing is pasted and no CR is due.
    expect(engine.turnProgress("s-cold")?.awaitingSubmit).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(crs(ptys[0])).toBe(0);

    hookCb!({ hook_event_name: "SessionStart", session_id: "c1" });
    hookCb!({ hook_event_name: "Stop", last_assistant_message: "done" });
    await turn;
  });

  it("does not confirm a native command, which never emits the hook", async () => {
    vi.useFakeTimers();
    const pty = await completeColdTurn("s-native");
    const before = crs(pty);

    void engine.run({ sessionId: "s-native", prompt: "/compact", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(20);

    // /compact runs locally and settles on its own timer. One CR submits it; a
    // retry loop would fire spurious CRs at a prompt that already did its work.
    expect(engine.turnProgress("s-native")?.awaitingSubmit).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(crs(pty)).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(crs(pty)).toBe(before + 1);
  });

  it("writes no further CRs once the turn settles unacknowledged", async () => {
    vi.useFakeTimers();
    const pty = await completeColdTurn("s-cancel");

    const turn = engine.run({ sessionId: "s-cancel", prompt: "second", cwd: "/tmp" } as any);
    await vi.advanceTimersByTimeAsync(200); // initial CR sent, prompt unacknowledged
    const before = crs(pty);

    // Settled without ever seeing UserPromptSubmit — the case where the loop
    // would otherwise outlive its turn and submit whatever the composer holds
    // when the warm PTY is handed to the next one.
    engine.kill("s-cancel", "Interrupted: new message received");
    await turn;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(crs(pty)).toBe(before);
    expect(engine.turnProgress("s-cancel")).toBeUndefined();
  });

  // NOT tested here: that run()'s finally calls entry.cancelSubmitConfirm().
  // `submitted()` also reads resolver.isSettled, so a settled turn stops the loop
  // at its next tick with or without that call — removing it changes no
  // observable behaviour, confirmed by mutation. The only difference is that the
  // interval lives ~1.5s longer, and timer counts cannot isolate it from the
  // per-session timers armed alongside. The cancel stays as redundancy; the
  // guarantee that matters is pinned by the test above.
});
