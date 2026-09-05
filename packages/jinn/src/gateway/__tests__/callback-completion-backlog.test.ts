import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRunOpts } from "../../shared/types.js";
import {
  createChild, createParent, dbModule, eventually, makeContext,
  queueModule, registry, resetCallbackState,
} from "./helpers/callback-harness.js";
import {
  postCallbackDelivery, withRouteBackedFetch,
} from "./helpers/callback-requests.js";

beforeEach(resetCallbackState);

describe("completion backlog relay", () => {
  it("processes a completion backlog in bounded turns without losing distinct results or errors", async () => {
    const seenPrompts: string[] = [];
    let releaseFirst!: () => void;
    const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const engine = {
      name: "stub",
      run: vi.fn(async (opts: EngineRunOpts) => {
        seenPrompts.push(opts.prompt);
        if (seenPrompts.length === 1) await firstTurn;
        return { sessionId: `stub-${seenPrompts.length}`, result: "state already reconciled" };
      }),
    };
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("completion-backlog");
    const deliveries = Array.from({ length: 21 }, (_, index) => registry.claimSessionDelivery({
      targetSessionId: parent.id,
      sourceKind: "session" as const,
      sourceId: index === 7 ? "child-with-error" : `child-${index % 3}`,
      sourceAttempt: `attempt-${index}`,
      sourceOutcome: index === 7 ? "failed" : "succeeded",
      sourceVersion: index + 1,
      deliveryKind: "parent-completion",
      payload: {
        message: index === 7 ? "failure update: dependency unavailable" : `completion update ${index}`,
        displayMessage: index === 7 ? "Worker failed" : `Worker completed ${index}`,
      },
    }).delivery);

    await postCallbackDelivery(context, parent.id, deliveries[0]!.id);
    await eventually(() => expect(queue.isRunning(parent.sessionKey)).toBe(true));
    for (const delivery of deliveries.slice(1)) {
      await postCallbackDelivery(context, parent.id, delivery.id);
    }
    releaseFirst();

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toHaveLength(2);
    });
    const combined = seenPrompts.join("\n");
    for (let index = 0; index < 21; index++) {
      expect(combined).toContain(index === 7 ? "failure update: dependency unavailable" : `completion update ${index}`);
    }
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification"))
      .toHaveLength(21);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get())
      .toEqual({ n: 21 });

    const actionable = registry.claimSessionDelivery({
      targetSessionId: parent.id,
      sourceKind: "session",
      sourceId: "child-new-work",
      sourceAttempt: "attempt-new-work",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "new actionable result", displayMessage: "New actionable result" },
    }).delivery;
    await postCallbackDelivery(context, parent.id, actionable.id);
    await eventually(() => expect(seenPrompts).toHaveLength(3));
    expect(seenPrompts[2]).toBe("new actionable result");
  });

  it("does not multiply callback-driven acknowledgements through a management chain", async () => {
    const promptsBySession = new Map<string, string[]>();
    let managerSessionId = "";
    let releaseFirst!: () => void;
    const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const engine = {
      name: "stub",
      run: vi.fn(async (opts: EngineRunOpts) => {
        const prompts = promptsBySession.get(opts.sessionId!) ?? [];
        prompts.push(opts.prompt);
        promptsBySession.set(opts.sessionId!, prompts);
        if (opts.sessionId === managerSessionId && prompts.length === 1) await firstTurn;
        return {
          sessionId: `stub-${opts.sessionId}-${prompts.length}`,
          result: opts.sessionId === managerSessionId && prompts.length === 2
            ? "final actionable completion"
            : "intermediate synthesis",
        };
      }),
    };
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const grandparent = createParent("grandparent");
    const manager = createChild(grandparent.id, "callback-parent:manager", {
      employee: "team-lead",
      sessionKey: "web:callback-parent:manager",
      sourceRef: "web:callback-parent:manager",
    });
    managerSessionId = manager.id;
    const deliveries = Array.from({ length: 21 }, (_, index) => registry.claimSessionDelivery({
      targetSessionId: manager.id,
      sourceKind: "session" as const,
      sourceId: "worker-child",
      sourceAttempt: `worker-attempt-${index}`,
      sourceOutcome: "succeeded",
      sourceVersion: index + 1,
      deliveryKind: "parent-completion",
      payload: { message: `stale completion ${index}`, displayMessage: `Stale completion ${index}` },
    }).delivery);

    await withRouteBackedFetch(context, {}, async () => {
      await postCallbackDelivery(context, manager.id, deliveries[0]!.id);
      await eventually(() => expect(queue.isRunning(manager.sessionKey)).toBe(true));
      for (const delivery of deliveries.slice(1)) {
        await postCallbackDelivery(context, manager.id, delivery.id);
      }
      releaseFirst();

      await eventually(() => {
        expect(queue.isRunning(manager.sessionKey)).toBe(false);
        expect(promptsBySession.get(manager.id)).toHaveLength(2);
        expect(promptsBySession.get(grandparent.id)).toHaveLength(1);
      });
    });
    expect(dbModule.initDb().prepare(`
      SELECT COUNT(*) AS n FROM callback_deliveries
      WHERE target_session_id = ? AND source_id = ? AND delivery_kind = 'parent-completion'
    `).get(grandparent.id, manager.id)).toEqual({ n: 2 });
    expect(promptsBySession.get(grandparent.id)?.[0]).toContain("intermediate synthesis");
    expect(promptsBySession.get(grandparent.id)?.[0]).toContain("final actionable completion");
    expect(registry.getMessages(manager.id).some((message) =>
      message.role === "assistant" && message.content.includes("intermediate synthesis"),
    )).toBe(true);
  });

  it("relays a callback-driven failure immediately even when newer completion state waits", async () => {
    const promptsBySession = new Map<string, string[]>();
    let managerSessionId = "";
    let releaseFirst!: () => void;
    const firstTurn = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const engine = {
      name: "stub",
      run: vi.fn(async (opts: EngineRunOpts) => {
        const prompts = promptsBySession.get(opts.sessionId!) ?? [];
        prompts.push(opts.prompt);
        promptsBySession.set(opts.sessionId!, prompts);
        if (opts.sessionId === managerSessionId && prompts.length === 1) {
          await firstTurn;
          return { sessionId: "manager-failed", result: "", error: "new dependency failure" };
        }
        return { sessionId: `stub-${opts.sessionId}-${prompts.length}`, result: "final recovery state" };
      }),
    };
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const grandparent = createParent("error-grandparent");
    const manager = createChild(grandparent.id, "callback-parent:error-manager", {
      employee: "team-lead",
      sessionKey: "web:callback-parent:error-manager",
      sourceRef: "web:callback-parent:error-manager",
    });
    managerSessionId = manager.id;
    const deliveries = [0, 1].map((index) => registry.claimSessionDelivery({
      targetSessionId: manager.id,
      sourceKind: "session" as const,
      sourceId: `worker-${index}`,
      sourceAttempt: `error-worker-attempt-${index}`,
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: `worker state ${index}`, displayMessage: `Worker state ${index}` },
    }).delivery);

    await withRouteBackedFetch(context, {}, async () => {
      await postCallbackDelivery(context, manager.id, deliveries[0]!.id);
      await eventually(() => expect(queue.isRunning(manager.sessionKey)).toBe(true));
      await postCallbackDelivery(context, manager.id, deliveries[1]!.id);
      releaseFirst();
      await eventually(() => expect(dbModule.initDb().prepare(`
        SELECT COUNT(*) AS n FROM callback_deliveries
        WHERE target_session_id = ? AND source_id = ? AND delivery_kind = 'parent-completion'
      `).get(grandparent.id, manager.id)).toEqual({ n: 2 }));
    });
    const upstream = dbModule.initDb().prepare(`
      SELECT payload FROM callback_deliveries
      WHERE target_session_id = ? AND source_id = ?
      ORDER BY rowid
    `).all(grandparent.id, manager.id) as Array<{ payload: string }>;
    expect(upstream.some(({ payload }) => payload.includes("new dependency failure"))).toBe(true);
    expect(upstream.some(({ payload }) => payload.includes("final recovery state"))).toBe(true);
  });


});
