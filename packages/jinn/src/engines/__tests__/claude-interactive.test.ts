import { afterEach, describe, it, expect, vi } from "vitest";

// claude-interactive.ts imports node-pty at the top level. node-pty loads its
// native module at import time and that fails on Linux CI runners (looks for
// prebuilds/linux-x64/pty.node under a wrong relative path). TurnResolver is a
// pure-JS class with zero PTY dependency, so mocking the module keeps the test
// focused and CI-portable.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { TurnResolver, buildAttachmentSuffix, buildInteractiveArgs, claudeHookToDeltas, pasteAndSubmit, shouldSettleStalledTurn, sumTranscriptUsage } from "../claude-interactive.js";
import { MAIN_AGENT_SENTINEL } from "../sse-pty-proxy.js";
import { buildPromptWithPlatformContext } from "../platform-context.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("claudeHookToDeltas", () => {
  it("does not emit a duplicate tool_use for PreToolUse", () => {
    expect(claudeHookToDeltas({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "printf ok" },
    })).toEqual([]);
  });

  it("emits a tool_result for PostToolUse", () => {
    expect(claudeHookToDeltas({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
    })).toEqual([{ type: "tool_result", content: "Bash", toolName: "Bash" }]);
  });

  it("correlates a successful MCP receipt with the native Claude tool id", () => {
    expect(claudeHookToDeltas({
      hook_event_name: "PostToolUse",
      tool_name: "mcp__jinn__update_work_item",
      tool_use_id: "call-1",
      tool_response: {
        content: [{ type: "text", text: '{"activityReceiptId":"todo:wi_release"}' }],
      },
    })).toEqual([{
      type: "tool_result",
      content: "mcp__jinn__update_work_item",
      toolName: "mcp__jinn__update_work_item",
      toolId: "call-1",
      activityReceiptId: "todo:wi_release",
    }]);
  });
});

describe("TurnResolver", () => {
  it("resolves only after BOTH SessionStart and Stop", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "done" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved).toBeUndefined(); // Stop alone is not enough
    r.onHook({ hook_event_name: "SessionStart", session_id: "claude-123" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved.result).toBe("done");
    expect(resolved.sessionId).toBe("claude-123");
    expect(resolved.numTurns).toBe(1);
  });

  it("settles with an Interrupted error when killed", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.interrupt("Interrupted: user");
    const v = await r.promise;
    expect(v.error).toMatch(/^Interrupted/);
  });

  it("treats a missing session id as a hard error", async () => {
    const r = new TurnResolver({ fallbackSessionId: undefined });
    r.onHook({ hook_event_name: "SessionStart" }); // no session_id
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "x" });
    const v = await r.promise;
    expect(v.error).toMatch(/session id/i);
  });

  it("with assumeStarted, resolves on Stop alone using fallbackSessionId", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "ok" });
    const v = await r.promise;
    expect(v.result).toBe("ok");
    expect(v.sessionId).toBe("warm-sid");
    expect(v.numTurns).toBe(1);
  });

  it("strips leaked thinking blocks from Stop hook assistant text", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({
      hook_event_name: "Stop",
      last_assistant_message: "<thinking>private reasoning</thinking>\n\nVisible answer.",
    });
    const v = await r.promise;
    expect(v.result).toBe("Visible answer.");
    expect(v.result).not.toContain("private reasoning");
    expect(v.sessionId).toBe("warm-sid");
  });

  it("settles immediately on StopFailure (does not wait for SessionStart) and exposes it", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3pm" });
    const v = await r.promise;
    expect(v.error).toMatch(/rate_limit/);
    expect(v.numTurns).toBe(1);
    expect(r.stopFailure?.error).toBe("rate_limit");
  });

  it("can recover-complete a turn when the Stop hook is missing", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.completeRecovered("transcript final", "c1");
    const v = await r.promise;
    expect(v.result).toBe("transcript final");
    expect(v.sessionId).toBe("c1");
    expect(v.numTurns).toBe(1);
  });

  it("strips leaked thinking blocks from recovered transcript text", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.completeRecovered("<thinking>private transcript reasoning</thinking>\n\nVisible transcript answer.", "c1");
    const v = await r.promise;
    expect(v.result).toBe("Visible transcript answer.");
    expect(v.result).not.toContain("private transcript reasoning");
  });
});

