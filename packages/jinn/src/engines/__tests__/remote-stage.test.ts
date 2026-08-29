import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { shq, buildSshSpawnArgs, sendWakeOnLan } from "../remote-stage.js";

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

/** The remote command is the last argv element, after the `--` separator. */
function remoteCommandOf(args: string[]): string {
  expect(args[args.length - 2]).toBe("--");
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

  it("names the destination immediately before the `--` separator", () => {
    expect(args[args.length - 3]).toBe("builder@build-box");
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
