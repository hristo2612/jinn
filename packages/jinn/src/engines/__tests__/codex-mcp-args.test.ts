import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codexMcpConfigArgs,
  prepareCodexSessionHome,
  removeCodexSessionHome,
  buildCodexFreshArgs,
  buildCodexResumeArgs,
  codexChildEnv,
  realCodexHome,
} from "../codex.js";
import type { ResolvedMcpConfig, EngineRunOpts } from "../../shared/types.js";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";

const CAPABILITY = "cap-SUPER-SECRET-do-not-leak-123";

/** A resolved-MCP payload with the builtin jinn server carrying a capability. */
function jinnResolvedWithCapability(capability = CAPABILITY): ResolvedMcpConfig {
  return {
    mcpServers: {
      jinn: {
        command: "/usr/bin/node",
        args: ["/abs/dist/src/mcp/server-entry.js"],
        env: {
          JINN_GATEWAY_URL: "http://127.0.0.1:7801",
          JINN_SESSION_ID: "sess-1",
          JINN_HOME: "/home/u/.jinn",
          JINN_SESSION_CAPABILITY: capability,
        },
      },
    },
  };
}

function baseOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { sessionId: "sess-1", prompt: "hi", ...over } as EngineRunOpts;
}

/**
 * GRS-012b — Codex is the first non-Claude consumer of the wave-30 `resolvedMcp`
 * payload. These tests pin the `-c mcp_servers.*` overrides the adapter emits so a
 * spawned `codex exec` attaches the jinn server per-session without touching the
 * operator's global ~/.codex/config.toml — and, critically, that NO secret is
 * serialized into argv.
 */

describe("codexMcpConfigArgs", () => {
  it("emits nothing when there is no resolved MCP config", () => {
    expect(codexMcpConfigArgs(undefined)).toEqual([]);
    expect(codexMcpConfigArgs({ mcpServers: {} })).toEqual([]);
  });

  it("emits command + args -c overrides for a stdio server", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: { command: "/usr/bin/node", args: ["/abs/dist/src/mcp/server-entry.js"] },
      },
    };
    const args = codexMcpConfigArgs(resolved);
    expect(args).toEqual([
      "-c",
      'mcp_servers.jinn.command="/usr/bin/node"',
      "-c",
      'mcp_servers.jinn.args=["/abs/dist/src/mcp/server-entry.js"]',
    ]);
  });

  it("emits the non-secret env as a TOML inline table when present", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: {
          command: "/usr/bin/node",
          args: ["/abs/entry.js"],
          env: { JINN_GATEWAY_URL: "http://127.0.0.1:7788" },
        },
      },
    };
    const args = codexMcpConfigArgs(resolved);
    expect(args).toContain("-c");
    expect(args).toContain('mcp_servers.jinn.env={JINN_GATEWAY_URL="http://127.0.0.1:7788"}');
  });

  it("DROPS non-allowlisted (secret) env keys from argv — only JINN_GATEWAY_URL is emitted", () => {
    // A custom/search server whose env carries a resolved secret must NOT leak it
    // into the world-readable process argv; only the non-secret gateway URL passes.
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        search: {
          command: "npx",
          args: ["-y", "brave-search-mcp"],
          env: { BRAVE_API_KEY: "sk-super-secret", JINN_GATEWAY_URL: "http://127.0.0.1:7777" },
        },
      },
    };
    const joined = codexMcpConfigArgs(resolved).join(" ");
    expect(joined).not.toContain("sk-super-secret");
    expect(joined).not.toContain("BRAVE_API_KEY");
    // The command/args still emit; only the URL survives in env.
    expect(joined).toContain('mcp_servers.search.command="npx"');
    expect(joined).toContain('mcp_servers.search.env={JINN_GATEWAY_URL="http://127.0.0.1:7777"}');
  });

  it("emits no env clause at all when a server has only secret (non-allowlisted) env", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: { custom: { command: "run", args: [], env: { TOKEN: "leak-me" } } },
    };
    const joined = codexMcpConfigArgs(resolved).join(" ");
    expect(joined).not.toContain("leak-me");
    expect(joined).not.toContain(".env=");
  });

  it("does NOT serialize a bearer token — only what the resolver put in env reaches argv", () => {
    // The resolver never places the token in server.env; assert the emit path
    // itself carries nothing token-shaped for the jinn server's real (URL-only) env.
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: { command: "node", args: ["/e.js"], env: { JINN_GATEWAY_URL: "http://127.0.0.1:7777" } },
      },
    };
    const joined = codexMcpConfigArgs(resolved).join(" ");
    expect(joined).not.toMatch(/TOKEN/i);
    expect(joined).not.toMatch(/authorization/i);
  });

  it("skips URL-based (non-stdio) servers this slice", () => {
    const resolved: ResolvedMcpConfig = {
      // Cast: a URL server has no `command`; the emitter must skip it.
      mcpServers: { remote: { type: "sse", url: "http://example/mcp" } as never },
    };
    expect(codexMcpConfigArgs(resolved)).toEqual([]);
  });

  it("handles multiple stdio servers independently", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        jinn: { command: "node", args: ["/j.js"] },
        search: { command: "npx", args: ["-y", "brave-search-mcp"] },
      },
    };
    const args = codexMcpConfigArgs(resolved);
    expect(args).toContain('mcp_servers.jinn.command="node"');
    expect(args).toContain('mcp_servers.search.command="npx"');
    expect(args).toContain('mcp_servers.search.args=["-y","brave-search-mcp"]');
  });
});

