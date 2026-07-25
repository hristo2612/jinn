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
export interface ClaudeSettings {
  hooks: Record<"SessionStart" | "UserPromptSubmit" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse", HookMatcher[]>;
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
 * Idempotently mark a project directory trusted AND complete the global first-run
 * onboarding in the real ~/.claude.json, so the interactive (PTY) `claude` never
 * blocks on a one-time consent dialog.
 *
 * Recent Claude Code versions gate the interactive TUI behind blocking first-run
 * prompts: the "Bypass Permissions mode" consent (triggered by
 * --dangerously-skip-permissions) and the "Claude in Chrome (beta)" intro
 * (triggered by --chrome). The InteractiveClaudeEngine launches `claude`
 * interactively with both flags and never sends a keystroke to dismiss the
 * dialogs, so on any install where onboarding is not already complete (fresh,
 * headless/CI, or after a Claude Code upgrade resets onboarding for a new
 * version) every work turn hangs forever before reaching the API. Pre-seeding
 * these flags at gateway boot answers the dialogs up front. See upstream issue #66.
 */
export function seedTrust(claudeJsonPath: string, projectDir: string): void {
  const realDir = fs.realpathSync(projectDir);
  let data: any = {};
  try { data = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8")); } catch { /* new file */ }
  data.projects ??= {};
  const proj = (data.projects[realDir] ??= {});
  const alreadySeeded =
    data.hasCompletedOnboarding === true &&
    data.hasCompletedClaudeInChromeOnboarding === true &&
    proj.hasTrustDialogAccepted === true &&
    proj.hasCompletedProjectOnboarding === true;
  if (alreadySeeded) return;
  // About to modify the user's real ~/.claude.json — keep a one-time backup of the
  // pre-Jinn original (no timestamped proliferation; first write wins).
  const backupPath = `${claudeJsonPath}.jinn-backup`;
  if (fs.existsSync(claudeJsonPath) && !fs.existsSync(backupPath)) {
    try { fs.copyFileSync(claudeJsonPath, backupPath, fs.constants.COPYFILE_EXCL); } catch { /* best effort */ }
  }
  // Global onboarding: dismisses the Bypass Permissions consent
  // (hasCompletedOnboarding) and the Claude in Chrome (beta) intro
  // (hasCompletedClaudeInChromeOnboarding) that otherwise block the interactive PTY.
  data.hasCompletedOnboarding = true;
  data.hasCompletedClaudeInChromeOnboarding = true;
  // Per-project trust: dismisses the folder-trust dialog.
  proj.hasTrustDialogAccepted = true;
  proj.hasCompletedProjectOnboarding = true;
  proj.allowedTools ??= [];
  const tmp = `${claudeJsonPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, claudeJsonPath);
  // Defensive: ensure the final file has 0o600 even if the target pre-existed
  // with a more permissive mode (rename preserves the destination inode's perms
  // on some platforms / filesystems is not guaranteed — be explicit).
  fs.chmodSync(claudeJsonPath, 0o600);
}
