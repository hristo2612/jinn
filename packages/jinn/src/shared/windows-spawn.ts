import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Make a command line runnable on Windows when the binary is a `.cmd`/`.bat` shim.
 *
 * Node has refused to spawn `.cmd` and `.bat` without a shell since 18.20.2 (the
 * CVE-2024-27980 fix): `spawn("codex.cmd", …)` throws EINVAL. Every CLI installed
 * by npm on Windows is exactly such a shim, so a bare spawn fails against a
 * perfectly working install.
 *
 * The fix is to invoke the interpreter explicitly — `cmd.exe /d /s /c "…"` —
 * rather than passing `shell: true`. Both end up running cmd.exe, but doing it
 * here keeps the quoting visible and reviewable instead of delegating it to
 * Node's shell handling, and it resolves cmd.exe from System32 rather than PATH.
 *
 * Arguments are quoted for cmd.exe's parser: the whole command is wrapped in the
 * outer quotes `/s` expects, and each argument is individually quoted with its
 * trailing backslash run doubled, per MSVCRT rules — the same escape hazard
 * `cli/skills.ts` documents. Callers must still not pass attacker-controlled
 * arguments; this is for fixed argv with an operator-configured binary path.
 */
export function needsCmdShim(bin: string): boolean {
  if (process.platform !== "win32") return false;
  const ext = path.extname(bin).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function quoteForCmd(arg: string): string {
  // Double only the FINAL run of backslashes: a run immediately before the
  // closing quote would otherwise escape it and swallow the next argument.
  return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
}

export function cmdExePath(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", "cmd.exe");
}

/**
 * Rewrite `(bin, args)` so a Windows shim can be executed, or pass them through.
 *
 * Spread `options` into the `spawn`/`execFile` call. It carries
 * `windowsVerbatimArguments` for the shim case: Node would otherwise apply its
 * own quoting on top of the command line built here, and cmd.exe would receive
 * escaped quotes and report the whole line as an unrecognised command. This is
 * the same flag `shell: true` sets internally.
 */
export interface SpawnPlan {
  command: string;
  args: string[];
  options: { windowsVerbatimArguments?: true };
}

export function spawnableCommand(bin: string, args: readonly string[]): SpawnPlan {
  if (!needsCmdShim(bin)) return { command: bin, args: [...args], options: {} };
  const line = [bin, ...args].map(quoteForCmd).join(" ");
  // /d skips AutoRun commands from the registry, which could otherwise inject
  // work into every spawn. /s with the outer quotes keeps the line intact.
  return {
    command: cmdExePath(),
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * Terminate a spawned process and anything it started.
 *
 * `spawnableCommand` interposes cmd.exe on Windows, so the engine runs as a
 * GRANDCHILD. Killing the returned handle then reaps only the interpreter and
 * leaves the engine running — for a long-lived `app-server` that is a leaked
 * process per collection, every time the read times out.
 *
 * Windows has no process groups to signal, so this uses taskkill /T, which walks
 * the child tree. Best-effort by design: the caller is already on an error path
 * and must not be derailed by a reap that raced with a normal exit.
 */
export function killProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (process.platform !== "win32" || !child.pid) {
    child.kill("SIGTERM");
    return;
  }
  try {
    const root = process.env.SystemRoot || process.env.windir || "C:\Windows";
    execFileSync(path.join(root, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Already gone, or taskkill unavailable. Fall back to the direct kill so the
    // interpreter at least does not survive.
    try { child.kill("SIGTERM"); } catch { /* already reaped */ }
  }
}
