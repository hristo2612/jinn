import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Pure-surface tests for the remote staging module. Nothing here touches SSH:
 * the two things worth proving without a second machine are the shell quoting
 * (which is all that stands between a prompt and remote command injection) and
 * the argv/remote-command construction.
 */

// ── dgram capture ────────────────────────────────────────────────────────────
// sendWakeOnLan broadcasts to 255.255.255.255, which a bound loopback socket
// cannot observe. Capture the datagram at the socket boundary instead.
interface SentPacket { buffer: Buffer; offset: number; length: number; port: number; address: string }
const sent: SentPacket[] = [];
let broadcastSet = false;
let closed = false;

vi.mock("node:dgram", () => {
  const createSocket = (_type: string) => {
    const handlers = new Map<string, (...a: any[]) => void>();
    return {
      once(event: string, cb: (...a: any[]) => void) { handlers.set(event, cb); },
      on(event: string, cb: (...a: any[]) => void) { handlers.set(event, cb); },
      bind(cb: () => void) { setImmediate(cb); },
      setBroadcast(_on: boolean) { broadcastSet = true; },
      // Rest-typed to match dgram's 6-argument send without tripping max-params.
      send(...a: [Buffer, number, number, number, string, (err?: Error) => void]) {
        const [buffer, offset, length, port, address, cb] = a;
        sent.push({ buffer: Buffer.from(buffer), offset, length, port, address });
        setImmediate(() => cb());
      },
      close() { closed = true; },
    };
  };
  return { default: { createSocket }, createSocket };
});

import { shq, buildSshSpawnArgs, sendWakeOnLan, FACTS_SCRIPT, FARM_SCRIPT, buildTrustSeedCommand, trustSeedKey, runLocalWakeCommand } from "../remote-stage.js";

const isWindows = process.platform === "win32";

// ── shq ──────────────────────────────────────────────────────────────────────

/** Round-trip a value through a REAL POSIX shell and return what it received. */
function throughRealSh(value: string): Buffer {
  return execFileSync("sh", ["-c", `printf %s ${shq(value)}`]);
}

describe.skipIf(isWindows)("shq — real `sh -c` round trip", () => {
  const nasty = [
    ["single quotes", `it's a 'quoted' word`],
    ["spaces", "two  spaced   words"],
    ["dollar and expansion", `$HOME $(id) ${"${PATH}"}`],
    ["backticks", "`id`"],
    ["newline", "line one\nline two"],
    ["all of it", `a'b c$d\`e\`f\n$(touch g) "h" \\i`],
    ["backslashes", "a\\b\\\\c"],
    ["semicolons and redirects", "a; b | c > d & e"],
    ["empty string", ""],
    ["a lone quote", "'"],
    ["glob characters", "* ? [a-z] ~"],
    ["unicode", "héllo — ünicode ✅"],
  ] as const;

  for (const [label, value] of nasty) {
    it(`survives byte-identically: ${label}`, () => {
      expect(throughRealSh(value)).toEqual(Buffer.from(value, "utf8"));
    });
  }

  it("a value that would otherwise close the quote and run a command does not run it", () => {
    // If the escaping were broken this would resolve a command name; the canary
    // is deliberately a name nothing provides, so a break shows up as a throw
    // rather than as a side effect.
    const payload = `x'; jinn-injection-canary-9f3a; echo 'y`;
    expect(throughRealSh(payload)).toEqual(Buffer.from(payload, "utf8"));
  });
});

// ── buildSshSpawnArgs ────────────────────────────────────────────────────────

const REMOTE_CWD = "/srv/jinn-work/proj";

function build(over: Partial<Parameters<typeof buildSshSpawnArgs>[0]> = {}): string[] {
  return buildSshSpawnArgs({
    destination: "builder@build-box",
    tunnelPort: 44321,
    gatewayPort: 8722,
    remoteCwd: REMOTE_CWD,
    remoteEnv: {
      JINN_HOME: "/mnt/jinn-home/.jinn-remote-stage",
      JINN_SESSION_ID: "sess-1",
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
    },
    unsetRemoteEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE"],
    claudeBin: "/usr/local/bin/claude",
    claudeArgs: ["--chrome", "--settings", "/mnt/jinn-home/.jinn-remote-stage/tmp/settings/sess-1.json"],
    ...over,
  });
}

