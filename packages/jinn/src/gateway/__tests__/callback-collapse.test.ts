import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApiContext,
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

});