describe("buildInteractiveArgs — system prompt + sentinel via CLI flag", () => {
  // Regression guard: the claude CLI ignores the settings-file `appendSystemPrompt`
  // KEY (≥2.1.x), so the persona + MAIN_AGENT_SENTINEL MUST go via the
  // --append-system-prompt FLAG, or the SSE proxy never tees and live streaming dies.
  const flagValue = (args: string[]): string | undefined => {
    const i = args.indexOf("--append-system-prompt");
    return i >= 0 ? args[i + 1] : undefined;
  };

  it("emits --append-system-prompt carrying the persona AND the sentinel", () => {
    const args = buildInteractiveArgs({
      prompt: "hi",
      settingsPath: "/tmp/s.json",
      appendSystemPrompt: `You are Jinn's COO.\n\n${MAIN_AGENT_SENTINEL}`,
    });
    const v = flagValue(args);
    expect(v).toBeDefined();
    expect(v).toContain("You are Jinn's COO.");
    expect(v).toContain(MAIN_AGENT_SENTINEL);
  });

  it("omits the flag when no appendSystemPrompt is given", () => {
    const args = buildInteractiveArgs({ prompt: "hi", settingsPath: "/tmp/s.json" });
    expect(args).not.toContain("--append-system-prompt");
  });

  it("leaves an unchanged positional resume prompt raw", () => {
    const prompt = buildPromptWithPlatformContext({
      prompt: "spawn the child now",
      resumeSessionId: "original-claude-id",
      systemPrompt: [
        "# You are Jimbo",
        "## Current session",
        "- Session ID: duplicated-jinn-session",
        "## Current configuration",
        "- Gateway: http://127.0.0.1:7777",
        "## Organization",
        "- Should not be repeated on resume",
      ].join("\n"),
    });
    const args = buildInteractiveArgs({ prompt, settingsPath: "/tmp/s.json", resumeSessionId: "original-claude-id" });
    const positionalPrompt = args[args.indexOf("original-claude-id") + 1];
    expect(positionalPrompt).toBe("spawn the child now");
  });

  it("can carry an explicit platform context refresh in the positional resume prompt", () => {
    const refresh = "## Jinn platform context refresh\n- Active model: opus";
    const prompt = buildPromptWithPlatformContext({
      prompt: "spawn the child now",
      resumeSessionId: "original-claude-id",
      systemPrompt: "# Full system context",
      platformContextRefresh: refresh,
    } as any);
    const args = buildInteractiveArgs({ prompt, settingsPath: "/tmp/s.json", resumeSessionId: "original-claude-id" });
    const positionalPrompt = args[args.indexOf("original-claude-id") + 1];
    expect(positionalPrompt).toBe(`${refresh}\n\nspawn the child now`);
  });
});

describe("pasteAndSubmit", () => {
  it("waits for multiline bracketed paste to settle before submitting", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const proc = { write: (data: string) => { writes.push(data); } };
    const text = `Describe this image${buildAttachmentSuffix(["/tmp/image.png"])}`;

    pasteAndSubmit(proc as any, text);

    expect(writes).toEqual([`\x1b[200~${text}\x1b[201~`]);
    vi.advanceTimersByTime(149);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([`\x1b[200~${text}\x1b[201~`, "\r"]);
  });
});

/**
 * Regression guard for the silently-unsubmitted warm-PTY paste.
 *
 * Claude Code's TUI auto-attaches any bracketed-pasted token that resolves to a
 * real image file, entering an async encode during which keypresses — including
 * pasteAndSubmit's submit CR, fired on a fixed 150ms timer — are DISCARDED. Any
 * real screenshot takes longer than 150ms to encode, so the turn hung forever
 * with no error. Verified live: a 5.8MB PNG hangs at 150ms, submits at 400ms,
 * and submits at 150ms once backticked.
 *
 * This asserts on the composed bytes so it needs no live PTY. Newlines are NOT
 * the trigger (a zero-newline prompt with a real image path hangs too), so do
 * not "simplify" this into a newline check.
 */
