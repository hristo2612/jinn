import path from "node:path";
import type { Employee, RemoteTarget } from "./types.js";
import type { RemoteExecutionConfig } from "./config-types.js";

/**
 * Remote-execution containment.
 *
 * Everything here is pure and POSIX: the paths being judged live on the REMOTE
 * host, so `path.posix` is used explicitly rather than `path` — a Windows
 * gateway must not apply Windows path semantics to a Linux box's directory.
 */

/**
 * Directory name, under the remote user's home, that serves as a remote
 * session's `$JINN_HOME`. It is a symlink farm over the sshfs-mounted gateway
 * home, plus a real `gateway.json` and `tmp/`.
 *
 * It lives here rather than next to the staging code because the write-policy
 * in `command-policy.ts` has to recognise it: the farm is instance-home-shaped
 * by design, so without this the policy would read a perfectly good
 * `$JINN_HOME/knowledge/x.md` as an instance-home write outside the mount and
 * block it — wedging the exact operation the mount exists to allow.
 *
 * Deliberately NOT `.jinn`: if a real Jinn instance is ever installed on that
 * machine, staging into its home would overwrite its gateway.json and point its
 * hook relay at our tunnel.
 */
export const REMOTE_STAGE_DIR_NAME = ".jinn-remote-stage";

/** True when this target names a remote host at all. The one predicate every
 *  call site branches on; a target with a `remoteCwd` but no `remoteHost` is
 *  local (and is rejected as a config error by {@link validateRemoteTarget}). */
export function isRemoteTarget(target: RemoteTarget | undefined): target is RemoteTarget & { remoteHost: string } {
  return typeof target?.remoteHost === "string" && target.remoteHost.trim().length > 0;
}

/**
 * True when `candidate` resolves strictly inside `root`.
 *
 * Strictly: `root` itself is accepted, but a sibling whose name merely starts
 * with the root's (`/srv/jinn-work-other` against `/srv/jinn-work`) is not —
 * which a bare `startsWith` would wave through. Traversal is normalized away
 * first, so `/srv/jinn-work/../../etc` is judged as `/etc` and refused.
 */
export function isUnderRoot(candidate: string, root: string): boolean {
  const normalizedRoot = path.posix.normalize(root).replace(/\/+$/, "") || "/";
  const normalized = path.posix.normalize(candidate).replace(/\/+$/, "") || "/";
  if (!path.posix.isAbsolute(normalizedRoot) || !path.posix.isAbsolute(normalized)) return false;
  if (normalized === normalizedRoot) return true;
  return normalized.startsWith(normalizedRoot === "/" ? "/" : `${normalizedRoot}/`);
}

/**
 * Hostnames, IPv4/IPv6 literals and `~/.ssh/config` aliases, and nothing else.
 *
 * The character set is the guard, and a leading `-` is the reason for it: the
 * destination sits in ssh's own argv, so a host of `-oProxyCommand=…` is read
 * by the LOCAL ssh as an option and runs a command ON THE GATEWAY. That is a
 * jump from "can edit an org YAML" — which employees are explicitly told they
 * may do — to code execution on the orchestrator, so it is refused at load.
 */
const SSH_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._:-]*[A-Za-z0-9])?$/;
/** POSIX-portable usernames. Same argv reasoning as the host. */
const SSH_USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

export interface RemoteTargetProblem {
  /** Operator-facing reason, already phrased for a log line or an API error. */
  error: string;
}

/**
 * Validate one employee's remote target against the instance's remote config.
 *
 * Returns `undefined` for a purely local employee and for a valid remote one;
 * a problem otherwise. Deliberately fails closed on a missing `remote` config
 * block: an employee asking to run on another machine when the operator has
 * configured no sandbox root at all is a misconfiguration, not a default.
 */
export function validateRemoteTarget(
  target: RemoteTarget,
  remote: RemoteExecutionConfig | undefined,
): RemoteTargetProblem | undefined {
  const host = typeof target.remoteHost === "string" ? target.remoteHost.trim() : "";
  const cwd = typeof target.remoteCwd === "string" ? target.remoteCwd.trim() : "";
  const user = typeof target.remoteUser === "string" ? target.remoteUser.trim() : "";

  if (!host) {
    // A cwd or user without a host is a half-written remote employee that would
    // otherwise silently run locally — the exact outcome this feature exists to
    // prevent. Name it rather than ignoring the orphaned fields.
    if (cwd || user) {
      return { error: "remoteCwd/remoteUser are set but remoteHost is not — this employee would silently run on the gateway" };
    }
    return undefined;
  }
  return validateDestination(host, user)
    ?? validateRemoteConfig(host, remote)
    ?? validateRemoteCwd(host, cwd, remote!)
    ?? validateClaudeConfigDir(target, remote!);
}

/**
 * The profile directory, if one is named. Absolute only, for the same reason
 * `remoteCwd` is: the gateway cannot expand `~` for another machine's user, and
 * passing it through unexpanded would have the remote shell resolve it outside
 * anything we checked — against a variable that decides which credentials and
 * which trust state the session runs with.
 */
