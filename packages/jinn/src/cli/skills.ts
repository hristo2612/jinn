import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { JINN_HOME, SKILLS_DIR } from "../shared/paths.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export const SKILLS_JSON = path.join(JINN_HOME, "skills.json");

/** Well-known directories where `npx skills add -g` may install skills. */
const GLOBAL_SKILL_DIRS = [
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
  path.join(os.homedir(), ".codex", "skills"),
];

// ── Manifest helpers ──────────────────────────────────────────────

export interface SkillManifestEntry {
  name: string;
  source: string;
  installedAt: string;
}

export function readManifest(): SkillManifestEntry[] {
  if (!fs.existsSync(SKILLS_JSON)) return [];
  try {
    return JSON.parse(fs.readFileSync(SKILLS_JSON, "utf-8"));
  } catch {
    return [];
  }
}

export function writeManifest(entries: SkillManifestEntry[]): void {
  fs.writeFileSync(SKILLS_JSON, JSON.stringify(entries, null, 2) + "\n");
}

export function upsertManifest(name: string, source: string): void {
  const manifest = readManifest();
  const idx = manifest.findIndex((e) => e.name === name);
  const entry: SkillManifestEntry = {
    name,
    source,
    installedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    manifest[idx] = entry;
  } else {
    manifest.push(entry);
  }
  writeManifest(manifest);
}

export function removeFromManifest(name: string): boolean {
  const manifest = readManifest();
  const idx = manifest.findIndex((e) => e.name === name);
  if (idx < 0) return false;
  manifest.splice(idx, 1);
  writeManifest(manifest);
  return true;
}

// ── Snapshot helpers for detecting newly installed skills ─────────

export function snapshotDirs(): Map<string, Set<string>> {
  const snap = new Map<string, Set<string>>();
  for (const dir of GLOBAL_SKILL_DIRS) {
    if (!fs.existsSync(dir)) {
      snap.set(dir, new Set());
      continue;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    snap.set(dir, new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name)));
  }
  return snap;
}

export function diffSnapshots(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>,
): Array<{ dir: string; name: string }> {
  const newEntries: Array<{ dir: string; name: string }> = [];
  for (const [dir, afterSet] of after) {
    const beforeSet = before.get(dir) || new Set();
    for (const name of afterSet) {
      if (!beforeSet.has(name)) {
        newEntries.push({ dir, name });
      }
    }
  }
  return newEntries;
}

// ── Helpers ───────────────────────────────────────────────────────

export function extractSkillName(pkg: string): string {
  // "owner/repo@skill-name" → "skill-name"
  const atIdx = pkg.lastIndexOf("@");
  if (atIdx > 0) return pkg.slice(atIdx + 1);
  // "owner/repo" → "repo"
  const slashIdx = pkg.lastIndexOf("/");
  if (slashIdx >= 0) return pkg.slice(slashIdx + 1);
  return pkg;
}

export function findExistingSkill(name: string): { name: string; dir: string } | null {
  for (const dir of GLOBAL_SKILL_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return { name, dir: candidate };
    }
  }
  return null;
}

