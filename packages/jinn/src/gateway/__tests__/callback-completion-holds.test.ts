import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRunOpts } from "../../shared/types.js";
import {
  api, createChild, createParent, eventually, makeContext,
  queueModule, registry, resetCallbackState,
} from "./helpers/callback-harness.js";
import {
  postCallbackDelivery, postUserMessage,
} from "./helpers/callback-requests.js";

beforeEach(resetCallbackState);

describe("completion drain holds", () => {
  it("owns a held relay until an empty source drain and preserves later target work order", async () => {
    const promptsBySession = new Map<string, string[]>();
    const engine = {
      name: "stub",
      run: vi.fn(async (opts: EngineRunOpts) => {
        const prompts = promptsBySession.get(opts.sessionId!) ?? [];
        prompts.push(opts.prompt);
        promptsBySession.set(opts.sessionId!, prompts);
        return {
          sessionId: `stub-${opts.sessionId}-${prompts.length}`,
          result: opts.prompt.includes("source drain input") ? "" : "processed",
        };
      }),
    };
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const target = createParent("held-target-order");
    const source = createChild(target.id, "held-source-order");
    const sourceInput = registry.claimSessionDelivery({
      targetSessionId: source.id,
      sourceKind: "session",
      sourceId: "source-worker",
      sourceAttempt: "source-worker-attempt",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "source drain input", displayMessage: "Source drain input" },
    }).delivery;
    registry.acceptSessionDelivery(sourceInput.id, source.id, source.sessionKey);
    const held = registry.claimSessionDelivery({
      targetSessionId: target.id,
      sourceKind: "session",
      sourceId: source.id,
      sourceAttempt: "source-intermediate-attempt",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "substantive source synthesis", displayMessage: "Source synthesis" },
    }).delivery;

    await postCallbackDelivery(context, target.id, held.id);
    await postUserMessage(context, target.id, "operator follow-up after held callback");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(promptsBySession.get(target.id)).toBeUndefined();
    expect(queue.isCallbackDrainHeld(target.sessionKey)).toBe(true);

    api.resumePendingWebQueueItems(context);
    await eventually(() => {
      expect(queue.isCallbackDrainHeld(target.sessionKey)).toBe(false);
      expect(promptsBySession.get(source.id)).toEqual(["source drain input"]);
      expect(promptsBySession.get(target.id)).toEqual([
        "substantive source synthesis",
        "operator follow-up after held callback",
      ]);
    });
  });

  it("releases a full held batch before dispatching the overflow row", async () => {
    const targetPrompts: string[] = [];
    let targetId = "";
    const engine = {
      name: "stub",
      run: vi.fn(async (opts: EngineRunOpts) => {
        if (opts.sessionId === targetId) targetPrompts.push(opts.prompt);
        return { sessionId: `stub-${opts.sessionId}`, result: "processed" };
      }),
    };
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const target = createParent("overflow-target");
    targetId = target.id;
    const source = createChild(target.id, "overflow-source");
    const sourceInput = registry.claimSessionDelivery({
      targetSessionId: source.id,
      sourceKind: "session",
      sourceId: "overflow-worker",
      sourceAttempt: "overflow-worker-attempt",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "pending overflow source", displayMessage: "Pending source" },
    }).delivery;
    const sourceQueueId = registry.acceptSessionDelivery(sourceInput.id, source.id, source.sessionKey)
      .delivery.queueItemId!;

    for (let index = 0; index < 32; index++) {
      const delivery = registry.claimSessionDelivery({
        targetSessionId: target.id,
        sourceKind: "session",
        sourceId: source.id,
        sourceAttempt: `held-overflow-${index}`,
        sourceOutcome: "succeeded",
        sourceVersion: index + 1,
        deliveryKind: "parent-completion",
        payload: { message: `held result ${index}`, displayMessage: `Held result ${index}` },
      }).delivery;
      await postCallbackDelivery(context, target.id, delivery.id);
    }
    expect(queue.isCallbackDrainHeld(target.sessionKey)).toBe(true);
    expect(targetPrompts).toEqual([]);

    registry.markQueueItemRunning(sourceQueueId);
    registry.markQueueItemCompleted(sourceQueueId);
    const finalDelivery = registry.claimSessionDelivery({
      targetSessionId: target.id,
      sourceKind: "session",
      sourceId: source.id,
      sourceAttempt: "held-overflow-final",
      sourceOutcome: "succeeded",
      sourceVersion: 33,
      deliveryKind: "parent-completion",
      payload: { message: "overflow final result", displayMessage: "Overflow final result" },
    }).delivery;
    await postCallbackDelivery(context, target.id, finalDelivery.id);

    await eventually(() => {
      expect(queue.isCallbackDrainHeld(target.sessionKey)).toBe(false);
      expect(targetPrompts).toHaveLength(2);
    });
    expect(targetPrompts[0]).toContain("held result 0");
    expect(targetPrompts[0]).toContain("held result 31");
    expect(targetPrompts[1]).toBe("overflow final result");
  });

  it("releases callback holds by queue item across multiple fenced sources", async () => {
    const targetPrompts: string[] = [];
    let targetId = "";
    const engine = {
      name: "stub",
      run: vi.fn(async (opts: EngineRunOpts) => {
        if (opts.sessionId === targetId) targetPrompts.push(opts.prompt);
        return { sessionId: `stub-${opts.sessionId}`, result: "processed" };
      }),
    };
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const target = createParent("multi-hold-target");
    targetId = target.id;
    const sourceA = createChild(target.id, "multi-hold-source-a");
    const sourceB = createChild(target.id, "multi-hold-source-b");
    const seedSource = (source: typeof sourceA, label: string) => {
      const input = registry.claimSessionDelivery({
        targetSessionId: source.id,
        sourceKind: "session",
        sourceId: `worker-${label}`,
        sourceAttempt: `worker-attempt-${label}`,
        sourceOutcome: "succeeded",
        sourceVersion: 1,
        deliveryKind: "parent-completion",
        payload: { message: `pending source ${label}`, displayMessage: `Pending source ${label}` },
      }).delivery;
      return registry.acceptSessionDelivery(input.id, source.id, source.sessionKey).delivery.queueItemId!;
    };
    const sourceQueueA = seedSource(sourceA, "a");
    const sourceQueueB = seedSource(sourceB, "b");
    const sendTarget = async (sourceId: string, attempt: string, message: string) => {
      const delivery = registry.claimSessionDelivery({
        targetSessionId: target.id,
        sourceKind: "session",
        sourceId,
        sourceAttempt: attempt,
        sourceOutcome: "succeeded",
        sourceVersion: 1,
        deliveryKind: "parent-completion",
        payload: { message, displayMessage: message },
      }).delivery;
      return postCallbackDelivery(context, target.id, delivery.id);
    };

    await sendTarget(sourceA.id, "source-a-initial", "source A initial");
    await postUserMessage(context, target.id, "operator ordering fence");
    await sendTarget(sourceB.id, "source-b-initial", "source B initial");
    expect(targetPrompts).toEqual([]);

    registry.markQueueItemRunning(sourceQueueA);
    registry.markQueueItemCompleted(sourceQueueA);
    await sendTarget(sourceA.id, "source-a-final", "source A final");
    await eventually(() => expect(targetPrompts).toEqual([
      "source A initial",
      "operator ordering fence",
    ]));
    expect(queue.isCallbackDrainHeld(target.sessionKey)).toBe(true);

    registry.markQueueItemRunning(sourceQueueB);
    registry.markQueueItemCompleted(sourceQueueB);
    await sendTarget(sourceB.id, "source-b-final", "source B final");
    await eventually(() => expect(targetPrompts).toHaveLength(3));
    expect(targetPrompts[2]).toContain("source B initial");
    expect(targetPrompts[2]).toContain("source A final");
    expect(targetPrompts[2]).toContain("source B final");
    expect(queue.isCallbackDrainHeld(target.sessionKey)).toBe(false);
  });
});
