#!/usr/bin/env node
/**
 * Runs the node suites that exercise POSIX host tooling, and says so instead of running them
 * on Windows.
 *
 * These six files test the maintainer's tools, not shipped product code: the upgrade lab reads
 * the process table with `ps`, the deliverable recorder shells out to `shasum`, the worktree
 * reaper depends on git worktree and symlink semantics, and the prerelease converter compiles a
 * C helper built on `openat`/`dirent.h`. None of that exists on Windows, and none of it ever
 * runs there — the tools are invoked from a maintainer's macOS or Linux checkout.
 *
 * Linux is deliberately NOT skipped. `test:node:host` once gated these to Darwin alone; making
 * them run on Linux was real work (0bc1ab0d) and this keeps that coverage. The line is POSIX vs
 * not, which is the line the tools themselves draw.
 */
import { spawnSync } from "node:child_process";

const SUITES = [
  "scripts/__tests__/deliverable-evidence.test.mjs",
  "scripts/__tests__/device-scroll-fixture.test.mjs",
  "scripts/__tests__/reap-worktrees.test.mjs",
  "scripts/upgrade-lab/__tests__/guards.test.mjs",
  "tools/prerelease-todo-converter/__tests__/artifacts.test.mjs",
  "tools/prerelease-todo-converter/__tests__/backup.test.mjs",
];

if (process.platform === "win32") {
  console.log(`skipping ${SUITES.length} POSIX-only node suites on win32 — they test host tooling `
    + "(ps, shasum, git worktrees, openat) that does not exist here; see scripts/run-posix-suites.mjs");
  process.exit(0);
}

const run = spawnSync(process.execPath, ["--test", ...SUITES], { stdio: "inherit" });
process.exit(run.status ?? 1);
