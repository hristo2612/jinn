import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  EMPLOYEE,
  connectorMessage,
  connectorStub,
  createTestHome,
  engineResult,
  eventually,
  rateLimitedResult,
  scriptedEngine,
  testConfig,
} from "./helpers/turn-parity-harness.js";

/**
 * ICI-714 — three terminal receipts the connector runner used to skip entirely,
 * each of which the web runner already wrote. They are covered here because the
 * connector path is the one that was missing them, and because a receipt nobody
 * writes is invisible until a parent hangs or a spinner never clears.
 */

createTestHome("jinn-connector-receipts-");
const dbModule = await import("../../shared/db.js");
const { createConnectorTurnSurface } = await import("../turn/connector-surface.js");

const notifyParentSession = vi.fn();
vi.mock("../callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../callbacks.js")>();
  return {
    ...actual,
    notifyParentSession: (...args: unknown[]) => notifyParentSession(...args),
    notifyParentSessionAndWait: (...args: unknown[]) => notifyParentSession(...args),
    notifyOperatorChannel: () => {},
    notifyRateLimited: () => {},
    notifyRateLimitResumed: () => {},
  };
});

let registry: typeof import("../registry.js");
let ManagerClass: typeof import("../manager.js").SessionManager;

beforeAll(async () => {
  [registry, { SessionManager: ManagerClass }] = await Promise.all([
    import("../registry.js"),
    import("../manager.js"),
  ]);
  dbModule.initDb();
});

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  notifyParentSession.mockClear();
});

const employee = { name: EMPLOYEE, engine: "claude", persona: "Turn receipts fixture" };

function managerWith(script: ReturnType<typeof engineResult>[], engines = new Map<string, unknown>()) {
  const claude = scriptedEngine("claude", script);
  engines.set("claude", claude);
  return new ManagerClass(testConfig(), engines as never, "receipts-boot", () => employee as never);
}

/** Route one connector turn and wait for it to reach a terminal status. */
async function routeTurn(
  manager: InstanceType<typeof ManagerClass>,
  opts: Record<string, unknown> = {},
): Promise<{ id: string; connector: ReturnType<typeof connectorStub> }> {
  const connector = connectorStub();
  const key = `stub:receipts-${Math.random().toString(16).slice(2)}`;
  const routed = await manager.route(connectorMessage(key, "probe"), connector, {
    employee: employee as never,
    ...opts,
  });
  const id = routed!.sessionId;
  await eventually(() => {
    const status = registry.getSession(id)?.status;
    return status === "idle" || status === "error" || status === "interrupted";
  }, 40_000);
  return { id, connector };
}

/** A delegated child session that a later `route` on the same key reuses. */
function seedChildSession(sessionKey: string): string {
  return registry.createSession({
    engine: "claude",
    source: "slack",
    sourceRef: sessionKey,
    connector: "stub",
    sessionKey,
    employee: EMPLOYEE,
    parentSessionId: "parent-1",
  } as never).id;
}

describe("connector-path terminal receipts", () => {
  it("wakes the parent when a rate-limit deadline expires", async () => {
    // resetsAt an hour in the past puts the deadline (resetsAt + 30min) behind
    // us, so the wait loop times out on its very first check.
    const manager = managerWith([rateLimitedResult(-3600)]);
    const key = "stub:rl-timeout";
    const id = seedChildSession(key);

    await manager.route(connectorMessage(key, "probe"), connectorStub(), { employee: employee as never });
    await eventually(() => registry.getSession(id)?.status === "error", 40_000);

    expect(notifyParentSession).toHaveBeenCalledTimes(1);
    const [, result] = notifyParentSession.mock.calls[0];
    expect((result as { error: string }).error).toContain("usage limit did not clear in time");
  }, 60_000);

  it("settles the attempt when the session's engine is not registered", async () => {
    const manager = managerWith([engineResult({ result: "unreachable" })]);
    const { id } = await routeTurn(manager, { engine: "ghost" });

    const session = registry.getSession(id)!;
    expect(session.status).toBe("error");
    expect(session.attemptOutcome).toBe("failed");
    expect(session.attemptTerminalVersion).toBe(1);
    expect(session.lastError).toContain('Engine "ghost" not available');
  });

  it("emits exactly one session:completed for a normal turn", async () => {
    const emit = vi.fn();
    const manager = managerWith([
      engineResult({ result: "the answer", sessionId: "native-1", cost: 0.5, durationMs: 1234, numTurns: 2 }),
    ]);
    manager.setGatewayEmitter(emit);
    const { id } = await routeTurn(manager);

    const completed = emit.mock.calls.filter(([event]) => event === "session:completed");
    expect(completed).toHaveLength(1);
    expect(completed[0][1]).toEqual({
      sessionId: id,
      employee: EMPLOYEE,
      title: registry.getSession(id)!.title,
      result: "the answer",
      error: null,
      cost: 0.5,
      durationMs: 1234,
    });
  });

  it("settles the turn without letting a rejected reply escape the surface", async () => {
    const emit = vi.fn();
    const manager = managerWith([engineResult({ result: "the answer" })]);
    manager.setGatewayEmitter(emit);

    const connector = connectorStub();
    const reply = vi.fn(async () => { throw new Error("connector offline"); });
    connector.replyMessage = reply as never;

    const key = `stub:reply-rejects-${Math.random().toString(16).slice(2)}`;
    const routed = await manager.route(connectorMessage(key, "probe"), connector, { employee: employee as never });
    const id = routed!.sessionId;
    await eventually(() => reply.mock.calls.length > 0 && registry.getSession(id)?.status === "idle", 40_000);

    // The rejection is contained: one terminal receipt, one completion, nothing thrown.
    expect(registry.getSession(id)!.attemptOutcome).toBe("succeeded");
    expect(emit.mock.calls.filter(([event]) => event === "session:completed")).toHaveLength(1);
  }, 60_000);

  it("reports a reply that never landed as the completion's error", async () => {
    const emit = vi.fn();
    const connector = connectorStub();
    connector.replyMessage = (async () => { throw new Error("connector offline"); }) as never;
    const session = { id: "s-1", employee: EMPLOYEE, title: "t" } as never;
    const surface = createConnectorTurnSurface({
      connector, target: { channel: "c1" }, session, config: testConfig(), decorate: false, emit,
    });

    // `reply` is no-throw, so the answer that never landed shows up on the receipt instead.
    await expect(surface.reply("the answer")).resolves.toBeUndefined();
    await surface.settled({ session, result: "the answer", error: null });

    const [, payload] = emit.mock.calls.find(([event]) => event === "session:completed")!;
    expect((payload as { error: string | null }).error).toBe("connector offline");
  });
});
