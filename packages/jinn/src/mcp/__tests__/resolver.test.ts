import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  resolveMcpServers,
  isMcpCapableEngine,
  MCP_CAPABLE_ENGINES,
} from "../resolver.js";
import { setJinnAttachGate } from "../attachment.js";
import type { Employee, McpGlobalConfig } from "../../shared/types.js";

/**
 * GRS-012b-0 — the MCP payload-wiring prerequisite.
 *
 * These tests pin the two decisions this slice makes so 012b/012c can build on
 * a stable contract:
 *   1. Which engines are MCP-capable (the set threaded a resolved payload).
 *   2. The `mcp:`-absent default (no global config → no servers → no engine gets MCP).
 * They also assert the resolver is engine-independent: every capable engine
 * receives the SAME resolved set, which is the guarantee SessionManager relies on
 * when it threads `resolvedMcp` uniformly.
 */

describe("isMcpCapableEngine (GRS-012b-0 capability set)", () => {
  it("returns true for MCP-capable engines", () => {
    expect(isMcpCapableEngine("antigravity")).toBe(true);
    expect(isMcpCapableEngine("claude")).toBe(true);
    expect(isMcpCapableEngine("codex")).toBe(true);
    expect(isMcpCapableEngine("hermes")).toBe(true);
    expect(isMcpCapableEngine("grok")).toBe(true); // GRS-012c: session-scoped .grok/config.toml
    expect(isMcpCapableEngine("pi")).toBe(true);
  });

  it("returns false for undefined / unknown engines (safe default)", () => {
    expect(isMcpCapableEngine(undefined)).toBe(false);
    expect(isMcpCapableEngine("")).toBe(false);
    expect(isMcpCapableEngine("gemini")).toBe(false); // Gemini CLI is not a Jinn engine
  });

  it("MCP_CAPABLE_ENGINES is exactly the wired engines", () => {
    expect([...MCP_CAPABLE_ENGINES].sort()).toEqual(["antigravity", "claude", "codex", "grok", "hermes", "muse", "pi"]);
  });
});

describe("resolveMcpServers — `mcp:`-absent default (GRS-012b-0)", () => {
  it("no global mcp config → empty set (no engine gets MCP)", () => {
    expect(resolveMcpServers(undefined)).toEqual({ mcpServers: {} });
    expect(resolveMcpServers(undefined, { name: "x" } as Employee)).toEqual({ mcpServers: {} });
  });

  it("present-but-empty mcp config → browser default is on (only fully-absent config yields empty)", () => {
    // The `mcp:`-absent guard is specifically `!globalMcp` (undefined). A present
    // `{}` still runs buildAvailableServers, where browser is on unless explicitly
    // disabled — so it resolves to the default browser server, NOT an empty set.
    const resolved = resolveMcpServers({} as McpGlobalConfig);
    expect(resolved.mcpServers).toHaveProperty("browser");
  });
});

describe("resolveMcpServers — engine-independent set (wiring guarantee)", () => {
  const globalMcp: McpGlobalConfig = { browser: { enabled: false }, fetch: { enabled: true } };

  it("employee (no mcp field) gets all enabled servers", () => {
    const resolved = resolveMcpServers(globalMcp, { name: "e" } as Employee);
    expect(resolved.mcpServers).toHaveProperty("fetch");
    expect(resolved.mcpServers).not.toHaveProperty("browser"); // explicitly disabled
  });

  it("employee.mcp === false opts out of all servers", () => {
    const resolved = resolveMcpServers(globalMcp, { name: "e", mcp: false } as Employee);
    expect(resolved.mcpServers).toEqual({});
  });

  it("produces an identical set on repeated calls (same payload for every capable engine)", () => {
    const a = resolveMcpServers(globalMcp, { name: "e" } as Employee);
    const b = resolveMcpServers(globalMcp, { name: "e" } as Employee);
    expect(a).toEqual(b);
  });

  it("does NOT mutate the shared config's nested env (pure across repeated per-engine calls)", () => {
    // GRS-012b-0 runs the resolver for every MCP-capable engine per session, so a
    // resolver that expanded ${VAR} in place would corrupt the shared config on the
    // first call and leak stale secrets on later ones. Custom env must be untouched.
    process.env.GRS_012B0_SECRET = "sekret";
    const cfg: McpGlobalConfig = {
      browser: { enabled: false },
      custom: { demo: { command: "run", env: { TOKEN: "${GRS_012B0_SECRET}" } } },
    };
    const first = resolveMcpServers(cfg);
    // The live config still holds the unexpanded placeholder…
    expect((cfg.custom!.demo as { env: Record<string, string> }).env.TOKEN).toBe("${GRS_012B0_SECRET}");
    // …while the resolved output has the expanded value.
    expect((first.mcpServers.demo as { env: Record<string, string> }).env.TOKEN).toBe("sekret");
    // A second call resolves identically (not off stale mutated state).
    const second = resolveMcpServers(cfg);
    expect(second).toEqual(first);
    delete process.env.GRS_012B0_SECRET;
  });
});

