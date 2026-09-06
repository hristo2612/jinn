import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The harness comes FIRST, before anything that reaches shared/paths.js: paths
// freezes JINN_HOME at import, so an earlier one would leave this file on the
// run-wide home. startRouteHarness asserts it.
import {
  call,
  config,
  firstUserMessage,
  sessionToolHeaders,
  startRouteHarness,
  stopRouteHarness,
  unavailableEngines,
  type Registry,
} from "./todo-route-harness.js";

/**
 * What the capture POST spends, and what it refuses to spend, over a real
 * gateway.
 *
 * Every refusal here happens BEFORE a session exists, which is the property
 * worth pinning: a capture that cannot be shaped must cost nothing and must
 * name the setting that fixes it. What the GET reports once a capture is
 * running is todo-capture-get.test.ts; the stage rules themselves are
 * unit-tested against fixtures in todo-capture-stage.test.ts.
 */

let registry: Registry;

beforeAll(async () => {
  ({ registry } = await startRouteHarness());
});
afterAll(async () => {
  await stopRouteHarness();
});

describe("POST /api/todo-captures", () => {
  it("spawns one Todo Shaper session and reports the capture as starting", async () => {
    const before = registry.countSessions();

    const response = await call("POST", "/api/todo-captures", { text: "the closed rail scrolls under the header on mobile" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ stage: "starting", workItemId: null, error: null });
    expect(response.body.captureId).toEqual(expect.any(String));
    expect(response.body.captureId).toBe(response.body.sessionId);
    expect(registry.countSessions()).toBe(before + 1);
    expect(registry.getSession(response.body.sessionId)).toMatchObject({ employee: "todo-shaper", status: "running" });
  });

  it.each([
    ["shape", "Shape only. Create or land the Todo, then stop without dispatching it."],
    ["shape-and-dispatch", "Shape & Dispatch. Create or land the Todo, then dispatch a newly created Todo."],
  ] as const)("hands the %s action to Todo Shaper only", async (action, instruction) => {
    const response = await call("POST", "/api/todo-captures", {
      text: "make the capture action explicit",
      action,
    });

    expect(response.status).toBe(201);
    expect(registry.getSession(response.body.sessionId)).toMatchObject({ employee: "todo-shaper" });
    expect(firstUserMessage(registry, response.body.sessionId)).toContain(instruction);
  });

  it("preserves line breaks in the message accepted by the shaping session", async () => {
    const text = "Keep the rough title\n\nAcceptance:\n- first line\n- second line";

    const response = await call("POST", "/api/todo-captures", { text, action: "shape" });

    expect(response.status).toBe(201);
    expect(firstUserMessage(registry, response.body.sessionId)).toContain(`Capture:\n${text}`);
  });

  it.each(["shape", "shape-and-dispatch"] as const)("pins Todos created by the %s path so Home includes them", async (action) => {
    const capture = await call("POST", "/api/todo-captures", { text: `pin the ${action} result`, action });
    const created = await call(
      "POST",
      "/api/work-items",
      { title: `Captured through ${action}` },
      await sessionToolHeaders(capture.body.sessionId),
    );

    expect(created.status).toBe(201);
    const home = await call("GET", "/api/work-items?home=true&rootsOnly=true&limit=200");
    expect(home.body.workItems).toContainEqual(expect.objectContaining({
      id: created.body.workItem.id,
      kept: true,
    }));
  });

  it("refuses an unknown action without creating a session", async () => {
    const before = registry.countSessions();

    const response = await call("POST", "/api/todo-captures", { text: "do something unclear", action: "launch" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/action/);
    expect(registry.countSessions()).toBe(before);
  });

  // The operator's own words are what gets stored. The speech note is added to
  // the engine copy only, so a transcript never shows the operator a caveat
  // about their own dictation.
  it("stores the operator's text verbatim even when the capture was dictated", async () => {
    const text = "make the closed rail stop scrolling under the header";

    const response = await call("POST", "/api/todo-captures", { text, speechDerived: true });

    const message = registry.getMessages(response.body.sessionId).find((m: { role: string }) => m.role === "user");
    expect(message?.content).toContain(text);
    expect(message?.content).not.toMatch(/Voice input note/);
  });

  it("refuses an empty capture without creating a session", async () => {
    const before = registry.countSessions();

    const response = await call("POST", "/api/todo-captures", { text: "   " });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/nothing to shape/);
    expect(registry.countSessions()).toBe(before);
  });

  it("refuses an over-long capture and names the cap and the way forward", async () => {
    const before = registry.countSessions();

    const response = await call("POST", "/api/todo-captures", { text: "x".repeat(4_001) });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/4000/);
    expect(response.body.error).toMatch(/full Todo form/);
    expect(registry.countSessions()).toBe(before);
  });

  // A missing engine is the failure journey step 9 provokes. The reason has to
  // be the gateway's real one, naming the override to change.
  it("names an unavailable engine and the setting to change, before spending anything", async () => {
    const before = registry.countSessions();
    const shaperEngine = config().engines.default;
    unavailableEngines.add(shaperEngine);

    try {
      const response = await call("POST", "/api/todo-captures", { text: "something the shaper will never see" });

      expect(response.status).toBe(502);
      expect(response.body.error).toContain(shaperEngine);
      expect(response.body.error).toMatch(/Todo Shaper engine override/);
      expect(registry.countSessions()).toBe(before);
    } finally {
      unavailableEngines.clear();
    }
  });

  it("names the toolset it cannot attach rather than starting a Shaper that cannot create a Todo", async () => {
    const { setJinnAttachGate } = await import("../../mcp/attachment.js");
    const before = registry.countSessions();
    setJinnAttachGate({ ok: false, reason: "the gateway MCP is disabled in config" });

    try {
      const response = await call("POST", "/api/todo-captures", { text: "a capture with no tools to shape it" });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/jinn toolset/);
      expect(response.body.error).toMatch(/the gateway MCP is disabled in config/);
      expect(registry.countSessions()).toBe(before);
    } finally {
      setJinnAttachGate({ ok: true });
    }
  });
});
