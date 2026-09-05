import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRunOpts } from "../../shared/types.js";
import {
  type ApiContext,
  api,
  callbacks,
  completeChildAttempt,
  createChild,
  createParent,
  dbModule,
  eventually,
  makeContext,
  makeEngine,
  queueModule,
  registry,
  resetCallbackState,
} from "./helpers/callback-harness.js";
import {
  type RouteFetch,
  postCallbackDelivery,
  postNotification,
  postUserMessage,
  withFetch,
  withRouteBackedFetch,
} from "./helpers/callback-requests.js";

beforeEach(resetCallbackState);

type Parent = ReturnType<typeof createParent>;

interface CollapseCase {
  name: string;
  parentSource: "web" | "talk";
  deliveryKind: string;
  /** Builds the subject and returns the callback the sender fires six times. */
  arrange: (parent: Parent, context: ApiContext) => () => void;
  /** Whatever this case asserts on top of the shared collapse guarantees. */
  alsoExpect: (probe: { fire: () => void; routeFetch: RouteFetch; seenPrompts: string[] }) => Promise<void> | void;
}

const collapseCases: CollapseCase[] = [
  {
    name: "manager visibility",
    parentSource: "web",
    deliveryKind: "manager-visibility",
    arrange: (parent) => {
      const details = {
        manager: "team-lead",
        managerDisplay: "Team Lead",
        delegator: "org-root",
        delegatorDisplay: "Org Root",
        employee: "worker",
        employeeDisplay: "Worker",
        childSessionId: "visibility-child",
        workItemId: "wi_visibility_boundary",
        title: "Inspect durable visibility",
      };
      return () => callbacks.notifyManagerVisibility(parent.id, details);
    },
    // A replay that arrives after the receipt was already accepted must land on
    // the same row, not a second one.
    alsoExpect: async ({ fire }) => {
      const accepted = dbModule.initDb().prepare(`
        SELECT id, status FROM callback_deliveries WHERE delivery_kind = 'manager-visibility'
      `).get();
      fire();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(dbModule.initDb().prepare(`
        SELECT COUNT(*) AS n FROM callback_deliveries WHERE delivery_kind = 'manager-visibility'
      `).get()).toEqual({ n: 1 });
      expect(dbModule.initDb().prepare(`
        SELECT id, status FROM callback_deliveries WHERE delivery_kind = 'manager-visibility'
      `).get()).toEqual(accepted);
    },
  },
  ...(["web", "talk"] as const).map((source): CollapseCase => ({
    name: `rate-limit-resumed for a ${source} parent`,
    parentSource: source,
    deliveryKind: "rate-limit-resumed",
    arrange: (parent) => {
      const child = createChild(parent.id, `rate-resumed-child:${source}`, {
        title: "Rate limited work",
        prompt: "resume after rate limit",
      });
      const attempt = registry.beginSessionAttempt(child.id)!;
      const resumed = registry.updateSession(child.id, { status: "running", attemptOutcome: null })!;
      expect(resumed.attemptToken).toBe(attempt.attemptToken);
      return () => callbacks.notifyRateLimitResumed(resumed);
    },
    alsoExpect: () => {},
  })),
  {
    name: "real settlement",
    parentSource: "web",
    deliveryKind: "parent-completion",
    arrange: (parent) => {
      const completed = completeChildAttempt(createChild(parent.id, "callback-child:real-six").id);
      return () => callbacks.notifyParentSession(completed, { result: "one immutable completion" });
    },
    alsoExpect: ({ routeFetch, seenPrompts }) => {
      expect(seenPrompts).toEqual([expect.stringContaining("one immutable completion")]);
      expect(dbModule.initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get()).toEqual({ n: 1 });
      expect(routeFetch).toHaveBeenCalledOnce();
    },
  },
];

