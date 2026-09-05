import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Engine, EngineRunOpts } from "../../../shared/types.js";

/**
 * Shared fixture for the parent-callback reliability suites. They exercise the
 * real sender, the real HTTP route handler, real SQLite, and a real queue, with
 * only `globalThis.fetch` stubbed out (see callback-requests.ts).
 *
 * The pool is `forks`, so importing this gives each suite its own process, its
 * own home, and its own SQLite DB. JINN_HOME must be set before db.js loads;
 * keep that order.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-callback-reliability-"));
process.env.JINN_HOME = home;
export const dbModule = await import("../../../shared/db.js");

export const api = await import("../../api.js");
export const registry = await import("../../../sessions/registry.js");
export const queueModule = await import("../../../sessions/queue.js");
export const callbacks = await import("../../../sessions/callbacks.js");
export const workItems = await import("../../../work-items/store.js");
dbModule.initDb();

export type ApiContext = import("../../api.js").ApiContext;

/**
 * Per-test reset. The sweep timer goes first: a sweep armed by the previous
 * test would otherwise wake against half-truncated rows.
 */
export function resetCallbackState(): void {
  callbacks.__resetCallbackRetrySweepForTest();
  dbModule.initDb().exec(`
    DELETE FROM work_item_events;
    DELETE FROM callback_deliveries;
    DELETE FROM queue_items;
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM work_items;
  `);
}

/** Polls on real timers, so no suite that uses this may install fake ones. */
export async function eventually(assertion: () => void, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

export function makeEngine(seenPrompts: string[]): Engine {
  return {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      seenPrompts.push(opts.prompt);
      return {
        sessionId: `stub-${seenPrompts.length}`,
        result: `acknowledged ${seenPrompts.length}`,
      };
    },
  };
}

export function makeContext(engine: Engine, queue: {
  enqueue: (...args: never[]) => Promise<void>;
  clearCancelled: (sessionKey: string) => void;
}, events: Array<{ event: string; data: unknown }> = []) {
  const config = {
    gateway: {},
    engines: { default: "stub", stub: {} },
    sessions: {},
    mcp: {},
  };
  return {
    config,
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: (event: string, data: unknown) => events.push({ event, data }),
    sessionManager: {
      getEngine: () => engine,
      getEngines: () => new Map([["stub", engine]]),
      getQueue: () => queue,
    },
  } as unknown as ApiContext;
}

/** A queue that accepts an enqueue and never runs it — the pre-restart process. */
export function acceptWithoutExecuting() {
  return {
    clearCancelled: () => {},
    hasInFlightItem: () => false,
    holdForCallbackDrain: () => {},
    releaseCallbackDrain: () => {},
    enqueue: async () => {},
  };
}

export function createParent(suffix: string, source: "web" | "talk" = "web") {
  return registry.createSession({
    engine: "stub",
    source,
    sourceRef: `${source}:callback-parent:${suffix}`,
    sessionKey: `${source}:callback-parent:${suffix}`,
    connector: source,
    prompt: "wait for child callbacks",
  });
}

type CreateSessionInput = Parameters<typeof registry.createSession>[0];

export function createChild(parentId: string, suffix: string, extra: Partial<CreateSessionInput> = {}) {
  return registry.createSession({
    engine: "stub",
    source: "web",
    sourceRef: `web:${suffix}`,
    sessionKey: `web:${suffix}`,
    connector: "web",
    employee: "worker",
    parentSessionId: parentId,
    prompt: "complete delegated work",
    ...extra,
  });
}

/** Runs a child's attempt through to a succeeded terminal state. */
export function completeChildAttempt(childId: string) {
  const attempt = registry.beginSessionAttempt(childId)!;
  return registry.completeSessionAttempt(childId, attempt.attemptToken!, {
    status: "idle",
    attemptOutcome: "succeeded",
  })!;
}