/** The remote command is the last argv element, directly after the destination.
 *
 *  This helper used to assert a `--` immediately before it — and that assertion
 *  is the bug it should have caught. ssh consumes only the FIRST `--` it sees,
 *  so with the guard already placed before the destination, a second one reached
 *  the remote shell as `-- cd …` and every spawn died with
 *  `/bin/bash: --: invalid option`. See the argv invariant in
 *  claude-interactive-remote.test.ts, which now pins the shape properly. */
function remoteCommandOf(args: string[]): string {
  return args[args.length - 1];
}

/** Index-aware option lookup: `-o Foo=bar` is two argv elements. */
function hasOption(args: string[], value: string): boolean {
  return args.some((a, i) => a === "-o" && args[i + 1] === value);
}

describe("buildSshSpawnArgs — ssh flags", () => {
  const args = build();

  it("forces remote PTY allocation with -tt", () => {
    // An explicit remote command makes ssh default to NO pty, which breaks the
    // TUI and with it the viewport parser that answers safety prompts.
    expect(args).toContain("-tt");
  });

  it("is key-only (BatchMode=yes) — there is nobody at the keyboard", () => {
    expect(hasOption(args, "BatchMode=yes")).toBe(true);
  });

  it("disables ssh's own ~ escapes so transcript/paste content cannot fire them", () => {
    expect(hasOption(args, "EscapeChar=none")).toBe(true);
  });

  it("exits immediately when the reverse tunnel cannot be established", () => {
    // Otherwise the session runs with hooks and MCP calls that can never reach
    // the gateway — a silent permanent hang instead of a fast, settleable exit.
    expect(hasOption(args, "ExitOnForwardFailure=yes")).toBe(true);
  });

  it("forwards the gateway port back over the tunnel, bound to loopback", () => {
    const i = args.indexOf("-R");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("44321:127.0.0.1:8722");
  });

  // ssh consumes only the FIRST `--` it sees and passes any later one into the
  // remote command, so the terminator goes BEFORE the destination and the
  // command follows it directly. A second `--` here was what made every spawn
  // die with `/bin/bash: --: invalid option`.
  it("puts the one `--` before the destination, with the command straight after", () => {
    expect(args.filter((a) => a === "--")).toHaveLength(1);
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("builder@build-box"));
    expect(args[args.length - 2]).toBe("builder@build-box");
    expect(args[args.length - 1]).toMatch(/^cd '/);
  });

  it("carries keepalives so a dead link is noticed rather than hung on", () => {
    expect(hasOption(args, "ServerAliveInterval=30")).toBe(true);
    expect(hasOption(args, "ServerAliveCountMax=3")).toBe(true);
  });
});

describe("buildSshSpawnArgs — the remote command", () => {
  const cmd = remoteCommandOf(build());

  it("cds to the remoteCwd before anything else", () => {
    expect(cmd.startsWith(`cd ${shq(REMOTE_CWD)} &&`)).toBe(true);
  });

  it("execs env so the remote shell is replaced rather than kept in the middle", () => {
    expect(cmd).toContain("&& exec env ");
  });

  it("unsets the three billing-relevant Anthropic variables", () => {
    // An ANTHROPIC_API_KEY in the remote user's shell profile would flip the
    // session from Max-subscription auth to metered API billing, silently.
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      expect(cmd).toContain(`'-u' '${key}'`);
    }
  });

  it("sets JINN_HOME and JINN_SESSION_ID for the remote process", () => {
    expect(cmd).toContain(`JINN_HOME='/mnt/jinn-home/.jinn-remote-stage'`);
    expect(cmd).toContain(`JINN_SESSION_ID='sess-1'`);
  });

  it("does NOT set ANTHROPIC_BASE_URL or the first-party assume flag — no SSE proxy runs remotely", () => {
    expect(cmd).not.toMatch(/ANTHROPIC_BASE_URL=/);
    expect(cmd).not.toMatch(/_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL/);
  });

  it("ends with the claude binary and its arguments", () => {
    expect(cmd).toContain(`'/usr/local/bin/claude' '--chrome' '--settings'`);
  });

  it("omits the env -u clause entirely when nothing is denied", () => {
    const bare = remoteCommandOf(build({ unsetRemoteEnv: [] }));
    expect(bare).toContain("&& exec env JINN_HOME=");
    expect(bare).not.toContain("'-u'");
  });
});