describe("parent callback collapse", () => {
  it.each(collapseCases)(
    "collapses six identical $name callbacks into one message, receipt, and arrival",
    async (row) => {
      const seenPrompts: string[] = [];
      const events: Array<{ event: string; data: unknown }> = [];
      const queue = new queueModule.SessionQueue();
      const context = makeContext(makeEngine(seenPrompts), queue, events);
      const parent = createParent(`collapse-${row.deliveryKind}`, row.parentSource);

      await withRouteBackedFetch(context, {}, async (routeFetch) => {
        const fire = row.arrange(parent, context);
        for (let index = 0; index < 6; index++) fire();

        await eventually(() => {
          expect(queue.isRunning(parent.sessionKey)).toBe(false);
          expect(seenPrompts).toHaveLength(1);
        });
        expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(1);
        expect(dbModule.initDb()
          .prepare("SELECT COUNT(*) AS n FROM callback_deliveries WHERE delivery_kind = ?")
          .get(row.deliveryKind)).toEqual({ n: 1 });
        expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);

        await row.alsoExpect({ fire, routeFetch, seenPrompts });
      });
    },
  );

  it("keeps rate-limit waiting and resumed receipts independently deliverable", async () => {
    const parent = createParent("rate-kinds");
    const child = createChild(parent.id, "rate-kind-child", { prompt: "rate kind distinction" });
    const attempt = registry.beginSessionAttempt(child.id)!;
    const active = registry.getSession(child.id)!;
    expect(active.attemptToken).toBe(attempt.attemptToken);

    await withFetch(
      vi.fn().mockRejectedValue(new Error("hold both receipts pending")) as unknown as typeof globalThis.fetch,
      async () => {
        callbacks.notifyRateLimited(active);
        callbacks.notifyRateLimitResumed(active);
        await eventually(() => {
          const rows = dbModule.initDb().prepare(`
            SELECT delivery_kind AS kind FROM callback_deliveries ORDER BY delivery_kind
          `).all();
          expect(rows).toEqual([{ kind: "rate-limit-resumed" }, { kind: "rate-limited" }]);
        });
      },
    );
  });

  it("accepts six duplicate callback deliveries as one message, queue item, arrival, and parent turn", async () => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    const context = makeContext(engine, queue, events);
    const parent = createParent("idempotent-six");
    const delivery = registry.claimSessionDelivery({
      targetSessionId: parent.id,

      sourceKind: "session",
      sourceId: "child-completed",
      sourceAttempt: "attempt-generation-1",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: {
        message: "one engine callback",
        displayMessage: "Worker replied\nOne result",
        meta: {
          kind: "child-reply",
          employee: "worker",
          childSessionId: "child-completed",
          fullMessage: "One result",
        },
      },
    }).delivery;

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => postCallbackDelivery(context, parent.id, delivery.id)),
    );
    // Simulate an accepted response being lost and the HTTP client retrying.
    responses.push(await postCallbackDelivery(context, parent.id, delivery.id));

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["one engine callback"]);
    });
    expect(responses.filter((response) => response.status === "queued")).toHaveLength(1);
    expect(responses.filter((response) => response.status === "duplicate")).toHaveLength(6);
    expect(enqueueSpy).toHaveBeenCalledOnce();
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toEqual([
      expect.objectContaining({
        content: "Worker replied\nOne result",
        meta: expect.objectContaining({ kind: "child-reply", childSessionId: "child-completed" }),
      }),
    ]);
    const stored = registry.getSessionDelivery(delivery.id)!;
    expect(stored).toMatchObject({ status: "accepted" });
    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS n FROM queue_items WHERE id = ?").get(stored.queueItemId))
      .toEqual({ n: 1 });
    expect(events.filter(({ event }) => event === "session:notification")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ sessionId: parent.id, message: "Worker replied\nOne result" }),
      }),
    ]);
  });

  it("delivers a legitimate resumed attempt as a second callback", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("resume-generation");
    const base = {
      targetSessionId: parent.id,
      sourceKind: "session" as const,
      sourceId: "child-resumed",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
    };
    const first = registry.claimSessionDelivery({
      ...base,
      sourceAttempt: "attempt-1",
      payload: { message: "first attempt", displayMessage: "First attempt" },
    }).delivery;
    const resumed = registry.claimSessionDelivery({
      ...base,
      sourceAttempt: "attempt-2",
      payload: { message: "resumed attempt", displayMessage: "Resumed attempt" },
    }).delivery;

    await postCallbackDelivery(context, parent.id, first.id);
    await postCallbackDelivery(context, parent.id, resumed.id);

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["first attempt", "resumed attempt"]);
    });
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification")).toHaveLength(2);
  });

  it("delivers two rapid child callbacks exactly once each", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("rapid");

    await Promise.all([
      postNotification(context, parent.id, "callback-one"),
      postNotification(context, parent.id, "callback-two"),
    ]);

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toHaveLength(2);
    });
    expect(seenPrompts).toEqual(["callback-one", "callback-two"]);
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification"))
      .toHaveLength(2);
  });

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