/**
 * BUG-1 fix — Codex 0.141 dropped the legacy `profile` config key, so `codex exec
 * resume` cannot layer a `--profile` file and MCP was lost after resume. The fix
 * unifies fresh + resume onto ONE mechanism: a per-session CODEX_HOME whose
 * `config.toml` carries the builtin-jinn stanza (capability in the 0600 file,
 * never on argv). Fresh AND resume point CODEX_HOME at the SAME per-session dir so
 * the codex thread rollout persists across turns.
 */
describe("prepareCodexSessionHome", () => {
  let realHome: string;
  let baseDir: string;

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-test-"));
    realHome = path.join(root, "real-codex");
    baseDir = path.join(root, "session-homes");
    fs.mkdirSync(realHome, { recursive: true });
    // A real codex home with an auth.json and a base config.toml the operator set.
    fs.writeFileSync(path.join(realHome, "auth.json"), JSON.stringify({ token: "login" }));
    fs.writeFileSync(path.join(realHome, "config.toml"), 'model = "gpt-5.5"\napproval_policy = "never"\n');
    process.env.CODEX_HOME = realHome;
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
  });

  it("returns undefined when there is no jinn server with a capability", () => {
    expect(prepareCodexSessionHome(undefined, "sess-1", { baseDir })).toBeUndefined();
    const noCap: ResolvedMcpConfig = { mcpServers: { jinn: { command: "node", args: ["/e.js"] } } };
    expect(prepareCodexSessionHome(noCap, "sess-1", { baseDir })).toBeUndefined();
  });

  it("creates a 0700 per-session home with a 0600 config.toml carrying the jinn stanza + merged base", () => {
    const home = prepareCodexSessionHome(jinnResolvedWithCapability(), "sess-1", { baseDir });
    expect(home).toBeDefined();
    expect(fs.existsSync(home!.home)).toBe(true);
    // Deterministic path — same session id → same dir every turn.
    expect(home!.home).toBe(path.join(baseDir, "sess-1"));

    expectPosixMode(home!.home, 0o700);

    const cfgPath = path.join(home!.home, "config.toml");
    expect(fs.existsSync(cfgPath)).toBe(true);
    expectPosixMode(fs.statSync(cfgPath), 0o600);

    const cfg = fs.readFileSync(cfgPath, "utf8");
    // Operator base settings preserved…
    expect(cfg).toContain('model = "gpt-5.5"');
    expect(cfg).toContain('approval_policy = "never"');
    // …plus the builtin jinn MCP stanza with the capability in the FILE.
    expect(cfg).toContain("[mcp_servers.jinn]");
    expect(cfg).toContain(CAPABILITY);
  });

  it("symlinks auth.json back to the real codex home (so token refreshes propagate)", () => {
    const home = prepareCodexSessionHome(jinnResolvedWithCapability(), "sess-1", { baseDir })!;
    const authLink = path.join(home.home, "auth.json");
    expect(fs.existsSync(authLink)).toBe(true);
    expect(fs.lstatSync(authLink).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(authLink)).toBe(fs.realpathSync(path.join(realHome, "auth.json")));
  });

  it("shares immutable/cache-heavy Codex assets instead of duplicating them per session", () => {
    const sharedNames = ["plugins", "cache", "skills", "vendor_imports", ".tmp"];
    for (const name of sharedNames) {
      const shared = path.join(realHome, name);
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(path.join(shared, "shared-marker"), name);
    }

    // Simulate a legacy overlay that already copied a full plugin checkout.
    const legacyPlugins = path.join(baseDir, "sess-1", "plugins");
    fs.mkdirSync(legacyPlugins, { recursive: true });
    fs.writeFileSync(path.join(legacyPlugins, "duplicated-marker"), "waste");

    const home = prepareCodexSessionHome(jinnResolvedWithCapability(), "sess-1", { baseDir })!;

    for (const name of sharedNames) {
      const link = path.join(home.home, name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(realHome, name)));
      expect(fs.readFileSync(path.join(link, "shared-marker"), "utf8")).toBe(name);
    }
    expect(fs.existsSync(path.join(home.home, "plugins", "duplicated-marker"))).toBe(false);
  });

  it("is idempotent across turns and rewrites config.toml when the capability rotates", () => {
    const first = prepareCodexSessionHome(jinnResolvedWithCapability("cap-round-1"), "sess-1", { baseDir })!;
    const second = prepareCodexSessionHome(jinnResolvedWithCapability("cap-round-2"), "sess-1", { baseDir })!;
    expect(second.home).toBe(first.home); // same stable dir across turns
    const cfg = fs.readFileSync(path.join(second.home, "config.toml"), "utf8");
    expect(cfg).toContain("cap-round-2");
    expect(cfg).not.toContain("cap-round-1"); // rewritten, not appended
  });

  it("strips any existing jinn MCP stanza from the base config before appending the fresh one", () => {
    fs.writeFileSync(
      path.join(realHome, "config.toml"),
      [
        'model = "gpt-5.5"',
        "[mcp_servers.search]",
        'command = "search"',
        "[mcp_servers.jinn]",
        'command = "old-node"',
        'args = ["old-entry.js"]',
        "[mcp_servers.jinn.env]",
        'JINN_SESSION_ID = "old-session"',
        'JINN_SESSION_CAPABILITY = "old-capability"',
        "[mcp_servers.filesystem]",
        'command = "filesystem"',
        "",
      ].join("\n"),
    );

    const first = prepareCodexSessionHome(jinnResolvedWithCapability("cap-round-1"), "sess-1", { baseDir })!;
    const firstCfg = fs.readFileSync(path.join(first.home, "config.toml"), "utf8");

    expect(countTomlTable(firstCfg, "mcp_servers.jinn")).toBe(1);
    expect(countTomlTable(firstCfg, "mcp_servers.jinn.env")).toBe(1);
    expect(firstCfg).not.toContain("old-node");
    expect(firstCfg).not.toContain("old-capability");
    expect(firstCfg).toContain("[mcp_servers.search]");
    expect(firstCfg).toContain("[mcp_servers.filesystem]");
    expect(firstCfg).toContain("cap-round-1");

    fs.writeFileSync(path.join(realHome, "config.toml"), firstCfg);
    const second = prepareCodexSessionHome(jinnResolvedWithCapability("cap-round-2"), "sess-1", { baseDir })!;
    const secondCfg = fs.readFileSync(path.join(second.home, "config.toml"), "utf8");

    expect(countTomlTable(secondCfg, "mcp_servers.jinn")).toBe(1);
    expect(countTomlTable(secondCfg, "mcp_servers.jinn.env")).toBe(1);
    expect(secondCfg).not.toContain("cap-round-1");
    expect(secondCfg).toContain("cap-round-2");
  });

  it("ignores CODEX_HOME when it points inside the per-session codex-homes base dir", () => {
    process.env.CODEX_HOME = path.join(baseDir, "poisoned-session-home");

    expect(realCodexHome(baseDir)).toBe(path.join(os.homedir(), ".codex"));
  });

  it("honors an external CODEX_HOME outside the per-session codex-homes base dir", () => {
    process.env.CODEX_HOME = realHome;

    expect(realCodexHome(baseDir)).toBe(realHome);
  });

  it("cleanup() removes the per-session dir; removeCodexSessionHome is a no-op when absent", () => {
    const home = prepareCodexSessionHome(jinnResolvedWithCapability(), "sess-1", { baseDir })!;
    expect(fs.existsSync(home.home)).toBe(true);
    home.cleanup();
    expect(fs.existsSync(home.home)).toBe(false);
    // Idempotent removal by id — safe on non-codex / already-removed sessions.
    expect(() => removeCodexSessionHome("sess-1", baseDir)).not.toThrow();
    expect(() => removeCodexSessionHome("never-existed", baseDir)).not.toThrow();
  });
});

