// packages/jinn/src/mcp/__tests__/engine-wiring.test.ts
/**
 * GRS-018 item 5 — the per-engine wiring seam for the GRS-017 default-on
 * decision (designed in parallel; NOT flipped here).
 *
 * One REAL resolver payload (mcp.gateway.enabled === true) is driven through
 * every MCP-capable engine's attach translation, pinning per engine:
 *   1. the jinn server reaches the engine's per-session attach artifact, and
 *   2. the engine's secret-channel contract holds:
 *        claude — temp-file JSON carries the spec verbatim (URL env only);
 *        codex  — argv `-c` overrides, allowlisted env only, NEVER the token;
 *        grok   — marker-guarded project TOML, allowlisted env only, NEVER
 *                 the token;
 *        hermes — in-memory ACP array; the ONLY channel that carries the
 *                 token (hermes filters inherited env for MCP subprocesses,
 *                 and the ACP stdin pipe never touches disk/argv).
 * And the OFF position: without the opt-in, every adapter produces a no-op —
 * so when GRS-017 flips the default, the only intended change is the
 * resolver's gate, and any adapter-level surprise fails one of these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile, MCP_CAPABLE_ENGINES } from "../resolver.js";
import { setJinnAttachGate } from "../attachment.js";
import {
  JINN_SESSION_CAPABILITY_ENV,
  JINN_WORKFLOW_ATTEMPT_ENV,
  attachSessionIdentity,
} from "../identity.js";
import { resolveMcpServerBootstrap } from "../server-bootstrap.js";
import { codexMcpConfigArgs, prepareCodexSessionHome } from "../../engines/codex.js";
import { prepareGrokProjectMcpConfig, cleanupGrokProjectMcpConfig, grokJinnSessionEnv, JINN_GROK_MCP_MARKER } from "../../engines/grok-mcp.js";
import { buildAcpMcpServers } from "../../engines/hermes-mcp.js";
import { writePiJinnMcpExtension, cleanupPiJinnMcpExtension, piJinnSessionEnv } from "../../engines/pi-mcp.js";
import {
  ensureAntigravityJinnMcpConfig,
  antigravityJinnSessionEnv,
  ANTIGRAVITY_JINN_MCP_MARKER,
} from "../../engines/antigravity-mcp.js";
import type { McpGlobalConfig } from "../../shared/types.js";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";

const GATEWAY_URL = "http://127.0.0.1:56789";
const TOKEN = "wiring-test-secret-token";
const ON: McpGlobalConfig = { browser: { enabled: false }, gateway: { enabled: true } } as McpGlobalConfig;
const OFF: McpGlobalConfig = { browser: { enabled: false } } as McpGlobalConfig;

let envBackup: Record<string, string | undefined>;
beforeEach(() => {
  envBackup = { JINN_GATEWAY_URL: process.env.JINN_GATEWAY_URL, JINN_GATEWAY_TOKEN: process.env.JINN_GATEWAY_TOKEN };
  process.env.JINN_GATEWAY_URL = GATEWAY_URL;
  process.env.JINN_GATEWAY_TOKEN = TOKEN;
  // GRS-017e-fix: the resolver only attaches jinn behind an armed-ok smoke
  // gate (unarmed fails closed); a booted gateway arms it, so wiring tests do.
  setJinnAttachGate({ ok: true });
});
afterEach(() => {
  setJinnAttachGate(null);
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("per-engine jinn-server wiring (GRS-018 seam for GRS-017 default-on)", () => {
  it("covers every MCP-capable engine (fails when the set grows without a wiring test here)", () => {
    // If a new engine joins MCP_CAPABLE_ENGINES, add its attach-artifact case
    // below and extend this list — the seam must stay complete.
    expect([...MCP_CAPABLE_ENGINES].sort()).toEqual(["antigravity", "claude", "codex", "grok", "hermes", "pi"]);
  });

  it("claude: temp-file JSON carries the jinn spec verbatim, non-secret env only, and cleans up", () => {
    const resolved = resolveMcpServers(ON, undefined);
    const p = writeMcpConfigFile(resolved, "wiring-claude");
    try {
      expectPosixMode(fs.statSync(p), 0o600);
      const onDisk = JSON.parse(fs.readFileSync(p, "utf-8"));
      expect(onDisk.mcpServers.jinn.command).toBeTruthy();
      // GRS-018 unified builtin env: URL + JINN_HOME (token-fallback hint) —
      // both non-secret; the bearer itself must never appear in the file.
      expect(onDisk.mcpServers.jinn.env.JINN_GATEWAY_URL).toBe(GATEWAY_URL);
      expect(typeof onDisk.mcpServers.jinn.env.JINN_HOME).toBe("string");
      expect(fs.readFileSync(p, "utf-8")).not.toContain(TOKEN);
    } finally {
      cleanupMcpConfigFile("wiring-claude");
    }
    expect(fs.existsSync(p)).toBe(false);
  });

  it("codex: -c argv overrides carry the jinn server with allowlisted env, NEVER the token", () => {
    const resolved = resolveMcpServers(ON, undefined);
    const args = codexMcpConfigArgs(resolved);
    const joined = args.join(" ");
    expect(joined).toContain("mcp_servers.jinn.command=");
    expect(joined).toContain(`JINN_GATEWAY_URL=${JSON.stringify(GATEWAY_URL)}`);
    expect(joined).not.toContain(TOKEN);
  });

  it("grok: marker-guarded project TOML carries the jinn server with allowlisted env, NEVER the token", () => {
    const resolved = resolveMcpServers(ON, undefined);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-grok-"));
    try {
      const handle = prepareGrokProjectMcpConfig(cwd, resolved);
      expect(handle.attached).toBe(true);
      if (handle.attached) {
        const toml = fs.readFileSync(handle.configPath, "utf-8");
        expect(toml.startsWith(JINN_GROK_MCP_MARKER)).toBe(true);
        expect(toml).toContain("[mcp_servers.jinn]");
        expect(toml).toContain(`JINN_GATEWAY_URL = ${JSON.stringify(GATEWAY_URL)}`);
        expect(toml).not.toContain(TOKEN);
        cleanupGrokProjectMcpConfig(handle);
        expect(fs.existsSync(handle.configPath)).toBe(false);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("hermes: ACP wire array carries the jinn server WITH the token (the one in-memory channel)", () => {
    const resolved = resolveMcpServers(ON, undefined);
    const wire = buildAcpMcpServers(resolved);
    const jinn = wire.find((s) => s.name === "jinn");
    expect(jinn).toBeDefined();
    expect(jinn!.env).toContainEqual({ name: "JINN_GATEWAY_URL", value: GATEWAY_URL });
    expect(jinn!.env).toContainEqual({ name: "JINN_GATEWAY_TOKEN", value: TOKEN });
  });

  // GRS-018 unified required-env model (GRS-017 QA critical 1): the builtin
  // jinn server needs URL + caller identity (JINN_SESSION_ID), the bound
  // per-session capability (JINN_SESSION_CAPABILITY), and a token path
  // (JINN_HOME → gateway.json fallback) to reach it under EVERY engine. This
  // block drives ONE identity-stamped payload (the exact shape manager.ts
  // threads) through each adapter and pins where each required key rides.
  describe("identity-stamped payload: JINN_SESSION_ID + capability + JINN_HOME reach the builtin per engine", () => {
    const SID = "sess-wiring-0123";
    const stamped = () => attachSessionIdentity(resolveMcpServers(ON, undefined), SID);
    const capabilityOf = (resolved: ReturnType<typeof stamped>) =>
      (resolved.mcpServers.jinn as { env?: Record<string, string> }).env?.[JINN_SESSION_CAPABILITY_ENV];

    it("claude: the per-session temp file carries the session id + capability (per-session file)", () => {
      const resolved = stamped();
      const capability = capabilityOf(resolved);
      const p = writeMcpConfigFile(resolved, "wiring-claude-sid");
      try {
        expectPosixMode(fs.statSync(p), 0o600);
        expect(path.basename(path.dirname(p))).toBe("wiring-claude-sid");
        const onDisk = JSON.parse(fs.readFileSync(p, "utf-8"));
        expect(onDisk.mcpServers.jinn.env.JINN_SESSION_ID).toBe(SID);
        expect(onDisk.mcpServers.jinn.env.JINN_SESSION_CAPABILITY).toBe(capability);
        const bootstrap = resolveMcpServerBootstrap(onDisk.mcpServers.jinn.args);
        expect(bootstrap).toMatchObject({
          callerSessionId: SID,
          sessionCapability: capability,
          gatewayUrl: GATEWAY_URL,
          jinnHome: expect.any(String),
        });
      } finally {
        cleanupMcpConfigFile("wiring-claude-sid");
      }
    });

    it("connector and web session launch paths both use the identity-stamping resolver", () => {
      const launchPaths = [
        new URL("../../sessions/manager.ts", import.meta.url),
        new URL("../../gateway/api.ts", import.meta.url),
      ];

      for (const sourceUrl of launchPaths) {
        const source = fs.readFileSync(sourceUrl, "utf-8");
        expect(source).toContain("resolveEngineRunMcp({");
        expect(source).toMatch(/sessionId:\s*(?:session|currentSession)\.id/);
        expect(source).toMatch(/engine\.run\(\{[\s\S]*?resolvedMcp,/);
      }
    });

    it("carries the workflow-attempt tool hint through per-session engine channels", () => {
      const resolved = attachSessionIdentity(resolveMcpServers(ON, undefined), SID, { workflowAttempt: true });
      const spec = resolved.mcpServers.jinn as { env?: Record<string, string> };
      expect(spec.env?.[JINN_WORKFLOW_ATTEMPT_ENV]).toBe("1");
      expect(grokJinnSessionEnv(resolved)[JINN_WORKFLOW_ATTEMPT_ENV]).toBe("1");
      expect(piJinnSessionEnv(resolved)[JINN_WORKFLOW_ATTEMPT_ENV]).toBe("1");
      expect(antigravityJinnSessionEnv(resolved)[JINN_WORKFLOW_ATTEMPT_ENV]).toBe("1");
      expect(buildAcpMcpServers(resolved).find((server) => server.name === "jinn")?.env)
        .toContainEqual({ name: JINN_WORKFLOW_ATTEMPT_ENV, value: "1" });
    });
    it("codex: argv never carries the capability; the per-session CODEX_HOME config.toml (0600) carries the bound jinn env", () => {
      const resolved = stamped();
      const capability = capabilityOf(resolved);
      const args = codexMcpConfigArgs(resolved);
      expect(args.join(" ")).not.toContain(String(capability));
      expect(args.join(" ")).not.toContain("JINN_SESSION_CAPABILITY");

      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-wiring-"));
      const home = prepareCodexSessionHome(resolved, SID, { baseDir });
      expect(home).toBeDefined();
      try {
        const cfgPath = path.join(home!.home, "config.toml");
        expectPosixMode(fs.statSync(cfgPath), 0o600);
        const toml = fs.readFileSync(cfgPath, "utf-8");
        expect(toml).toContain(`JINN_GATEWAY_URL = ${JSON.stringify(GATEWAY_URL)}`);
        expect(toml).toContain(`JINN_SESSION_ID = ${JSON.stringify(SID)}`);
        expect(toml).toContain(`JINN_SESSION_CAPABILITY = ${JSON.stringify(capability)}`);
        expect(toml).toContain("JINN_HOME = ");
        expect(toml).not.toContain(TOKEN);
      } finally {
        home?.cleanup();
      }
      expect(home && fs.existsSync(home.home)).toBe(false);
    });

    it("codex: the wider allowlist is a BUILTIN privilege — a third-party spec smuggling the same keys stays URL-only", () => {
      const sneaky = {
        mcpServers: {
          thirdparty: {
            command: "npx",
            args: [],
            env: { JINN_GATEWAY_URL: "http://x", JINN_SESSION_ID: "spoof", JINN_SESSION_CAPABILITY: "spoof-cap", JINN_HOME: "/tmp/x" },
          },
        },
      };
      const env = codexMcpConfigArgs(sneaky).find((a) => a.startsWith("mcp_servers.thirdparty.env="))!;
      expect(env).toContain("JINN_GATEWAY_URL=");
      expect(env).not.toContain("JINN_SESSION_ID");
      expect(env).not.toContain("JINN_SESSION_CAPABILITY");
      expect(env).not.toContain("JINN_HOME");
    });

    it("grok: the SHARED config stays byte-identical; identity + capability ride the child env instead", () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-grok-sid-"));
      try {
        const handle = prepareGrokProjectMcpConfig(cwd, stamped());
        expect(handle.attached).toBe(true);
        if (handle.attached) {
          const toml = fs.readFileSync(handle.configPath, "utf-8");
          expect(toml).not.toContain(SID);            // per-session value NEVER in the shared file
          expect(toml).toContain("JINN_HOME = ");     // process-global → byte-stable, allowed
          // A second concurrent session with a DIFFERENT id produces the same bytes.
          const other = prepareGrokProjectMcpConfig(cwd, attachSessionIdentity(resolveMcpServers(ON, undefined), "sess-other"));
          expect(other.attached).toBe(true);
          expect(fs.readFileSync(handle.configPath, "utf-8")).toBe(toml);
          cleanupGrokProjectMcpConfig(other);
          cleanupGrokProjectMcpConfig(handle);
        }
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
      // The child-env shim delivers the id (grok forwards full env to its MCP servers).
      const resolved = stamped();
      expect(grokJinnSessionEnv(resolved)).toEqual({
        JINN_SESSION_ID: SID,
        JINN_SESSION_CAPABILITY: capabilityOf(resolved),
      });
      expect(grokJinnSessionEnv(resolveMcpServers(ON, undefined))).toEqual({});
      expect(grokJinnSessionEnv(undefined)).toEqual({});
    });

    it("hermes: the ACP wire carries the session id + capability (full spec env passes through)", () => {
      const resolved = stamped();
      const wire = buildAcpMcpServers(resolved);
      const jinn = wire.find((s) => s.name === "jinn")!;
      expect(jinn.env).toContainEqual({ name: "JINN_SESSION_ID", value: SID });
      expect(jinn.env).toContainEqual({ name: "JINN_SESSION_CAPABILITY", value: capabilityOf(resolved) });
      expect(jinn.env.some((e) => e.name === "JINN_HOME")).toBe(true);
    });

    it("pi: a per-session extension file registers the jinn tools while identity rides the child env", () => {
      const resolved = stamped();
      const capability = capabilityOf(resolved);
      const handle = writePiJinnMcpExtension(resolved, SID);
      expect(handle.attached).toBe(true);
      try {
        if (!handle.attached) throw new Error("expected pi MCP extension to attach");
        expectPosixMode(fs.statSync(handle.extensionPath), 0o600);
        const source = fs.readFileSync(handle.extensionPath, "utf-8");
        expect(source).toContain("registerTool");
        expect(source).toContain("buildTools");
        expect(source).not.toContain(TOKEN);
        expect(source).not.toContain(SID);
        expect(source).not.toContain(String(capability));
      } finally {
        cleanupPiJinnMcpExtension(handle);
      }
      expect(handle.attached && fs.existsSync(handle.extensionPath)).toBe(false);
      expect(piJinnSessionEnv(resolved)).toEqual({
        JINN_SESSION_ID: SID,
        JINN_SESSION_CAPABILITY: capability,
      });
      expect(piJinnSessionEnv(resolveMcpServers(ON, undefined))).toEqual({});
      expect(piJinnSessionEnv(undefined)).toEqual({});
    });

    it("antigravity: guarded Gemini config carries only process-global jinn MCP data; identity rides the child env", () => {
      const resolved = stamped();
      const capability = capabilityOf(resolved);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-antigravity-"));
      const configPath = path.join(tmp, "mcp_config.json");
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { search: { command: "search-cli" } } }));
      try {
        const handle = ensureAntigravityJinnMcpConfig(resolved, { configPath });
        expect(handle.attached).toBe(true);
        const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        expect(json.mcpServers.search.command).toBe("search-cli");
        expect(json.mcpServers.jinn.command).toBeTruthy();
        expect(json.mcpServers.jinn.env.JINN_GATEWAY_URL).toBe(GATEWAY_URL);
        expect(json.mcpServers.jinn.env.JINN_MCP_MANAGED_BY).toBe(ANTIGRAVITY_JINN_MCP_MARKER);
        const onDisk = fs.readFileSync(configPath, "utf-8");
        expect(onDisk).not.toContain(TOKEN);
        expect(onDisk).not.toContain(SID);
        expect(onDisk).not.toContain(String(capability));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      expect(antigravityJinnSessionEnv(resolved)).toEqual({
        JINN_SESSION_ID: SID,
        JINN_SESSION_CAPABILITY: capability,
      });
      expect(antigravityJinnSessionEnv(resolveMcpServers(ON, undefined))).toEqual({});
      expect(antigravityJinnSessionEnv(undefined)).toEqual({});
    });
  });

  it("explicit kill switch keeps every adapter a no-op for jinn", () => {
    const resolved = resolveMcpServers({ ...OFF, gateway: { enabled: false } }, undefined);
    expect(resolved.mcpServers.jinn).toBeUndefined();

    // codex: no jinn override in argv.
    expect(codexMcpConfigArgs(resolved).join(" ")).not.toContain("mcp_servers.jinn");

    // grok: attach declines outright.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-grok-off-"));
    try {
      expect(prepareGrokProjectMcpConfig(cwd, resolved)).toEqual({ attached: false });
      expect(fs.existsSync(path.join(cwd, ".grok"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }

    // hermes: no jinn entry on the ACP wire (and thus no token anywhere).
    expect(buildAcpMcpServers(resolved).find((s) => s.name === "jinn")).toBeUndefined();

    // claude: the temp file simply carries no jinn server.
    const p = writeMcpConfigFile(resolved, "wiring-claude-off");
    try {
      expect(JSON.parse(fs.readFileSync(p, "utf-8")).mcpServers.jinn).toBeUndefined();
    } finally {
      cleanupMcpConfigFile("wiring-claude-off");
    }
  });
});
