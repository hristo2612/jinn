import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionSettings, writeSessionSettings, sessionSettingsPath, seedTrust } from "../claude-settings.js";

describe("claude-settings", () => {
  it("buildSessionSettings registers Stop/SessionStart/StopFailure hooks pointing at the relay with the session id", () => {
    const s = buildSessionSettings({ sessionId: "jinn-abc", relayScript: "/h/relay.mjs", appendSystemPrompt: "SYS" });
    const stop = s.hooks.Stop[0].hooks[0];
    expect(stop.type).toBe("command");
    expect(stop.command).toMatch(/relay\.mjs.*jinn-abc/);
    expect(s.hooks.SessionStart && s.hooks.PreToolUse && s.hooks.PostToolUse && s.hooks.StopFailure).toBeTruthy();
    expect(s.appendSystemPrompt).toBe("SYS");
  });

  it("writeSessionSettings writes atomically and is readable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-"));
    const p = writeSessionSettings(dir, "jinn-xyz", { sessionId: "jinn-xyz", relayScript: "/h/relay.mjs" });
    expect(p).toBe(sessionSettingsPath(dir, "jinn-xyz"));
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    expect(parsed.hooks.Stop).toBeTruthy();
    expect(fs.existsSync(`${p}.tmp`)).toBe(false);
  });

  it("seedTrust is idempotent and uses the realpath", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    const claudeJson = path.join(home, ".claude.json");
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proj-")));
    seedTrust(claudeJson, projectDir);
    seedTrust(claudeJson, projectDir);
    const d = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
    expect(d.projects[projectDir].hasTrustDialogAccepted).toBe(true);
    expect(d.projects[projectDir].hasCompletedProjectOnboarding).toBe(true);
    expect(d.hasCompletedOnboarding).toBe(true);
    expect(d.hasCompletedClaudeInChromeOnboarding).toBe(true);
  });

  it("seedTrust writes a one-time backup of a pre-existing ~/.claude.json before first modification", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    const claudeJson = path.join(home, ".claude.json");
    const backup = `${claudeJson}.jinn-backup`;
    const original = JSON.stringify({ projects: {}, userSetting: "keep-me" });
    fs.writeFileSync(claudeJson, original);
    const projA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proj-")));
    const projB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proj-")));
    seedTrust(claudeJson, projA);
    expect(fs.readFileSync(backup, "utf-8")).toBe(original); // pristine pre-Jinn copy
    seedTrust(claudeJson, projB); // second modification must NOT overwrite the backup
    expect(fs.readFileSync(backup, "utf-8")).toBe(original);
  });

  it("seedTrust does not create a backup when ~/.claude.json doesn't exist yet", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    const claudeJson = path.join(home, ".claude.json");
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proj-")));
    seedTrust(claudeJson, projectDir);
    expect(fs.existsSync(`${claudeJson}.jinn-backup`)).toBe(false);
  });
});