function countTomlTable(config: string, table: string): number {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (config.match(new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, "gm")) ?? []).length;
}

describe("buildCodexFreshArgs / buildCodexResumeArgs — no --profile, no capability on argv", () => {
  it("fresh argv has no --profile and never leaks the capability", () => {
    const opts = baseOpts({ model: "gpt-5.5", resolvedMcp: jinnResolvedWithCapability() });
    const args = buildCodexFreshArgs(opts, "the prompt", /* homeActive */ true);
    expect(args).not.toContain("--profile");
    expect(args.join(" ")).not.toContain(CAPABILITY);
    // jinn server rides config.toml (home active) → NOT re-emitted on argv…
    expect(args.join(" ")).not.toContain("mcp_servers.jinn.command");
  });

  it("resume argv has no --profile, no -C, carries the resume id, and never leaks the capability", () => {
    const opts = baseOpts({
      model: "gpt-5.5",
      resumeSessionId: "thread-abc",
      resolvedMcp: jinnResolvedWithCapability(),
    });
    const args = buildCodexResumeArgs(opts, "the prompt", /* homeActive */ true);
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).not.toContain("--profile");
    expect(args).not.toContain("-C"); // codex exec resume rejects -C
    expect(args).toContain("thread-abc");
    expect(args.join(" ")).not.toContain(CAPABILITY);
    expect(args.join(" ")).not.toContain("mcp_servers.jinn.command");
  });

  it("still emits third-party stdio servers on argv even when the jinn home is active", () => {
    const resolved: ResolvedMcpConfig = {
      mcpServers: {
        ...jinnResolvedWithCapability().mcpServers,
        search: { command: "npx", args: ["-y", "brave-search-mcp"] },
      },
    };
    const args = buildCodexFreshArgs(baseOpts({ resolvedMcp: resolved }), "p", true);
    expect(args.join(" ")).toContain('mcp_servers.search.command="npx"');
    expect(args.join(" ")).not.toContain("mcp_servers.jinn.command");
  });
});

