import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO = join(PKG, "..", "..");

const SCAN_PATHS = [
  "CHANGELOG.md",
  "LICENSE",
  "docs",
  "packages/jinn/template",
  "packages/jinn/src",
  "packages/web/src",
];

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const BLOCKED_TERMS = [
  ["hris", "to"].join(""),
  ["jim", "my"].join(""),
  ["jim", "my", "english"].join(""),
  ["prav", "ko"].join(""),
  ["move", "kit"].join(""),
  ["sql", "noir"].join(""),
  ["ho", "my"].join(""),
  ["spy", "cam"].join(""),
  ["aso", "maniac"].join(""),
  ["kiwi", "labs"].join(""),
  ["kiwi", " labs"].join(""),
  ["tucker", "@"].join(""),
  ["/", "Users", "/", "jim", "my", "english"].join(""),
];

function listTrackedTextFiles(repo: string, scanPaths: string[]): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...scanPaths], {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return tracked
    .split("\0")
    .filter((path) => path.length > 0 && TEXT_EXTENSIONS.has(extname(path)))
    .map((path) => join(repo, path));
}

function findBlockedTerms(files: string[], root: string): string[] {
  const findings: string[] = [];

  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const lower = text.toLowerCase();
    for (const term of BLOCKED_TERMS) {
      const index = lower.indexOf(term.toLowerCase());
      if (index === -1) continue;
      const line = text.slice(0, index).split(/\r?\n/).length;
      findings.push(`${relative(root, file)}:${line} contains "${term}"`);
    }
  }

  return findings;
}

describe("privacy guard", () => {
  it("keeps local sprint/evidence sandboxes out of the repository", () => {
    const localSprintDirs = readdirSync(REPO, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\.jinn-.*-sprint$/.test(name));

    expect(localSprintDirs).toEqual([]);
  });

  it("keeps shipped templates and public source fixtures generic", () => {
    expect(findBlockedTerms(listTrackedTextFiles(REPO, SCAN_PATHS), REPO)).toEqual([]);
  });

  it("ignores an untracked personal path but catches it once tracked", () => {
    const repo = mkdtempSync(join(tmpdir(), "jinn-privacy-guard-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "ignore" });
      mkdirSync(join(repo, "docs"));
      const scratch = join(repo, "docs", "scratch.md");
      writeFileSync(scratch, `local path: ${BLOCKED_TERMS.at(-1)}/scratch\n`);

      expect(findBlockedTerms(listTrackedTextFiles(repo, ["docs"]), repo)).toEqual([]);

      execFileSync("git", ["add", "--", "docs/scratch.md"], { cwd: repo, stdio: "ignore" });
      const findings = findBlockedTerms(listTrackedTextFiles(repo, ["docs"]), repo);
      expect(findings).not.toEqual([]);
      expect(findings).toEqual(
        expect.arrayContaining([expect.stringContaining("docs/scratch.md:1 contains")]),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
