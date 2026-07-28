import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir } from "../../shared/test-support/temp-dir.js";
import type { AddressInfo } from "node:net";
import type { JinnConfig } from "../../shared/types.js";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-browser-operator-auth-"));
process.env.JINN_HOME = testHome;

fs.writeFileSync(
  path.join(testHome, "config.yaml"),
  `gateway:
  host: 127.0.0.1
engines:
  default: codex
  codex: {}
portal:
  portalName: Portal
  setupComplete: true
`,
);
fs.mkdirSync(path.join(testHome, "org"), { recursive: true });
fs.writeFileSync(
  path.join(testHome, "org", "operator.yaml"),
  "name: operator\ndisplayName: Operator\ndepartment: company\nrank: executive\nengine: codex\nmodel: default\npersona: Runs the organization.\n",
);

type Api = typeof import("../api.js");

let api: Api;
let server: http.Server;
let baseUrl: string;
let viteProxy: http.Server;
let viteBaseUrl: string;
let config: JinnConfig;
let lastRequestHeaders: http.IncomingHttpHeaders = {};
let handlerRejections = 0;
let registry: typeof import("../../sessions/registry.js");

const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "gateway-token",
  jinnHome: testHome,
  sessionManager: {
    getEngine: () => undefined,
    getEngines: () => new Map(),
    getQueue: () => ({
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
      clearQueue: () => undefined,
    }),
  },
  emit: () => undefined,
} as unknown as import("../api.js").ApiContext;

