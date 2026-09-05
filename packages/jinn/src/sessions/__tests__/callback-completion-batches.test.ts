import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-completion-batches-"));
process.env.JINN_HOME = home;
const dbModule = await import("../../shared/db.js");
const registry = await import("../registry.js");
type Registry = typeof registry;

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM callback_deliveries; DELETE FROM queue_items; DELETE FROM messages; DELETE FROM sessions;");
});
afterAll(() => {
  dbModule.__closeDbForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

function callbackInput(overrides: Record<string, unknown> = {}) {
  return {
    targetSessionId: "parent-1",
    sourceKind: "session" as const,
    sourceId: "child-1",
    sourceAttempt: "attempt-1",
    sourceOutcome: "succeeded",
    sourceVersion: 1,
    deliveryKind: "parent-completion",
    payload: overrides.payload ?? {
      message: "engine callback payload",
      displayMessage: "Worker replied\nDone",
      meta: {
        kind: "child-reply",
        employee: "worker",
        childSessionId: "child-1",
        fullMessage: "Done",
      },
    },
    ...overrides,
  } as Parameters<Registry["claimSessionDelivery"]>[0];
}

function createSession(id: string, parentSessionId?: string) {
  const session = registry.createSession({
    engine: "stub",
    source: "web",
    sourceRef: `web:${id}`,
    sessionKey: `web:${id}`,
    connector: "web",
    parentSessionId,
    prompt: `session ${id}`,
  });
  dbModule.initDb().prepare("UPDATE sessions SET id = ? WHERE id = ?").run(id, session.id);
  return registry.getSession(id)!;
}

describe("completion batch acceptance", () => {
  it("starts a second completion batch rather than building an unbounded engine prompt", () => {
    const parent = createSession("parent-bounded-batch");
    const bodies = ["a", "b", "c"].map((letter, index) =>
      `result ${index} ${letter.repeat(60_000)}`,
    );
    for (const [index, body] of bodies.entries()) {
      const delivery = registry.claimSessionDelivery(callbackInput({
        targetSessionId: parent.id,
        sourceId: `child-${index}`,
        sourceAttempt: `attempt-${index}`,
        payload: { message: body, displayMessage: `Result ${index}` },
      })).delivery;
      registry.acceptSessionDelivery(delivery.id, parent.id, parent.sessionKey);
    }

    const queued = registry.listAllPendingQueueItems();
    expect(queued).toHaveLength(2);
    expect(queued[0]!.prompt).toContain(bodies[0]);
    expect(queued[0]!.prompt).toContain(bodies[1]);
    expect(queued[0]!.prompt).not.toContain(bodies[2]);
    expect(queued[1]!.prompt).toBe(bodies[2]);
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification"))
      .toHaveLength(3);
  });

  it("caps a completion batch at 32 durable receipts", () => {
    const parent = createSession("parent-item-bounded-batch");
    for (let index = 0; index < 33; index++) {
      const delivery = registry.claimSessionDelivery(callbackInput({
        targetSessionId: parent.id,
        sourceId: `bounded-child-${index}`,
        sourceAttempt: `bounded-attempt-${index}`,
        payload: { message: `bounded result ${index}`, displayMessage: `Bounded result ${index}` },
      })).delivery;
      registry.acceptSessionDelivery(delivery.id, parent.id, parent.sessionKey);
    }

    const queued = registry.listAllPendingQueueItems();
    expect(queued).toHaveLength(2);
    expect(queued[0]!.prompt).toContain("32 durable completion updates");
    expect(queued[1]!.prompt).toBe("bounded result 32");
  });

  it("keeps callback completion order at acceptance when timestamps collide", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const parent = createSession("parent-ordered-batch");
    const claimed = ["claimed first", "accepted first"].map((message, index) =>
      registry.claimSessionDelivery(callbackInput({
        targetSessionId: parent.id,
        sourceId: `ordered-child-${index}`,
        sourceAttempt: `ordered-attempt-${index}`,
        payload: { message, displayMessage: message },
      })).delivery,
    );

    registry.acceptSessionDelivery(claimed[1]!.id, parent.id, parent.sessionKey);
    registry.acceptSessionDelivery(claimed[0]!.id, parent.id, parent.sessionKey);

    const prompt = registry.listAllPendingQueueItems()[0]!.prompt;
    expect(prompt.indexOf("accepted first")).toBeLessThan(prompt.indexOf("claimed first"));
    vi.useRealTimers();
  });

  it("keeps queued operator work as a compaction and batching fence", () => {
    const parent = createSession("parent-queue-fence");
    const accept = (label: string) => {
      const delivery = registry.claimSessionDelivery(callbackInput({
        targetSessionId: parent.id,
        sourceId: `fence-child-${label}`,
        sourceAttempt: `fence-attempt-${label}`,
        payload: { message: `completion ${label}`, displayMessage: `Completion ${label}` },
      })).delivery;
      return registry.acceptSessionDelivery(delivery.id, parent.id, parent.sessionKey).delivery;
    };
    const first = accept("before");
    const operatorQueueId = registry.enqueueQueueItem(parent.id, parent.sessionKey, "operator follow-up");
    const second = accept("after");

    expect(registry.coalescePendingParentCompletionQueueItems()).toBe(0);
    expect(registry.listAllPendingQueueItems().map(({ id, prompt }) => ({ id, prompt }))).toEqual([
      { id: first.queueItemId, prompt: "completion before" },
      { id: operatorQueueId, prompt: "operator follow-up" },
      { id: second.queueItemId, prompt: "completion after" },
    ]);
    expect(registry.getMessages(parent.id).filter((message) => message.role === "notification"))
      .toHaveLength(2);
  });

});
