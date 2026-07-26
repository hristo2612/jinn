#!/usr/bin/env node
/**
 * Cross-platform build for jinn-cli.
 *
 * This was a shell one-liner (`rm -rf … && tsc && mkdir -p … && cp …`). npm and
 * pnpm run package scripts through the platform shell, which on Windows is cmd —
 * where none of those commands exist, so `pnpm build` failed with "The syntax of
 * the command is incorrect" and the repo could not be built there at all. Node's
 * own fs APIs do the same work on every platform.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(packageRoot, "dist");
const require = createRequire(import.meta.url);

/** Run TypeScript's own entry with the current Node. Resolving the JS entry
 *  instead of the `tsc` shim keeps this shell-free, which avoids both the
 *  Windows .CMD resolution problem and shell argument concatenation. */
function runTsc(args) {
  const tsc = require.resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd: packageRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 1. Clear only the compiled output. dist/web is produced separately by
//    scripts/sync-web-dist.mjs and must survive a package rebuild.
for (const dir of ["bin", "src"]) {
  fs.rmSync(path.join(dist, dir), { recursive: true, force: true });
}

// 2. Compile.
runTsc(["-p", "tsconfig.build.json"]);

// 3. Copy the Talk assets tsc does not emit (Markdown + Python live beside the
//    TypeScript). Missing files are not an error: they are optional extras.
const talkSource = path.join(packageRoot, "src", "talk");
const talkTarget = path.join(dist, "src", "talk");
fs.mkdirSync(talkTarget, { recursive: true });
let copied = 0;
try {
  for (const entry of fs.readdirSync(talkSource)) {
    if (!/\.(md|py)$/i.test(entry)) continue;
    fs.copyFileSync(path.join(talkSource, entry), path.join(talkTarget, entry));
    copied += 1;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(`build: compiled to dist/, copied ${copied} talk asset(s)`);