describe("codexChildEnv — CODEX_HOME wiring", () => {
  it("points CODEX_HOME at the per-session home and strips inherited CODEX_*", () => {
    const base = { PATH: "/usr/bin", CODEX_HOME: "/real/.codex", CODEX_API_KEY: "x", CLAUDECODE: "1" };
    const env = codexChildEnv(base, "sess-1", "/jinn/tmp/codex-homes/sess-1");
    expect(env.CODEX_HOME).toBe("/jinn/tmp/codex-homes/sess-1");
    expect(env.CODEX_API_KEY).toBeUndefined(); // inherited CODEX_* stripped
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.JINN_SESSION_ID).toBe("sess-1");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strips inherited lifecycle takeover state from engine children", () => {
    const env = codexChildEnv({
      PATH: "/usr/bin",
      JINN_TAKE_PORT: "1",
      JINN_HOME_IDENTITY: "/private/tmp/jinn-home",
    }, "sess-1");

    expect(env.JINN_TAKE_PORT).toBeUndefined();
    expect(env.JINN_HOME_IDENTITY).toBeUndefined();
  });

  it("omits CODEX_HOME when no per-session home is active (default ~/.codex path)", () => {
    const env = codexChildEnv({ PATH: "/usr/bin" }, "sess-1");
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.JINN_SESSION_ID).toBe("sess-1");
  });
});
