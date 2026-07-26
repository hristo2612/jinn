import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";

const KEY_RELATIVE_PATH = path.join("secrets", "mcp-session-capability.key");

describe("restart-stable MCP session capability authority", () => {
  let home: string;
  let keyFile: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-capability-"));
    keyFile = path.join(home, KEY_RELATIVE_PATH);
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("keeps an attached session authorized after a simulated gateway restart", async () => {
    const first = await import("../identity.js");
    const capability = first.ensureSessionCapability("session-a", keyFile);
    expect(first.verifySessionCapability("session-a", capability, keyFile)).toBe(true);

    vi.resetModules();
    const restarted = await import("../identity.js");
    const { resolveCallerIdentity } = await import("../../gateway/session-comm-guards.js");

    expect(restarted.verifySessionCapability("session-a", capability, keyFile)).toBe(true);
    expect(resolveCallerIdentity({
      [restarted.TOOL_CALL_HEADER]: restarted.TOOL_CALL_HEADER_VALUE,
      [restarted.CALLER_SESSION_HEADER]: "session-a",
      [restarted.CALLER_SESSION_CAPABILITY_HEADER]: capability,
    }, {
      sessionExists: (sessionId) => sessionId === "session-a",
      verifySessionCapability: (sessionId, proof) => restarted.verifySessionCapability(sessionId, proof, keyFile),
      requireCapability: true,
      operatorAuthenticated: false,
    })).toEqual({ kind: "session", callerId: "session-a" });
  });

  it("keeps capabilities session-scoped and fails closed for absent or invalid proof", async () => {
    const identity = await import("../identity.js");
    const { resolveCallerIdentity } = await import("../../gateway/session-comm-guards.js");
    const capabilityA = identity.ensureSessionCapability("session-a", keyFile);
    const capabilityB = identity.ensureSessionCapability("session-b", keyFile);

    expect(identity.verifySessionCapability("session-b", capabilityA, keyFile)).toBe(false);
    expect(identity.verifySessionCapability("session-a", capabilityB, keyFile)).toBe(false);
    expect(identity.verifySessionCapability("session-a", "", keyFile)).toBe(false);
    expect(identity.verifySessionCapability("session-a", "x".repeat(43), keyFile)).toBe(false);

    const options = {
      sessionExists: (sessionId: string) => sessionId === "session-a",
      verifySessionCapability: (sessionId: string, proof: string) => identity.verifySessionCapability(sessionId, proof, keyFile),
      requireCapability: true,
      operatorAuthenticated: false,
    };
    expect(resolveCallerIdentity({
      [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
      [identity.CALLER_SESSION_HEADER]: "session-a",
    }, options)).toEqual({ kind: "unidentified-tool" });
    expect(resolveCallerIdentity({
      [identity.TOOL_CALL_HEADER]: identity.TOOL_CALL_HEADER_VALUE,
      [identity.CALLER_SESSION_HEADER]: "deleted-session",
      [identity.CALLER_SESSION_CAPABILITY_HEADER]: capabilityA,
    }, options)).toEqual({ kind: "unidentified-tool" });
  });

  it("accepts only the exact canonical capability encoding", async () => {
    const identity = await import("../identity.js");
    const capability = identity.ensureSessionCapability("session-a", keyFile);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalIndex = alphabet.indexOf(capability.at(-1)!);
    const alternateFinalIndex = (finalIndex & ~0b11) | ((finalIndex + 1) & 0b11);
    const alternate = `${capability.slice(0, -1)}${alphabet[alternateFinalIndex]}`;

    expect(alternate).not.toBe(capability);
    expect(Buffer.from(alternate, "base64url")).toEqual(Buffer.from(capability, "base64url"));
    expect(identity.verifySessionCapability("session-a", capability, keyFile)).toBe(true);
    expect(identity.verifySessionCapability("session-a", alternate, keyFile)).toBe(false);
  });

  it("derives deterministic opaque proof from an owner-only per-instance key", async () => {
    const first = await import("../identity.js");
    const sessionId = "stable-session-identity";
    const capability = first.ensureSessionCapability(sessionId, keyFile);
    expect(first.ensureSessionCapability(sessionId, keyFile)).toBe(capability);

    vi.resetModules();
    const restarted = await import("../identity.js");
    expect(restarted.ensureSessionCapability(sessionId, keyFile)).toBe(capability);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(capability).not.toContain(sessionId);

    expectPosixMode(fs.statSync(keyFile), 0o600);

    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-capability-other-"));
    try {
      vi.resetModules();
      const otherInstance = await import("../identity.js");
      expect(otherInstance.ensureSessionCapability(sessionId, path.join(otherHome, KEY_RELATIVE_PATH))).not.toBe(capability);
    } finally {
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  });
});