/** Characters that could break out of a cmd.exe command line. */
const WINDOWS_UNSAFE_ARG = /["&|<>^%`\r\n]/;

/**
 * Quote one argument for a Windows command line.
 *
 * Windows programs parse their own command line with MSVCRT rules, where a run
 * of backslashes immediately before a quote escapes it. Wrapping bare in
 * `"${arg}"` therefore breaks for any argument ending in a backslash: `trailing\`
 * became `"trailing\"`, the closing quote was consumed, and the child received
 * `trailing"` — smuggling in exactly the quote character WINDOWS_UNSAFE_ARG
 * exists to reject, and letting one argument swallow the next.
 *
 * A run of 2n backslashes before the closing quote yields n literal
 * backslashes and still terminates the string, so double only that final run.
 * Interior backslashes are literal and must not be touched, or every Windows
 * path argument would be mangled.
 */
export function quoteWindowsArg(arg: string): string {
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

export function runNpxSkills(args: string[], stdio: "inherit" | "pipe" = "inherit"): { status: number | null } {
  if (process.platform === "win32") {
    // Windows ships npx as npx.cmd, which Node refuses to spawn without a shell
    // (EINVAL since Node 18.20.2). Args are user-controlled, so reject anything
    // that could escape the quoting below instead of trusting the shell.
    const unsafe = args.find((a) => WINDOWS_UNSAFE_ARG.test(a));
    if (unsafe !== undefined) {
      console.error(`${RED}Refusing to run: argument contains shell metacharacters: ${unsafe}${RESET}`);
      return { status: 1 };
    }
    return spawnSync("npx", ["skills", ...args].map(quoteWindowsArg), { stdio, shell: true });
  }
  return spawnSync("npx", ["skills", ...args], {
    stdio,
    shell: false,
  });
}

export function copySkillToInstance(name: string, sourceDir: string): void {
  const destDir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(destDir, { recursive: true });
  copyDirRecursive(sourceDir, destDir);
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── CLI action functions ──────────────────────────────────────────

export function skillsFind(query?: string): void {
  const args = ["find"];
  if (query) args.push(query);
  const result = runNpxSkills(args);
  process.exitCode = result.status ?? 1;
}

export function skillsAdd(pkg: string): void {
  console.log(`\nInstalling skill: ${pkg}\n`);

  // Snapshot before
  const before = snapshotDirs();

  // Run npx skills add
  const result = runNpxSkills(["add", pkg, "-g", "-y"]);

  if (result.status !== 0) {
    console.error(`\n${RED}Failed to install skill.${RESET}`);
    process.exitCode = 1;
    return;
  }

  // Snapshot after to detect new directories
  const after = snapshotDirs();
  const newDirs = diffSnapshots(before, after);

  if (newDirs.length === 0) {
    // Skill may have been already installed globally — try to find it by name
    const skillName = extractSkillName(pkg);
    const existing = findExistingSkill(skillName);
    if (existing) {
      copySkillToInstance(existing.name, existing.dir);
      upsertManifest(existing.name, pkg);
      console.log(`\n${GREEN}Skill "${existing.name}" added to ${SKILLS_DIR}${RESET}`);
    } else {
      console.log(`\n${YELLOW}Skill installed globally but could not locate the directory.${RESET}`);
    }
    return;
  }

  // Copy first new directory to our skills dir
  const installed = newDirs[0];
  copySkillToInstance(installed.name, path.join(installed.dir, installed.name));
  upsertManifest(installed.name, pkg);
  console.log(`\n${GREEN}Skill "${installed.name}" added to ${SKILLS_DIR}${RESET}`);
}

export function skillsRemove(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(skillDir)) {
    console.error(`${RED}Skill "${name}" not found in ${SKILLS_DIR}${RESET}`);
    process.exitCode = 1;
    return;
  }

  fs.rmSync(skillDir, { recursive: true, force: true });
  removeFromManifest(name);
  console.log(`${GREEN}Skill "${name}" removed.${RESET}`);
}

export function skillsList(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log("No skills installed.");
    return;
  }

  const manifest = readManifest();
  const manifestMap = new Map(manifest.map((e) => [e.name, e]));

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());

  if (skillDirs.length === 0) {
    console.log("No skills installed.");
    return;
  }

  console.log(`\n  Skills in ${DIM}${SKILLS_DIR}${RESET}\n`);
  for (const dir of skillDirs) {
    const meta = manifestMap.get(dir.name);
    const source = meta ? `${DIM}(${meta.source})${RESET}` : `${DIM}(local)${RESET}`;
    const skillMd = path.join(SKILLS_DIR, dir.name, "SKILL.md");
    let description = "";
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/description:\s*(.+)/);
        if (descMatch) description = `  ${DIM}${descMatch[1].trim()}${RESET}`;
      }
    }
    console.log(`  ${GREEN}${dir.name}${RESET} ${source}${description}`);
  }
  console.log("");
}

export function skillsUpdate(): void {
  const manifest = readManifest();
  if (manifest.length === 0) {
    console.log("No skills in manifest to update.");
    return;
  }

  console.log(`\nUpdating ${manifest.length} skill(s)...\n`);
  for (const entry of manifest) {
    console.log(`  Updating ${entry.name} from ${entry.source}...`);
    const before = snapshotDirs();
    const result = runNpxSkills(["add", entry.source, "-g", "-y"], "pipe");

    if (result.status !== 0) {
      console.log(`  ${RED}Failed to update ${entry.name}${RESET}`);
      continue;
    }

    const after = snapshotDirs();
    const newDirs = diffSnapshots(before, after);
    if (newDirs.length > 0) {
      copySkillToInstance(newDirs[0].name, path.join(newDirs[0].dir, newDirs[0].name));
    } else {
      const existing = findExistingSkill(entry.name);
      if (existing) {
        copySkillToInstance(existing.name, existing.dir);
      }
    }
    upsertManifest(entry.name, entry.source);
    console.log(`  ${GREEN}Updated ${entry.name}${RESET}`);
  }
  console.log("");
}

export function skillsRestore(): void {
  const manifest = readManifest();
  if (manifest.length === 0) {
    console.log("No skills in manifest to restore.");
    return;
  }

  console.log(`\nRestoring ${manifest.length} skill(s)...\n`);
  for (const entry of manifest) {
    const destDir = path.join(SKILLS_DIR, entry.name);
    if (fs.existsSync(destDir)) {
      console.log(`  ${DIM}${entry.name} already exists, skipping${RESET}`);
      continue;
    }

    console.log(`  Installing ${entry.name} from ${entry.source}...`);
    const before = snapshotDirs();
    const result = runNpxSkills(["add", entry.source, "-g", "-y"], "pipe");

    if (result.status !== 0) {
      console.log(`  ${RED}Failed to install ${entry.name}${RESET}`);
      continue;
    }

    const after = snapshotDirs();
    const newDirs = diffSnapshots(before, after);
    if (newDirs.length > 0) {
      copySkillToInstance(newDirs[0].name, path.join(newDirs[0].dir, newDirs[0].name));
    } else {
      const existing = findExistingSkill(entry.name);
      if (existing) {
        copySkillToInstance(existing.name, existing.dir);
      }
    }
    console.log(`  ${GREEN}Restored ${entry.name}${RESET}`);
  }
  console.log("");
}
