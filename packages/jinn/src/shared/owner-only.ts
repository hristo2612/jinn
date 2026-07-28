import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Owner-only file protection, on both permission models.
 *
 * POSIX expresses this with mode bits and uid. Windows has neither: fs.chmod
 * only toggles the read-only attribute there, so a file written 0o600 reports
 * 0o666 and every uid is 0. Access on Windows is the ACL, so that is what this
 * module reads and writes.
 *
 * Everything here fails closed. An unparseable ACL is treated as "not owner
 * only", never as "probably fine".
 */

/** Trustees that may hold access without the path counting as shared. SYSTEM and
 *  Administrators can take ownership of anything on Windows, so excluding them
 *  would make every path "shared" and the check meaningless.
 *
 *  Identified by SID, never by name. `icacls` prints names resolved into the
 *  system locale — German Windows says VORDEFINIERT\Administratoren — so an
 *  English allowlist reports every path as shared there, which is both a
 *  permanent boot warning and a silent failure of the check itself. SDDL uses
 *  well-known two-letter aliases plus raw SIDs and is locale-independent. */
const ALWAYS_PRIVILEGED_TRUSTEES = new Set([
  "SY", "S-1-5-18",        // NT AUTHORITY\SYSTEM
  "BA", "S-1-5-32-544",    // BUILTIN\Administrators
  "CO", "S-1-3-0",         // CREATOR OWNER
  "OW", "S-1-3-4",         // OWNER RIGHTS
]);

/** Absolute path to a System32 tool.
 *
 *  Never invoke these by bare name: MSYS, Cygwin and Git Bash ship their own
 *  `whoami` and put it ahead of Windows' on PATH, so a bare call gets the Unix
 *  one, fails to parse, and this module silently degrades to "cannot tell" — a
 *  permanent boot warning and a hardening call that quietly does nothing. */
function system32(exe: string): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", exe);
}

/** This process's user SID. The SID is the only locale-independent identity Node
 *  can obtain without a native binding; %USERNAME% gives a name that still has to
 *  be resolved, and resolution is exactly what localisation breaks. */
export function currentWindowsSid(): string | undefined {
  try {
    // "DOMAIN\user","S-1-5-21-..." — no header, no shell.
    const out = execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 5_000,
    }).trim();
    const sid = out.split(",").pop()?.replace(/"/g, "").trim();
    return sid && /^S-1-[\d-]+$/.test(sid) ? sid.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Trustees granted access by an SDDL security descriptor, upper-cased.
 *
 *  SDDL DACL shape: `D:AI(A;OICIID;FA;;;SY)(A;;FA;;;S-1-5-21-…)`. The trustee is
 *  the sixth semicolon-separated field of each ACE — either a two-letter
 *  well-known alias or a raw SID, neither of which is localised.
 *
 *  `icacls /save` emits the DACL only (no `O:`/`G:` prefix), which is what this
 *  reads; an owner/group prefix is not handled because it never appears here, and
 *  `G:BAD:AI(…)` is genuinely ambiguous to parse.
 *
 *  Exported for tests: this parser decides whether a path counts as shared. */
export function parseSddlTrustees(sddl: string): string[] {
  const dacl = /(?:^|[\s\0])D:([^\s\0]*)/.exec(sddl)?.[1];
  if (!dacl) return [];
  const trustees: string[] = [];
  for (const ace of dacl.matchAll(/\(([^)]*)\)/g)) {
    const fields = ace[1].split(";");
    if (fields.length < 6) continue;
    // Only Allow ACEs grant reach; a Deny ACE cannot make a path shared.
    if (!/^A/i.test(fields[0].trim())) continue;
    const trustee = fields[5].trim().toUpperCase();
    if (trustee) trustees.push(trustee);
  }
  return trustees;
}

/** Every SDDL spelling of one specific account SID.
 *
 *  SDDL serializes some well-known SIDs as two-letter aliases, so an ACE granting
 *  exactly this user can come back as `LA` rather than `S-1-5-21-…-500` — the
 *  form `icacls /grant` was given. Comparing the raw SID alone then reads the
 *  user's own grant as a stranger's and reports a correctly restricted directory
 *  as shared. Observed on GitHub's windows-latest runner, which runs as the
 *  built-in Administrator.
 *
 *  Derived from the RID rather than accepted unconditionally: `LA` denotes THIS
 *  machine's Administrator account, so it is the current user only when the
 *  current user is that account. For anyone else it is a different principal and
 *  must still count as shared. */
function sddlSpellingsOf(sid: string): Set<string> {
  const spellings = new Set([sid.toUpperCase()]);
  // Local account RIDs: 500 = Administrator, 501 = Guest. Domain accounts start
  // at 1000 and have no alias.
  if (/-500$/.test(sid)) spellings.add("LA");
  if (/-501$/.test(sid)) spellings.add("LG");
  return spellings;
}