function validateClaudeConfigDir(
  target: RemoteTarget,
  remote: RemoteExecutionConfig,
): RemoteTargetProblem | undefined {
  for (const [label, value] of [
    ["remoteClaudeConfigDir", target.remoteClaudeConfigDir],
    ["remote.claudeConfigDir", remote.claudeConfigDir],
  ] as const) {
    const dir = typeof value === "string" ? value.trim() : "";
    if (!dir) continue;
    if (dir.startsWith("~")) {
      return { error: `${label} "${dir}" must be an absolute path, not home-relative` };
    }
    if (!path.posix.isAbsolute(dir)) {
      return { error: `${label} "${dir}" must be an absolute path on the remote host` };
    }
  }
  return undefined;
}

/** The half that keeps the target out of ssh's option namespace. */
function validateDestination(host: string, user: string): RemoteTargetProblem | undefined {
  if (!SSH_HOST_RE.test(host)) {
    return { error: `remoteHost "${host}" is not a plain hostname, address or ssh alias — it would be passed into ssh's own arguments` };
  }
  if (user && !SSH_USER_RE.test(user)) {
    return { error: `remoteUser "${user}" is not a plain username — it would be passed into ssh's own arguments` };
  }
  return undefined;
}

/** The instance-wide half: is remote execution configured coherently at all? */
function validateRemoteConfig(
  host: string,
  remote: RemoteExecutionConfig | undefined,
): RemoteTargetProblem | undefined {
  if (!remote) {
    return { error: `remoteHost "${host}" is set but the instance has no \`remote\` config block (needs remote.root and remote.mount)` };
  }
  if (!remote.root || !path.posix.isAbsolute(remote.root)) {
    return { error: "remote.root must be an absolute path on the remote host" };
  }
  if (!remote.mount || !path.posix.isAbsolute(remote.mount)) {
    return { error: "remote.mount must be an absolute path on the remote host" };
  }
  return undefined;
}

/** The per-employee half: does this working directory sit inside the sandbox? */
function validateRemoteCwd(
  host: string,
  cwd: string,
  remote: RemoteExecutionConfig,
): RemoteTargetProblem | undefined {
  if (!cwd) {
    return { error: `remoteHost "${host}" is set but remoteCwd is not` };
  }
  // `~` is deliberately refused rather than expanded: the gateway cannot know
  // the remote user's home, so expanding it here would be a guess, and passing
  // it through would have the remote shell expand it OUTSIDE any check we made.
  if (cwd.startsWith("~")) {
    return { error: `remoteCwd "${cwd}" must be an absolute path, not home-relative` };
  }
  if (!isUnderRoot(cwd, remote.root)) {
    return { error: `remoteCwd "${cwd}" does not resolve under the configured remote.root "${remote.root}"` };
  }
  return undefined;
}

/**
 * The spawn-time re-check. Throws rather than returning, because by this point
 * a violation is not a config mistake to report — it is a reason to not start
 * the process at all.
 */
export function assertRemoteTarget(
  target: RemoteTarget,
  remote: RemoteExecutionConfig | undefined,
): asserts target is RemoteTarget & { remoteHost: string; remoteCwd: string } {
  const problem = validateRemoteTarget(target, remote);
  if (problem) throw new Error(`Refusing to spawn a remote session: ${problem.error}`);
  if (!isRemoteTarget(target) || !target.remoteCwd) {
    throw new Error("Refusing to spawn a remote session: no remoteHost/remoteCwd");
  }
}

/** `user@host` when a user is configured, else the bare host so ssh applies its
 *  own config (`~/.ssh/config` User, then the local username). */
export function sshDestination(target: RemoteTarget & { remoteHost: string }): string {
  const user = typeof target.remoteUser === "string" ? target.remoteUser.trim() : "";
  return user ? `${user}@${target.remoteHost.trim()}` : target.remoteHost.trim();
}

/** The remote target carried by an employee, or undefined when it is local. */
export function employeeRemoteTarget(employee: Employee | undefined): RemoteTarget | undefined {
  if (!employee || !isRemoteTarget(employee)) return undefined;
  return {
    remoteHost: employee.remoteHost,
    ...(employee.remoteUser === undefined ? {} : { remoteUser: employee.remoteUser }),
    ...(employee.remoteCwd === undefined ? {} : { remoteCwd: employee.remoteCwd }),
    ...(employee.remoteClaudeConfigDir === undefined ? {} : { remoteClaudeConfigDir: employee.remoteClaudeConfigDir }),
  };
}

/**
 * Which Claude Code profile a remote session runs as: the employee's own
 * `remoteClaudeConfigDir`, else the instance-wide `remote.claudeConfigDir`,
 * else undefined for the remote user's default profile.
 *
 * The value reaches TWO places and they must agree, or the feature fails
 * silently: the session's `CLAUDE_CONFIG_DIR`, and the environment the
 * folder-trust seed runs under. Claude Code keeps `.claude.json` INSIDE the
 * config dir once that variable is set (`home.ts` `claudeJsonPath`), so a seed
 * run without it writes `~/.claude.json` while the session reads
 * `<profile>/.claude.json` — the trust dialog then appears in front of a PTY
 * with nobody at the keyboard and the first turn hangs forever.
 */
export function resolveRemoteClaudeConfigDir(
  target: RemoteTarget,
  remote: RemoteExecutionConfig | undefined,
): string | undefined {
  const own = typeof target.remoteClaudeConfigDir === "string" ? target.remoteClaudeConfigDir.trim() : "";
  if (own) return own;
  const shared = typeof remote?.claudeConfigDir === "string" ? remote.claudeConfigDir.trim() : "";
  return shared || undefined;
}
