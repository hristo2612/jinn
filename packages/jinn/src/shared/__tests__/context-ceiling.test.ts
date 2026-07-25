import { describe, it, expect, beforeEach } from "vitest";
import {
  assessContextCeiling,
  resetContextCeilingState,
  SUSPECT_RATIO,
  MIN_TURNS_SINCE_PEAK,
  MIN_EVIDENCE_TOKENS,
} from "../context-ceiling.js";

/** Measured from the real incident (2026-07-24, transcript 1a6151f8): Opus
 *  spawned via the bare `opus` alias got a 200K window while the roster
 *  declared 1M — it peaked at 191,584 across 116 readings. Fable, on a genuine
 *  1M window, peaked at 640,447 across 1021. Those two numbers are what the
 *  thresholds are calibrated against. */
const DECLARED_1M = 1_000_000;
const BROKEN_PEAK = 191_584;
const HEALTHY_PEAK = 640_447;

/** Feed n turns at `tokens`, as manager.ts would.
 *
 *  Returns the last verdict, but with `warn`/`suspect` folded across the whole
 *  run: `warn` is once-per-model, so the final verdict of a long run always
 *  reads false even when it fired on turn 26. Asserting on the last verdict
 *  alone silently passes — that flaw let a mutation removing MIN_EVIDENCE_TOKENS
 *  survive. "Did it ever fire" is what these tests actually mean. */
function feed(n: number, tokens: number, declared: number, model = "opus", userPrompt = "do the task") {
  let last!: ReturnType<typeof assessContextCeiling>;
  let everWarned = false;
  let everSuspect = false;
  for (let i = 0; i < n; i++) {
    last = assessContextCeiling({
      engine: "claude", model, declaredWindow: declared, currentTokens: tokens, userPrompt,
    });
    everWarned ||= last.warn;
    everSuspect ||= last.suspect;
  }
  return { ...last, warn: everWarned, suspect: everSuspect };
}

beforeEach(() => resetContextCeilingState());

describe("assessContextCeiling — detection", () => {
  it("fires on the real incident's ceiling once there is enough evidence", () => {
    const v = feed(MIN_TURNS_SINCE_PEAK + 1, BROKEN_PEAK, DECLARED_1M);
    expect(v.warn).toBe(true);
    expect(v.observedCeiling).toBe(BROKEN_PEAK);
    expect(v.ratio).toBeCloseTo(0.192, 3);
  });

  it("warns exactly once per model however long the thrash continues", () => {
    const verdicts = Array.from({ length: 200 }, () =>
      assessContextCeiling({
        engine: "claude", model: "opus", declaredWindow: DECLARED_1M,
        currentTokens: BROKEN_PEAK, userPrompt: "go",
      }),
    );
    expect(verdicts.filter((v) => v.warn).length).toBe(1);
  });

  it("tracks each engine/model pair independently", () => {
    feed(MIN_TURNS_SINCE_PEAK + 1, BROKEN_PEAK, DECLARED_1M, "opus");
    expect(feed(MIN_TURNS_SINCE_PEAK + 1, BROKEN_PEAK, DECLARED_1M, "sonnet").warn).toBe(true);
  });

  it("remembers the peak — one big turn is enough to clear suspicion", () => {
    assessContextCeiling({
      engine: "claude", model: "opus", declaredWindow: DECLARED_1M,
      currentTokens: HEALTHY_PEAK, userPrompt: "go",
    });
    expect(feed(MIN_TURNS_SINCE_PEAK * 2, 60_000, DECLARED_1M, "opus").warn).toBe(false);
  });
});

describe("assessContextCeiling — false positives", () => {
  it("never fires on the healthy 1M model from the same transcript", () => {
    expect(feed(200, HEALTHY_PEAK, DECLARED_1M, "fable").warn).toBe(false);
  });

  it("stays silent before there is enough evidence", () => {
    expect(feed(MIN_TURNS_SINCE_PEAK, BROKEN_PEAK, DECLARED_1M).suspect).toBe(false);
  });

  it("stays silent on light usage that never pushed the window", () => {
    // Many turns, but never near MIN_EVIDENCE_TOKENS — proves nothing.
    expect(feed(500, MIN_EVIDENCE_TOKENS - 1, DECLARED_1M, "chatty").warn).toBe(false);
  });

  it("stays silent when the roster declares the window honestly", () => {
    // Same 191K ceiling, but the roster correctly says 200K.
    expect(feed(200, BROKEN_PEAK, 200_000, "opus-honest").warn).toBe(false);
  });

  it("stays silent when the declared window is unknown", () => {
    expect(feed(200, BROKEN_PEAK, undefined as unknown as number, "mystery").suspect).toBe(false);
  });

  it("excludes slash commands from evidence entirely", () => {
    for (const cmd of ["/clear", "/compact", "  /compact  ", "/model opus"]) {
      resetContextCeilingState();
      expect(feed(200, BROKEN_PEAK, DECLARED_1M, "opus", cmd).suspect, `${cmd} must not count`).toBe(false);
    }
  });

  it("does not mistake a path argument for a slash command", () => {
    expect(feed(MIN_TURNS_SINCE_PEAK + 1, BROKEN_PEAK, DECLARED_1M, "opus", "read /etc/hosts").warn).toBe(true);
  });
});

describe("assessContextCeiling — robustness", () => {
  it("returns a fresh verdict object each call", () => {
    const a = assessContextCeiling({ engine: "claude", model: "m", declaredWindow: DECLARED_1M, currentTokens: null });
    (a as { suspect: boolean }).suspect = true;
    const b = assessContextCeiling({ engine: "claude", model: "m", declaredWindow: DECLARED_1M, currentTokens: null });
    expect(b.suspect).toBe(false);
  });

  it("never throws on malformed or hostile input", () => {
    const bad = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined];
    for (const tokens of bad) {
      for (const declared of [DECLARED_1M, 0, -1, Number.NaN, undefined]) {
        expect(() =>
          assessContextCeiling({
            engine: "claude", model: "opus",
            declaredWindow: declared as number,
            currentTokens: tokens as number,
          }),
        ).not.toThrow();
      }
    }
  });

  it("keeps the threshold inside the gap measured on real data", () => {
    expect(BROKEN_PEAK / DECLARED_1M).toBeLessThan(SUSPECT_RATIO);
    expect(HEALTHY_PEAK / DECLARED_1M).toBeGreaterThan(SUSPECT_RATIO);
  });
});
