import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import {
  authCookieHeaders,
  authCookieName,
  authDeviceCookieName,
  authenticateGatewayRequest,
  authRequiredForRequest,
  clearAuthCookieHeader,
  createAuthSession,
  consumeLocalBootstrapGrant,
  consumePairingCode,
  createAuthState,
  createFilePairingCodeStore,
  createPairingCode,
  ensureGatewayAuthToken,
  listAuthSessions,
  isLoopbackHost,
  isNetworkHost,
  matchesGatewayAuthToken,
  issuePairingCode,
  issueLocalBootstrapGrant,
  normalizePairingCode,
  revokeAuthSession,
  shouldRequireGatewayAuth,
  validateGatewayExposure,
  verifyAuthSession,
} from "../auth.js";

function req(headers: Record<string, string | undefined>, remoteAddress = "127.0.0.1") {
  return { headers, socket: { remoteAddress } } as any;
}

describe("gateway auth", () => {
  it("creates a persistent token under the supplied JINN_HOME with owner-only permissions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-auth-"));
    const first = ensureGatewayAuthToken(home);
    const second = ensureGatewayAuthToken(home);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);

    const tokenFile = path.join(home, "gateway.json");
    expectPosixMode(tokenFile, 0o600);
    expect(JSON.parse(fs.readFileSync(tokenFile, "utf-8")).token).toBe(first);
  });

  it("accepts bearer auth and revocable browser sessions without accepting legacy raw-token cookies", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-auth-cookie-"));
    const session = createAuthSession(home, req({ "user-agent": "Mozilla/5.0" }, "100.64.1.2"));
    const scheme = "Bear" + "er";
    expect(authenticateGatewayRequest(req({ authorization: `${scheme} tok` }), "tok").ok).toBe(true);
    expect(authenticateGatewayRequest(req({ cookie: `theme=dark; jinn_auth=${session.secret}; jinn_device=${session.device.id}` }), "tok", home).ok).toBe(true);
    expect(authenticateGatewayRequest(req({ cookie: "theme=dark; jinn_auth=tok" }), "tok", home).ok).toBe(false);
    expect(authenticateGatewayRequest(req({ authorization: `${scheme} wrong`, cookie: "jinn_auth=wrong" }), "tok").ok).toBe(false);
  });

  it("leaves proof-based pairing routes to route-local auth", () => {
    expect(authRequiredForRequest("POST", "/api/internal/hook")).toBe(false);
    expect(authRequiredForRequest("GET", "/api/internal/hook")).toBe(true);
    expect(authRequiredForRequest("POST", "/api/auth/pairing-challenges")).toBe(false);
    expect(authRequiredForRequest("GET", "/api/auth/pairing-challenges")).toBe(true);
    expect(authRequiredForRequest("POST", "/api/auth/pairing-codes")).toBe(false);
    expect(authRequiredForRequest("GET", "/api/auth/pairing-codes")).toBe(true);
  });

  it("requires auth for remote/network exposure but not default loopback unless explicitly enabled", () => {
    expect(isLoopbackHost("localhost:7777")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:7777")).toBe(true);
    expect(isLoopbackHost("[::1]:7777")).toBe(true);
    expect(isLoopbackHost("100.95.1.62:7777")).toBe(false);
    expect(shouldRequireGatewayAuth({ gateway: { host: "127.0.0.1" } } as any)).toBe(false);
    expect(shouldRequireGatewayAuth({ gateway: { host: "0.0.0.0" } } as any)).toBe(true);
    expect(shouldRequireGatewayAuth({ gateway: { host: "192.168.1.10" } } as any)).toBe(true);
    expect(shouldRequireGatewayAuth({ gateway: { host: "127.0.0.1", authRequired: true } } as any)).toBe(true);
  });

  it("refuses unauthenticated network binds unless the explicit insecure escape hatch is set", () => {
    expect(isNetworkHost("0.0.0.0")).toBe(true);
    expect(validateGatewayExposure({ gateway: { host: "127.0.0.1", authRequired: true } } as any).ok).toBe(true);
    expect(validateGatewayExposure({ gateway: { host: "0.0.0.0", authRequired: true } } as any).ok).toBe(true);
    expect(validateGatewayExposure({ gateway: { host: "0.0.0.0", authDisabled: true } } as any).ok).toBe(false);
    expect(validateGatewayExposure({ gateway: { host: "0.0.0.0", authDisabled: true, insecureAllowUnauthenticatedNetwork: true } } as any).ok).toBe(true);
  });

  it("reports safe auth state for local, remote, and already-paired browsers", () => {
    const config = { gateway: { host: "0.0.0.0" } } as any;
    expect(createAuthState(config, req({}, "127.0.0.1"), "tok")).toMatchObject({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: true,
      networkExposed: true,
    });
    expect(createAuthState(config, req({ host: "100.95.1.62:7777" }, "127.0.0.1"), "tok")).toMatchObject({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: false,
      networkExposed: true,
    });
    expect(createAuthState(config, req({}, "100.64.1.2"), "tok")).toMatchObject({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: false,
      networkExposed: true,
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-auth-state-"));
    const session = createAuthSession(home, req({ "user-agent": "Mozilla/5.0" }, "100.64.1.2"));
    expect(createAuthState(config, req({ cookie: `jinn_auth=${session.secret}; jinn_device=${session.device.id}` }, "100.64.1.2"), "tok", home)).toMatchObject({
      authRequired: true,
      authenticated: true,
      canBootstrapLocal: false,
      networkExposed: true,
    });
  });

  it("creates single-use normalized pairing codes without storing the raw code", () => {
    const store = new Map<string, { expiresAt: number }>();
    const issued = issuePairingCode(store, 1_000, () => "ABCD-EFGH-JKLM");

    expect(issued.code).toBe("ABCD-EFGH-JKLM");
    expect(issued.expiresAt).toBe(301_000);
    expect(store.size).toBe(1);
    expect([...store.keys()][0]).not.toContain("ABCD");

    expect(normalizePairingCode("abcd efgh-jklm")).toBe("ABCDEFGHJKLM");
    expect(consumePairingCode(store, "abcd efgh jklm", 2_000)).toBe(true);
    expect(consumePairingCode(store, "ABCD-EFGH-JKLM", 2_001)).toBe(false);
  });

  it("namespaces auth cookies per instance so same-host gateways don't clobber each other", () => {
    // Cookies ignore port, so two instances on one host must use distinct names.
    const jinnHome = path.join(os.homedir(), ".jinn");
    const yorioHome = path.join(os.homedir(), ".jinn-yorio");

    // Default instance keeps the bare names (no forced re-pair on upgrade).
    expect(authCookieName(jinnHome)).toBe("jinn_auth");
    expect(authDeviceCookieName(jinnHome)).toBe("jinn_device");

    // A second instance gets its own namespace and cannot collide with the default.
    expect(authCookieName(yorioHome)).toBe("jinn_auth_jinn-yorio");
    expect(authDeviceCookieName(yorioHome)).toBe("jinn_device_jinn-yorio");
    expect(authCookieName(yorioHome)).not.toBe(authCookieName(jinnHome));

    // Ad-hoc/test homes (no leading-dot instance name) stay on the bare names.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-cookie-ns-"));
    expect(authCookieName(tmp)).toBe("jinn_auth");

    // Emitted Set-Cookie headers carry the namespaced name for a second instance.
    const headers = authCookieHeaders("secret-value", "device-value", yorioHome);
    expect(headers[0]).toContain("jinn_auth_jinn-yorio=");
    expect(headers[1]).toContain("jinn_device_jinn-yorio=");
  });

  it("persists pairing codes under JINN_HOME so they survive a gateway restart", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pairing-store-"));

    // Mint against one store instance...
    const issued = issuePairingCode(createFilePairingCodeStore(home), 1_000, () => "ABCD-EFGH-JKLM");
    expect(issued.code).toBe("ABCD-EFGH-JKLM");

    // ...only hashes hit disk, never the raw code.
    const onDisk = fs.readFileSync(path.join(home, "pairing-codes.json"), "utf-8");
    expect(onDisk).not.toContain("ABCD");

    // A fresh store (as after a restart) still redeems it, and it stays single-use.
    expect(consumePairingCode(createFilePairingCodeStore(home), "abcd-efgh-jklm", 2_000)).toBe(true);
    expect(consumePairingCode(createFilePairingCodeStore(home), "ABCD-EFGH-JKLM", 2_001)).toBe(false);
  });

  it("expires persisted pairing codes past their TTL", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pairing-store-ttl-"));
    const issued = issuePairingCode(createFilePairingCodeStore(home), 1_000, () => "WXYZ-2345-6789");
    expect(consumePairingCode(createFilePairingCodeStore(home), issued.code, issued.expiresAt + 1)).toBe(false);
  });

  it("creates short-lived single-use local bootstrap grants without storing the raw grant", () => {
    const store = new Map<string, { expiresAt: number }>();
    const grant = issueLocalBootstrapGrant(store, 1_000, () => "test-launch-grant-long");

    expect(grant).toBe("test-launch-grant-long");
    expect([...store.keys()]).not.toContain(grant);
    expect(consumeLocalBootstrapGrant(grant, store, 1_001)).toBe(true);
    expect(consumeLocalBootstrapGrant(grant, store, 1_002)).toBe(false);

    const expired = issueLocalBootstrapGrant(store, 2_000, () => "test-expired-grant-long");
    expect(consumeLocalBootstrapGrant(expired, store, 2_000 + 60_001)).toBe(false);
  });

  it("rejects expired pairing codes and keeps gateway token fallback timing-safe", () => {
    const store = new Map<string, { expiresAt: number }>();
    const issued = issuePairingCode(store, 1_000, () => "WXYZ-2345-6789");

    expect(consumePairingCode(store, issued.code, issued.expiresAt + 1)).toBe(false);
    expect(matchesGatewayAuthToken("tok", "tok")).toBe(true);
    expect(matchesGatewayAuthToken("wrong", "tok")).toBe(false);
    expect(clearAuthCookieHeader()).toContain("Max-Age=0");
  });

  it("generates browser-friendly pairing codes", () => {
    const code = createPairingCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01OI]/);
  });

  it("creates revocable browser auth sessions without storing raw secrets", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-auth-devices-"));
    const created = createAuthSession(home, req({ "user-agent": "Mozilla/5.0 Mac OS X" }, "100.64.1.2"), {
      name: "Remote browser",
      now: 1_000,
    });

    expect(created.secret).toHaveLength(43);
    expect(verifyAuthSession(home, created.device.id, created.secret)).toBe(true);

    const file = path.join(home, "auth-devices.json");
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain(created.secret);
    expect(JSON.parse(raw).devices[0]).toMatchObject({
      id: created.device.id,
      name: "Remote browser",
      createdAt: "1970-01-01T00:00:01.000Z",
    });

    const listed = listAuthSessions(home, created.device.id);
    expect(listed).toEqual([
      expect.objectContaining({
        id: created.device.id,
        name: "Remote browser",
        current: true,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");

    revokeAuthSession(home, created.device.id);
    expect(verifyAuthSession(home, created.device.id, created.secret)).toBe(false);
  });

  it("keeps repeated local bootstrap sessions separately revocable", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-auth-local-devices-"));
    const first = createAuthSession(home, req({ "user-agent": "Mozilla/5.0 Macintosh Chrome" }, "127.0.0.1"), {
      kind: "local",
      now: 1_000,
    });
    const second = createAuthSession(home, req({ "user-agent": "Mozilla/5.0 Macintosh Chrome" }, "127.0.0.1"), {
      kind: "local",
      now: 2_000,
    });

    expect(first.device.id).toMatch(/^d_/);
    expect(second.device.id).toMatch(/^d_/);
    expect(second.device.id).not.toBe(first.device.id);
    expect(verifyAuthSession(home, first.device.id, first.secret)).toBe(true);
    expect(verifyAuthSession(home, second.device.id, second.secret)).toBe(true);
    expect(listAuthSessions(home)).toHaveLength(2);
  });

  it("removes stale automation browser sessions without merging real browsers", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-auth-automation-devices-"));
    const automated = createAuthSession(home, req({ "user-agent": "Mozilla/5.0 HeadlessChrome/149.0.0.0" }), {
      kind: "local",
      now: 1_000,
    });
    const human = createAuthSession(home, req({ "user-agent": "Mozilla/5.0 Macintosh Chrome/149.0.0.0" }), {
      kind: "local",
      now: 1_000,
    });

    const listed = listAuthSessions(home, undefined, 60 * 60 * 1000 + 1_001);

    expect(listed.map((device) => device.id)).toEqual([human.device.id]);
    expect(verifyAuthSession(home, automated.device.id, automated.secret)).toBe(false);
    expect(verifyAuthSession(home, human.device.id, human.secret)).toBe(true);
  });
});
