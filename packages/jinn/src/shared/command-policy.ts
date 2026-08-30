import path from "node:path";
import { isUnderRoot, REMOTE_STAGE_DIR_NAME } from "./remote-target.js";

export type CommandPolicyAction = "allow" | "block";

export interface CommandPolicyDecision {
  action: CommandPolicyAction;
  reason?: string;
}

/**
 * Extra facts a caller can supply about *where* the session is running. Absent
 * (the local case) every rule below the destructive/exfil block is inert, so a
 * single-argument call behaves exactly as it did before these fields existed.
 */
export interface CommandPolicyOptions {
  /** Absolute POSIX path on the REMOTE host where the gateway's JINN_HOME is
   *  sshfs-mounted. Set only for a remote session; its presence is what turns
   *  the containment rule on. */
  remoteMountRoot?: string;
  /** The gateway's own JINN_HOME. A remote session naming this path verbatim is
   *  addressing a directory that does not exist on the remote host, so the
   *  write would silently create a local one. */
  gatewayHome?: string;
  /** `$HOME` on the remote host, when known. Only used to expand `$HOME`/`~`
   *  in a command's path tokens, so that `$HOME/.jinn/knowledge/x.md` is judged
   *  as the instance-home write it is rather than skipped as un-parseable. */
  remoteHome?: string;
}

const DESTRUCTIVE: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[;&|]\s*)rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+(?:\/|~(?:\s|$)|\$HOME(?:\s|$))/i, reason: "Refusing destructive recursive removal of a home/root path" },
  { re: /(^|[;&|]\s*)sudo\s+rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+\//i, reason: "Refusing sudo destructive removal" },
  { re: /(^|[;&|]\s*)(?:mkfs|dd\s+if=.*\sof=\/dev\/|diskutil\s+erase)/i, reason: "Refusing disk-destructive command" },
];

const SECRET_PATH = /(?:~\/\.ssh|\$HOME\/\.ssh|\.ssh\/id_[a-z0-9]+|~\/\.jinn\/secrets|\$HOME\/\.jinn\/secrets|\.env(?:\.[\w.-]+)?|auth\.json)/i;
const EXFIL = /\b(?:curl|wget|nc|ncat|netcat|scp|rsync|ftp|sftp|python\s+-m\s+http\.server)\b/i;

/**
 * An instance home's shared trees, addressed through a dotted instance-home
 * segment (`.jinn`, or `.jinn-<instance>` for a second instance on one box).
 *
 * Deliberately narrower than "any path under a `.jinn` directory": these three
 * subtrees are the ones the sshfs mount exists to share, so a write landing
 * outside the mount is the divergence this rule is here to catch. A `.jinn/logs`
 * or `.jinn/sessions.db` on the remote is that host's own local state and is
 * none of this rule's business — blocking it would wedge a real turn for
 * nothing.
 */
const SHARED_TREE = /(?:^|\/)\.jinn(?:-[A-Za-z0-9._-]+)?\/(?:knowledge|docs|org)(?:\/|$)/;

/** The remote session's staged `$JINN_HOME` — a symlink farm over the mount.
 *  Escaped from the shared constant so the two can never drift apart. */
const STAGE_FARM_SEGMENT = new RegExp(
  `(?:^|/)${REMOTE_STAGE_DIR_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`,
);