/** Whether a DACL's trustees mean "only this user can reach it".
 *
 *  Exported for tests: with {@link parseSddlTrustees} this is the whole verdict,
 *  and it must be checkable without a Windows box to read an ACL from.
 *
 *  Empty is not a pass — no parsed trustee means the descriptor was not
 *  understood, and guessing there would report an unreadable ACL as safe. */
export function trusteesAreOwnerOnly(trustees: readonly string[], mySid: string): boolean {
  if (trustees.length === 0) return false;
  const mine = sddlSpellingsOf(mySid);
  return trustees.every((t) => mine.has(t.toUpperCase()) || ALWAYS_PRIVILEGED_TRUSTEES.has(t.toUpperCase()));
}

/** True when only the current user (plus the unavoidable privileged trustees)
 *  can reach `target`. Windows only; undefined when it cannot tell.
 *
 *  Reads the descriptor as SDDL rather than parsing `icacls`'s human output,
 *  because that output is localised and this comparison must not be. */
export function windowsPathIsOwnerOnly(target: string): boolean | undefined {
  const mySid = currentWindowsSid();
  if (!mySid) return undefined;
  const dump = path.join(os.tmpdir(), `jinn-acl-${process.pid}-${crypto.randomUUID()}.sddl`);
  try {
    // icacls cannot print SDDL to stdout; /save writes it as UTF-16LE.
    execFileSync(system32("icacls.exe"), [target, "/save", dump, "/Q"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 5_000,
      // Discard icacls' own stderr: a missing path is an expected answer here
      // ("not owner only"), not something to print over the caller's output.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sddl = fs.readFileSync(dump, "utf16le");
    const trustees = parseSddlTrustees(sddl);
    if (trustees.length === 0) return undefined; // parsed nothing — do not guess
    return trusteesAreOwnerOnly(trustees, mySid);
  } catch {
    return undefined;
  } finally {
    try { fs.unlinkSync(dump); } catch { /* nothing written */ }
  }
}

/**
 * True when `target` is readable only by its owner.
 *
 * POSIX callers pass the already-taken Stats to avoid a second syscall.
 */
export function pathIsOwnerOnly(target: string, stats?: fs.Stats): boolean {
  if (process.platform === "win32") return windowsPathIsOwnerOnly(target) === true;
  // throwIfNoEntry: false, because this must fail closed rather than throw. The
  // gateway calls it unguarded at boot on every platform, so a plain statSync
  // turned a missing path into a crash instead of a "not owner only" answer —
  // contradicting this module's own contract and its own test.
  const stat = stats ?? fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) return false;
  return (stat.mode & 0o077) === 0;
}

/**
 * Restrict `directory` to the current user, and make new children inherit that.
 *
 * One call at setup/boot covers every file the instance will ever write, which
 * is why this is a directory operation rather than a per-file chmod: on Windows
 * inheritance is the only way to get the property without touching each file.
 *
 * Returns true only when the directory is owner-only AFTERWARDS — the result is
 * verified, never assumed, because the caller prints it as an assurance. Never
 * throws: a hardening failure must not stop the gateway from starting, and the
 * caller logs it.
 */
export function enforceOwnerOnlyDirectory(directory: string): boolean {
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(directory, 0o700);
      return pathIsOwnerOnly(directory);
    }
    const mySid = currentWindowsSid();
    if (!mySid) return false;
    // /reset first: /inheritance:r below drops only INHERITED ACEs, so without
    // this a pre-existing EXPLICIT ACE for an unrelated group survives the whole
    // operation. /reset drops explicit ACEs and leaves inherited ones for
    // /inheritance:r to remove.
    execFileSync(system32("icacls.exe"), [directory, "/reset", "/Q"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 10_000,
      // icacls writes its own progress and errors to the console; without this
      // they print raw over `jinn setup`'s formatted output. The read path above
      // already does the same.
      stdio: ["ignore", "pipe", "ignore"],
    });
    // /inheritance:r drops ACEs inherited from the profile — the mechanism by
    // which an unrelated group can otherwise reach the whole instance.
    // /grant:r replaces rather than adds, so re-running is idempotent.
    //
    // Grant by SID (the *S-… form), not by name: the literals would have to be
    // the localised ones on a non-English Windows, where "BUILTIN\Administrators"
    // does not resolve and the whole call fails.
    execFileSync(system32("icacls.exe"), [
      directory,
      "/inheritance:r",
      "/grant:r", `*${mySid}:(OI)(CI)(F)`,
      "/grant:r", "*S-1-5-18:(OI)(CI)(F)",      // NT AUTHORITY\SYSTEM
      "/grant:r", "*S-1-5-32-544:(OI)(CI)(F)",  // BUILTIN\Administrators
      "/Q",
    ], { encoding: "utf-8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    // Verify rather than assume. /grant:r replaces permissions only for the
    // trustees it names, so this cannot report success on the strength of an
    // exit code alone — that is the same "reports success, silently does
    // nothing" failure this module exists to remove. `undefined` means the ACL
    // could not be read, which is a failure here, not a pass.
    return windowsPathIsOwnerOnly(directory) === true;
  } catch {
    return false;
  }
}
