import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptWithoutExecuting,
  api,
  createParent,
  dbModule,
  eventually,
  makeContext,
  makeEngine,
  queueModule,
  registry,
  resetCallbackState,
} from "./helpers/callback-harness.js";
import { clearVisibleQueue, postCallbackDelivery, postNotification } from "./helpers/callback-requests.js";

beforeEach(resetCallbackState);

type ReplayProbe = { parentId: string; events: Array<{ event: string; data: unknown }> };

const restartCases = [
  {
    source: "web" as const,
    deliveryKind: "parent-completion",
    message: "callback after restart",
    displayMessage: "Worker replied\nRestart result",
    // Twice: the accepted response is lost and the HTTP client retries. Neither
    // the message nor the arrival may be announced a second time.
    deliveries: 2,
    alsoExpectAccepted: ({ parentId, events }: ReplayProbe) => {
      expect(registry.getMessages(parentId).filter((message) => message.role === "notification")).toHaveLength(1);
      expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
    },
    alsoExpectReplayed: ({ events }: ReplayProbe) => {
      expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
    },
  },
  {
    source: "talk" as const,
    deliveryKind: "talk-attachment",
    message: "attached callback after restart",
    displayMessage: "Attached worker replied\nRestart result",
    deliveries: 1,
    alsoExpectAccepted: () => {},
    alsoExpectReplayed: () => {},
  },
];

