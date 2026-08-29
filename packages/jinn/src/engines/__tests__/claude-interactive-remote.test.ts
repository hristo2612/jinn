import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

/**
 * The engine's remote branch.
 *
 * The guarantee under test is a negative one: for a remote employee, NOTHING is
 * ever spawned on the gateway — not the turn, not the dashboard's idle PTY, and
 * not a fallback. A regression here is invisible in the UI (a local `claude`
 * looks exactly like a remote one in the terminal pane) and would quietly clone
 * work onto the wrong machine, so it has to be held by a test.
 */

const REMOTE_STAGE = "/mnt/jinn-home/.jinn-remote-stage";
const REMOTE_SETTINGS = `${REMOTE_STAGE}/tmp/settings/remote-sess.json`;
const REMOTE_MCP = `${REMOTE_STAGE}/tmp/mcp/remote-sess/config.json`;

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[]; opts: any }[],
  prepareCalls: [] as any[],
  ensureCalls: [] as any[],
  proxyConstructions: 0,
  /** Everything written into any fake PTY, so a paste can be asserted against. */
  writes: [] as string[],
  /** Flipped by one test to prove an unready host never reaches pty.spawn. */
  ready: true as boolean,
}));

// ── node-pty ─────────────────────────────────────────────────────────────────
interface FakePty {
  pid: number;
  _exitCode: number | null;
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: () => void;
  write: (d: string) => void;
  resize: () => void;
  on: () => void;
}
vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: any) => {
    hoisted.spawns.push({ bin, args, opts });
    const p: FakePty = {
      pid: 3000 + hoisted.spawns.length,
      _exitCode: null,
      onData() {},
      onExit(cb) { p._exitCb = cb; },
      kill() {},
      write(d: string) { hoisted.writes.push(d); },
      resize() {},
      on() {},
    };
    return p;
  }),
}));

// ── remote-stage ─────────────────────────────────────────────────────────────
// Only the two functions that would talk to a real host are replaced. The argv
// builder and its shell quoting stay REAL, so the assertions below are made
// against the command that would genuinely be sent.
vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    ensureRemoteReady: vi.fn(async (target: any, remote: any, opts: any) => {
      hoisted.ensureCalls.push({ target, remote, opts });
      if (!hoisted.ready) return { ready: false, reason: "build-box is not reachable" };
      return {
        ready: true,
        facts: {
          home: "/home/builder",
          stageDir: REMOTE_STAGE,
          nodeBin: "/usr/bin/node",
          claudeBin: "/usr/local/bin/claude",
          jinnVersion: "0.32.0",
          entryDir: "/usr/lib/jinn/src/mcp",
        },
      };
    }),
    prepareRemoteSession: vi.fn(async (opts: any) => {
      hoisted.prepareCalls.push(opts);
      return {
        destination: "builder@build-box",
        tunnelPort: 44321,
        settingsPath: REMOTE_SETTINGS,
        ...(opts.resolvedMcp ? { mcpConfigPath: REMOTE_MCP } : {}),
      };
    }),
  };
});

