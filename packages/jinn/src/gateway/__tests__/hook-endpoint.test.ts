import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

import { describe, it, expect, afterEach, vi } from "vitest";
import { handleHookPost, isLoopback } from "../hook-endpoint.js";
import { HookRegistry } from "../hook-registry.js";
import { MEMORY_TRIAL_POLICY, type MemoryTrialClaims } from "../../memory-trial/guardrails.js";
import type { MemoryTrialHookRouteOptions } from "../../memory-trial/hook-adapter.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-hook-endpoint-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

describe("isLoopback", () => {
  it("accepts loopback addresses in their common forms", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("::FFFF:127.0.0.1")).toBe(true); // case-insensitive
    expect(isLoopback("127.0.0.2")).toBe(true); // anywhere in 127.0.0.0/8
    expect(isLoopback("127.255.255.254")).toBe(true);
  });

  it("rejects non-loopback and malformed addresses", () => {
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback("")).toBe(false);
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback("::ffff:10.0.0.5")).toBe(false);
    expect(isLoopback("128.0.0.1")).toBe(false);
    expect(isLoopback("127.0.0.999")).toBe(false);
    expect(isLoopback("fe80::1")).toBe(false);
  });
});

type Api = typeof import("../api.js");
type MemoryTrialHookInjection = Pick<
  MemoryTrialHookRouteOptions,
  "enabled" | "circuitOpen" | "triggers" | "dispatch" | "operationStore"
>;
type JinnConfig = import("../../shared/config-types.js").JinnConfig;

function makeApiRes() {
  let status = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number, sent?: Record<string, string>) {
      status = code;
      Object.assign(headers, sent ?? {});
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    headers,
    get status() { return status; },
    get body() { return JSON.parse(Buffer.concat(chunks).toString("utf8")); },
  };
}

function makeHookReq(secret: string, body: unknown) {
  const raw = Buffer.from(JSON.stringify(body));
  const headers = {
    host: "localhost",
    "content-type": "application/json",
    "content-length": String(raw.byteLength),
    "x-jinn-hook-secret": secret,
  };
  return Object.assign(Readable.from([raw]), {
    method: "POST",
    url: "/api/internal/hook",
    headers,
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]),
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

function makeApiContext(
  hookRegistry: HookRegistry,
  memoryTrialHookRouteOptions?: MemoryTrialHookInjection,
  memoryTrial?: import("../../shared/config-types.js").JinnConfig["memoryTrial"],
  jinnHome = tmpHome,
): import("../api.js").ApiContext {
  const config = {
    gateway: {},
    sessions: {},
    connectors: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    ...(memoryTrial ? { memoryTrial } : {}),
  };
  return {
    config,
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    hookRegistry,
    hookSecret: "sek",
    emit: () => {},
    sessionManager: {
      getEngines: () => new Map(),
      getEngine: () => undefined,
      getQueue: () => ({
        clearQueue: () => {},
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
    jinnHome,
    memoryTrialHookRouteOptions,
  } as unknown as import("../api.js").ApiContext;
}

function makeApiContextWithConfig(
  hookRegistry: HookRegistry,
  config: JinnConfig,
  jinnHome = tmpHome,
): import("../api.js").ApiContext {
  return {
    config,
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    hookRegistry,
    hookSecret: "sek",
    emit: () => {},
    sessionManager: {
      getEngines: () => new Map(),
      getEngine: () => undefined,
      getQueue: () => ({
        clearQueue: () => {},
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
    jinnHome,
  } as unknown as import("../api.js").ApiContext;
}

describe("handleHookPost", () => {
  // Track every registry created in this suite so the sweep timer is always
  // disposed — otherwise vitest holds the event loop open between runs.
  const registries: HookRegistry[] = [];
  const makeReg = (): HookRegistry => {
    const r = new HookRegistry();
    registries.push(r);
    return r;
  };
  afterEach(() => {
    while (registries.length > 0) registries.pop()!.dispose();
  });

  it("rejects a wrong secret with 403", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "nope", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(403);
  });

  it("rejects a non-loopback remote with 403", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "10.0.0.5" },
      "sek", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(403);
  });

  it("accepts an IPv4-mapped loopback remote", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "::ffff:127.0.0.1" },
      "sek", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(200);
  });

  it("delivers a valid hook to the registry and returns 200", () => {
    const reg = makeReg();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek", { jinnSessionId: "s1", hook: { hook_event_name: "Stop", last_assistant_message: "hi" } });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Stop"]);
  });

  it("returns 400 for a malformed body", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" }, "sek", {});
    expect(res.status).toBe(400);
  });

  it("blocks dangerous Bash PreToolUse commands before delivery", () => {
    const reg = makeReg();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek", { jinnSessionId: "s1", hook: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } } });
    expect(res.status).toBe(451);
    expect(seen).toEqual([]);
  });

  it("returns 401 when the server secret is empty (defense-in-depth)", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "", remoteAddress: "127.0.0.1" },
      "", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(401);
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