describe.skipIf(isWindows)("buildSshSpawnArgs — the remote command parsed by a REAL shell", () => {
  /**
   * Parse the remote command the way the remote login shell would, without
   * running anything: `env` is shadowed by a function that prints its argv, and
   * PATH is emptied so a quoting break can resolve no external command at all.
   */
  function remoteArgv(cmd: string, cwd: string): string[] {
    const script = [
      `PATH=''`,
      `env() { printf '%s\\0' "$@"; }`,
      cmd.replace(" && exec env ", " && env "),
    ].join("\n");
    const out = execFileSync("sh", ["-c", script], { cwd, encoding: "utf8" });
    const parts = out.split("\0");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  }

  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-stage-"));
  });

  it("a prompt full of shell metacharacters arrives as ONE argument", () => {
    const prompt = `'; rm -rf /; echo '`;
    const cmd = remoteCommandOf(build({
      remoteCwd: dir,
      claudeArgs: ["--chrome", prompt],
      unsetRemoteEnv: ["ANTHROPIC_API_KEY"],
    }));
    const argv = remoteArgv(cmd, dir);
    // Everything the remote `env` receives, in order.
    expect(argv).toEqual([
      "-u", "ANTHROPIC_API_KEY",
      "JINN_HOME=/mnt/jinn-home/.jinn-remote-stage",
      "JINN_SESSION_ID=sess-1",
      "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
      "/usr/local/bin/claude",
      "--chrome",
      prompt,
    ]);
    // The dangerous substring is one opaque argument, not a command.
    expect(argv.filter((a) => a.includes("rm -rf /"))).toEqual([prompt]);
  });

  it("a multi-line prompt with expansions and backticks survives intact", () => {
    const prompt = "line one $(id)\nline two `whoami` ${HOME} & echo done";
    const cmd = remoteCommandOf(build({
      remoteCwd: dir,
      claudeArgs: ["-p", prompt],
      unsetRemoteEnv: [],
    }));
    const argv = remoteArgv(cmd, dir);
    expect(argv[argv.length - 1]).toBe(prompt);
    expect(argv[argv.length - 2]).toBe("-p");
  });

  it("an env VALUE containing a quote does not break the assignment", () => {
    const cmd = remoteCommandOf(build({
      remoteCwd: dir,
      remoteEnv: { JINN_SESSION_ID: `s'; id; echo '1` },
      unsetRemoteEnv: [],
      claudeArgs: [],
    }));
    const argv = remoteArgv(cmd, dir);
    expect(argv).toEqual([`JINN_SESSION_ID=s'; id; echo '1`, "/usr/local/bin/claude"]);
  });

  it("the `cd` really lands in the remoteCwd", () => {
    const cmd = remoteCommandOf(build({ remoteCwd: dir, unsetRemoteEnv: [], claudeArgs: [] }));
    const script = [
      `PATH=''`,
      `env() { printf '%s\\0' "$PWD"; }`,
      cmd.replace(" && exec env ", " && env "),
    ].join("\n");
    const pwd = execFileSync("sh", ["-c", script], { cwd: os.tmpdir(), encoding: "utf8" }).replace(/\0$/, "");
    expect(fs.realpathSync(pwd)).toBe(fs.realpathSync(dir));
  });
});

// ── sendWakeOnLan ────────────────────────────────────────────────────────────

