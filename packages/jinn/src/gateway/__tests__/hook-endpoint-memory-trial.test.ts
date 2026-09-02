import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach, vi } from "vitest";
import { HookRegistry } from "../hook-registry.js";
import { MEMORY_TRIAL_POLICY, type MemoryTrialClaims } from "../../memory-trial/guardrails.js";
import { makeApiRes, makeHookReq, makeApiContext, makeApiContextWithConfig, tmpHome } from "./hook-endpoint-fixtures.js";

describe("handleHookPost - memory trial", () => {
  const registries: HookRegistry[] = [];
  const makeReg = (): HookRegistry => {
    const r = new HookRegistry();
    registries.push(r);
    return r;
  };
  afterEach(() => {
    while (registries.length > 0) registries.pop()!.dispose();
  });

  it("routes only authorized memory-trial lifecycle hooks with session identity, policy gates and idempotence", async () => {
    const [{ handleApiRequest }, { initDb }, { createSession }] = await Promise.all([
      import("../api.js"),
      import("../../shared/db.js"),
      import("../../sessions/registry.js"),
    ]);
    initDb();

    const session = createSession({
      engine: "codex",
      source: "web",
      sourceRef: "hook-endpoint-test",
      employee: "jarvis-fullstack-builder",
      model: "gpt-5.5",
      title: "Hook endpoint test",
    });
    const reg = makeReg();
    const delivered: string[] = [];
    reg.register(session.id, (hook) => { delivered.push(hook.hook_event_name); });
    const dispatched = vi.fn(async (_claims: MemoryTrialClaims) => undefined);
    const operationStore = new Set<string>();
    const context = makeApiContext(reg, {
      enabled: true,
      circuitOpen: false,
      triggers: MEMORY_TRIAL_POLICY.triggers,
      dispatch: dispatched,
      operationStore,
    });

    for (const hook of [
      { hook_event_name: "SessionStart", session_id: "claude-session" },
      { hook_event_name: "Stop", session_id: "claude-session" },
      { hook_event_name: "SessionStart", session_id: "claude-session" },
    ] as const) {
      const response = makeApiRes();
      await handleApiRequest(
        makeHookReq("sek", { jinnSessionId: session.id, hook }),
        response.res,
        context,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: "ok" });
    }

    expect(delivered).toEqual(["SessionStart", "Stop", "SessionStart"]);
    expect(dispatched).toHaveBeenCalledTimes(2);
    expect(dispatched.mock.calls.map(([claims]) => claims)).toEqual([
      {
        createdAt: Date.parse(session.createdAt),
        projectId: "jarvis",
        agentId: "jarvis-fullstack-builder",
        sessionId: session.id,
        trigger: "authorized-session-start",
      },
      {
        createdAt: Date.parse(session.createdAt),
        projectId: "jarvis",
        agentId: "jarvis-fullstack-builder",
        sessionId: session.id,
        trigger: "session-finalized",
      },
    ]);
  });

  it("keeps the hook path and engine-session capture alive when memory dispatch fails", async () => {
    const [{ handleApiRequest }, { initDb }, { createSession, getSession, getEngineSessionRef }] = await Promise.all([
      import("../api.js"),
      import("../../shared/db.js"),
      import("../../sessions/registry.js"),
    ]);
    initDb();

    const session = createSession({
      engine: "claude",
      source: "web",
      sourceRef: "hook-endpoint-memory-failure-test",
      employee: "jarvis-fullstack-builder",
      model: "claude-omni",
      title: "Hook endpoint memory failure test",
    });
    const reg = makeReg();
    const delivered: string[] = [];
    reg.register(session.id, (hook) => { delivered.push(hook.hook_event_name); });
    const dispatched = vi.fn(async (_claims: MemoryTrialClaims) => { throw new Error("budget-violation"); });
    const context = makeApiContext(reg, {
      enabled: true,
      circuitOpen: false,
      triggers: MEMORY_TRIAL_POLICY.triggers,
      dispatch: dispatched,
      operationStore: new Set<string>(),
    });

    const response = makeApiRes();
    await handleApiRequest(
      makeHookReq("sek", { jinnSessionId: session.id, hook: { hook_event_name: "SessionStart", session_id: "claude-session-after-failure" } }),
      response.res,
      context,
    );

    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "ok" });
    expect(delivered).toEqual(["SessionStart"]);
    expect(getEngineSessionRef(getSession(session.id)!, "claude").id).toBe("claude-session-after-failure");
  });

  it("routes memory-trial hooks through save/load restart config without persisting authorization", async () => {
    const [{ handleApiRequest }, { initDb }, { createSession }, { loadConfig, saveConfigAtomic }] = await Promise.all([
      import("../api.js"),
      import("../../shared/db.js"),
      import("../../sessions/registry.js"),
      import("../../shared/config.js"),
    ]);
    initDb();

    const session = createSession({
      engine: "codex",
      source: "web",
      sourceRef: "hook-endpoint-restart-test",
      employee: "jarvis-fullstack-builder",
      model: "gpt-5.5",
      title: "Hook endpoint restart test",
    });
    const reg = makeReg();
    reg.register(session.id, () => {});
    const jinnHome = tmpHome;
    const controlPath = path.join(jinnHome, "state", "memory-trial", "control.json");
    fs.rmSync(path.dirname(controlPath), { recursive: true, force: true });
    expect(fs.existsSync(controlPath)).toBe(false);

    saveConfigAtomic({
      gateway: {},
      sessions: {},
      connectors: {},
      engines: {
        default: "codex",
        claude: { bin: "claude", model: "claude-sonnet-4-5" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      memoryTrial: {
        enabled: true,
        circuitOpen: false,
        activationEpoch: Date.parse(session.createdAt) - 1,
        triggers: ["authorized-session-start", "session-finalized"],
      },
    });
    const loadedConfig = loadConfig();
    expect(loadedConfig.memoryTrial).toEqual({
      enabled: true,
      circuitOpen: false,
      activationEpoch: Date.parse(session.createdAt) - 1,
      triggers: ["authorized-session-start", "session-finalized"],
    });

    const response = makeApiRes();
    await handleApiRequest(
      makeHookReq("sek", {
        jinnSessionId: session.id,
        hook: { hook_event_name: "SessionStart", session_id: "claude-session" },
      }),
      response.res,
      makeApiContextWithConfig(reg, loadedConfig, jinnHome),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "ok" });
    const control = JSON.parse(fs.readFileSync(controlPath, "utf8")) as Record<string, unknown>;
    expect(control).toMatchObject({
      enabled: false,
      circuitOpen: true,
      triggers: [],
      pending: [],
      checkpoints: [
        [
          MEMORY_TRIAL_POLICY.projectId,
          "jarvis-fullstack-builder",
          session.id,
          "authorized-session-start",
          MEMORY_TRIAL_POLICY.policyVersion,
        ].join("\u001f"),
      ],
    });
  });


  it("leaves memory-trial inert when persisted authorization is absent", async () => {
    const [{ handleApiRequest }, { initDb }, { createSession }] = await Promise.all([
      import("../api.js"),
      import("../../shared/db.js"),
      import("../../sessions/registry.js"),
    ]);
    initDb();

    const session = createSession({
      engine: "codex",
      source: "web",
      sourceRef: "hook-endpoint-disabled-test",
      employee: "jarvis-fullstack-builder",
      model: "gpt-5.5",
      title: "Hook endpoint disabled test",
    });
    const reg = makeReg();
    reg.register(session.id, () => {});
    const jinnHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-memory-trial-disabled-"));
    const controlPath = path.join(jinnHome, "state", "memory-trial", "control.json");

    const response = makeApiRes();
    await handleApiRequest(
      makeHookReq("sek", {
        jinnSessionId: session.id,
        hook: { hook_event_name: "SessionStart", session_id: "claude-session" },
      }),
      response.res,
      makeApiContext(reg, undefined, undefined, jinnHome),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "ok" });
    expect(fs.existsSync(controlPath)).toBe(false);
  });
});