describe("accepted callback queue intents survive a restart", () => {
  it.each(restartCases)("replays one accepted $source callback queue intent after restart", async (row) => {
    const seenPrompts: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    const engine = makeEngine(seenPrompts);
    const parent = createParent(`${row.source}-restart`, row.source);
    const delivery = registry.claimSessionDelivery({
      targetSessionId: parent.id,

      sourceKind: "session",
      sourceId: `child-${row.source}-restart`,
      sourceAttempt: `attempt-${row.source}-restart-1`,
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: row.deliveryKind,
      payload: { message: row.message, displayMessage: row.displayMessage },
    }).delivery;
    const preRestartQueue = acceptWithoutExecuting();

    for (let index = 0; index < row.deliveries; index++) {
      await postCallbackDelivery(makeContext(engine, preRestartQueue, events), parent.id, delivery.id);
    }

    expect(registry.listAllPendingQueueItems()).toHaveLength(1);
    row.alsoExpectAccepted({ parentId: parent.id, events });

    const postRestartQueue = new queueModule.SessionQueue();
    api.resumePendingWebQueueItems(makeContext(engine, postRestartQueue, events));

    await eventually(() => {
      expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual([row.message]);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
    row.alsoExpectReplayed({ parentId: parent.id, events });
  });

  it.each(["web", "talk"] as const)(
    "keeps an accepted %s callback queue intent pending while its engine is unavailable",
    async (source) => {
      const seenPrompts: string[] = [];
      const events: Array<{ event: string; data: unknown }> = [];
      const engine = makeEngine(seenPrompts);
      const parent = createParent(`missing-engine-${source}`, source);
      const delivery = registry.claimSessionDelivery({
        targetSessionId: parent.id,

        sourceKind: "session",
        sourceId: `child-missing-engine-${source}`,
        sourceAttempt: `attempt-missing-engine-${source}`,
        sourceOutcome: "succeeded",
        sourceVersion: 1,
        deliveryKind: source === "web" ? "parent-completion" : "talk-attachment",
        payload: {
          message: `callback survives ${source} engine outage`,
          displayMessage: "Worker replied\nEngine outage result",
        },
      }).delivery;
      const preRestartQueue = acceptWithoutExecuting();

      await postCallbackDelivery(makeContext(engine, preRestartQueue, events), parent.id, delivery.id);
      const accepted = registry.getSessionDelivery(delivery.id)!;
      const messageId = accepted.messageId;
      const queueItemId = accepted.queueItemId;
      expect(accepted).toMatchObject({ status: "accepted" });
      expect(messageId).toBeTruthy();
      expect(queueItemId).toBeTruthy();

      const postRestartQueue = new queueModule.SessionQueue();
      const restoredContext = makeContext(engine, postRestartQueue, events);
      let engineAvailable = false;
      restoredContext.sessionManager.getEngine = () => engineAvailable ? engine : undefined;

      api.resumePendingWebQueueItems(restoredContext);

      expect(seenPrompts).toEqual([]);
      expect(registry.getSessionDelivery(delivery.id)).toMatchObject({
        status: "accepted",
        messageId,
        queueItemId,
      });
      expect(registry.listAllPendingQueueItems()).toEqual([
        expect.objectContaining({ id: queueItemId, status: "pending" }),
      ]);

      engineAvailable = true;
      api.resumePendingWebQueueItems(restoredContext);

      await eventually(() => {
        expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
        expect(seenPrompts).toEqual([`callback survives ${source} engine outage`]);
        expect(registry.listAllPendingQueueItems()).toEqual([]);
      });
      expect(registry.getSessionDelivery(delivery.id)).toMatchObject({
        status: "accepted",
        messageId,
        queueItemId,
      });
      expect(registry.getMessages(parent.id).filter((message) => message.role === "notification"))
        .toHaveLength(1);
      expect(events.filter(({ event }) => event === "session:notification")).toHaveLength(1);
    },
  );

  it("replays an accepted but unconsumed callback after a simulated restart", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const parent = createParent("restart");
    const preRestartQueue = acceptWithoutExecuting();

    await postNotification(makeContext(engine, preRestartQueue), parent.id, "callback-after-restart");

    expect(registry.listAllPendingQueueItems()).toEqual([
      expect.objectContaining({
        sessionId: parent.id,
        prompt: "callback-after-restart",
        internal: true,
      }),
    ]);
    expect(registry.getQueueItems(parent.sessionKey)).toEqual([]);
    expect(registry.cancelAllPendingQueueItems(parent.sessionKey)).toBe(0);
    expect(registry.listAllPendingQueueItems()).toHaveLength(1);

    const postRestartQueue = new queueModule.SessionQueue();
    api.resumePendingWebQueueItems(makeContext(engine, postRestartQueue));

    await eventually(() => {
      expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["callback-after-restart"]);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
  });

  it("does not discard an internal callback when the operator clears visible queued messages", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const parent = createParent("visible-clear");
    queue.pauseQueue(parent.sessionKey);

    await postNotification(context, parent.id, "callback-survives-visible-clear");
    expect(registry.listAllPendingQueueItems()).toHaveLength(1);

    expect(await clearVisibleQueue(context, parent.id)).toMatchObject({
      status: "cleared",
      cancelled: 0,
    });
    queue.resumeQueue(parent.sessionKey);

    await eventually(() => {
      expect(queue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toEqual(["callback-survives-visible-clear"]);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
  });

  it("replays a durable completion backlog as one bounded turn while retaining every receipt", async () => {
    const seenPrompts: string[] = [];
    const engine = makeEngine(seenPrompts);
    const parent = createParent("backlog-restart");
    const deliveries = Array.from({ length: 12 }, (_, index) => registry.claimSessionDelivery({
      targetSessionId: parent.id,
      sourceKind: "session" as const,
      sourceId: `restart-child-${index % 2}`,
      sourceAttempt: `restart-attempt-${index}`,
      sourceOutcome: index === 5 ? "failed" : "succeeded",
      sourceVersion: index + 1,
      deliveryKind: "parent-completion",
      payload: {
        message: index === 5 ? "restart backlog error" : `restart backlog result ${index}`,
        displayMessage: `Restart update ${index}`,
      },
    }).delivery);

    // Reproduce the durable shape written by releases before callback batching:
    // every accepted receipt owns a separate pending queue row at boot.
    for (const delivery of deliveries) {
      const accepted = registry.acceptSessionDelivery(delivery.id, parent.id, parent.sessionKey);
      registry.markQueueItemRunning(accepted.delivery.queueItemId!);
    }
    dbModule.initDb().prepare(
      "UPDATE queue_items SET status = 'pending', started_at = NULL WHERE session_id = ?",
    ).run(parent.id);

    expect(registry.listAllPendingQueueItems()).toHaveLength(12);
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification"))
      .toHaveLength(12);
    expect(dbModule.initDb().prepare("SELECT COUNT(*) AS n FROM callback_deliveries").get())
      .toEqual({ n: 12 });

    const postRestartQueue = new queueModule.SessionQueue();
    api.resumePendingWebQueueItems(makeContext(engine, postRestartQueue));
    await eventually(() => {
      expect(postRestartQueue.isRunning(parent.sessionKey)).toBe(false);
      expect(seenPrompts).toHaveLength(1);
      expect(registry.listAllPendingQueueItems()).toEqual([]);
    });
    for (let index = 0; index < 12; index++) {
      expect(seenPrompts[0]).toContain(index === 5 ? "restart backlog error" : `restart backlog result ${index}`);
    }
  });
});
