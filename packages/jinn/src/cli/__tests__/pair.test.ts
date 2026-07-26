import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import {
  formatPairedDevices,
  formatPairingInstructions,
  requestPairedDevices,
  requestPairingCode,
  requestUnpairDevice,
} from "../pair.js";

describe("pair CLI helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("completes a loopback filesystem challenge without sending bearer auth", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pair-cli-"));
    const challengeId = "challenge-id-1234567890";
    const nonce = "nonce-value-1234567890";
    const challengePath = path.join(home, `pair-challenge-${challengeId}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/auth/pairing-challenges")) {
        return new Response(JSON.stringify({
          challengeId,
          nonce,
          path: challengePath,
          expiresAt: "2026-07-14T20:00:10.000Z",
          ttlSeconds: 10,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      expect(url).toBe("http://127.0.0.1:7777/api/auth/pairing-codes");
      expect(JSON.parse(String(init?.body))).toEqual({ challengeId });
      expect(fs.readFileSync(challengePath, "utf-8")).toBe(nonce);
      expectPosixMode(fs.statSync(challengePath), 0o600);
      return new Response(JSON.stringify({
        status: "ok",
        code: "ABCD-EFGH-JKLM",
        expiresAt: "2026-07-14T20:05:00.000Z",
        ttlSeconds: 300,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await requestPairingCode({
      port: 7777,
      jinnHome: home,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.code).toBe("ABCD-EFGH-JKLM");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
    expect(fs.existsSync(challengePath)).toBe(false);
  });

  it("cleans up its proof file on failure and refuses a server path outside JINN_HOME", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-pair-cli-failure-"));
    const challengeId = "challenge-id-failure0001";
    const challengePath = path.join(home, `pair-challenge-${challengeId}`);
    const failingFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        challengeId,
        nonce: "nonce-value-failure0001",
        path: challengePath,
        expiresAt: "2026-07-14T20:00:10.000Z",
        ttlSeconds: 10,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "challenge rejected" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }));

    await expect(requestPairingCode({
      port: 7777,
      jinnHome: home,
      fetchImpl: failingFetch as unknown as typeof fetch,
    })).rejects.toThrow("challenge rejected");
    expect(fs.existsSync(challengePath)).toBe(false);

    const outside = path.join(os.tmpdir(), `pair-challenge-${challengeId}`);
    const outsideFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      challengeId,
      nonce: "nonce-value-failure0001",
      path: outside,
      expiresAt: "2026-07-14T20:00:10.000Z",
      ttlSeconds: 10,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(requestPairingCode({
      port: 7777,
      jinnHome: home,
      fetchImpl: outsideFetch as unknown as typeof fetch,
    })).rejects.toThrow(/outside JINN_HOME/i);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("prints the usable pairing code and browser instructions", () => {
    const text = formatPairingInstructions({
      code: "ABCD-EFGH-JKLM",
      expiresAt: "2026-07-14T20:05:00.000Z",
      ttlSeconds: 300,
    }, 7777);

    expect(text).toContain("ABCD-EFGH-JKLM");
    expect(text).toContain("Open Jinn on the other device");
    expect(text).toContain("5 minutes");
    expect(text).not.toContain("gateway-token");
  });

  it("labels the target instance so multi-instance operators pick the right one", () => {
    const forDefault = formatPairingInstructions(
      { code: "ABCD-EFGH-JKLM", expiresAt: "2026-07-14T20:05:00.000Z", ttlSeconds: 300 },
      7777,
    );
    expect(forDefault).toContain("Instance: jinn (port 7777)");

    const forYorio = formatPairingInstructions(
      { code: "WAMP-EYJL-TEV3", expiresAt: "2026-07-14T20:05:00.000Z", ttlSeconds: 300 },
      7801,
      "jinn-yorio",
    );
    expect(forYorio).toContain("Instance: jinn-yorio (port 7801)");
  });

  it("lists paired devices from the local gateway auth endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        devices: [
          { id: "device-1", name: "This Mac", current: true, lastSeenAt: "2026-06-24T10:00:00.000Z" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const devices = await requestPairedDevices({
      port: 7777,
      host: "::1",
      token: "gateway-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(devices).toEqual([
      expect.objectContaining({ id: "device-1", name: "This Mac", current: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://[::1]:7777/api/auth/devices",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("unpairs a device through the shared device delete endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", current: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await requestUnpairDevice({
      port: 7777,
      token: "gateway-token",
      deviceId: "device-2",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7777/api/auth/devices/device-2",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("prints unpair instructions without leaking the gateway token", () => {
    const text = formatPairedDevices([
      { id: "device-1", name: "This Mac", current: true, lastSeenAt: "2026-06-24T10:00:00.000Z" },
      { id: "-device-2", name: "iPhone browser", current: false, lastSeenAt: "2026-06-24T10:05:00.000Z" },
    ]);

    expect(text).toContain("Paired browsers");
    expect(text).toContain("This Mac");
    expect(text).toContain("iPhone browser");
    expect(text).toContain("jinn unpair -- -device-2");
    expect(formatPairedDevices([])).toContain("Create a code with jinn pair");
    expect(text).not.toContain("gateway-token");
  });
});
