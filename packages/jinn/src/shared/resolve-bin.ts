import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Dynamic engine-binary resolution.
 *
 * Jinn ships to other users' machines, so engine binaries must NEVER be
 * hardcoded to an absolute path. We resolve a binary the same way a shell
 * would (search PATH), plus a few common install dirs that aren't always on
 * a daemon's PATH (notably `~/.local/bin`, where the Antigravity installer
 * drops `agy`). An optional config override (`engines.<name>.bin`) wins.
 */

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // Windows has no executable bit: X_OK succeeds for any readable file, so the
    // check is meaningless there and what makes a file runnable is its extension
    // (see windowsCandidates).
    if (process.platform === "win32") return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Extensions Windows will actually execute, most-specific first.
 *
 *  A CLI installed by npm on Windows is `name.cmd`, never a bare `name`, so
 *  joining dir + name finds nothing and resolution falls through to the bare
 *  name — which CreateProcess then cannot start either, because it tries .exe
 *  and .com but not .cmd. Both halves have to know about PATHEXT. */
function windowsCandidates(name: string): string[] {
  if (path.extname(name)) return [name]; // already explicit
  const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [...pathext.map((ext) => `${name}${ext.toLowerCase()}`), name];
}

/** Common install locations not guaranteed to be on a daemon's PATH. */
export function commonBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, "bin"),
    path.join(home, ".npm-global", "bin"), // npm global prefix (common override)
    "/opt/homebrew/lib/node_modules/.bin", // homebrew node global bins
  ];
}

/**
 * Resolve an engine binary to an absolute path.
 *
 * Resolution order:
 *   1. `override` that looks like a path (contains a separator) → returned
 *      verbatim, even if missing, so a wrong config surfaces a clear spawn error.
 *   2. `override` that is a bare name → resolved as if it were `name`.
 *   3. First match on `$PATH`.
 *   4. First match in {@link commonBinDirs}.
 *   5. Fallback: the bare `name`, letting `spawn`/`pty.spawn` try its own PATH.
 */
/** First executable match for `name` on PATH then {@link commonBinDirs}, or null. */
function findOnPath(name: string): string | null {
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const seen = new Set<string>();
  for (const dir of [...pathDirs, ...commonBinDirs()]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const names = process.platform === "win32" ? windowsCandidates(name) : [name];
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

export function resolveBin(name: string, override?: string): string {
  if (override && override.trim()) {
    const o = override.trim();
    if (o.includes("/") || o.includes(path.sep)) {
      return o; // explicit path — honor it as-is
    }
    name = o; // bare-name override → resolve that name instead
  }

  return findOnPath(name) ?? name; // fallback: bare name, let spawn try its own PATH
}

/**
 * Whether an engine binary is actually installed (resolvable to an executable).
 *
 * Unlike {@link resolveBin} — which returns the bare name as a fallback so a
 * spawn surfaces a clear error — this returns a boolean, so the registry can gate
 * an engine's visibility on real presence. An explicit-path override must point
 * at an existing executable to count as installed.
 */
export function isInstalled(name: string, override?: string): boolean {
  if (override && override.trim()) {
    const o = override.trim();
    if (o.includes("/") || o.includes(path.sep)) {
      return isExecutableFile(o);
    }
    name = o;
  }
  return findOnPath(name) !== null;
}