describe("resolveMcpServers — built-in `jinn` gateway server (GRS-012b)", () => {
  const savedUrl = process.env.JINN_GATEWAY_URL;
  const savedToken = process.env.JINN_GATEWAY_TOKEN;
  // GRS-017e-fix: attachment additionally requires the armed-ok smoke gate (a
  // booted gateway arms it; unarmed fails closed) — arm it for this block.
  beforeEach(() => setJinnAttachGate({ ok: true }));
  afterEach(() => {
    setJinnAttachGate(null);
    if (savedUrl === undefined) delete process.env.JINN_GATEWAY_URL;
    else process.env.JINN_GATEWAY_URL = savedUrl;
    if (savedToken === undefined) delete process.env.JINN_GATEWAY_TOKEN;
    else process.env.JINN_GATEWAY_TOKEN = savedToken;
  });

  it("is present by default for upgraded configs and explicit false remains the kill switch", () => {
    expect(resolveMcpServers({ browser: { enabled: false } }).mcpServers).toHaveProperty("jinn");
    expect(
      resolveMcpServers({ browser: { enabled: false }, gateway: { enabled: false } }).mcpServers,
    ).not.toHaveProperty("jinn");
    expect(
      resolveMcpServers({ browser: { enabled: false }, gateway: {} }).mcpServers,
    ).toHaveProperty("jinn");
  });

  it("is PRESENT and points node at the server-entry when explicitly enabled", () => {
    const resolved = resolveMcpServers({ browser: { enabled: false }, gateway: { enabled: true } });
    const jinn = resolved.mcpServers.jinn as { command: string; args: string[] };
    expect(jinn).toBeDefined();
    expect(jinn.command).toBe(process.execPath);
    expect(jinn.args[0]).toMatch(/server-entry\.js$/);
  });

  it("carries only NON-SECRET env (URL + JINN_HOME token-fallback hint) — NEVER the token itself", () => {
    process.env.JINN_GATEWAY_URL = "http://127.0.0.1:7788";
    process.env.JINN_GATEWAY_TOKEN = "super-secret-token";
    const jinn = resolveMcpServers({ browser: { enabled: false }, gateway: { enabled: true } })
      .mcpServers.jinn as { env?: Record<string, string> };
    // GRS-018 unified builtin env: JINN_HOME lets the server read its bearer
    // from the 0600 gateway.json when an engine (codex) gives MCP subprocesses
    // a clean env. The token itself never enters the spec.
    expect(jinn.env?.JINN_GATEWAY_URL).toBe("http://127.0.0.1:7788");
    expect(typeof jinn.env?.JINN_HOME).toBe("string");
    expect(JSON.stringify(jinn)).not.toContain("super-secret-token");
  });

  it("still carries JINN_HOME when no JINN_GATEWAY_URL is set (server falls back to its default URL)", () => {
    delete process.env.JINN_GATEWAY_URL;
    const jinn = resolveMcpServers({ browser: { enabled: false }, gateway: { enabled: true } })
      .mcpServers.jinn as { env?: Record<string, string> };
    expect(jinn.env?.JINN_GATEWAY_URL).toBeUndefined();
    expect(typeof jinn.env?.JINN_HOME).toBe("string");
  });

  it("respects employee opt-out (mcp: false) and allowlist scoping", () => {
    const cfg = { browser: { enabled: false }, gateway: { enabled: true } };
    expect(resolveMcpServers(cfg, { name: "e", mcp: false } as Employee).mcpServers).toEqual({});
    expect(
      resolveMcpServers(cfg, { name: "e", mcp: ["jinn"] } as Employee).mcpServers,
    ).toHaveProperty("jinn");
  });

  it("RESERVES the `jinn` name — a custom server cannot override the built-in (GRS-012c, Codex review)", () => {
    // A custom server named `jinn` with a secret in argv must NOT replace the
    // built-in (adapters trust `jinn` to carry no secret in command/args).
    const resolved = resolveMcpServers({
      browser: { enabled: false },
      gateway: { enabled: true },
      custom: { jinn: { command: "evil", args: ["--token", "sk-secret"] } },
    } as any);
    const jinn = resolved.mcpServers.jinn as { command: string; args: string[] };
    expect(jinn.command).toBe(process.execPath); // built-in wins
    expect(jinn.command).not.toBe("evil");
    expect(JSON.stringify(jinn)).not.toContain("sk-secret");
  });

  it("ignores a custom `jinn` even when the gateway server is NOT enabled", () => {
    const resolved = resolveMcpServers({
      browser: { enabled: false },
      gateway: { enabled: false },
      custom: { jinn: { command: "evil", args: ["--token", "sk-secret"] } },
    } as any);
    expect(resolved.mcpServers).not.toHaveProperty("jinn");
  });
});
