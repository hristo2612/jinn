import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";
import {
  buildSessionDelegatedActivityIndex,
  serializeSession,
  type ApiContext,
} from "../api.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "web:sess-1",
    connector: "web",
    sessionKey: "web:sess-1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    lastActivity: "2026-06-01T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function makeContext(
  backgroundActivity?: ApiContext["backgroundActivity"],
  transportByKey: Record<string, "idle" | "queued" | "running" | "error" | "interrupted"> = {},
  engine?: unknown,
): ApiContext {
  return {
    backgroundActivity,
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (key: string) => transportByKey[key] ?? "idle",
      }),
      getEngine: () => engine,
    },
  } as unknown as ApiContext;
}

/** An engine that reports turn progress, as the interactive Claude engine does. */
function makeProgressEngine(progress: {
  turnStartedAt: number;
  lastProgressAt: number;
  awaitingSubmit: boolean;
  activeTools: number;
  activeUpstream: boolean;
} | null) {
  return { turnProgress: () => progress };
}

describe("serializeSession", () => {
  it("reports runtime activity as running transport state while keeping stored status idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const session = makeSession({ status: "idle" });
    const context = makeContext(new Map([
      ["sess-1", { activeStreams: 1, lastActivityAt: Date.now() }],
    ]));

    const serialized = serializeSession(session, context);

    expect(serialized.status).toBe("idle");
    expect(serialized.transportState).toBe("running");
    expect(serialized.backgroundActivity?.activeStreams).toBe(1);
    vi.useRealTimers();
  });

  it("keeps long active runtime work visible instead of staling it out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:10:00.000Z"));
    const session = makeSession({ status: "idle" });
    const context = makeContext(new Map([
      ["sess-1", { activeStreams: 1, lastActivityAt: new Date("2026-06-01T00:00:00.000Z").getTime() }],
    ]));

    const serialized = serializeSession(session, context);

    expect(serialized.transportState).toBe("running");
    expect(serialized.backgroundActivity?.activeStreams).toBe(1);
    vi.useRealTimers();
  });

  it("serializes transitive delegated activity without changing the parent's durable status", () => {
    const parent = makeSession({ id: "parent", sessionKey: "web:parent" });
    const manager = makeSession({
      id: "manager",
      sessionKey: "web:manager",
      parentSessionId: "parent",
      employee: "ops-lead",
    });
    const worker = makeSession({
      id: "worker",
      sessionKey: "web:worker",
      parentSessionId: "manager",
      employee: "researcher",
      status: "running",
    });
    const context = makeContext(undefined, { "web:worker": "running" });
    const index = buildSessionDelegatedActivityIndex([parent, manager, worker], context);

    const serialized = serializeSession(parent, context, index);

    expect(serialized.status).toBe("idle");
    expect(serialized.delegatedActivity).toEqual({
      activeSessions: 1,
      employees: ["researcher"],
    });
  });

  it.each([
    {
      label: "queued transport",
      child: makeSession({ id: "child", sessionKey: "web:child", parentSessionId: "parent", employee: "developer" }),
      context: makeContext(undefined, { "web:child": "queued" }),
    },
    {
      label: "waiting status",
      child: makeSession({ id: "child", sessionKey: "web:child", parentSessionId: "parent", employee: "developer", status: "waiting" }),
      context: makeContext(),
    },
    {
      label: "post-turn runtime activity",
      child: makeSession({ id: "child", sessionKey: "web:child", parentSessionId: "parent", employee: "developer" }),
      context: makeContext(new Map([
        ["child", { activeStreams: 1, lastActivityAt: Date.now() }],
      ])),
    },
  ])("treats $label as delegated work still in progress", ({ child, context }) => {
    const parent = makeSession({ id: "parent", sessionKey: "web:parent" });

    expect(buildSessionDelegatedActivityIndex([parent, child], context).get("parent")).toEqual({
      activeSessions: 1,
      employees: ["developer"],
    });
  });

  it("does not keep a parent active for idle or errored descendants", () => {
    const parent = makeSession({ id: "parent", sessionKey: "web:parent" });
    const idle = makeSession({ id: "idle", parentSessionId: "parent", employee: "writer" });
    const errored = makeSession({ id: "errored", parentSessionId: "parent", employee: "researcher", status: "error" });
    const context = makeContext();
    const index = buildSessionDelegatedActivityIndex([parent, idle, errored], context);

    expect(index.has("parent")).toBe(false);
    expect(serializeSession(parent, context, index).delegatedActivity).toBeNull();
  });
});

describe("serializeSession: turnProgress", () => {
  const NOW = new Date("2026-06-01T00:00:00.000Z").getTime();
  const live = {
    turnStartedAt: NOW - 5_000,
    lastProgressAt: NOW - 5_000,
    awaitingSubmit: false,
    activeTools: 0,
    activeUpstream: false,
  };

  it("reports the instant for any live turn, with no staleness verdict of its own", () => {
    // The client owns the threshold: a stalled session emits nothing, so a verdict
    // computed here would never be delivered. Five seconds in is still reported.
    const session = makeSession({ status: "running" });
    const context = makeContext(undefined, {}, makeProgressEngine(live));

    expect(serializeSession(session, context).turnProgress).toEqual({
      lastProgressAt: NOW - 5_000,
      awaitingSubmit: false,
    });
  });

  it("passes through awaitingSubmit so the row can say why it is quiet", () => {
    const session = makeSession({ status: "running" });
    const context = makeContext(undefined, {}, makeProgressEngine({ ...live, awaitingSubmit: true }));

    expect(serializeSession(session, context).turnProgress?.awaitingSubmit).toBe(true);
  });

  it.each([
    { label: "a tool is running", progress: { ...live, activeTools: 1 } },
    { label: "an upstream request is in flight", progress: { ...live, activeUpstream: true } },
  ])("stays silent while $label", ({ progress }) => {
    // State, not time — the server is the right place to judge it, and both edges
    // emit hooks, so the clearing refetch is guaranteed.
    const session = makeSession({ status: "running" });
    const context = makeContext(undefined, {}, makeProgressEngine(progress));

    expect(serializeSession(session, context).turnProgress).toBeNull();
  });

  it("stays silent when no turn is in flight, or the session is not running", () => {
    const idle = makeContext(undefined, {}, makeProgressEngine(null));
    expect(serializeSession(makeSession({ status: "running" }), idle).turnProgress).toBeNull();

    const running = makeContext(undefined, {}, makeProgressEngine(live));
    expect(serializeSession(makeSession({ status: "idle" }), running).turnProgress).toBeNull();
    expect(serializeSession(makeSession({ status: "waiting" }), running).turnProgress).toBeNull();
  });

  it("stays silent for engines that cannot report progress at all", () => {
    const session = makeSession({ status: "running", engine: "codex" });

    expect(serializeSession(session, makeContext()).turnProgress).toBeNull();
    expect(serializeSession(session, makeContext(undefined, {}, {})).turnProgress).toBeNull();
  });
});