describe("sendWakeOnLan — magic packet construction", () => {
  beforeEach(() => {
    sent.length = 0;
    broadcastSet = false;
    closed = false;
  });

  it("sends 102 bytes: 6 × 0xFF then the MAC sixteen times", async () => {
    await sendWakeOnLan("aa:bb:cc:dd:ee:ff");
    expect(sent).toHaveLength(1);
    const { buffer, length } = sent[0];
    expect(buffer).toHaveLength(102);
    expect(length).toBe(102);
    expect([...buffer.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const mac = Buffer.from("aabbccddeeff", "hex");
    for (let i = 0; i < 16; i += 1) {
      expect(buffer.subarray(6 + i * 6, 12 + i * 6), `repetition ${i}`).toEqual(mac);
    }
  });

  it("broadcasts to the discard port and closes the socket", async () => {
    await sendWakeOnLan("aa-bb-cc-dd-ee-ff");
    expect(broadcastSet).toBe(true);
    expect(sent[0].port).toBe(9);
    expect(sent[0].address).toBe("255.255.255.255");
    expect(sent[0].offset).toBe(0);
    expect(closed).toBe(true);
  });

  it("accepts the common MAC separators and bare hex identically", async () => {
    for (const mac of ["aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", "aabbccddeeff", "aabb.ccdd.eeff"]) {
      sent.length = 0;
      await sendWakeOnLan(mac);
      expect(sent[0].buffer.subarray(6, 12), mac).toEqual(Buffer.from("aabbccddeeff", "hex"));
    }
  });

  it("throws on a malformed MAC rather than broadcasting a garbage packet", async () => {
    for (const bad of ["", "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:ff:00", "not-a-mac", "zz:zz:zz:zz:zz:zz"]) {
      await expect(sendWakeOnLan(bad), bad).rejects.toThrow(/is not a 6-byte MAC address/);
    }
    expect(sent).toHaveLength(0);
  });
});

/**
 * The host-facts probe, run through a REAL POSIX shell against a fake nvm
 * layout. These are shell semantics, not TypeScript, and the bug they guard was
 * found on a live Raspberry Pi: a non-interactive ssh reads no rc file, so a
 * version-managed node is invisible and every hook would fail to start.
 */
describe.skipIf(process.platform === "win32")("FACTS_SCRIPT node resolution", () => {
  let home: string;

  function runFacts(extraPath = ""): Record<string, string> {
    const out = execFileSync("sh", ["-s"], {
      input: FACTS_SCRIPT,
      encoding: "utf8",
      env: { HOME: home, PATH: extraPath || "/usr/bin:/bin" },
    });
    const kv: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return kv;
  }

  function fakeNode(version: string): void {
    const dir = path.join(home, ".nvm", "versions", "node", version, "bin");
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "node");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-facts-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reports $HOME even when nothing else is installed", () => {
    expect(runFacts().home).toBe(home);
  });

  it("finds a version-managed node that a non-interactive shell cannot see", () => {
    fakeNode("v22.22.3");
    // No nvm.sh is created on purpose: it is bash-only and /bin/sh is dash on
    // Debian-family systems, so sourcing it is not an option the script has.
    expect(runFacts().node).toBe(path.join(home, ".nvm/versions/node/v22.22.3/bin/node"));
  });

  it("honours nvm's default alias rather than taking the newest version", () => {
    fakeNode("v22.22.3");
    fakeNode("v24.14.1");
    fs.mkdirSync(path.join(home, ".nvm", "alias"), { recursive: true });
    fs.writeFileSync(path.join(home, ".nvm", "alias", "default"), "22\n");
    // This is the case that matters: a global jinn-cli lives under ONE version's
    // tree, so resolving to v24 here would report jinn missing on a host where
    // it is installed perfectly well under v22.
    expect(runFacts().node).toContain("v22.22.3");
    expect(runFacts().node).not.toContain("v24");
  });

  it("falls back to the newest version when no default alias is set", () => {
    fakeNode("v22.22.3");
    fakeNode("v24.14.1");
    expect(runFacts().node).toContain("v24.14.1");
  });

  it("prefers a node already on PATH over anything under nvm", () => {
    fakeNode("v22.22.3");
    const realDir = path.join(home, "sysbin");
    fs.mkdirSync(realDir, { recursive: true });
    const bin = path.join(realDir, "node");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
    expect(runFacts(`${realDir}:/usr/bin:/bin`).node).toBe(bin);
  });
});

