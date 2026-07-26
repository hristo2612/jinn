import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest, type ApiContext } from "../api.js";
import { requestPairingCode } from "../../cli/pair.js";
import { enforceOwnerOnlyDirectory } from "../../shared/owner-only.js";
import {
  createAuthSession,
  issueLocalBootstrapGrant,
  LOCAL_BOOTSTRAP_GRANT_HEADER,
} from "../auth.js";

function makeReq(
  method: string,
  url: string,
  opts: { body?: unknown; cookie?: string; remoteAddress?: string; userAgent?: string; authorization?: string; host?: string; bootstrapGrant?: string } = {},
): IncomingMessage {
  const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: opts.host ?? "localhost",
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.userAgent ? { "user-agent": opts.userAgent } : {}),
    ...(opts.authorization ? { authorization: opts.authorization } : {}),
    ...(opts.bootstrapGrant ? { [LOCAL_BOOTSTRAP_GRANT_HEADER]: opts.bootstrapGrant } : {}),
  };
  (req as any).socket = { remoteAddress: opts.remoteAddress ?? "127.0.0.1" };
  return req;
}

function makeRes() {
  let status = 200;
  let chunks: Buffer[] = [];
  const headers = new Map<string, unknown>();
  const res = {
    setHeader(name: string, value: unknown) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead(s: number, h?: Record<string, unknown>) {
      status = s;
      if (h) for (const [key, value] of Object.entries(h)) headers.set(key.toLowerCase(), value);
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get header() {
      return (name: string) => headers.get(name.toLowerCase());
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

/** The loopback pairing proof requires a home only this account can reach.
 *  mkdtemp gives that on POSIX (0700) but not on Windows, where a temp
 *  directory inherits whatever %TEMP% grants. Establish it either way. */
function ownerOnlyTempHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  enforceOwnerOnlyDirectory(home);
  return home;
}

function ctx(jinnHome = ownerOnlyTempHome("jinn-auth-api-")): ApiContext {
  return {
    gatewayAuthToken: "gateway-token",
    jinnHome,
    getConfig: () => ({ gateway: { host: "0.0.0.0" }, engines: { default: "claude" } }),
    connectors: new Map(),
    startTime: Date.now(),
  } as unknown as ApiContext;
}

function browserCookie(jinnHome: string, remoteAddress = "127.0.0.1"): string {
  const session = createAuthSession(
    jinnHome,
    { headers: { "user-agent": "Mozilla/5.0" }, socket: { remoteAddress } } as any,
    { kind: remoteAddress === "127.0.0.1" ? "local" : "remote" },
  );
  return `jinn_auth=${session.secret}; jinn_device=${session.device.id}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth UX API routes", () => {
  it("reports safe auth state without exposing the token", async () => {
    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/auth/state", { remoteAddress: "100.64.1.2" }), cap.res, ctx());

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: false,
      networkExposed: true,
    });
    expect(JSON.stringify(cap.body)).not.toContain("gateway-token");
  });

  it("auto-pairs a local browser by exchanging the CLI launch grant for revocable cookies", async () => {
    const context = ctx();
    const bootstrapped = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        bootstrapGrant: issueLocalBootstrapGrant(),
        remoteAddress: "127.0.0.1",
        host: "localhost:7777",
        userAgent: "Mozilla/5.0 Macintosh",
        body: {},
      }),
      bootstrapped.res,
      context,
    );

    expect(bootstrapped.status).toBe(200);
    expect(bootstrapped.body).toMatchObject({ status: "ok", authRequired: true });
    const setCookies = bootstrapped.header("set-cookie") as string[];
    expect(setCookies).toHaveLength(2);
    expect(setCookies.every((cookie) => cookie.includes("HttpOnly"))).toBe(true);

    const cookie = setCookies.map((part) => part.split(";", 1)[0]).join("; ");
    const state = makeRes();
    await handleApiRequest(
      makeReq("GET", "/api/auth/state", {
        cookie,
        remoteAddress: "127.0.0.1",
        host: "localhost:7777",
      }),
      state.res,
      context,
    );

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ authRequired: true, authenticated: true });
  });

  it("creates a loopback-only pairing code for an authenticated local browser", async () => {
    const context = ctx();
    const cap = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        cookie: browserCookie((context as any).jinnHome),
        remoteAddress: "127.0.0.1",
        body: {},
      }),
      cap.res,
      context,
    );

    expect(cap.status).toBe(200);
    expect(cap.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(cap.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(cap.body)).not.toContain("gateway-token");
  });

  it("mints a pairing code after one valid loopback filesystem challenge", async () => {
    const context = ctx();
    const created = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-challenges", { body: {} }),
      created.res,
      context,
    );

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      challengeId: expect.any(String),
      nonce: expect.any(String),
      path: expect.any(String),
      ttlSeconds: 10,
    });
    expect(created.body.path).toBe(path.join((context as any).jinnHome, `pair-challenge-${created.body.challengeId}`));
    fs.writeFileSync(created.body.path, created.body.nonce, { mode: 0o600 });
    fs.chmodSync(created.body.path, 0o600);

    const minted = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", { body: { challengeId: created.body.challengeId } }),
      minted.res,
      context,
    );
    expect(minted.status).toBe(200);
    expect(minted.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(fs.existsSync(created.body.path)).toBe(false);

    const replay = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", { body: { challengeId: created.body.challengeId } }),
      replay.res,
      context,
    );
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBeUndefined();
  });

  it("rejects bearer-only pairing-code creation", async () => {
    const context = ctx();
    const bearer = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        authorization: "Bearer gateway-token",
        body: {},
      }),
      bearer.res,
      context,
    );

    expect(bearer.status).toBe(403);
    expect(bearer.body.code).toBeUndefined();

    const unauthenticated = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", { body: {} }),
      unauthenticated.res,
      context,
    );
    expect(unauthenticated.status).toBe(403);
    expect(unauthenticated.body.code).toBeUndefined();
  });

  it("rejects non-loopback challenge issuance and redemption", async () => {
    const context = ctx();
    const remote = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-challenges", {
        remoteAddress: "100.64.1.2",
        host: "localhost:7777",
        body: {},
      }),
      remote.res,
      context,
    );
    expect(remote.status).toBe(403);

    const proxied = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-challenges", {
        remoteAddress: "127.0.0.1",
        host: "tailnet.example.ts.net",
        body: {},
      }),
      proxied.res,
      context,
    );
    expect(proxied.status).toBe(403);

    const local = makeRes();
    await handleApiRequest(makeReq("POST", "/api/auth/pairing-challenges", { body: {} }), local.res, context);
    fs.writeFileSync(local.body.path, local.body.nonce, { mode: 0o600 });
    const remoteMint = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        remoteAddress: "100.64.1.2",
        host: "localhost:7777",
        body: { challengeId: local.body.challengeId },
      }),
      remoteMint.res,
      context,
    );
    expect(remoteMint.status).toBe(403);
    expect(remoteMint.body.code).toBeUndefined();

    const proxiedMint = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        remoteAddress: "127.0.0.1",
        host: "tailnet.example.ts.net",
        body: { challengeId: local.body.challengeId },
      }),
      proxiedMint.res,
      context,
    );
    expect(proxiedMint.status).toBe(403);
    expect(proxiedMint.body.code).toBeUndefined();
    fs.rmSync(local.body.path, { force: true });
  });

  it("rejects expired and mismatched challenge proofs as terminal", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const context = ctx();
    const expired = makeRes();
    await handleApiRequest(makeReq("POST", "/api/auth/pairing-challenges", { body: {} }), expired.res, context);
    fs.writeFileSync(expired.body.path, expired.body.nonce, { mode: 0o600 });

    now.mockReturnValue(11_001);
    const expiredMint = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", { body: { challengeId: expired.body.challengeId } }),
      expiredMint.res,
      context,
    );
    expect(expiredMint.status).toBe(403);
    expect(fs.existsSync(expired.body.path)).toBe(false);

    now.mockReturnValue(20_000);
    const mismatch = makeRes();
    await handleApiRequest(makeReq("POST", "/api/auth/pairing-challenges", { body: {} }), mismatch.res, context);
    fs.writeFileSync(mismatch.body.path, "wrong nonce", { mode: 0o600 });
    const mismatchMint = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", { body: { challengeId: mismatch.body.challengeId } }),
      mismatchMint.res,
      context,
    );
    expect(mismatchMint.status).toBe(403);
    expect(fs.existsSync(mismatch.body.path)).toBe(false);

    fs.writeFileSync(mismatch.body.path, mismatch.body.nonce, { mode: 0o600 });
    const retried = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", { body: { challengeId: mismatch.body.challengeId } }),
      retried.res,
      context,
    );
    expect(retried.status).toBe(403);
    fs.rmSync(mismatch.body.path, { force: true });
  });

  it("keeps the CLI request sequence aligned with the real route contract", async () => {
    const context = ctx();
    const requests: Array<{ pathname: string; authorization: string | null }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({ pathname: url.pathname, authorization: headers.get("authorization") });
      const rawBody = init?.body === undefined ? undefined : String(init.body);
      const cap = makeRes();
      await handleApiRequest(
        makeReq(init?.method ?? "GET", url.pathname, {
          body: rawBody ? JSON.parse(rawBody) : undefined,
          authorization: headers.get("authorization") ?? undefined,
          host: url.host,
          remoteAddress: "127.0.0.1",
        }),
        cap.res,
        context,
      );
      return new Response(JSON.stringify(cap.body), {
        status: cap.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const pairing = await requestPairingCode({
      port: 7777,
      jinnHome: (context as any).jinnHome,
      fetchImpl,
    });

    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(requests).toEqual([
      { pathname: "/api/auth/pairing-challenges", authorization: null },
      { pathname: "/api/auth/pairing-codes", authorization: null },
    ]);
  });

  it("rejects remote and proxied local bootstrap without setting cookies", async () => {
    const remote = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        remoteAddress: "100.64.1.2",
        host: "100.64.1.10:7777",
        body: {},
      }),
      remote.res,
      ctx(),
    );

    expect(remote.status).toBe(403);
    expect(remote.header("set-cookie")).toBeUndefined();

    const proxied = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        remoteAddress: "127.0.0.1",
        host: "tailnet.example.ts.net",
        body: {},
      }),
      proxied.res,
      ctx(),
    );

    expect(proxied.status).toBe(403);
    expect(proxied.header("set-cookie")).toBeUndefined();
  });

  it("rejects remote pairing-code creation", async () => {
    const context = ctx();
    const cap = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        cookie: browserCookie((context as any).jinnHome, "100.64.1.2"),
        remoteAddress: "100.64.1.2",
        body: {},
      }),
      cap.res,
      context,
    );

    expect(cap.status).toBe(403);
  });

  it("pairs a remote browser with a one-time code and sets the auth cookie", async () => {
    const context = ctx();
    const created = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        cookie: browserCookie((context as any).jinnHome),
        body: {},
      }),
      created.res,
      context,
    );

    const paired = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pair", {
        remoteAddress: "100.64.1.2",
        body: { code: created.body.code },
      }),
      paired.res,
      context,
    );

    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ status: "ok" });
    expect(String(paired.header("set-cookie"))).toContain("jinn_auth=");
    expect(String(paired.header("set-cookie"))).toContain("jinn_device=");
    expect(String(paired.header("set-cookie"))).toContain("HttpOnly");

    const reused = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pair", {
        remoteAddress: "100.64.1.2",
        body: { code: created.body.code },
      }),
      reused.res,
      context,
    );
    expect(reused.status).toBe(401);
  });

  it("rejects oversized public auth bodies before parsing", async () => {
    const cap = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pair", {
        remoteAddress: "100.64.1.2",
        body: { code: "A".repeat(20_000) },
      }),
      cap.res,
      ctx(),
    );

    expect(cap.status).toBe(413);
  });

  it("lists paired devices without exposing secrets", async () => {
    const context = ctx();
    const created = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        bootstrapGrant: issueLocalBootstrapGrant(),
        remoteAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0 Macintosh",
        body: {},
      }),
      created.res,
      context,
    );
    const cookie = Array.isArray(created.header("set-cookie"))
      ? created.header("set-cookie")
      : [created.header("set-cookie")];
    const cookieHeader = (cookie as string[]).map((part) => part.split(";")[0]).join("; ");

    const listed = makeRes();
    await handleApiRequest(makeReq("GET", "/api/auth/devices", { cookie: cookieHeader }), listed.res, context);

    expect(listed.status).toBe(200);
    expect(listed.body.devices).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        current: true,
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("gateway-token");
    expect(JSON.stringify(listed.body)).not.toContain("tokenHash");
  });

  it("revokes paired devices by id and clears cookies when revoking the current device", async () => {
    const context = ctx();
    const local = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/bootstrap", {
        bootstrapGrant: issueLocalBootstrapGrant(),
        remoteAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0 Macintosh",
        body: {},
      }),
      local.res,
      context,
    );
    const localCookies = Array.isArray(local.header("set-cookie"))
      ? local.header("set-cookie")
      : [local.header("set-cookie")];
    const localCookieHeader = (localCookies as string[]).map((part) => part.split(";")[0]).join("; ");

    const pairingCode = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pairing-codes", {
        cookie: localCookieHeader,
        remoteAddress: "127.0.0.1",
        body: {},
      }),
      pairingCode.res,
      context,
    );

    const remote = makeRes();
    await handleApiRequest(
      makeReq("POST", "/api/auth/pair", {
        remoteAddress: "100.64.1.2",
        userAgent: "Mozilla/5.0 iPhone",
        body: { code: pairingCode.body.code },
      }),
      remote.res,
      context,
    );

    const remoteDeviceId = remote.body.device.id;
    const revokedRemote = makeRes();
    await handleApiRequest(
      makeReq("DELETE", `/api/auth/devices/${encodeURIComponent(remoteDeviceId)}`, {
        authorization: "Bearer gateway-token",
      }),
      revokedRemote.res,
      context,
    );

    expect(revokedRemote.status).toBe(200);
    expect(revokedRemote.body).toMatchObject({ status: "ok", current: false });

    const listed = makeRes();
    await handleApiRequest(
      makeReq("GET", "/api/auth/devices", { authorization: "Bearer gateway-token" }),
      listed.res,
      context,
    );
    expect((listed.body.devices as Array<{ id: string }>).map((device) => device.id)).not.toContain(remoteDeviceId);

    const localDeviceId = local.body.device.id;
    const revokedCurrent = makeRes();
    await handleApiRequest(
      makeReq("DELETE", `/api/auth/devices/${encodeURIComponent(localDeviceId)}`, {
        cookie: localCookieHeader,
      }),
      revokedCurrent.res,
      context,
    );

    expect(revokedCurrent.status).toBe(200);
    expect(revokedCurrent.body).toMatchObject({ status: "ok", current: true });
    expect(String(revokedCurrent.header("set-cookie"))).toContain("Max-Age=0");
    expect(String(revokedCurrent.header("set-cookie"))).toContain("jinn_device=");
  });

  it("clears auth and device cookies on logout", async () => {
    const cap = makeRes();
    await handleApiRequest(makeReq("POST", "/api/auth/logout", { body: {} }), cap.res, ctx());

    expect(cap.status).toBe(200);
    expect(String(cap.header("set-cookie"))).toContain("Max-Age=0");
    expect(String(cap.header("set-cookie"))).toContain("jinn_device=");
  });
});
