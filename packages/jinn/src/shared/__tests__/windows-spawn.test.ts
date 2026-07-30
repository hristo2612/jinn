import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { cmdExePath, needsCmdShim, spawnableCommand, windowsRoot } from "../windows-spawn.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-winspawn-"));
  roots.push(dir);
  return dir;
}

describe("windowsRoot", () => {
  const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("prefers SystemRoot, then windir", () => {
    process.env.SystemRoot = "D:\\Alt";
    process.env.windir = "E:\\Other";
    expect(windowsRoot()).toBe("D:\\Alt");
    delete process.env.SystemRoot;
    expect(windowsRoot()).toBe("E:\\Other");
  });

  it("falls back to a ROOTED default when the environment omits both", () => {
    // Regression: one of two copies of this fallback was written "C:\Windows",
    // where \W is not an escape sequence — JavaScript dropped the backslash and
    // produced the drive-RELATIVE "C:Windows". taskkill.exe beneath it cannot be
    // found, and killProcessTree's catch then silently degraded to a plain kill,
    // leaving the grandchild it exists to reap. Reachable in a stripped service
    // environment where neither variable is set.
    delete process.env.SystemRoot;
    delete process.env.windir;
    expect(windowsRoot()).toBe("C:\\Windows");
    expect(path.win32.isAbsolute(windowsRoot())).toBe(true);
    // Pin the distinction the bug turned on, so the assertion above cannot be
    // "fixed" later by matching whatever the code happens to produce.
    expect(path.win32.isAbsolute("C:Windows")).toBe(false);
  });

  it("keeps every System32 consumer rooted, not just the one that was correct", () => {
    delete process.env.SystemRoot;
    delete process.env.windir;
    // cmdExePath and killProcessTree's taskkill share this resolver now, so one
    // assertion covers both rather than each carrying its own copy to proofread.
    expect(path.win32.isAbsolute(cmdExePath().replace(/\//g, "\\"))).toBe(true);
    expect(cmdExePath()).toContain("System32");
  });
});

describe("needsCmdShim", () => {
  it.skipIf(process.platform !== "win32")("recognises the extensions Node refuses to spawn", () => {
    expect(needsCmdShim("C:\\tools\\codex.cmd")).toBe(true);
    expect(needsCmdShim("C:\\tools\\codex.BAT")).toBe(true);
    expect(needsCmdShim("C:\\tools\\codex.exe")).toBe(false);
    expect(needsCmdShim("codex")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("never rewrites anything off Windows", () => {
    // A POSIX file may legitimately be named `foo.cmd`; only Windows' loader
    // treats the extension as meaningful.
    expect(needsCmdShim("/usr/local/bin/codex.cmd")).toBe(false);
    expect(needsCmdShim("/usr/local/bin/codex")).toBe(false);
  });
});

describe("spawnableCommand", () => {
  it("passes a normal binary through untouched", () => {
    expect(spawnableCommand("/usr/local/bin/codex", ["app-server", "--stdio"])).toEqual({
      command: "/usr/local/bin/codex",
      args: ["app-server", "--stdio"],
      options: {},
    });
  });

  it.skipIf(process.platform !== "win32")("routes a shim through cmd.exe from System32", () => {
    const { command, args, options } = spawnableCommand("C:\\tools\\codex.cmd", ["app-server", "--stdio"]);
    expect(command.toLowerCase()).toContain("system32\\cmd.exe");
    // Without this Node applies its own quoting on top of the line built here and
    // cmd.exe reports the whole thing as an unrecognised command.
    expect(options.windowsVerbatimArguments).toBe(true);
    // /d so a registry AutoRun cannot inject work into every engine spawn.
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(args[3]).toBe('""C:\\tools\\codex.cmd" "app-server" "--stdio""');
  });

  it.skipIf(process.platform !== "win32")("doubles a trailing backslash run so it cannot escape the quote", () => {
    // A directory argument ends in a backslash routinely. `C:\work\` + `"`
    // becomes `C:\work\"`, escaping the closing quote and swallowing whatever
    // follows — the same hazard cli/skills.ts documents for npx.
    const { args } = spawnableCommand("C:\\tools\\codex.cmd", ["C:\\work\\", "--stdio"]);
    expect(args[3]).toContain('"C:\\work\\\\"');
    expect(args[3]).toContain('"--stdio"');
  });
});

describe("spawnableCommand against a real shim", () => {
  it.skipIf(process.platform !== "win32")("runs a .cmd that a bare spawn cannot", async () => {
    const dir = tempDir();
    const shim = path.join(dir, "echo-args.cmd");
    fs.writeFileSync(shim, "@echo off\r\necho ARGS:%1,%2\r\n");

    // The regression itself: Node refuses the shim without an interpreter.
    const bare = spawnSync(shim, ["alpha", "beta"], { encoding: "utf-8" });
    expect(bare.error).toBeTruthy();
    expect((bare.error as NodeJS.ErrnoException).code).toBe("EINVAL");

    const { command, args, options } = spawnableCommand(shim, ["alpha", "beta"]);
    const out = execFileSync(command, args, { encoding: "utf-8", windowsHide: true, ...options });
    expect(out).toContain("ARGS:");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });
});
