import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnConfig } from "../../shared/types.js";

/**
 * The API fixture the ICI-733 route tests share: a throwaway JINN_HOME holding
 * one employee and two skills, and a `call` that drives `handleApiRequest`
 * directly instead of over a socket.
 *
 * JINN_HOME is set as this module is evaluated, so every test file that uses it
 * must import it BEFORE anything that reads the home — which is why the gateway
 * modules below are imported dynamically, from `startRouteHarness`.
 */

export const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-dispatch-config-route-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "route-worker.yaml"),
  [
    "name: route-worker",
    "displayName: Route Worker",
    "department: platform",
    "rank: employee",
    "engine: codex",
    "model: gpt-5.6-sol",
    "persona: Completes bounded route work",
    "",
  ].join("\n"),
);

export const skillsDir = path.join(home, "skills");
for (const name of ["dev-workflow", "browser-use"]) {
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
}

type Api = typeof import("../api.js");
export type Registry = typeof import("../../sessions/registry.js");
export type WorkItems = typeof import("../../work-items/store.js");

let api: Api;

const engineStub = {
  name: "stub",
  // Every dispatched session hangs, so a started attempt stays inspectable.
  run: async () => new Promise(() => {}),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};

/** Engines this harness should report as missing, so a route's "engine not
 *  available" refusal can be driven without a real engine registry. Cleared by
 *  the test that sets it. */
export const unavailableEngines = new Set<string>();

const queueStub = {
  enqueue: async (_key: string, fn: () => Promise<void>) => fn(),
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

export function config(): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: {
      default: "codex",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high" },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: false }, { id: "sonnet", supportsEffort: false }] },
      codex: {
        default: "gpt-5.6-sol",
        models: [
          { id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "gpt-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    mcp: { gateway: { enabled: true } },
  } as unknown as JinnConfig;
}

const context = {
  getConfig: config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  reloadOrg: () => {},
  sessionManager: {
    getEngine: (name: string) => (unavailableEngines.has(name) ? undefined : engineStub),
    getEngines: () => new Map(),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) { status = nextStatus; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

export async function call(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const request = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json", ...headers },
    },
  );
  const captured = makeResponse();
  await api.handleApiRequest(
    request as unknown as Parameters<Api["handleApiRequest"]>[0],
    captured.res,
    context,
  );
  return { status: captured.status, body: captured.body };
}

export async function startRouteHarness(): Promise<{ registry: Registry; workItems: WorkItems }> {
  // shared/paths.js freezes JINN_HOME at import. If a test file imported
  // anything that reaches it BEFORE this module — shared/logger.js is the easy
  // mistake — then the home set above never took, and the whole file runs
  // against vitest's run-wide home: one SQLite registry shared with every other
  // suite in the run, which silently turns a session-count assertion into a race
  // against unrelated tests. Fail here, naming the cause, rather than flake there.
  const paths = await import("../../shared/paths.js");
  if (paths.JINN_HOME !== home) {
    throw new Error(
      `todo-route-harness: JINN_HOME was frozen to ${paths.JINN_HOME} before this harness could set ${home}. `
      + "Import ./todo-route-harness.js before any module that reads the home.",
    );
  }
  api = await import("../api.js");
  const registry = await import("../../sessions/registry.js");
  const workItems = await import("../../work-items/store.js");
  (await import("../../shared/db.js")).initDb();
  (await import("../../mcp/attachment.js")).setJinnAttachGate({ ok: true });
  return { registry, workItems };
}

export async function stopRouteHarness(): Promise<void> {
  (await import("../../mcp/attachment.js")).setJinnAttachGate(null);
}

/** Authenticate a request as one of the harness's spawned engine sessions. */
export async function sessionToolHeaders(sessionId: string): Promise<Record<string, string>> {
  const identity = await import("../../mcp/identity.js");
  return {
    [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
    [identity.CALLER_SESSION_HEADER]: sessionId,
    [identity.CALLER_SESSION_CAPABILITY_HEADER]: identity.ensureSessionCapability(sessionId),
  };
}

/** The prompt the attempt actually received. */
export function firstUserMessage(registry: Registry, sessionId: string): string {
  return registry.getMessages(sessionId).find((message) => message.role === "user")?.content ?? "";
}
