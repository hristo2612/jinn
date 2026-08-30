import fs from "node:fs";
import path from "node:path";

export interface SessionSettingsOpts {
  sessionId: string;
  relayScript: string;
  statusLineDir?: string;
  appendSystemPrompt?: string;
}

interface HookCommand { type: "command"; command: string; }
interface HookMatcher { hooks: HookCommand[]; }

// StopFailure fires INSTEAD of Stop when an API error ends the turn (rate_limit,
// billing_error, server_error, …) — confirmed by the Phase 0 spike. It is the
// structured rate-limit signal, so it must be registered alongside Stop.
// UserPromptSubmit is the CLI's authoritative "this prompt is now running"
// acknowledgement. The warm-PTY path submits by writing a CR after a bracketed
// paste, and that CR can be swallowed (large paste mid-redraw, TUI busy) — leaving
// the text sitting in the composer while the gateway waits on a turn that never
// started. Registering this hook turns "did the submit land?" from a guess into a
// fact; claude-interactive.ts retries the CR until it arrives.
// Notification carries the ONLY structured signal that the CLI is blocked on a
// human. Claude Code keeps a handful of hardcoded safety prompts that
// --dangerously-skip-permissions does not suppress (dangerous rm on a
// possibly-empty variable path, the `&` background operator, suspicious Windows
// paths); a gateway PTY has nobody at the keyboard, so the turn hangs forever.
// Verified against claude 2.1.220: the hook fires ~6s after PreToolUse with
// notification_type "permission_prompt". A PreToolUse hook answering
// permissionDecision:"allow" was tested and does NOT dismiss these — hooks
// cannot pre-approve a circuit breaker — so detecting it here and answering the
// TUI is the only route. See engines/claude-permission-prompt.ts.
export interface ClaudeSettings {
  hooks: Record<"SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse" | "Notification", HookMatcher[]>;
  statusLine?: HookCommand;
  appendSystemPrompt?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildStatusLineRecorderCommand(sessionId: string, dir: string): string {
  const script = [
    `const fs=require("fs"),path=require("path");`,
    `let s="";`,
    `process.stdin.setEncoding("utf8");`,
    `process.stdin.on("data",d=>s+=d);`,
    `process.stdin.on("end",()=>{try{`,
    `const dir=process.argv[1],id=process.argv[2];`,
    `fs.mkdirSync(dir,{recursive:true});`,
    `const parsed=JSON.parse(s||"{}");`,
    `const file=path.join(dir,id+".json"),tmp=file+".tmp";`,
    `let prev={};try{prev=JSON.parse(fs.readFileSync(file,"utf8"));}catch{}`,
    `const usefulCtx=parsed.context_window&&parsed.context_window.used_percentage!=null;`,
    `const safe={captured_at:new Date().toISOString(),jinn_session_id:id,model:parsed.model||prev.model,version:parsed.version||prev.version,rate_limits:parsed.rate_limits||prev.rate_limits,context_window:usefulCtx?parsed.context_window:(prev.context_window||parsed.context_window),cost:parsed.cost||prev.cost};`,
    `fs.writeFileSync(tmp,JSON.stringify(safe,null,2),{mode:0o600});`,
    `fs.renameSync(tmp,file);`,
    `fs.chmodSync(file,0o600);`,
    `}catch{}});`,
  ].join("");
  return `node -e ${shellQuote(script)} ${shellQuote(dir)} ${shellQuote(sessionId)}`;
}

export function buildSessionSettings(opts: SessionSettingsOpts): ClaudeSettings {
  // Relay is invoked as: node <relayScript> <jinnSessionId>
  // It reads the hook JSON on stdin and POSTs to the gateway.
  const cmd = (): HookMatcher => ({
    hooks: [{ type: "command", command: `node ${shellQuote(opts.relayScript)} ${shellQuote(opts.sessionId)}` }],
  });
  return {
    hooks: {
      SessionStart: [cmd()],
      UserPromptSubmit: [cmd()],
      Stop: [cmd()],
      StopFailure: [cmd()],
      PreToolUse: [cmd()],
      PostToolUse: [cmd()],
      Notification: [cmd()],
    },
    ...(opts.statusLineDir ? { statusLine: { type: "command", command: buildStatusLineRecorderCommand(opts.sessionId, opts.statusLineDir) } } : {}),
    ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
  };
}

export function sessionSettingsPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.json`);
}

export function writeSessionSettings(dir: string, sessionId: string, opts: SessionSettingsOpts): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = sessionSettingsPath(dir, sessionId);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(buildSessionSettings(opts), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  // Defensive: ensure the final file has 0o600 even if the target pre-existed.
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

export function cleanupSessionSettings(dir: string, sessionId: string): void {
  try { fs.unlinkSync(sessionSettingsPath(dir, sessionId)); } catch { /* best effort */ }
}

/**
 * The pure half of {@link seedTrust}: given parsed `.claude.json` contents and an
 * ALREADY-REALPATHED project directory, apply the onboarding + per-project trust keys.
 *
 * `changed: false` means the caller must not write — every key is already set, and a
 * rewrite would take a backup and touch the file for nothing.
 *
 * Separated from the I/O because the same key set has to be applied on a remote SSH
 * host, where none of the gateway's filesystem is reachable. `assets/remote-trust-seed.mjs`
 * is the standalone mirror that runs there; `src/shared/__tests__/remote-trust-seed.test.ts`
 * deep-compares the two outputs so they cannot drift apart silently.
 */
export function applyTrustSeed(data: any, realProjectDir: string): { data: any; changed: boolean } {
  data.projects ??= {};
  const proj = (data.projects[realProjectDir] ??= {});
  const alreadySeeded =
    data.hasCompletedOnboarding === true &&
    data.hasCompletedClaudeInChromeOnboarding === true &&
    proj.hasTrustDialogAccepted === true &&
    proj.hasCompletedProjectOnboarding === true;
  if (alreadySeeded) return { data, changed: false };
  // Global onboarding: dismisses the first-run intro (hasCompletedOnboarding) and
  // the Claude in Chrome (beta) intro (hasCompletedClaudeInChromeOnboarding) that
  // otherwise block the interactive PTY.
  data.hasCompletedOnboarding = true;
  data.hasCompletedClaudeInChromeOnboarding = true;
  // Per-project trust: dismisses the folder-trust dialog.
  proj.hasTrustDialogAccepted = true;
  proj.hasCompletedProjectOnboarding = true;
  proj.allowedTools ??= [];
  return { data, changed: true };
}

/**
 * Idempotently mark a project directory trusted and complete non-destructive global
 * onboarding in the real ~/.claude.json.
 *
 * Recent Claude Code versions gate the interactive TUI behind blocking first-run
 * Host startup must not accept Claude Code's Bypass Permissions consent on the user's
 * behalf. The Docker entrypoint handles that container-only consent explicitly inside
 * the dedicated Claude volume; this host path only handles ordinary onboarding and
 * per-project trust. See upstream issue #66.
 */
export function seedTrust(claudeJsonFile: string, projectDir: string): void {
  const realDir = fs.realpathSync(projectDir);
  let data: any = {};
  try { data = JSON.parse(fs.readFileSync(claudeJsonFile, "utf-8")); } catch { /* new file */ }
  const seeded = applyTrustSeed(data, realDir);
  if (!seeded.changed) return;
  // About to modify the user's real ~/.claude.json — keep a one-time backup of the
  // pre-Jinn original (no timestamped proliferation; first write wins).
  const backupPath = `${claudeJsonFile}.jinn-backup`;
  if (fs.existsSync(claudeJsonFile) && !fs.existsSync(backupPath)) {
    try { fs.copyFileSync(claudeJsonFile, backupPath, fs.constants.COPYFILE_EXCL); } catch { /* best effort */ }
  }
  // Under CLAUDE_CONFIG_DIR the target directory may not exist yet, unlike the old
  // os.homedir(); the caller swallows the ENOENT and every turn then hangs on the dialog
  // this function exists to answer. 0700 because credentials and transcripts land there.
  fs.mkdirSync(path.dirname(claudeJsonFile), { recursive: true, mode: 0o700 });
  const tmp = `${claudeJsonFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(seeded.data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, claudeJsonFile);
  // Defensive: ensure the final file has 0o600 even if the target pre-existed
  // with a more permissive mode (rename preserves the destination inode's perms
  // on some platforms / filesystems is not guaranteed — be explicit).
  fs.chmodSync(claudeJsonFile, 0o600);
}
