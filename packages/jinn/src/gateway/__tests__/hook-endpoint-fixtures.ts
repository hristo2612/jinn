import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

import { HookRegistry } from "../hook-registry.js";

type Api = typeof import("../api.js");
import type { MemoryTrialHookRouteOptions } from "../../memory-trial/hook-adapter.js";

/** One disposable JINN_HOME for every suite that posts a hook. */
export const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-hook-endpoint-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });

export type MemoryTrialHookInjection = Pick<
  MemoryTrialHookRouteOptions,
  "enabled" | "circuitOpen" | "triggers" | "dispatch" | "operationStore"
>;
type JinnConfig = import("../../shared/config-types.js").JinnConfig;

export function makeApiRes() {
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

export function makeHookReq(secret: string, body: unknown) {
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

export function makeApiContext(
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

export function makeApiContextWithConfig(
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
