#!/usr/bin/env node
// Jinn remote trust seed. Staged onto a remote SSH host and invoked there as:
//   node remote-trust-seed.mjs <remoteProjectDir>
//
// The gateway seeds its OWN ~/.claude.json at boot (src/gateway/server.ts, seedTrust).
// A session running over SSH gets a Claude Code process on a different machine, whose
// config file the gateway cannot touch — so the folder-trust dialog is still armed there.
// That dialog is a silent deadlock, not a nuisance: parsePermissionPrompt() in
// src/engines/claude-permission-prompt.ts only recognises the strict
// "Do you want to proceed?" shape, so the trust dialog fires no Notification hook and
// the first turn waits forever on a prompt nobody will ever answer.
//
// Standalone by necessity — the remote host has no Jinn install, so this file carries a
// copy of applyTrustSeed() from src/shared/claude-settings.ts rather than importing it.
// src/shared/__tests__/remote-trust-seed.test.ts runs this script and deep-compares the
// JSON it produces against applyTrustSeed()'s, so the copy cannot drift unnoticed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mirrors claudeJsonPath() in src/shared/home.ts, resolved against THIS host's
// environment: CLAUDE_CONFIG_DIR moves .claude.json inside the config dir, and its
// absence puts it beside the home directory.
function claudeJsonPath() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR), ".claude.json");
  return path.join(os.homedir(), ".claude.json");
}

// Copy of applyTrustSeed() in src/shared/claude-settings.ts — keep the two in step.
function applyTrustSeed(data, realProjectDir) {
  data.projects ??= {};
  const proj = (data.projects[realProjectDir] ??= {});
  const alreadySeeded =
    data.hasCompletedOnboarding === true &&
    data.hasCompletedClaudeInChromeOnboarding === true &&
    proj.hasTrustDialogAccepted === true &&
    proj.hasCompletedProjectOnboarding === true;
  if (alreadySeeded) return { data, changed: false };
  data.hasCompletedOnboarding = true;
  data.hasCompletedClaudeInChromeOnboarding = true;
  proj.hasTrustDialogAccepted = true;
  proj.hasCompletedProjectOnboarding = true;
  proj.allowedTools ??= [];
  return { data, changed: true };
}

function main() {
  const projectDir = process.argv[2];
  if (!projectDir) throw new Error("usage: node remote-trust-seed.mjs <remoteProjectDir>");
  // Claude Code keys its per-project state by the resolved path, so a symlinked
  // checkout seeded under its link name leaves the real one untrusted.
  const realDir = fs.realpathSync(projectDir);

  const claudeJsonFile = claudeJsonPath();
  let data = {};
  try { data = JSON.parse(fs.readFileSync(claudeJsonFile, "utf-8")); } catch { /* new file */ }
  const seeded = applyTrustSeed(data, realDir);
  if (!seeded.changed) {
    process.stdout.write("jinn-trust-seed: ok changed=false\n");
    return;
  }

  // About to modify a real user's ~/.claude.json on a machine that is not ours — keep a
  // one-time backup of the pre-Jinn original (no timestamped proliferation; first write wins).
  const backupPath = `${claudeJsonFile}.jinn-backup`;
  if (fs.existsSync(claudeJsonFile) && !fs.existsSync(backupPath)) {
    try { fs.copyFileSync(claudeJsonFile, backupPath, fs.constants.COPYFILE_EXCL); } catch { /* best effort */ }
  }
  // Under CLAUDE_CONFIG_DIR the target directory may not exist yet. 0700 because
  // credentials and transcripts land there.
  fs.mkdirSync(path.dirname(claudeJsonFile), { recursive: true, mode: 0o700 });
  const tmp = `${claudeJsonFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seeded.data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, claudeJsonFile);
  // Defensive: rename does not reliably carry the source mode onto a pre-existing
  // destination inode across platforms and filesystems — be explicit.
  fs.chmodSync(claudeJsonFile, 0o600);
  process.stdout.write("jinn-trust-seed: ok changed=true\n");
}

try {
  main();
} catch (err) {
  // A failure here is not cosmetic: the first remote turn would hang on the dialog this
  // script exists to answer, so say so loudly rather than exiting 0 like the hook relay.
  process.stderr.write(`jinn-trust-seed: failed: ${err?.message ?? err}\n`);
  process.exitCode = 1;
}
