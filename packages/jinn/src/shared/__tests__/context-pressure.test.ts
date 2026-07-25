import { describe, it, expect } from "vitest";
import { assessContextPressure, handoffNudgeText, HANDOFF_LEVELS } from "../context-pressure.js";

const WINDOW = 1_000_000;
const at = (pct: number) => Math.round(WINDOW * pct);

const worker = (contextTokens: number, alreadyNudged: "wrap-up" | "urgent" | null = null) =>
  assessContextPressure({ contextTokens, contextWindow: WINDOW, employee: "fight-process-lead", alreadyNudged });

describe("assessContextPressure — firing", () => {
  it("stays silent well below the first threshold", () => {
    expect(worker(at(0.20))).toBeNull();
    expect(worker(at(0.69))).toBeNull();
  });

  it("fires wrap-up at the first threshold", () => {
    const v = worker(at(0.70));
    expect(v?.level).toBe("wrap-up");
    expect(v?.ratio).toBeCloseTo(0.70, 2);
  });

  it("escalates to urgent at the higher threshold", () => {
    expect(worker(at(0.85))?.level).toBe("urgent");
    expect(worker(at(0.97))?.level).toBe("urgent");
  });

  it("reports the numbers it decided on", () => {
    const v = worker(at(0.75));
    expect(v?.contextTokens).toBe(at(0.75));
    expect(v?.contextWindow).toBe(WINDOW);
  });
});

describe("assessContextPressure — never nags", () => {
  it("does not repeat a level already delivered", () => {
    expect(worker(at(0.72), "wrap-up")).toBeNull();
    expect(worker(at(0.80), "wrap-up")).toBeNull();
  });

  it("still escalates from wrap-up to urgent", () => {
    expect(worker(at(0.86), "wrap-up")?.level).toBe("urgent");
  });

  it("never re-fires once urgent has been delivered", () => {
    expect(worker(at(0.90), "urgent")).toBeNull();
    expect(worker(at(0.99), "urgent")).toBeNull();
  });

  it("does not regress to a lower level after escalating", () => {
    // Context shrank after a compaction; the agent already got the urgent nudge.
    expect(worker(at(0.71), "urgent")).toBeNull();
  });
});

describe("assessContextPressure — scope", () => {
  it("ignores operator chat — Genie has nobody to hand off to", () => {
    for (const employee of [undefined, null, "", "   "]) {
      expect(assessContextPressure({ contextTokens: at(0.95), contextWindow: WINDOW, employee })).toBeNull();
    }
  });

  it("ignores sessions with no context reading yet", () => {
    expect(assessContextPressure({ contextTokens: null, contextWindow: WINDOW, employee: "x" })).toBeNull();
  });

  it("ignores an unknown context window rather than guessing one", () => {
    expect(assessContextPressure({ contextTokens: at(0.95), contextWindow: undefined, employee: "x" })).toBeNull();
  });

  it("never throws on malformed input", () => {
    for (const t of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const w of [0, -1, Number.NaN, undefined]) {
        expect(() =>
          assessContextPressure({ contextTokens: t, contextWindow: w as number, employee: "x" }),
        ).not.toThrow();
      }
    }
  });
});

describe("handoffNudgeText", () => {
  it("names the contract the org already runs on", () => {
    const text = handoffNudgeText(worker(at(0.70))!);
    expect(text).toContain("DONE");
    expect(text).toContain("BLOCKED");
    expect(text).toContain("work item");
  });

  it("explicitly steers away from the destructive options", () => {
    const text = handoffNudgeText(worker(at(0.70))!);
    expect(text).toContain("/clear");
    expect(text).toContain("/compact");
    expect(text.toLowerCase()).toContain("do not run");
  });

  it("reports the real numbers so the agent can judge urgency", () => {
    const text = handoffNudgeText(worker(at(0.70))!);
    expect(text).toContain("70%");
    expect(text).toContain((1_000_000).toLocaleString());
  });

  it("is more insistent at the urgent level", () => {
    expect(handoffNudgeText(worker(at(0.70))!)).toContain("next safe stopping point");
    expect(handoffNudgeText(worker(at(0.90))!)).toContain("wrap up now");
  });
});

describe("thresholds", () => {
  it("are ordered and inside the window", () => {
    const ats = HANDOFF_LEVELS.map((l) => l.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    for (const a of ats) { expect(a).toBeGreaterThan(0); expect(a).toBeLessThan(1); }
  });

  it("leave real headroom — a nudge at 100% would be useless", () => {
    expect(Math.max(...HANDOFF_LEVELS.map((l) => l.at))).toBeLessThanOrEqual(0.9);
  });
});