// ── SSE proxy ────────────────────────────────────────────────────────────────
// Counting constructions is the direct measure of "startProxy was entered".
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void, _opts?: unknown) {
      hoisted.proxyConstructions += 1;
    }
    async start() { return 41000; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";

const flush = () => new Promise((r) => setTimeout(r, 20));
const SID = "remote-sess";
const REMOTE_CONFIG = { root: "/srv/jinn-work", mount: "/mnt/jinn-home" };
const TARGET = { remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/jinn-work/proj" };

/** The remote command ssh would run — the last argv element, after `--`. */
function remoteCommandOf(args: string[]): string {
  expect(args[args.length - 2]).toBe("--");
  return args[args.length - 1];
}

/** The value the remote `claude` receives for a flag, read out of the quoted
 *  remote command string. */
function remoteFlagValue(cmd: string, flag: string): string | undefined {
  const m = cmd.match(new RegExp(`'${flag}' '([^']*)'`));
  return m ? m[1] : undefined;
}

describe("InteractiveClaudeEngine — remote branch", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    hoisted.spawns.length = 0;
    hoisted.prepareCalls.length = 0;
    hoisted.ensureCalls.length = 0;
    hoisted.proxyConstructions = 0;
    hoisted.writes.length = 0;
    hoisted.ready = true;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
    // No turn here is ever settled by hooks — every assertion is made at the
    // spawn boundary — so the registry only has to accept the registration.
    const hookRegistry = { register: () => {}, unregister: () => {} } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry, {
      remote: () => REMOTE_CONFIG,
      gatewayPort: () => 8722,
    });
  });

  afterEach(() => {
    lifecycle.killAll();
    cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  });

  // ── run() ──────────────────────────────────────────────────────────────────

  describe("a turn for a remote employee", () => {
    /** Kick off a remote turn and let it reach pty.spawn. The turn itself never
     *  settles (no hooks are fired); afterEach tears it down. */
    async function startRemoteTurn(extra: Record<string, unknown> = {}): Promise<void> {
      void engine.run({ sessionId: SID, prompt: "do the thing", cwd: "/tmp", ...TARGET, ...extra } as any)
        .catch(() => { /* the turn is abandoned by design */ });
      await flush();
    }

    it("spawns SSH, never a local claude", async () => {
      await startRemoteTurn();
      expect(hoisted.spawns).toHaveLength(1);
      const { bin, args } = hoisted.spawns[0];
      expect(path.basename(bin).replace(/\.exe$/i, "")).toBe("ssh");
      expect(path.basename(bin)).not.toMatch(/claude/);
      // Real ssh argv, built by the real builder.
      expect(args).toContain("-tt");
      expect(args.some((a, i) => a === "-o" && args[i + 1] === "BatchMode=yes")).toBe(true);
      expect(args.some((a, i) => a === "-o" && args[i + 1] === "ExitOnForwardFailure=yes")).toBe(true);
      expect(args[args.indexOf("-R") + 1]).toBe("44321:127.0.0.1:8722");
      expect(args).toContain("builder@build-box");
      // The gateway's own working directory is irrelevant; the remote command cds.
      expect(remoteCommandOf(args)).toContain("cd '/srv/jinn-work/proj' &&");
    });

    it("never starts an SSE forward proxy", async () => {
      await startRemoteTurn();
      expect(hoisted.proxyConstructions).toBe(0);
      // The observable consequence: no base-url override reaches the child.
      const env = hoisted.spawns[0].opts.env as Record<string, string>;
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBeUndefined();
      // …nor the remote command, which is where the remote process's env is set.
      const cmd = remoteCommandOf(hoisted.spawns[0].args);
      expect(cmd).not.toMatch(/ANTHROPIC_BASE_URL=/);
      expect(cmd).not.toMatch(/_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL/);
    });

    it("passes the REMOTE staged --settings path, not the gateway's", async () => {
      await startRemoteTurn();
      const cmd = remoteCommandOf(hoisted.spawns[0].args);
      expect(remoteFlagValue(cmd, "--settings")).toBe(REMOTE_SETTINGS);
      // The gateway's own settings directory must appear nowhere in the command.
      expect(cmd).not.toContain(CLAUDE_SETTINGS_DIR);
    });

    it("passes the REMOTE staged --mcp-config path, not the gateway's", async () => {
      await startRemoteTurn({ resolvedMcp: { mcpServers: { jinn: { command: "node", args: ["server.js"] } } } });
      const cmd = remoteCommandOf(hoisted.spawns[0].args);
      expect(remoteFlagValue(cmd, "--mcp-config")).toBe(REMOTE_MCP);
      // The resolved set was handed to the stager so it could be remapped there.
      expect(hoisted.prepareCalls[0].resolvedMcp).toBeDefined();
      expect(hoisted.prepareCalls[0].gatewayPort).toBe(8722);
    });

    it("unsets the Anthropic billing variables on the remote side", async () => {
      await startRemoteTurn();
      const cmd = remoteCommandOf(hoisted.spawns[0].args);
      for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
        expect(cmd, key).toContain(`'-u' '${key}'`);
      }
      expect(cmd).toContain(`JINN_HOME='${REMOTE_STAGE}'`);
      expect(cmd).toContain(`JINN_SESSION_ID='${SID}'`);
    });

    it("never wakes the host from a spawn path", async () => {
      await startRemoteTurn();
      expect(hoisted.ensureCalls[0].opts.allowWake).toBe(false);
    });

    // Refused as a settled EngineResult carrying `error`, not as a rejection —
    // the same contract the concurrent-turn guard beside it uses, so the turn
    // settles through the normal path instead of settleThrownTurn.
    it("refuses attachments rather than passing gateway paths through", async () => {
      const result = await engine.run({
        sessionId: SID,
        prompt: "look at this",
        cwd: "/tmp",
        ...TARGET,
        attachments: ["/mnt/jinn-home/tmp/uploads/a.png"],
      } as any);
      expect(result.error).toMatch(/attachments are not supported for remote employees/i);
      // And nothing was spawned or staged on the way to that refusal.
      expect(hoisted.spawns).toHaveLength(0);
    });

    // The cold path is not the risky one: only a turn with NO warm PTY reaches
    // spawn(). With one adopted, run() takes injectPrompt instead, which appends
    // buildAttachmentSuffix unconditionally — so a guard living inside
    // spawnRemote would let gateway paths reach a session on another host from
    // the second turn onward. Assert against a genuinely warm PTY.
    it("refuses attachments while a warm PTY is adopted, not just on a cold spawn", async () => {
      engine.ensureIdleSpawn(SID, { engineSessionId: "eng-1", cols: 80, rows: 24, ...TARGET } as any);
      await vi.waitFor(() => expect(engine.hasWarmPty(SID)).toBe(true));
      const spawnsBefore = hoisted.spawns.length;

      const result = await engine.run({
        sessionId: SID,
        prompt: "two",
        cwd: "/tmp",
        ...TARGET,
        attachments: ["/mnt/jinn-home/tmp/uploads/a.png"],
      } as any);

      expect(result.error).toMatch(/attachments are not supported for remote employees/i);
      // Nothing was pasted into the live PTY, and no new one was made.
      expect(hoisted.spawns).toHaveLength(spawnsBefore);
      expect(hoisted.writes.join("")).not.toContain("Attached files:");
    });

    it("refuses to spawn when the target escapes the configured remote.root", async () => {
      await expect(engine.run({
        sessionId: SID,
        prompt: "hi",
        cwd: "/tmp",
        remoteHost: "build-box",
        remoteCwd: "/srv/jinn-work-evil/proj",
      } as any)).rejects.toThrow(/Refusing to spawn a remote session/);
      expect(hoisted.spawns).toHaveLength(0);
    });

    it("fails the turn instead of falling back to the gateway when the host is not ready", async () => {
      hoisted.ready = false;
      await expect(engine.run({ sessionId: SID, prompt: "hi", cwd: "/tmp", ...TARGET } as any))
        .rejects.toThrow(/remote host not ready/);
      expect(hoisted.spawns).toHaveLength(0);
    });

    it("a purely local employee is unaffected — local claude, with a proxy", async () => {
      void engine.run({ sessionId: "local-sess", prompt: "hi", cwd: "/tmp" } as any).catch(() => {});
      await flush();
      expect(hoisted.spawns).toHaveLength(1);
      expect(path.basename(hoisted.spawns[0].bin).replace(/\.exe$/i, "")).toBe("claude");
      expect(hoisted.proxyConstructions).toBe(1);
      expect(hoisted.prepareCalls).toHaveLength(0);
      cleanupSessionSettings(CLAUDE_SETTINGS_DIR, "local-sess");
    });
  });

  // ── ensureIdleSpawn() ──────────────────────────────────────────────────────

  describe("the dashboard's idle PTY", () => {
    it("goes over SSH for a remote employee — it must not relocate the session to the gateway", async () => {
      // The invisible regression this guards: a locally-spawned idle PTY is
      // adopted as the warm PTY, so the NEXT real turn pastes its prompt into a
      // gateway-local claude and the employee quietly runs here after all.
      engine.ensureIdleSpawn(SID, { ...TARGET, cols: 100, rows: 30, engineSessionId: "cc-1" } as any);
      await flush();
      expect(hoisted.spawns).toHaveLength(1);
      const { bin, args, opts } = hoisted.spawns[0];
      expect(path.basename(bin).replace(/\.exe$/i, "")).toBe("ssh");
      expect(args).toContain("-tt");
      expect(opts.cols).toBe(100);
      expect(opts.rows).toBe(30);
      const cmd = remoteCommandOf(args);
      expect(cmd).toContain("cd '/srv/jinn-work/proj' &&");
      expect(remoteFlagValue(cmd, "--resume")).toBe("cc-1");
      expect(hoisted.proxyConstructions).toBe(0);
    });

    it("uses the REMOTE staged --settings path for the idle PTY too", async () => {
      engine.ensureIdleSpawn(SID, { ...TARGET } as any);
      await flush();
      const cmd = remoteCommandOf(hoisted.spawns[0].args);
      expect(remoteFlagValue(cmd, "--settings")).toBe(REMOTE_SETTINGS);
      expect(cmd).not.toContain(CLAUDE_SETTINGS_DIR);
    });

    it("adopts the ssh PTY as the session's warm PTY", async () => {
      engine.ensureIdleSpawn(SID, { ...TARGET } as any);
      await flush();
      expect(lifecycle.getWarm(SID)).toBeDefined();
    });

    it("spawns nothing at all when the remote host is not ready", async () => {
      hoisted.ready = false;
      engine.ensureIdleSpawn(SID, { ...TARGET } as any);
      await flush();
      expect(hoisted.spawns).toHaveLength(0);
      expect(lifecycle.getWarm(SID)).toBeUndefined();
    });

    it("a local employee's idle PTY still spawns claude locally", async () => {
      engine.ensureIdleSpawn("local-idle", { cwd: "/tmp" } as any);
      await flush();
      expect(hoisted.spawns).toHaveLength(1);
      expect(path.basename(hoisted.spawns[0].bin).replace(/\.exe$/i, "")).toBe("claude");
      expect(hoisted.prepareCalls).toHaveLength(0);
      cleanupSessionSettings(CLAUDE_SETTINGS_DIR, "local-idle");
    });
  });
});