describe("buildSshSpawnArgs — remote PATH", () => {
  const base = {
    destination: "builder@build-box",
    tunnelPort: 40001,
    gatewayPort: 7777,
    remoteCwd: "/srv/jinn-work/main",
    remoteEnv: { JINN_HOME: "/home/u/.jinn-remote-stage" },
    claudeBin: "/usr/bin/claude",
    claudeArgs: ["--chrome"],
  };

  it("prepends the node directory so Claude Code's bare `node` hooks can run", () => {
    const cmd = buildSshSpawnArgs({
      ...base,
      pathPrepend: ["/home/u/.nvm/versions/node/v22.22.3/bin"],
    }).at(-1)!;
    expect(cmd).toContain(`PATH='/home/u/.nvm/versions/node/v22.22.3/bin':"$PATH"`);
  });

  it("leaves PATH untouched when nothing is prepended", () => {
    expect(buildSshSpawnArgs(base).at(-1)!).not.toContain("PATH=");
  });

  it.skipIf(process.platform === "win32")("expands to the host's own PATH, not a replacement", () => {
    const cmd = buildSshSpawnArgs({ ...base, pathPrepend: ["/opt/node/bin"] }).at(-1)!;
    // Pull out just the PATH assignment and let a real shell evaluate it.
    const assignment = cmd.match(/PATH=[^ ]+/)![0];
    const shown = execFileSync("sh", ["-c", `${assignment} sh -c 'printf %s "$PATH"'`], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(shown).toBe("/opt/node/bin:/usr/bin:/bin");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(isWindows)("FARM_SCRIPT — run for real against a fixture mount", () => {
  let dir: string;
  let mount: string;
  let root: string;

  /** Run the farm exactly as `sshScript` would: script on stdin to `sh -s`. */
  function runFarm(sessionId: string, ttlDays = 7): string {
    const home = path.join(root, "sessions", sessionId);
    return execFileSync("sh", ["-s", mount, root, home, String(ttlDays)], {
      input: FARM_SCRIPT,
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-farm-"));
    mount = path.join(dir, "mount");
    root = path.join(dir, "stage");
    // A gateway instance home as the remote host sees it through sshfs.
    fs.mkdirSync(path.join(mount, "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(mount, "org"), { recursive: true });
    fs.mkdirSync(path.join(mount, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(mount, "knowledge", "a.md"), "real knowledge\n");
    fs.writeFileSync(path.join(mount, "gateway.json"), '{"port":7777}\n');
    // The gateway copies the relay INTO its own home, so the mount exposes it.
    fs.writeFileSync(path.join(mount, "hook-relay.mjs"), "// the gateway's copy\n");
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("gives each session its own JINN_HOME, so one spawn cannot repoint another", () => {
    runFarm("sess-a");
    runFarm("sess-b");
    const a = path.join(root, "sessions", "sess-a");
    const b = path.join(root, "sessions", "sess-b");
    // The whole point: gateway.json names a PER-SPAWN tunnel port, so a shared
    // home would let one session's prepare rewrite the port another live turn's
    // hook relay is about to read — and the relay swallows a failed POST, so
    // that turn completes with no Stop and nothing reported anywhere.
    expect(fs.existsSync(path.join(a, "knowledge"))).toBe(true);
    expect(fs.existsSync(path.join(b, "knowledge"))).toBe(true);
    fs.writeFileSync(path.join(a, "gateway.json"), '{"port":1111}\n');
    fs.writeFileSync(path.join(b, "gateway.json"), '{"port":2222}\n');
    expect(fs.readFileSync(path.join(a, "gateway.json"), "utf8")).toContain("1111");
    expect(fs.readFileSync(path.join(b, "gateway.json"), "utf8")).toContain("2222");
  });

  it("writes through the farm to the real gateway home", () => {
    runFarm("sess-a");
    fs.writeFileSync(path.join(root, "sessions", "sess-a", "knowledge", "b.md"), "written from the remote\n");
    // The single operation the whole mount exists to permit.
    expect(fs.readFileSync(path.join(mount, "knowledge", "b.md"), "utf8")).toBe("written from the remote\n");
  });

  it("never symlinks gateway.json or tmp/ — both are real, host-local", () => {
    runFarm("sess-a");
    const home = path.join(root, "sessions", "sess-a");
    expect(fs.existsSync(path.join(home, "gateway.json"))).toBe(false);
    expect(fs.lstatSync(path.join(home, "tmp")).isSymbolicLink()).toBe(false);
  });

  it("leaves the REAL hook-relay.mjs alone across repeated spawns", () => {
    // The regression: the relay lives at the stage ROOT, outside every
    // session's farm. When it sat inside the farm, `ln -sfn` on the second
    // spawn replaced the real copy with a symlink into the mount — so a mount
    // blip would take the relay, and with it every Stop hook, hanging the turn.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "hook-relay.mjs"), "// the staged real copy\n");
    for (let i = 0; i < 3; i += 1) runFarm("sess-a");
    const relay = path.join(root, "hook-relay.mjs");
    expect(fs.lstatSync(relay).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(relay, "utf8")).toBe("// the staged real copy\n");
  });

  it("reports which per-host assets are really present, so a wiped stage restages", () => {
    fs.mkdirSync(root, { recursive: true });
    expect(runFarm("sess-a")).not.toContain("asset=hook-relay.mjs");

    fs.writeFileSync(path.join(root, "hook-relay.mjs"), "// real\n");
    fs.writeFileSync(path.join(root, "remote-trust-seed.mjs"), "// real\n");
    const out = runFarm("sess-a");
    expect(out).toContain("asset=hook-relay.mjs");
    expect(out).toContain("asset=remote-trust-seed.mjs");

    // A symlink is NOT a real copy — reporting one as present is exactly what
    // would put the relay back on the mount for the hook hot path.
    fs.unlinkSync(path.join(root, "hook-relay.mjs"));
    fs.symlinkSync(path.join(mount, "hook-relay.mjs"), path.join(root, "hook-relay.mjs"));
    expect(runFarm("sess-a")).not.toContain("asset=hook-relay.mjs");
  });

  it("prunes stale symlinks when the gateway home loses a directory", () => {
    runFarm("sess-a");
    const home = path.join(root, "sessions", "sess-a");
    expect(fs.existsSync(path.join(home, "org"))).toBe(true);
    fs.rmSync(path.join(mount, "org"), { recursive: true });
    runFarm("sess-a");
    expect(fs.existsSync(path.join(home, "org"))).toBe(false);
    expect(fs.lstatSync(path.join(home, "knowledge")).isSymbolicLink()).toBe(true);
  });

  it("reaps dead session stages but never the one being prepared", () => {
    runFarm("old-sess");
    runFarm("live-sess");
    const old = path.join(root, "sessions", "old-sess");
    const ago = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(old, ago, ago);
    runFarm("live-sess");
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(root, "sessions", "live-sess"))).toBe(true);
  });

  it("is idempotent and keeps the stage private", () => {
    runFarm("sess-a");
    const before = fs.readdirSync(path.join(root, "sessions", "sess-a")).sort();
    runFarm("sess-a");
    expect(fs.readdirSync(path.join(root, "sessions", "sess-a")).sort()).toEqual(before);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, "sessions", "sess-a")).mode & 0o777).toBe(0o700);
  });
});

describe("buildSshSpawnArgs — the destination is never read as an option", () => {
  it("puts `--` before the destination", () => {
    // Verified against the real ssh: WITHOUT this, `-oProxyCommand=…` as a host
    // is interpreted by the LOCAL ssh and the command runs ON THE GATEWAY.
    // Employees are explicitly told they may hand-edit org YAML, so this is a
    // reachable jump from "can edit a roster file" to gateway code execution.
    const args = build({ destination: "builder@build-box" });
    const at = args.indexOf("builder@build-box");
    expect(at).toBeGreaterThan(-1);
    expect(args[at - 1]).toBe("--");
  });

  it("keeps the remote command as the final argument after its own `--`", () => {
    expect(remoteCommandOf(build())).toContain("exec env");
  });
});

describe.skipIf(isWindows)("buildSshSpawnArgs — the session secret file", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-envfile-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("sources the env file, and keeps the token OUT of the command line", () => {
    const envFile = path.join(dir, "session-env.sh");
    const cmd = remoteCommandOf(build({ envFile }));
    expect(cmd).toContain(`. '${envFile}'`);
    // A remote command line is readable by every process on that host through
    // the process table, so the bearer must never be inlined into it.
    expect(cmd).not.toContain("secret-bearer-token");
  });

  it("the sourced values actually reach the exec'd process", () => {
    const envFile = path.join(dir, "session-env.sh");
    fs.writeFileSync(envFile, [
      `export JINN_GATEWAY_URL='http://127.0.0.1:44321'`,
      `export JINN_GATEWAY_TOKEN='secret-bearer-token'`,
      "",
    ].join("\n"));
    // A real executable, not a shell function: `env` execs a binary, so a
    // function would be invisible to it.
    const fakeClaude = path.join(dir, "fake-claude");
    fs.writeFileSync(fakeClaude, '#!/bin/sh\nprintf "%s|%s" "$JINN_GATEWAY_URL" "$JINN_GATEWAY_TOKEN"\n', { mode: 0o755 });
    const cmd = remoteCommandOf(build({ envFile, remoteCwd: dir, claudeBin: fakeClaude, claudeArgs: [] }));
    // Run it for real. This is the claim that matters: the system prompt tells
    // every session both vars are already exported, and every documented curl —
    // delegation included — is dead if that is not true.
    const out = execFileSync("sh", ["-c", cmd.replace("exec env", "env")], { cwd: dir, encoding: "utf8" });
    expect(out).toBe("http://127.0.0.1:44321|secret-bearer-token");
  });
});

/**
 * The folder-trust seed and the session must agree on which Claude Code profile
 * they are talking about.
 *
 * Claude Code keeps `.claude.json` INSIDE `CLAUDE_CONFIG_DIR`, so a seed run
 * without the variable writes `~/.claude.json` while a session with it reads
 * `<profile>/.claude.json`. The dialog then appears in front of a PTY with
 * nobody at the keyboard and the first turn hangs forever, reporting nothing —
 * indistinguishable from never having seeded at all.
 */
describe("trust seed — profile agreement", () => {
  const FACTS = {
    home: "/home/u",
    stageDir: "/home/u/.jinn-remote-stage",
    nodeBin: "/usr/bin/node",
    claudeBin: "/usr/local/bin/claude",
    jinnVersion: "0.32.0",
    entryDir: "/usr/lib/jinn/src/mcp",
  };
  const PROFILE = "/home/u/.claude-profiles/personal";

  it("runs the seeder under the session's CLAUDE_CONFIG_DIR", () => {
    const cmd = buildTrustSeedCommand(FACTS, "/srv/jinn-work/proj", PROFILE);
    expect(cmd).toContain(`CLAUDE_CONFIG_DIR='${PROFILE}'`);
    // …and before the interpreter, so it is that process's environment.
    expect(cmd.indexOf("CLAUDE_CONFIG_DIR=")).toBeLessThan(cmd.indexOf("/usr/bin/node"));
  });

  it("sets no profile when none is configured, matching a default-profile session", () => {
    expect(buildTrustSeedCommand(FACTS, "/srv/jinn-work/proj", undefined)).not.toContain("CLAUDE_CONFIG_DIR");
  });

  // Run the real command through a real shell, with `node` shadowed by a
  // function that prints the variable. This proves the value reaches the
  // interpreter's ENVIRONMENT intact — not merely that it appears in the string.
  it.skipIf(process.platform === "win32")("delivers a profile path with quotes and spaces intact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-seed-"));
    try {
      const profile = "/home/u/profiles/it's here";
      const cmd = buildTrustSeedCommand({ ...FACTS, nodeBin: "node" }, dir, profile);
      const shown = execFileSync("sh", ["-c", `node() { printf %s "$CLAUDE_CONFIG_DIR"; }\n${cmd}`], {
        encoding: "utf8",
      });
      expect(shown).toBe(profile);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-seeds when the profile changes, because trust lives in the profile", () => {
    const a = trustSeedKey("box", "/srv/jinn-work/proj", PROFILE);
    const b = trustSeedKey("box", "/srv/jinn-work/proj", "/home/u/.claude-profiles/work");
    const none = trustSeedKey("box", "/srv/jinn-work/proj", undefined);
    expect(new Set([a, b, none]).size).toBe(3);
  });

  it("does not re-seed the same profile and directory twice", () => {
    expect(trustSeedKey("box", "/srv/jinn-work/proj", PROFILE))
      .toBe(trustSeedKey("box", "/srv/jinn-work/proj", PROFILE));
  });
});


/**
 * The wake budget.
 *
 * A real startup path is not a packet: it may probe reachability, read a power
 * state over the network, press a physical ATX button, then wait for POST. The
 * dangerous kill is the one that lands BETWEEN the state read and the press —
 * the host never wakes and the turn just times out with nothing to show.
 */
describe("wakeCommand timeout", () => {
  // Driven directly rather than through ensureRemoteReady: that path spawns real
  // ssh probes, which are slow and can outlive the test as unhandled child
  // errors — a test that reddens CI at random is worse than no test.

  it("lets a command run well past the old thirty-second limit", async () => {
    const started = Date.now();
    await runLocalWakeCommand("sleep 0.3", 300_000);
    const elapsed = Date.now() - started;
    // Ran to completion rather than being cut short.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it("still kills a command that overruns its budget", async () => {
    const started = Date.now();
    await runLocalWakeCommand("sleep 30", 300);
    // Without the kill this would take 30s.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 40_000);

  it("returns rather than throwing when the command cannot start", async () => {
    // A wake is best-effort: reachability is the real verdict, so a broken
    // command must not take the turn down with it.
    await expect(runLocalWakeCommand("definitely-not-a-real-binary-xyz", 5_000)).resolves.toBeUndefined();
  }, 20_000);
});