/** Commands that create or overwrite a file named in their arguments. */
const WRITE_COMMAND = /(?:^|[;&|(]\s*|\s)(?:tee|cp|mv|install|mkdir|rmdir|touch|rsync|ln|dd|truncate|unlink|rm)\b/i;
/** `> path` / `>> path`, where the target is absolute or home-relative.
 *  `$HOME`/`${HOME}` count as home-relative: without them a plain
 *  `echo x > $HOME/.jinn/knowledge/y.md` never even reached the containment
 *  check, because nothing in the line looked like a write to a path. */
const WRITE_REDIRECT = />>?\s*['"]?(?:[~/]|\$\{?HOME\}?\/)/;
/** In-place edit: the file is both the input and the output. */
const SED_IN_PLACE = /\bsed\b[^|;&]*\s-i\b/i;

/**
 * Absolute (`/…`), home-relative (`~/…`) and `$HOME`-rooted tokens in a shell
 * command, taken as plain strings. This is a lexer's job done with a regex on
 * purpose: the policy has to stay pure and total, and a token it mis-splits can
 * only ever cause it to look at a path that is not there — the destructive and
 * exfil rules above do not depend on it.
 *
 * What this DOESN'T reach is stated plainly because it bounds the whole rule:
 * a path assembled at runtime, one built inside `python -c`, or one reached
 * through a relative `cd` is invisible here. That is why this layer is
 * explicitly defence in depth and the MOUNT SENTINEL is the primary guard —
 * the sentinel is checked before every spawn and cannot be talked around,
 * because it does not read the command at all.
 */
function absolutePathTokens(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s='":><(])((?:~|\$HOME|\$\{HOME\})?\/[^\s'"();|&]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Strip quoting and a leading `~`, then normalize traversal away. POSIX
 *  explicitly: the paths judged here live on the remote (Linux) host, so a
 *  Windows gateway must not apply Windows path semantics to them. */
function normalizeRemotePath(raw: string, remoteHome?: string): string {
  let s = raw.trim().replace(/^['"]/, "").replace(/['"]$/, "");
  // `~` and `$HOME` both mean the remote user's home. Expanding to it when we
  // know it keeps `$HOME/.jinn/knowledge/x.md` inside the rule; falling back to
  // stripping the prefix keeps the old behaviour when we don't.
  const homePrefix = s.startsWith("$HOME") ? "$HOME" : s.startsWith("${HOME}") ? "${HOME}" : s.startsWith("~") ? "~" : "";
  if (homePrefix) {
    const rest = s.slice(homePrefix.length);
    s = remoteHome && path.posix.isAbsolute(remoteHome) ? path.posix.join(remoteHome, rest) : rest || "/";
  }
  if (!s) return "";
  return path.posix.normalize(s);
}

/**
 * Normalize `raw` and decide whether it is even a candidate for the containment
 * rules — i.e. an absolute path that does NOT already reach the gateway.
 * Returns the normalized path when it still needs judging, or `undefined` when
 * it is fine as it stands.
 */
function reachesGatewayHome(raw: string, mount: string, remoteHome?: string): string | undefined {
  const candidate = normalizeRemotePath(raw, remoteHome);
  // A relative path is resolved against the session's remoteCwd, which
  // validateRemoteTarget already bounds to remote.root. Nothing to add here.
  if (!candidate || !path.posix.isAbsolute(candidate)) return undefined;
  const root = normalizeRemotePath(mount);
  if (!path.posix.isAbsolute(root)) return undefined;
  if (isUnderRoot(candidate, root)) return undefined;
  // The remote session's own $JINN_HOME is a symlink farm whose entries resolve
  // THROUGH the mount, so a write there does reach the gateway — but its path is
  // instance-home-shaped and is not string-wise under the mount, so the rules
  // below would otherwise refuse it. That would block the single operation this
  // whole mount exists to permit (`$JINN_HOME/knowledge/x.md`), and a pure
  // policy cannot resolve a symlink to tell the two apart. Recognise the farm by
  // its one reserved name instead.
  if (STAGE_FARM_SEGMENT.test(candidate)) return undefined;
  return candidate;
}

/**
 * The one containment decision, shared by the command and the file-path entry
 * points: does `raw` name an instance home that is NOT the verified mount?
 * Returns the operator-facing reason, or undefined when the path is fine.
 */
function offendingHomePath(raw: string, mount: string, opts: CommandPolicyOptions): string | undefined {
  const candidate = reachesGatewayHome(raw, mount, opts.remoteHome);
  if (candidate === undefined) return undefined;
  const root = normalizeRemotePath(mount);
  // The remote session's own $JINN_HOME is a symlink farm whose entries resolve
  // THROUGH the mount, so a write there does reach the gateway — but its path is
  // instance-home-shaped and is not string-wise under the mount, so every rule
  // below would otherwise refuse it. That would block the single operation this
  // whole mount exists to permit (`$JINN_HOME/knowledge/x.md`), and a pure
  // policy cannot resolve a symlink to tell the two apart. Recognise the farm by
  // its one reserved name instead.
  if (STAGE_FARM_SEGMENT.test(candidate)) return undefined;

  const home = opts.gatewayHome ? normalizeRemotePath(opts.gatewayHome) : "";
  if (home && path.posix.isAbsolute(home) && isUnderRoot(candidate, home)) {
    return `Refusing a remote write to "${candidate}": that is the gateway's own JINN_HOME path, which on this host is not the verified mount "${root}"`;
  }
  if (SHARED_TREE.test(candidate)) {
    return `Refusing a remote write to "${candidate}": shared knowledge/docs/org must land under the verified JINN_HOME mount "${root}"`;
  }
  return undefined;
}

/**
 * Judge a Write/Edit target. Separate from {@link evaluateCommandPolicy}
 * because the Write and Edit hooks hand over a path, not a command line, and
 * running a shell-command lexer over a path would only invent ways to be wrong.
 */
export function evaluateWritePathPolicy(filePath: string, opts?: CommandPolicyOptions): CommandPolicyDecision {
  const mount = opts?.remoteMountRoot?.trim();
  if (!mount) return { action: "allow" };
  const raw = String(filePath ?? "").trim();
  if (!raw) return { action: "allow" };
  const reason = offendingHomePath(raw, mount, opts ?? {});
  return reason ? { action: "block", reason } : { action: "allow" };
}

export function evaluateCommandPolicy(command: string, opts?: CommandPolicyOptions): CommandPolicyDecision {
  const text = String(command ?? "").trim();
  if (!text) return { action: "allow" };
  for (const rule of DESTRUCTIVE) {
    if (rule.re.test(text)) return { action: "block", reason: rule.reason };
  }
  if (SECRET_PATH.test(text) && EXFIL.test(text)) {
    return { action: "block", reason: "Refusing command that appears to exfiltrate secret files" };
  }
  const containment = remoteContainmentReason(text, opts);
  if (containment) return { action: "block", reason: containment };
  return { action: "allow" };
}

/** The remote half of {@link evaluateCommandPolicy}, split out because the
 *  combined function exceeds the complexity cap in eslint.config.mjs. */
function remoteContainmentReason(text: string, opts: CommandPolicyOptions | undefined): string | undefined {
  const mount = opts?.remoteMountRoot?.trim();
  if (!mount) return undefined;
  if (!WRITE_COMMAND.test(text) && !WRITE_REDIRECT.test(text) && !SED_IN_PLACE.test(text)) return undefined;
  // Write intent is only the gate: a command still has to *name* an offending
  // path before it is refused, so `npm install` (which trips WRITE_COMMAND)
  // never blocks on its own.
  for (const token of absolutePathTokens(text)) {
    const reason = offendingHomePath(token, mount, opts ?? {});
    if (reason) return reason;
  }
  return undefined;
}