describe("buildAttachmentSuffix", () => {
  // A bare absolute image path is what the TUI auto-attaches on.
  const BARE_IMAGE_PATH = /(^|[\s(\[])(\/[^\s`'"]+\.(png|jpe?g|gif|webp|bmp|svg))(?=$|[\s)\]])/i;

  it("never hands the TUI a bare image path", () => {
    const suffix = buildAttachmentSuffix(["/Users/x/.jinn/uploads/2026-07-25/s/shot.png"]);
    expect(BARE_IMAGE_PATH.test(suffix)).toBe(false);
    expect(suffix).toBe("\n\nAttached files:\n- `/Users/x/.jinn/uploads/2026-07-25/s/shot.png`");
  });

  it("backticks every path when several are attached", () => {
    const suffix = buildAttachmentSuffix(["/tmp/a.png", "/tmp/b.jpeg", "/tmp/notes.txt"]);
    expect(BARE_IMAGE_PATH.test(suffix)).toBe(false);
    expect(suffix).toBe("\n\nAttached files:\n- `/tmp/a.png`\n- `/tmp/b.jpeg`\n- `/tmp/notes.txt`");
  });

  it("keeps the composed warm-PTY payload free of bare image paths end to end", () => {
    const payload = `Describe this${buildAttachmentSuffix(["/tmp/screenshot.png"])}`;
    expect(BARE_IMAGE_PATH.test(payload)).toBe(false);
    // Sanity-check the guard itself: the same payload unbackticked MUST match,
    // otherwise this test would pass vacuously and lock in nothing.
    expect(BARE_IMAGE_PATH.test("Describe this\n\nAttached files:\n- /tmp/screenshot.png")).toBe(true);
  });
});

/**
 * Regression guard for the web-session accounting bug (#89) and, more
 * importantly, for the trap that fixing it exposes.
 *
 * A Claude transcript is CUMULATIVE — it holds every turn of the session. The
 * cost is added to a running total by accumulateSessionCost, so summing the
 * whole file on every turn counts an N-turn session quadratically. Codex
 * already reports a per-run delta; scoping by the turn's start timestamp is
 * what makes the two engines agree.
 */
describe("sumTranscriptUsage — per-turn scoping", () => {
  const line = (id: string, ts: string, input: number, output: number) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      message: { id, usage: { input_tokens: input, output_tokens: output } },
    });

  // A two-turn session: turn 1 at 10:00, turn 2 at 10:05.
  const TRANSCRIPT = [
    line("m1", "2026-07-25T10:00:00.000Z", 1000, 100),
    line("m2", "2026-07-25T10:05:00.000Z", 3000, 300),
  ].join("\n");

  const TURN_2_START = Date.parse("2026-07-25T10:04:00.000Z");

  it("sums the whole session when unscoped", () => {
    const u = sumTranscriptUsage(TRANSCRIPT);
    expect(u.assistantTurns).toBe(2);
    expect(u.inputTokens).toBe(4000);
    expect(u.outputTokens).toBe(400);
  });

  it("counts only the current turn when scoped to its start", () => {
    const u = sumTranscriptUsage(TRANSCRIPT, TURN_2_START);
    // Turn 1's 1000/100 must NOT be re-counted into turn 2.
    expect(u.assistantTurns).toBe(1);
    expect(u.inputTokens).toBe(3000);
    expect(u.outputTokens).toBe(300);
  });

  it("does not attribute an untimestamped line to the current turn", () => {
    const withUndated = `${TRANSCRIPT}\n${JSON.stringify({
      type: "assistant",
      message: { id: "m3", usage: { input_tokens: 9999, output_tokens: 9999 } },
    })}`;
    const u = sumTranscriptUsage(withUndated, TURN_2_START);
    expect(u.inputTokens).toBe(3000);
    expect(u.assistantTurns).toBe(1);
  });

  it("still dedupes the double assistant line that --effort high emits", () => {
    // Same message.id twice (thinking + text) with identical usage.
    const dup = [
      line("m9", "2026-07-25T10:05:00.000Z", 500, 50),
      line("m9", "2026-07-25T10:05:01.000Z", 500, 50),
    ].join("\n");
    const u = sumTranscriptUsage(dup, TURN_2_START);
    expect(u.assistantTurns).toBe(1);
    expect(u.inputTokens).toBe(500);
  });
});

/**
 * Regression guard for the session stuck at "thinking" forever.
 *
 * Observed 2026-07-25 on session 7e93171a: the turn spawned fresh
 * ("resume: none"), its SessionStart hook never landed, and its Stop hook was
 * lost. Missing-Stop recovery needs a Claude session id to locate the
 * transcript (`resolver.sessionId ?? opts.resumeSessionId`) — on a fresh spawn
 * BOTH are undefined, so the 2s recovery interval could only ever return early.
 * Nothing else settled the turn, so the session stayed "running" for 25+ minutes
 * and the messages queued behind it never dispatched.
 *
 * A sibling session with an engineSessionId recovered normally 17 minutes in,
 * which is exactly why this only bites id-less turns.
 */
describe("shouldSettleStalledTurn", () => {
  const MIN = 60_000;

  it("settles the real stuck turn (25m elapsed, 24m quiet)", () => {
    expect(shouldSettleStalledTurn(25 * MIN, 24 * MIN)).toBe(true);
  });

  it("leaves a long turn alone while it is still streaming", () => {
    // 40m elapsed but output 10s ago — healthy, just slow.
    expect(shouldSettleStalledTurn(40 * MIN, 10_000)).toBe(false);
  });

  it("leaves an early quiet gap alone", () => {
    // Quiet for 6m but only 8m into the turn — recovery has not had its shot.
    expect(shouldSettleStalledTurn(8 * MIN, 6 * MIN)).toBe(false);
  });

  it("requires BOTH bounds, not either", () => {
    expect(shouldSettleStalledTurn(20 * MIN, 1 * MIN)).toBe(false);
    expect(shouldSettleStalledTurn(1 * MIN, 20 * MIN)).toBe(false);
  });

  it("fires only after transcript recovery has had its window", () => {
    // Recovery starts at 5m elapsed / 60s quiet; the backstop must sit well
    // above it so a recoverable turn is never killed in favour of an error.
    expect(shouldSettleStalledTurn(5 * MIN, 60_000)).toBe(false);
    expect(shouldSettleStalledTurn(15 * MIN, 5 * MIN)).toBe(true);
  });


  it("stops after one CR when no confirmation is requested", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    pasteAndSubmit({ write: (d: string) => writes.push(d) } as any, "hello");
    vi.advanceTimersByTime(60_000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(1);
  });

  it("re-sends CR until the engine acknowledges the prompt", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const retries: number[] = [];
    let submitted = false;
    pasteAndSubmit({ write: (d: string) => writes.push(d) } as any, "queued work", {
      submitted: () => submitted,
      onRetry: (n) => retries.push(n),
      onUnconfirmed: () => { throw new Error("must not give up — the prompt was acknowledged"); },
      intervalMs: 1000,
      attempts: 3,
    });
    vi.advanceTimersByTime(150);
    expect(writes.filter((w) => w === "\r")).toHaveLength(1); // the optimistic CR

    // The swallowed-CR case: nothing acknowledges, so the loop retries.
    vi.advanceTimersByTime(1000);
    expect(retries).toEqual([1]);
    expect(writes.filter((w) => w === "\r")).toHaveLength(2);

    // The CLI finally takes it — retries must stop immediately, and no further CR
    // may be written (an extra CR would submit an empty prompt on the next turn).
    submitted = true;
    vi.advanceTimersByTime(10_000);
    expect(retries).toEqual([1]);
    expect(writes.filter((w) => w === "\r")).toHaveLength(2);
  });

  it("gives up after the retry budget so the turn can be failed instead of hanging", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const gaveUp: number[] = [];
    pasteAndSubmit({ write: (d: string) => writes.push(d) } as any, "queued work", {
      submitted: () => false,
      onUnconfirmed: (n) => gaveUp.push(n),
      intervalMs: 1000,
      attempts: 3,
    });
    vi.advanceTimersByTime(150 + 3 * 1000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(4); // initial + 3 retries
    expect(gaveUp).toEqual([]);
    vi.advanceTimersByTime(1000); // the sweep after the budget is spent
    expect(gaveUp).toEqual([3]);
    // And it must stop writing — not spin CRs into the PTY forever.
    vi.advanceTimersByTime(60_000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(4);
  });

  it("cancel() stops the retry loop, so a settled turn cannot type into the next one", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const cancel = pasteAndSubmit({ write: (d: string) => writes.push(d) } as any, "queued work", {
      submitted: () => false,
      onUnconfirmed: () => { throw new Error("cancelled loops must not report"); },
      intervalMs: 1000,
      attempts: 5,
    });
    vi.advanceTimersByTime(150);
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(1);
  });

  it("treats a settled turn as no longer needing submission", () => {
    // run() wires `submitted` to include resolver.isSettled, so an early interrupt
    // stops the retry loop immediately rather than typing into a dead turn.
    vi.useFakeTimers();
    const writes: string[] = [];
    let settled = false;
    pasteAndSubmit({ write: (d: string) => writes.push(d) } as any, "queued work", {
      submitted: () => settled, // stands in for `promptSubmitted || resolver.isSettled`
      onUnconfirmed: () => { throw new Error("a settled turn must not be reported unconfirmed"); },
      intervalMs: 1000,
      attempts: 3,
    });
    vi.advanceTimersByTime(150);
    settled = true;
    vi.advanceTimersByTime(60_000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(1);
  });

  it("does not retry or report while the CLI is busy", () => {
    // Claude Code queues a pasted prompt behind a turn already running and fires
    // no UserPromptSubmit until it dequeues, so a queued prompt looks exactly
    // like a swallowed CR. Spraying CRs at a busy TUI, then declaring a live
    // turn lost, is the failure mode this gate exists to prevent.
    vi.useFakeTimers();
    const writes: string[] = [];
    const retries: number[] = [];
    let busy = true;
    pasteAndSubmit({ write: (d: string) => writes.push(d) } as any, "queued work", {
      submitted: () => false,
      busy: () => busy,
      onRetry: (n) => retries.push(n),
      onUnconfirmed: () => { throw new Error("must not report while the CLI is busy"); },
      intervalMs: 1000,
      attempts: 2,
    });
    vi.advanceTimersByTime(150);
    expect(writes.filter((w) => w === "\r")).toHaveLength(1); // the optimistic CR

    // Long enough to burn the whole budget if the gate were not honoured.
    vi.advanceTimersByTime(60_000);
    expect(retries).toEqual([]);
    expect(writes.filter((w) => w === "\r")).toHaveLength(1);

    // Work finishes without an acknowledgement: now retrying is correct.
    busy = false;
    vi.advanceTimersByTime(1000);
    expect(retries).toEqual([1]);
    expect(writes.filter((w) => w === "\r")).toHaveLength(2);
  });

  it("reports rather than settling, leaving the verdict to the stall backstop", () => {
    // pasteAndSubmit must never decide a turn is dead: it has only the absence of
    // a signal to go on, and that signal is legitimately absent for live work.
    vi.useFakeTimers();
    const writes: string[] = [];
    const reported: number[] = [];
    const cancel = pasteAndSubmit({ write: (d: string) => writes.push(d) } as any, "queued work", {
      submitted: () => false,
      onUnconfirmed: (n) => reported.push(n),
      intervalMs: 1000,
      attempts: 2,
    });
    vi.advanceTimersByTime(150 + 3 * 1000);
    expect(reported).toEqual([2]);
    // Reporting is terminal for the loop — no further CRs, and no side effect
    // beyond the callback.
    vi.advanceTimersByTime(60_000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(3); // initial + 2 retries
    expect(reported).toEqual([2]);
    cancel();
  });

  it("cancel() before the initial CR suppresses the submit entirely", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const cancel = pasteAndSubmit({ write: (d: string) => writes.push(d) } as any, "queued work", {
      submitted: () => false,
    });
    cancel(); // turn died inside the 150ms paste-settle beat
    vi.advanceTimersByTime(60_000);
    expect(writes.filter((w) => w === "\r")).toHaveLength(0);
  });
});