async function needsAttention(headers: HeadersInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/work-items?needsAttentionFor=me&limit=10`, { headers });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function needsAttentionViaRawHttp(headers: http.OutgoingHttpHeaders): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL("/api/work-items?needsAttentionFor=me&limit=10", baseUrl);
  return await new Promise((resolve, reject) => {
    const request = http.request(target, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function needsAttentionViaRawSocket(headerLines: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(baseUrl);
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(target.port) });
    const chunks: Buffer[] = [];
    socket.once("connect", () => {
      socket.write([
        "GET /api/work-items?needsAttentionFor=me&limit=10 HTTP/1.1",
        ...headerLines,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const [head, payload = ""] = raw.split("\r\n\r\n", 2);
      const status = Number.parseInt(head?.split("\r\n", 1)[0]?.split(" ")[1] ?? "0", 10);
      const bodyText = /\r\ntransfer-encoding:\s*chunked\r\n/i.test(`\r\n${head}\r\n`)
        ? decodeChunkedBody(payload)
        : payload;
      resolve({ status, body: JSON.parse(bodyText) as Record<string, unknown> });
    });
  });
}

function decodeChunkedBody(payload: string): string {
  let offset = 0;
  let decoded = "";
  while (offset < payload.length) {
    const lineEnd = payload.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(payload.slice(offset, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    decoded += payload.slice(start, start + size);
    offset = start + size + 2;
  }
  return decoded;
}

function sameOriginFetchHeaders(): Record<string, string> {
  return {
    accept: "*/*",
    referer: `${baseUrl}/todos`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36",
  };
}

function viteBrowserHeaders(method: "GET" | "POST", origin = viteBaseUrl): Record<string, string> {
  return {
    accept: "application/json",
    referer: `${viteBaseUrl}/workflows`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36",
    ...(method === "POST" ? { "content-type": "application/json", origin } : {}),
  };
}

async function stopViaViteProxy(sessionId: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${viteBaseUrl}/api/sessions/${sessionId}/stop`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

async function createSessionViaHttp(headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ prompt: "Verify scoped-write authorization" }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  registry.initDb();
  config = {
    gateway: { host: "127.0.0.1", authDisabled: true },
    engines: { default: "codex", codex: {}, claude: {} },
  } as JinnConfig;

  server = http.createServer((req, res) => {
    lastRequestHeaders = req.headers;
    void api.handleApiRequest(req, res, context).catch((error: unknown) => {
      handlerRejections += 1;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // Minimal real-network model of Vite's configured changeOrigin proxy: the
  // gateway-facing Host is rewritten, browser Origin/Referer are preserved,
  // and no Forwarded/X-Forwarded headers are added.
  viteProxy = http.createServer((req, res) => {
    const target = new URL(req.url || "/", baseUrl);
    const upstream = http.request(target, {
      method: req.method,
      headers: { ...req.headers, host: new URL(baseUrl).host },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", (error) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    viteProxy.once("error", reject);
    viteProxy.listen(0, "127.0.0.1", resolve);
  });
  viteBaseUrl = `http://127.0.0.1:${(viteProxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => viteProxy.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  // Close the database before removing its directory: Windows refuses to unlink
  // a file with an open handle, so the sqlite connection has to go first.
  registry.__closeDbForTest();
  removeTempDir(testHome);
});

describe("browser operator authorization", () => {
  it("recognizes an Origin-less same-origin browser fetch when gateway auth is disabled", async () => {
    const result = await needsAttention(sameOriginFetchHeaders());

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ workItems: [], total: 0, nextOffset: null });
    expect(lastRequestHeaders).toMatchObject({
      host: new URL(baseUrl).host,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    });
    expect(lastRequestHeaders.origin).toBeUndefined();
  });

  it.each([
    ["Forwarded", { forwarded: "for=198.51.100.20;host=portal.example;proto=https" }],
    ["Via", { via: "1.1 proxy.example" }],
    ["X-Forwarded-For", { "x-forwarded-for": "198.51.100.20" }],
    ["X-Forwarded-Host", { "x-forwarded-host": "portal.example" }],
    ["X-Forwarded-Port", { "x-forwarded-port": "443" }],
    ["X-Forwarded-Proto", { "x-forwarded-proto": "https" }],
    ["X-Real-IP", { "x-real-ip": "198.51.100.20" }],
  ])("rejects an external reverse-proxy-shaped Origin-less request carrying %s even when Host was rewritten to the loopback listener", async (_label, forwardedHeaders) => {
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      ...forwardedHeaders,
    });

    expect(result.status).toBe(403);
  });

  it("diagnoses a proxied scoped write when gateway auth is not configured", async () => {
    const result = await createSessionViaHttp({
      ...sameOriginFetchHeaders(),
      "x-forwarded-for": "198.51.100.20",
      "x-forwarded-host": "portal.example",
      "x-forwarded-proto": "https",
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/operator authentication failed/i);
    expect(result.body.error).toMatch(/forwarded headers present/i);
    expect(result.body.error).toMatch(/gateway has no auth configured/i);
    expect(result.body.error).toMatch(/gateway\.authRequired: true/i);
    expect(result.body.error).toMatch(/pair your device/i);
    expect(result.body.error).not.toMatch(/JINN_SESSION_ID|JINN_SESSION_CAPABILITY/);
  });

  it("keeps the MCP identity-loss diagnosis for a forwarded tool-marked scoped write", async () => {
    const result = await createSessionViaHttp({
      ...sameOriginFetchHeaders(),
      "x-forwarded-for": "198.51.100.20",
      "x-jinn-tool-call": "jinn-mcp",
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/caller identity unavailable/i);
    expect(result.body.error).toMatch(/JINN_SESSION_ID/);
    expect(result.body.error).toMatch(/JINN_SESSION_CAPABILITY/);
    expect(result.body.error).not.toMatch(/gateway has no auth configured/i);
  });

  it.each([
    ["missing Fetch Metadata", {}],
    ["missing Fetch site", { "sec-fetch-mode": "cors" }],
    ["missing Fetch mode", { "sec-fetch-site": "same-origin" }],
    ["missing Fetch destination", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }],
    ["cross-site Fetch Metadata", { origin: "https://attacker.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }],
    ["navigation mode", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" }],
  ])("rejects an unauthenticated Origin-less or non-same-origin client with %s", async (_label, headers) => {
    const result = await needsAttentionViaRawHttp(headers);

    expect(result.status).toBe(403);
  });

  it("rejects same-origin metadata paired with a spoofed Host", async () => {
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      host: "attacker.example",
    });

    expect(result.status).toBe(403);
  });

  it("rejects a DNS-rebinding-style Host that embeds a loopback address", async () => {
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      host: "127.0.0.1.attacker.example",
    });

    expect(result.status).toBe(403);
  });

  it("rejects inconsistent Origin and Host even when Fetch Metadata claims same-origin", async () => {
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      host: "attacker.example",
      origin: baseUrl,
    });

    expect(result.status).toBe(403);
  });

  it("rejects a same-origin Origin paired with navigation metadata", async () => {
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      origin: baseUrl,
      "sec-fetch-mode": "navigate",
    });

    expect(result.status).toBe(403);
  });

  it("rejects a loopback Host whose port is not the actual listener port", async () => {
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      host: "127.0.0.1:1",
    });

    expect(result.status).toBe(403);
  });

  it("rejects a loopback literal that does not match the actual listener address", async () => {
    const target = new URL(baseUrl);
    const result = await needsAttentionViaRawHttp({
      ...sameOriginFetchHeaders(),
      host: `127.0.0.2:${target.port}`,
    });

    expect(result.status).toBe(403);
  });

  it("rejects duplicate Host authorities instead of accepting the first", async () => {
    const target = new URL(baseUrl);
    const result = await needsAttentionViaRawSocket([
      `Host: ${target.host}`,
      "Host: attacker.example",
      "Sec-Fetch-Dest: empty",
      "Sec-Fetch-Mode: cors",
      "Sec-Fetch-Site: same-origin",
    ]);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid request authority" });
  });

  it("rejects duplicate browser metadata instead of accepting the first value", async () => {
    const target = new URL(baseUrl);
    const result = await needsAttentionViaRawSocket([
      `Host: ${target.host}`,
      "Sec-Fetch-Dest: empty",
      "Sec-Fetch-Mode: cors",
      "Sec-Fetch-Site: same-origin",
      "Sec-Fetch-Site: cross-site",
    ]);

    expect(result.status).toBe(403);
  });

  it("rejects malformed Host without throwing through the handler or reflecting the authority", async () => {
    const rejectionsBefore = handlerRejections;
    const result = await needsAttentionViaRawSocket([
      "Host: [private.internal",
      "Sec-Fetch-Dest: empty",
      "Sec-Fetch-Mode: cors",
      "Sec-Fetch-Site: same-origin",
    ]);

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid request authority" });
    expect(JSON.stringify(result.body)).not.toContain("private.internal");
    expect(handlerRejections).toBe(rejectionsBefore);

    const followUp = await needsAttention(sameOriginFetchHeaders());
    expect(followUp.status).toBe(200);
  });

  it("does not treat Fetch Metadata as operator authentication when gateway auth is enabled", async () => {
    config = { ...config, gateway: { host: "127.0.0.1", authRequired: true } } as JinnConfig;
    try {
      const result = await needsAttention(sameOriginFetchHeaders());
      expect(result.status).toBe(403);
    } finally {
      config = { ...config, gateway: { host: "127.0.0.1", authDisabled: true } } as JinnConfig;
    }
  });

  it("preserves credentialed API access without browser Fetch Metadata", async () => {
    config = { ...config, gateway: { host: "127.0.0.1", authRequired: true } } as JinnConfig;
    try {
      const result = await needsAttention({ authorization: "Bearer gateway-token", "user-agent": "api-client/1.0" });
      expect(result.status).toBe(200);
    } finally {
      config = { ...config, gateway: { host: "127.0.0.1", authDisabled: true } } as JinnConfig;
    }
  });

  it("recognizes an auth-disabled browser mutation through the real Vite proxy shape", async () => {
    const session = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "vite-browser-stop",
      title: "Vite browser stop",
    });
    registry.updateSession(session.id, { status: "running" });

    const response = await stopViaViteProxy(session.id, viteBrowserHeaders("POST"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "stopped", sessionId: session.id });
    expect(registry.getSession(session.id)?.status).toBe("interrupted");
    expect(lastRequestHeaders).toMatchObject({
      host: new URL(baseUrl).host,
      origin: viteBaseUrl,
      referer: `${viteBaseUrl}/workflows`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    });
    expect(lastRequestHeaders["x-forwarded-for"]).toBeUndefined();
  });

  it("keeps cross-origin, forged, and forwarded Vite-shaped mutations fail-closed with zero session effects", async () => {
    const session = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "forged-vite-browser-stop",
      title: "Forged Vite browser stop",
    });
    registry.updateSession(session.id, { status: "running" });

    const response = await stopViaViteProxy(
      session.id,
      viteBrowserHeaders("POST", "https://attacker.example"),
    );

    expect(response.status).toBe(403);
    expect(registry.getSession(session.id)?.status).toBe("running");

    const forgedLoopbackOrigin = await stopViaViteProxy(
      session.id,
      viteBrowserHeaders("POST", "http://127.0.0.1:1"),
    );
    expect(forgedLoopbackOrigin.status).toBe(403);
    expect(registry.getSession(session.id)?.status).toBe("running");

    const forwarded = await stopViaViteProxy(session.id, {
      ...viteBrowserHeaders("POST"),
      "x-forwarded-for": "127.0.0.1",
    });
    expect(forwarded.status).toBe(403);
    expect(registry.getSession(session.id)?.status).toBe("running");
  });

  it("keeps auth-enabled Vite browser mutations credential-bound", async () => {
    config = { ...config, gateway: { host: "127.0.0.1", authRequired: true } } as JinnConfig;
    try {
      const denied = registry.createSession({
        engine: "codex",
        source: "web",
        sourceRef: "auth-enabled-vite-denied",
        title: "Auth enabled denied",
      });
      registry.updateSession(denied.id, { status: "running" });
      expect((await stopViaViteProxy(denied.id, viteBrowserHeaders("POST"))).status).toBe(403);
      expect(registry.getSession(denied.id)?.status).toBe("running");

      const allowed = registry.createSession({
        engine: "codex",
        source: "web",
        sourceRef: "auth-enabled-vite-token",
        title: "Auth enabled token",
      });
      registry.updateSession(allowed.id, { status: "running" });
      const response = await stopViaViteProxy(allowed.id, {
        ...viteBrowserHeaders("POST"),
        authorization: "Bearer gateway-token",
      });
      expect(response.status).toBe(200);
      expect(registry.getSession(allowed.id)?.status).toBe("interrupted");
    } finally {
      config = { ...config, gateway: { host: "127.0.0.1", authDisabled: true } } as JinnConfig;
    }
  });
});
