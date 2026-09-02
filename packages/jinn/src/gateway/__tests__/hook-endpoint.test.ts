import { describe, it, expect, afterEach } from "vitest";
import { handleHookPost, isLoopback } from "../hook-endpoint.js";
import { HookRegistry } from "../hook-registry.js";

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
});
