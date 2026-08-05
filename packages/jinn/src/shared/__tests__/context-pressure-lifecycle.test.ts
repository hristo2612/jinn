import { describe, it, expect } from "vitest";
import { assessContextPressure, pendingNudgeText, markNudgeDelivered, queueNudge, deliveredLevel } from "../context-pressure.js";
import { mergeTransportMeta } from "../../sessions/manager.js";

/**
 * The nudge is delivered through transportMeta across turns, so the parts that
 * can actually break are the state transitions, not the threshold maths:
 * queue → carry across a turn → prepend → clear → don't repeat → escalate once.
 * This walks a session through them the way manager.ts does.
 */

const WINDOW = 1_000_000;

/** Mirrors manager.ts turn-end: assess, and queue the nudge into meta. */
function endTurn(meta: Record<string, unknown>, contextTokens: number, employee = "fight-process-lead") {
  const next = { ...meta };
  const carried = pendingNudgeText(next);
  if (carried) markNudgeDelivered(next, next["contextHandoffPendingLevel"]);
  const v = assessContextPressure({
    contextTokens, contextWindow: WINDOW, employee, alreadyNudged: deliveredLevel(next),
  });
  if (v) queueNudge(next, v);
  return next;
}

/** Mirrors manager.ts turn-start: prepend a pending nudge to the real prompt. */
function startTurn(meta: Record<string, unknown>, prompt: string) {
  const pending = pendingNudgeText(meta);
  return pending ? `${pending}\n\n---\n\n${prompt}` : prompt;
}

describe("handoff nudge lifecycle", () => {
  it("queues nothing while the session is comfortable", () => {
    const meta = endTurn({}, 300_000);
    expect(meta["contextHandoffPending"]).toBeUndefined();
    expect(startTurn(meta, "do the thing")).toBe("do the thing");
  });

  it("queues at 70% and rides the NEXT real prompt rather than forcing a turn", () => {
    const meta = endTurn({}, 720_000);
    expect(meta["contextHandoffPending"]).toBeTypeOf("string");
    const prompt = startTurn(meta, "continue the audit");
    expect(prompt).toContain("Context checkpoint");
    expect(prompt).toContain("continue the audit"); // the real work is preserved
    expect(prompt.indexOf("Context checkpoint")).toBeLessThan(prompt.indexOf("continue the audit"));
  });

  it("clears after delivery so it is never prepended twice", () => {
    let meta = endTurn({}, 720_000);
    expect(startTurn(meta, "x")).toContain("Context checkpoint");
    meta = endTurn(meta, 730_000);               // the turn that carried it completes
    expect(startTurn(meta, "x")).toBe("x");       // gone
    expect(meta["contextHandoffDelivered"]).toBe("wrap-up");
  });

  it("does not nag while the agent is still wrapping up", () => {
    let meta = endTurn({}, 720_000);
    meta = endTurn(meta, 750_000);
    for (const tokens of [760_000, 780_000, 800_000, 840_000]) {
      meta = endTurn(meta, tokens);
      expect(startTurn(meta, "x"), `should stay quiet at ${tokens}`).toBe("x");
    }
  });

  it("escalates once when the agent blows past the second threshold", () => {
    let meta = endTurn({}, 720_000);
    meta = endTurn(meta, 730_000);                // wrap-up delivered
    meta = endTurn(meta, 880_000);                // crosses urgent
    const prompt = startTurn(meta, "x");
    expect(prompt).toContain("wrap up now");
    meta = endTurn(meta, 890_000);                // urgent delivered
    expect(meta["contextHandoffDelivered"]).toBe("urgent");
    meta = endTurn(meta, 950_000);
    expect(startTurn(meta, "x")).toBe("x");       // never again
  });

  it("survives a transport adapter overwriting metadata mid-session", () => {
    const meta = endTurn({}, 720_000);
    // A connector merges its own transportMeta; internal keys must survive.
    const merged = mergeTransportMeta(meta as never, { channelName: "web" } as never) as Record<string, unknown>;
    expect(merged["contextHandoffPending"]).toBe(meta["contextHandoffPending"]);
    expect(startTurn(merged, "x")).toContain("Context checkpoint");
  });

  it("leaves operator chat alone through the whole lifecycle", () => {
    let meta: Record<string, unknown> = {};
    for (const tokens of [720_000, 880_000, 990_000]) {
      meta = endTurn(meta, tokens, "");           // Genie: no employee
      expect(startTurn(meta, "keep chatting")).toBe("keep chatting");
    }
  });

  it("keeps the pending level when a connector's own metadata would clobber it", () => {
    // mergeTransportMeta spreads incoming over existing, so the preserved-key
    // list is the ONLY thing protecting an internal key that a transport
    // adapter also happens to set. Without it the level is lost, `delivered` is
    // never recorded, and the nudge re-fires on every subsequent turn.
    const meta = endTurn({}, 720_000);
    const clobbering = { contextHandoffPendingLevel: undefined, contextHandoffPending: undefined } as never;
    const merged = mergeTransportMeta(meta as never, clobbering) as Record<string, unknown>;
    expect(merged["contextHandoffPendingLevel"], "level must survive a clobbering merge").toBe("wrap-up");
    expect(merged["contextHandoffPending"], "nudge must survive a clobbering merge").toBeTypeOf("string");
  });

  it("cleans up the level after delivery so no stale value can be re-recorded", () => {
    let meta = endTurn({}, 720_000);
    meta = endTurn(meta, 730_000);
    expect(meta["contextHandoffDelivered"]).toBe("wrap-up");
    expect(meta["contextHandoffPendingLevel"], "stale level must be removed").toBeUndefined();
  });

});
