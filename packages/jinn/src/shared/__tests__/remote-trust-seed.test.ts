import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyTrustSeed } from "../claude-settings.js";

const ASSET = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "assets", "remote-trust-seed.mjs");

function tmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Run the staged asset the way the remote host does: node <asset> <projectDir>. */
function runSeed(configDir: string, projectDir: string): string {
  return execFileSync(process.execPath, [ASSET, projectDir], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
}

describe("remote-trust-seed asset", () => {
  it("ships in the published tarball", () => {
    // Staged onto the remote host from the installed package; if assets/ ever stops
    // being published, the remote path silently loses its only trust seeder.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "package.json"), "utf-8"),
    );
    expect(pkg.files).toContain("assets/");
    expect(fs.existsSync(ASSET)).toBe(true);
  });

  it("produces exactly the JSON applyTrustSeed produces", () => {
    // The whole point of this file: two implementations of one key set, one of which
    // runs on a machine that cannot import the other. If they drift, the remote host
    // gets a config Claude Code still blocks on and the first turn hangs forever.
    const configDir = path.join(tmpDir("cfg-"), "not-created-yet");
    const projectDir = tmpDir("proj-");

    runSeed(configDir, projectDir);

    const written = JSON.parse(fs.readFileSync(path.join(configDir, ".claude.json"), "utf-8"));
    expect(written).toEqual(applyTrustSeed({}, projectDir).data);
  });

  it("resolves .claude.json from its own CLAUDE_CONFIG_DIR", () => {
    const configDir = tmpDir("cfg-");
    const projectDir = tmpDir("proj-");
    const stdout = runSeed(configDir, projectDir);
    expect(stdout.trim()).toBe("jinn-trust-seed: ok changed=true");
    expect(fs.existsSync(path.join(configDir, ".claude.json"))).toBe(true);
  });

  it("is idempotent: a second run changes nothing", () => {
    const configDir = tmpDir("cfg-");
    const projectDir = tmpDir("proj-");
    const claudeJson = path.join(configDir, ".claude.json");

    expect(runSeed(configDir, projectDir).trim()).toBe("jinn-trust-seed: ok changed=true");
    const afterFirst = fs.readFileSync(claudeJson, "utf-8");

    expect(runSeed(configDir, projectDir).trim()).toBe("jinn-trust-seed: ok changed=false");
    expect(fs.readFileSync(claudeJson, "utf-8")).toBe(afterFirst);
  });

  it("backs a pre-existing config up exactly once, preserving unrelated keys", () => {
    const configDir = tmpDir("cfg-");
    const claudeJson = path.join(configDir, ".claude.json");
    const backup = `${claudeJson}.jinn-backup`;
    const original = JSON.stringify({ projects: {}, userSetting: "keep-me" });
    fs.writeFileSync(claudeJson, original);

    runSeed(configDir, tmpDir("proj-"));
    expect(fs.readFileSync(backup, "utf-8")).toBe(original); // pristine pre-Jinn copy

    runSeed(configDir, tmpDir("proj-")); // a second modification must not overwrite it
    expect(fs.readFileSync(backup, "utf-8")).toBe(original);
    expect(fs.readdirSync(configDir).filter((f) => f.includes("jinn-backup"))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(claudeJson, "utf-8")).userSetting).toBe("keep-me");
  });

  it("does not accept bypass-permissions consent on the remote host either", () => {
    const configDir = tmpDir("cfg-");
    const claudeJson = path.join(configDir, ".claude.json");
    fs.writeFileSync(claudeJson, JSON.stringify({ bypassPermissionsModeAccepted: false }));

    runSeed(configDir, tmpDir("proj-"));

    expect(JSON.parse(fs.readFileSync(claudeJson, "utf-8")).bypassPermissionsModeAccepted).toBe(false);
  });

  it("exits non-zero with a message when it cannot resolve the project dir", () => {
    const configDir = tmpDir("cfg-");
    let status: number | undefined;
    let stderr = "";
    try {
      execFileSync(process.execPath, [ASSET, path.join(configDir, "no-such-project")], {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        stdio: ["ignore", "ignore", "pipe"],
      });
      status = 0;
    } catch (err: any) {
      status = err.status;
      stderr = String(err.stderr ?? "");
    }
    expect(status).not.toBe(0);
    expect(stderr).toContain("jinn-trust-seed: failed");
  });

  it("cleans its lock up, and breaks one left behind by a killed run", () => {
    const configDir = tmpDir("cfg-lock-");
    const lock = path.join(configDir, ".claude.json.jinn-lock");
    // A lock whose owner died must not wedge the host forever — that would turn
    // one crashed seed into a permanent hang for every project on the box.
    fs.writeFileSync(lock, "");
    const stale = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, stale, stale);

    expect(runSeed(configDir, tmpDir("proj-lock-"))).toContain("changed=true");
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(configDir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
