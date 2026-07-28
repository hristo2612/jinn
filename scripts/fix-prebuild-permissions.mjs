// Restore the executable bit on node-pty's spawn-helper after install.
//
// This replaces a shell one-liner:
//
//   chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
//
// pnpm runs package scripts through cmd.exe on Windows, where `chmod` and glob
// expansion do not exist, so that line failed there. It failed harmlessly —
// `|| true` swallowed it, and Windows has no executable bit to restore — but a
// postinstall that always errors is noise in every Windows install log.
//
// Behaviour is otherwise deliberately unchanged: every prebuild directory is
// still visited, not just the current platform's, because a workspace can be
// installed on one machine and mounted on another. Missing files and chmod
// failures stay non-fatal, as `2>/dev/null || true` made them.
import { chmod, readdir } from "node:fs/promises";
import path from "node:path";

if (process.platform === "win32") process.exit(0);

const pnpmRoot = path.join(process.cwd(), "node_modules", ".pnpm");

async function directories(target) {
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

let fixed = 0;
for (const pkg of await directories(pnpmRoot)) {
  if (!pkg.startsWith("node-pty@")) continue;
  const prebuilds = path.join(pnpmRoot, pkg, "node_modules", "node-pty", "prebuilds");
  for (const platform of await directories(prebuilds)) {
    try {
      await chmod(path.join(prebuilds, platform, "spawn-helper"), 0o755);
      fixed += 1;
    } catch {
      // No spawn-helper for this prebuild, or no permission to change it.
      // Neither is fatal: the shell version discarded both.
    }
  }
}

if (process.env.npm_config_loglevel === "verbose") {
  process.stdout.write(`fix-prebuild-permissions: ${fixed} spawn-helper(s)\n`);
}
