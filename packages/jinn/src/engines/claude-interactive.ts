import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, EngineRateLimitInfo, StreamDelta, TurnProgress } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT, CLAUDE_LIMITS_DIR } from "../shared/paths.js";
import { cleanupSessionSettings, writeSessionSettings } from "../shared/claude-settings.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped } from "./pty-stream.js";
import type { PtyControlEvent, PtyViewEngine, PtyIdleSpawnOpts, PtySnapshotSubscription } from "./pty-view-engine.js";
import type { HookRegistry, HookPayload } from "../gateway/hook-registry.js";
import { SsePtyProxy, MAIN_AGENT_SENTINEL, type SseDataEvent, type UpstreamActivityInfo } from "./sse-pty-proxy.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { buildPromptWithPlatformContext } from "./platform-context.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";
import { writeMcpConfigFile } from "../mcp/resolver.js";

export type { PtyControlEvent } from "./pty-view-engine.js";

interface InteractiveArgsOpts {
  prompt: string;
  settingsPath: string;
  resumeSessionId?: string;
  model?: string;
  effortLevel?: string;
  mcpConfigPath?: string;
  cliFlags?: string[];
  attachments?: string[];
  /** Gateway system prompt (persona/org context) + main-agent sentinel, passed via
   *  the CLI `--append-system-prompt` flag. The settings-file `appendSystemPrompt`
   *  KEY is ignored by claude CLI ≥2.1.x, so this flag is the only path that
   *  actually lands it in the request `system` (and thus lets the SSE proxy tee). */
  appendSystemPrompt?: string;
}

interface TranscriptUsage { inputTokens: number; outputTokens: number; cacheTokens: number; assistantTurns: number; }

// $/million tokens. Conservative defaults.
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-4-7": { in: 15, out: 75 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const DEFAULT_PRICE = { in: 15, out: 75 };

/**
 * Sum assistant-message usage from a Claude transcript.
 *
 * `afterMs` scopes the sum to ONE turn. A Claude transcript is cumulative — it
 * holds every turn of the session — so an unscoped sum returns session-to-date
 * totals. Callers that ADD the result to a running total (accumulateSessionCost)
 * must pass the turn's start time, or an N-turn session is counted
 * quadratically. Codex reports a per-run delta already; this is what makes the
 * two engines agree.
 */
export function sumTranscriptUsage(content: string, afterMs?: number): TranscriptUsage {
  const u: TranscriptUsage = { inputTokens: 0, outputTokens: 0, cacheTokens: 0, assistantTurns: 0 };
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    if (afterMs !== undefined) {
      const ts = transcriptLineTimestampMs(msg);
      // An untimestamped line can't be placed in a turn. Skip it rather than
      // attribute another turn's tokens to this one.
      if (ts === undefined || ts < afterMs) continue;
    }
    const usage = msg?.message?.usage;
    if (!usage) continue;
    // Phase 0 finding: --effort high emits two assistant lines per response
    // (thinking + text) with the same message.id and identical usage. Dedupe
    // by message.id so tokens aren't double-counted. Lines without an id are
    // always counted (can't dedupe what we can't key).
    const id = msg?.message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.assistantTurns += 1;
    u.inputTokens += Number(usage.input_tokens ?? 0);
    u.outputTokens += Number(usage.output_tokens ?? 0);
    u.cacheTokens += Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  }
  return u;
}

/** Most recent turn's input-context size (input + cache-read + cache-creation
 *  tokens) from the transcript — how full the window is. Undefined if no usage. */
function lastTurnContextTokens(transcriptPath: string): number | undefined {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let last: number | undefined;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    const u = msg?.message?.usage;
    if (!u) continue;
    last = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
  }
  return last && last > 0 ? last : undefined;
}

/** Claude Code stores per-project transcripts at
 *  ~/.claude/projects/<cwd-slug>/<claudeSessionId>.jsonl, where the slug is the
 *  cwd with every "/" and "." replaced by "-". Derive that path; fall back to a
 *  scan across project dirs if the slug heuristic misses (defensive). Exported
 *  for the transcript-recovery unit test. */
export function findTranscriptForSession(
  claudeSessionId: string,
  homeDir: string = JINN_HOME,
  projectsDir: string = path.join(os.homedir(), ".claude", "projects"),
): string | undefined {
  if (!claudeSessionId) return undefined;
  const slug = homeDir.replace(/[/.]/g, "-");
  const direct = path.join(projectsDir, slug, `${claudeSessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, d, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* projects dir missing — nothing to recover */ }
  return undefined;
}

/** Last assistant text block from a Claude transcript — the turn's final
 *  message. Used to recover result text when the Stop hook (which normally
 *  carries last_assistant_message) was lost (gateway restart deleting
 *  gateway.json mid-turn, PTY crash, or SSE drop), so the parent-session
 *  callback shows real output instead of "(no output)". Exported for tests. */
function transcriptLineTimestampMs(msg: any): number | undefined {
  const raw = msg?.timestamp ?? msg?.created_at ?? msg?.createdAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function lastAssistantTextFromTranscript(transcriptPath: string, afterMs?: number): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, "utf-8"); } catch { return undefined; }
  let last: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg: any;
    try { msg = JSON.parse(t); } catch { continue; }
    if (msg.type !== "assistant") continue;
    if (afterMs !== undefined) {
      const ts = transcriptLineTimestampMs(msg);
      if (ts === undefined || ts < afterMs) continue;
    }
    const content = msg?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
    if (text.trim()) last = text;
  }
  return last;
}

export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<\s*(thinking|reasoning|thought)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/```(?:thinking|reasoning|thought)\b[\s\S]*?```/gi, "")
    .trim();
}

/** Cost for ONE turn. `afterMs` (the turn's start) scopes the cumulative
 *  transcript to this turn — see sumTranscriptUsage. */
function computeInteractiveCost(transcriptPath: string, model?: string, afterMs?: number): { cost: number; turns: number } | null {
  let content: string;
  try { content = fs.readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  const u = sumTranscriptUsage(content, afterMs);
  if (u.assistantTurns === 0) return null;
  const price = (model && MODEL_PRICES[model]) || DEFAULT_PRICE;
  const cost = (u.inputTokens / 1_000_000) * price.in + (u.outputTokens / 1_000_000) * price.out;
  return { cost, turns: u.assistantTurns };
}

/**
 * Map a StopFailure hook payload to an EngineRateLimitInfo.
 * Returns null unless the turn failed specifically with error === "rate_limit".
 * The shape matches what ClaudeEngine produces from `rate_limit_event` JSON, so
 * detectRateLimit() / the wait-retry machinery in manager.ts work unchanged.
 * (error_details may carry a reset time, but its format is unconfirmed — left
 * unparsed; manager.ts computes a default backoff when resetsAt is absent.)
 */
function rateLimitFromStopFailure(payload: HookPayload | undefined): EngineRateLimitInfo | null {
  if (!payload || payload.hook_event_name !== "StopFailure") return null;
  if (payload.error !== "rate_limit") return null;
  return { status: "rejected", rateLimitType: "interactive_detected" };
}

export function buildInteractiveArgs(o: InteractiveArgsOpts): string[] {
  const args: string[] = [];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);

  let prompt = o.prompt;
  if (o.attachments?.length) {
    prompt += buildAttachmentSuffix(o.attachments);
  }
  args.push(prompt); // positional — MUST precede variadic --mcp-config

  args.push("--chrome");
  if (o.effortLevel && o.effortLevel !== "default") args.push("--effort", o.effortLevel);
  if (o.model) args.push("--model", o.model);
  args.push("--dangerously-skip-permissions");
  args.push("--disallowedTools", "AskUserQuestion", "ExitPlanMode");
  args.push("--settings", o.settingsPath);
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  if (o.cliFlags?.length) args.push(...o.cliFlags);
  if (o.mcpConfigPath) args.push("--mcp-config", o.mcpConfigPath);
  return args;
}

export function claudeHookToDeltas(h: Record<string, unknown>): StreamDelta[] {
  if (h.hook_event_name !== "PostToolUse") return [];
  const toolName = typeof h.tool_name === "string" ? h.tool_name : undefined;
  const response = h.tool_response;
  const responseRecord = response && typeof response === "object" && !Array.isArray(response)
    ? response as Record<string, unknown>
    : undefined;
  const responseText = Array.isArray(responseRecord?.content)
    ? (responseRecord.content as unknown[])
        .find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "text")
    : undefined;
  const receiptSource = responseText && typeof responseText === "object"
    ? (responseText as Record<string, unknown>).text
    : response;
  const isError = h.is_error === true || responseRecord?.isError === true || responseRecord?.is_error === true;
  const activityReceiptId = extractActivityReceiptId(receiptSource, { isError });
  const toolId = typeof h.tool_use_id === "string" && h.tool_use_id ? h.tool_use_id : undefined;
  return [{
    type: "tool_result",
    content: String(h.tool_name ?? ""),
    toolName,
    ...(toolId ? { toolId } : {}),
    ...(activityReceiptId ? { activityReceiptId } : {}),
  }];
}

/**
 * Translate one parsed Anthropic SSE `data:` event into StreamDeltas. This is the
 * live streaming source (replacing the old transcript tailer): word-by-word text
 * in true order, tool markers positioned correctly relative to text, and live
 * context tokens from message_start.usage.
 *  - message_start.usage         → `context` (input + cache_read + cache_creation)
 *  - content_block_start tool_use → `tool_use` marker (in-order with text)
 *  - content_block_delta text_delta → incremental `text` (word-by-word)
 * tool_result is NOT in the assistant SSE stream (tools run between messages); the
 * PostToolUse hook supplies that completion marker. input_json_delta / thinking
 * deltas are intentionally not surfaced to the chat pane.
 */
export function sseEventToDeltas(e: SseDataEvent): StreamDelta[] {
  switch (e.type) {
    case "message_start": {
      const u = (e as any).message?.usage;
      if (!u) return [];
      const ctx = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
      return ctx > 0 ? [{ type: "context", content: String(ctx) }] : [];
    }
    case "content_block_start": {
      const cb = (e as any).content_block;
      if (cb?.type === "tool_use") {
        return [{ type: "tool_use", content: String(cb.name ?? "tool"), toolName: String(cb.name ?? "tool"), toolId: String(cb.id ?? "") }];
      }
      return [];
    }
    case "content_block_delta": {
      const d = (e as any).delta;
      if (d?.type === "text_delta" && typeof d.text === "string" && d.text.length > 0) {
        return [{ type: "text", content: d.text }];
      }
      return [];
    }
    default:
      return [];
  }
}

/** Claude Code runs auto-compaction (and `/compact`) as an ordinary API call through
 *  this same proxy — same tools, same sentinel system prompt — so it passes every
 *  tee gate and its summarizer output used to stream into the chat as one enormous
 *  `<analysis>…</analysis><summary>This session is being continued…</summary>`
 *  bubble. The reliable marker is that this is the one assistant message that OPENS
 *  with `<analysis>`, so hold each message's first characters until that is decided
 *  and drop the whole message when it matches. */
const COMPACTION_OPENER = "<analysis>";

/** Per-message gate: buffers the opening text of an assistant message just long
 *  enough to tell a real reply from a compaction summary. Exported for tests. */
export class CompactionStreamGate {
  private held: StreamDelta[] = [];
  private opening = "";
  private verdict: "undecided" | "pass" | "drop" = "undecided";

  /** A new assistant message started — decide again from scratch. */
  reset(): void {
    this.held = [];
    this.opening = "";
    this.verdict = "undecided";
  }

  /** Deltas safe to forward now. Text is briefly held while the opener is undecided. */
  accept(deltas: StreamDelta[]): StreamDelta[] {
    const out: StreamDelta[] = [];
    for (const d of deltas) {
      if (this.verdict === "drop") continue;
      if (this.verdict === "pass") { out.push(d); continue; }
      // `context` is the FIRST delta of every message (message_start carries
      // usage), so deciding the verdict on it would latch `pass` before any
      // text arrives and the gate would never drop anything. Forward it and
      // keep deciding.
      if (d.type === "context") { out.push(d); continue; }
      // Any other non-text delta (a tool call) can never be a compaction summary.
      if (d.type !== "text") { this.verdict = "pass"; out.push(...this.flush(), d); continue; }
      this.opening += String(d.content ?? "");
      this.held.push(d);
      const trimmed = this.opening.trimStart();
      if (trimmed.startsWith(COMPACTION_OPENER)) { this.verdict = "drop"; this.held = []; continue; }
      if (!trimmed || COMPACTION_OPENER.startsWith(trimmed)) continue; // still could be it
      this.verdict = "pass";
      out.push(...this.flush());
    }
    return out;
  }

  /** Message finished — release anything still held (messages shorter than the opener). */
  end(): StreamDelta[] {
    const out = this.verdict === "drop" ? [] : this.flush();
    this.reset();
    return out;
  }

  private flush(): StreamDelta[] {
    const h = this.held;
    this.held = [];
    return h;
  }
}

const STOP_FAILURE_GRACE_MS = 20_000;
/** StopFailure errors that must settle immediately. Rate-limit/billing/auth
 *  need the manager fallback machinery right away; everything else gets a grace
 *  window because Claude Code can keep working after a sub-agent/API failure. */
const IMMEDIATE_STOP_FAILURE_ERRORS = new Set(["rate_limit", "billing_error", "authentication_failed", "max_output_tokens"]);

export interface TurnResolverOpts {
  fallbackSessionId: string | undefined;
  /** When true (warm-PTY reuse / post-idle-spawn), the resolver skips waiting for
   *  SessionStart (it already fired once at process start) and pre-fills the
   *  Claude session id from fallbackSessionId. */
  assumeStarted?: boolean;
  /** Test override for the StopFailure grace window (default 20s). */
  stopFailureGraceMs?: number;
  /** While true, a graced StopFailure keeps waiting instead of settling. */
  shouldDeferStopFailure?: () => boolean;
  /** This turn is a Claude-native local command (see isNativeClaudeCommand). Such
   *  commands produce no new assistant message, so a Stop hook's
   *  last_assistant_message is the PREVIOUS turn's stale text — maybeComplete must
   *  settle empty rather than re-persist it as a duplicate. */
  native?: boolean;
}

/** State machine for one interactive turn: resolves after BOTH SessionStart + Stop, or on StopFailure/interrupt. */
export class TurnResolver {
  readonly promise: Promise<EngineResult>;
  private resolve!: (r: EngineResult) => void;
  private settled = false;
  private claudeSessionId: string | undefined;
  private gotSessionStart = false;
  private stopPayload: HookPayload | undefined;
  private stopFailurePayload: HookPayload | undefined;
  private graceTimer: NodeJS.Timeout | undefined;

  constructor(private opts: TurnResolverOpts) {
    this.promise = new Promise((res) => { this.resolve = res; });
    if (opts.assumeStarted) {
      this.gotSessionStart = true;
      this.claudeSessionId = opts.fallbackSessionId;
    }
  }

  onHook(h: HookPayload): void {
    if (this.settled) return;
    if (h.hook_event_name === "SessionStart") {
      this.gotSessionStart = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      // A Stop supersedes any pending StopFailure — the CLI retried and finished.
      this.clearGrace();
      this.stopFailurePayload = undefined;
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn. In interactive mode the CLI survives
      // invalid_request/server_error/unknown and usually retries — hold the
      // failure in a grace window instead of settling: a later Stop supersedes
      // it, activity re-arms it, the PTY-death watchdog still fails fast.
      // Other error types (rate_limit, billing, auth) settle immediately.
      // numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      if (!IMMEDIATE_STOP_FAILURE_ERRORS.has(String(h.error ?? "unknown"))) {
        this.armGrace();
      } else {
        this.settleWithFailure();
      }
    } else {
      // PreToolUse/PostToolUse/etc — proof of life while a failure is pending.
      this.noteActivity();
    }
  }

  /** Claude session id learned so far (for engineSessionId persistence on warm-PTY turns). */
  get sessionId(): string | undefined { return this.claudeSessionId; }
  get isSettled(): boolean { return this.settled; }
  /** The StopFailure payload, if the turn ended in an API error (Task 5.3 maps it to rateLimit). */
  get stopFailure(): HookPayload | undefined { return this.stopFailurePayload; }
  /** transcript_path from whichever hook carried it. */
  get transcriptPath(): string | undefined {
    const p = this.stopPayload?.transcript_path ?? this.stopFailurePayload?.transcript_path;
    return typeof p === "string" ? p : undefined;
  }

  private maybeComplete(): void {
    if (!this.gotSessionStart || !this.stopPayload) return;
    const sid = this.claudeSessionId ?? this.opts.fallbackSessionId;
    if (!sid) {
      this.settle({ sessionId: "", result: "", error: "Interactive turn produced no Claude session id" });
      return;
    }
    // Native local commands (/usage, /limits, …) produce no new assistant
    // message; the Stop hook's last_assistant_message is the prior turn's stale
    // text. Settling with it would persist a duplicate chat echo — settle empty.
    const text = this.opts.native ? "" : stripReasoningBlocks(String(this.stopPayload.last_assistant_message ?? ""));
    this.settle({ sessionId: sid, result: text, error: undefined, numTurns: 1 });
  }

  interrupt(reason: string): void {
    // PTY died while a StopFailure was held in grace — the API error is the
    // real cause; report it instead of the generic "process exited". Other
    // interrupt reasons (user abort, engine switch, preemption) keep their
    // "Interrupted: …" text so the quiet-interrupt handling downstream engages.
    if (this.stopFailurePayload && !this.settled && reason === "Interrupted: claude process exited") {
      this.settleWithFailure();
      return;
    }
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }

  completeNativeCommand(): void {
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", numTurns: 1 });
  }

  completeRecovered(text: string, sessionId?: string): void {
    if (sessionId && !this.claudeSessionId) this.claudeSessionId = sessionId;
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: stripReasoningBlocks(text), numTurns: 1 });
  }

  /** Proof of life (SSE delta / tool hook) while a StopFailure is pending —
   *  re-arms the grace window. No-op when no failure is pending. */
  noteActivity(): void {
    if (this.graceTimer) this.armGrace();
  }

  private armGrace(): void {
    this.clearGrace();
    const ms = this.opts.stopFailureGraceMs ?? STOP_FAILURE_GRACE_MS;
    this.graceTimer = setTimeout(() => {
      if (this.opts.shouldDeferStopFailure?.()) {
        this.armGrace();
        return;
      }
      this.settleWithFailure();
    }, ms);
    this.graceTimer.unref?.();
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  private settleWithFailure(): void {
    this.settle({
      sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
      result: "",
      error: `Interactive turn failed: ${this.stopFailurePayload?.error ?? "unknown"}`,
      numTurns: 1,
    });
  }

  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    this.clearGrace();
    this.resolve(r);
  }
}

/** How long activeStreams must sit at 0 (post-settle) before the engine reports
 *  the session's background activity as cleared. Background subagents fire
 *  consecutive API requests with small gaps between them — a quiet window keeps
 *  the indicator from flapping null↔active on every inter-request beat. */
const BACKGROUND_CLEAR_QUIET_MS = 10_000;

const NATIVE_COMMAND_QUIET_MS = 1800;
const NATIVE_COMMAND_MIN_MS = 3000;
const NATIVE_COMMAND_MAX_MS = 90_000;
const LOST_STOP_RECOVERY_QUIET_MS = 60_000;
const LOST_STOP_RECOVERY_MIN_MS = 5 * 60_000;
const LATE_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
/**
 * Terminal backstop for a turn that produced no Stop hook AND cannot be
 * recovered from a transcript. Transcript recovery needs a Claude session id
 * (`resolver.sessionId ?? opts.resumeSessionId`); on a FRESH spawn ("resume:
 * none") whose SessionStart hook was also lost, both are undefined, so the
 * recovery interval can only ever return early. Without this the turn never
 * settles: the session is pinned at "running" forever and its queued messages
 * never dispatch. Deliberately far above the recovery thresholds so genuine
 * recovery always gets first refusal.
 */
const TURN_STALL_TIMEOUT_MS = 15 * 60_000;
const TURN_STALL_QUIET_MS = 5 * 60_000;

/** Stall predicate, split out so it is testable without a live PTY. Both bounds
 *  must hold: a long turn that is still streaming is healthy, and a brief quiet
 *  gap early in a turn is normal. Exported for tests. */
export function shouldSettleStalledTurn(elapsedMs: number, quietMs: number): boolean {
  return elapsedMs >= TURN_STALL_TIMEOUT_MS && quietMs >= TURN_STALL_QUIET_MS;
}

/** Warm-PTY submit confirmation. The CR that submits a bracketed paste is not
 *  guaranteed to land — a 30-line paste into a TUI that is mid-redraw (or near
 *  auto-compact) can swallow it, stranding the text in the composer while the
 *  gateway waits forever on a turn that never started. UserPromptSubmit is the
 *  CLI's acknowledgement; until it arrives, re-send the CR. Every window here is
 *  bounded so an unsubmittable prompt fails loudly instead of hanging. */
const SUBMIT_CONFIRM_INTERVAL_MS = 1500;
const SUBMIT_CONFIRM_ATTEMPTS = 3;
/** Hooks that prove the pasted prompt is running. SessionStart is excluded on
 *  purpose: the idle spawn that warmed this PTY fires it before the paste. */
const SUBMIT_ACK_HOOKS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure"]);

/** Claude Code built-in slash commands that run locally and never produce a new
 *  assistant API turn. Two behaviours, both handled by the native-command path:
 *   - Context mutators (/compact, /clear, /model) end without firing a Stop hook;
 *     the native-command quiet-window timer settles them with an empty result.
 *   - Info/overlay commands (/usage, /limits, /cost, …) DO fire a Stop hook on
 *     dismiss, but its `last_assistant_message` still carries the PREVIOUS turn's
 *     text. Without native classification that stale text was persisted as a new
 *     assistant message — the duplicate-chat-echo bug. native-aware maybeComplete
 *     settles these empty instead.
 *  Only commands that genuinely yield no persistable assistant output belong here:
 *  misclassifying a real-turn command (/init, /review, skill commands) would drop
 *  its answer. */
const NATIVE_CLAUDE_COMMANDS = new Set([
  "/compact", "/clear", "/model",
  "/usage", "/limits", "/cost", "/status", "/config", "/help", "/doctor",
  "/release-notes", "/vim", "/terminal-setup", "/mcp", "/agents", "/permissions",
  "/hooks", "/memory", "/export", "/login", "/logout", "/bug", "/resume",
]);

export function isNativeClaudeCommand(prompt: string): boolean {
  const first = prompt.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return first !== undefined && NATIVE_CLAUDE_COMMANDS.has(first);
}

/** Per-session bookkeeping for the turn currently in flight. Everything here is
 *  in-memory and lives exactly as long as run() is pending, which is also exactly
 *  the window in which the gateway's 5s heartbeat is asserting status:"running".
 *  turnProgress() reads it so that assertion can be checked instead of trusted. */
interface ActiveTurn {
  resolver: TurnResolver;
  onStream?: (d: StreamDelta) => void;
  boundProc?: pty.IPty;
  /** Suppresses auto-compaction summaries from leaking into the chat stream. */
  gate?: CompactionStreamGate;
  /** Local tool calls in flight (PreToolUse seen, PostToolUse not yet). A long
   *  tool is real work, so a quiet PTY with tools running is NOT a stall. */
  activeTools: number;
  startedAt: number;
  /** Last hook of any kind — proof of life independent of PTY redraw noise. */
  lastHookAt: number;
  /** Set once the CLI acknowledges the prompt. False forever = swallowed submit. */
  promptSubmitted: boolean;
  /** Stops the submit-confirmation retry loop; called when the turn settles. */
  cancelSubmitConfirm?: () => void;
}

/** Optional submit acknowledgement probe for pasteAndSubmit. Supplied by the
 *  gateway-driven warm-PTY path, where an unsubmitted prompt is an invisible hang;
 *  omitted for raw WS input, where a human is at the keyboard and can press Enter. */
export interface SubmitConfirmation {
  /** True once the CLI acknowledged the prompt (UserPromptSubmit or any in-turn hook). */
  submitted: () => boolean;
  /** Called before each re-sent CR. */
  onRetry?: (attempt: number) => void;
  /** Called when the retries are exhausted and the prompt is still unacknowledged. */
  onUnconfirmed?: (attempts: number) => void;
  /** Test overrides. */
  intervalMs?: number;
  attempts?: number;
}

/** Bracketed-paste `text` into a PTY then submit with CR after a 150ms beat.
 *  Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! —
 *  they still trigger the slash-command / mention / bash-mode handlers and the
 *  turn is never submitted. neutralizeForPaste() prepends a space for mentions,
 *  bash-mode, and jinn-skill slash commands, while letting engine-native commands
 *  (/compact, /clear, /model, …) pass through raw so the TUI actually runs them.
 *  Shared by injectPrompt() (warm-PTY first turn) and writeStdin() (raw WS input).
 *
 *  Pass `confirm` to make the submit verified rather than assumed: the CR is
 *  re-sent until the CLI acknowledges the prompt, and `onUnconfirmed` fires if it
 *  never does. Backticking attachment paths (below) removes the known trigger for
 *  a swallowed CR; this covers the ones we have not characterised — a large paste
 *  into a TUI mid-redraw, or one near auto-compact. Returns a cancel function —
 *  the caller MUST call it when the turn settles (see the cancellation note). */
/**
 * Compose the "Attached files:" suffix, with every path wrapped in backticks.
 *
 * The backticks are load-bearing, not cosmetic. Claude Code's TUI scans
 * bracketed-paste text for tokens resolving to an existing IMAGE file and, on a
 * hit, enters an async "Pasting…" state while it reads and base64-encodes the
 * file into an `[Image #N]` chip. Keypresses are discarded while that state is
 * active — including pasteAndSubmit's submit CR, which fires on a fixed 150ms
 * timer. Any real screenshot takes longer than 150ms to encode, so the CR is
 * swallowed and the turn hangs forever: text sits in the input box, no spinner,
 * no error, no Stop hook.
 *
 * Verified against a live PTY (claude 2.1.220): a 5.8MB PNG hangs at 150ms and
 * submits at 400ms; the same path in backticks submits at 150ms every time.
 * Newlines are irrelevant — a zero-newline prompt with a real image path hangs,
 * and a three-newline prompt with a non-existent path submits.
 *
 * Backticks stop the path from being auto-attached, so there is no async state
 * to race. The model resolves the path with Read (which renders images), which
 * is already how the cold/argv path behaves — argv prompts never traverse the
 * TUI paste handler, so warm and cold now agree.
 */
export function buildAttachmentSuffix(attachments: readonly string[]): string {
  return "\n\nAttached files:\n" + attachments.map((a) => `- \`${a}\``).join("\n");
}

export function pasteAndSubmit(
  proc: Pick<pty.IPty, "write">,
  text: string,
  confirm?: SubmitConfirmation,
): () => void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~`);
  let retryTimer: NodeJS.Timeout | undefined;
  const submitTimer = setTimeout(() => {
    proc.write("\r");
    if (!confirm) return;
    const maxAttempts = confirm.attempts ?? SUBMIT_CONFIRM_ATTEMPTS;
    let attempt = 0;
    retryTimer = setInterval(() => {
      if (confirm.submitted()) {
        if (retryTimer) clearInterval(retryTimer);
        retryTimer = undefined;
        return;
      }
      if (attempt >= maxAttempts) {
        if (retryTimer) clearInterval(retryTimer);
        retryTimer = undefined;
        confirm.onUnconfirmed?.(attempt);
        return;
      }
      attempt += 1;
      confirm.onRetry?.(attempt);
      proc.write("\r");
    }, confirm.intervalMs ?? SUBMIT_CONFIRM_INTERVAL_MS);
    retryTimer.unref?.();
  }, 150);
  // Cancellation is not optional: a turn that settles for any other reason (user
  // interrupt, PTY death, engine switch) must stop this loop, or it would keep
  // writing CRs into a PTY that now belongs to a DIFFERENT turn — submitting
  // whatever that turn's composer happens to hold.
  return () => {
    clearTimeout(submitTimer);
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = undefined;
  };
}

export class InteractiveClaudeEngine implements InterruptibleEngine, PtyViewEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Jinn session id. `boundProc` is the specific
   *  PTY serving this turn (captured at spawn / warm-reuse). A PTY's onExit only
   *  interrupts the active resolver when it IS that bound proc — so a stale PTY
   *  released by a kill->respawn race can't poison the freshly-started turn.
   *  `onStream` is the current turn's delta callback; the per-PTY SSE proxy routes
   *  parsed events here (a PTY outlives its turn, so the proxy looks this up live). */
  private active = new Map<string, ActiveTurn>();
  /** Sessions with an in-flight async idle-spawn (proxy.start awaited) — prevents
   *  a second ensureIdleSpawn from racing in a duplicate PTY during that gap. */
  private idleSpawning = new Set<string>();
  /** Per-session PTY output streams (scrollback ring buffer + live subscribers).
   *  Survives PTY respawn. */
  private streams: PtyStreamManager;
  /** Last terminal geometry reported by the client per session. Used to spawn
   *  follow-up PTYs at the correct dimensions when a turn comes in after the
   *  warm PTY was reaped — otherwise spawn() falls back to 120×40 and the TUI
   *  text body is locked in at the wrong width. Intentionally survives PTY
   *  release (its job is to size the NEXT spawn); growth is bounded by setCapped. */
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  private lastOutputAt = new Map<string, number>();
  /** Model/effort the live PTY was spawned with, per session. `--model`/`--effort`
   *  apply only at spawn, so a mid-chat switch must cold-respawn rather than reuse
   *  the warm PTY (which would keep running the old model). */
  private spawnParams = new Map<string, { model?: string; effortLevel?: string; appendApplied?: boolean }>();
  /** Sessions with a post-failure recovery listener armed (turn settled as an
   *  API error, but the CLI may still finish — a late Stop supersedes). */
  private lateRecovery = new Map<string, { timer: NodeJS.Timeout }>();
  /** Post-settle background work per session: the CLI's SSE proxy still has
   *  upstream requests in flight (background subagents/tasks) after the Stop
   *  hook settled the turn. `emitted` tracks whether the gateway was told, so a
   *  cleared (null) notification is only sent when there's something to clear. */
  private bgActivity = new Map<string, { info: UpstreamActivityInfo; clearTimer?: NodeJS.Timeout; emitted: boolean }>();
  private backgroundActivityCb?: (jinnSessionId: string, info: UpstreamActivityInfo | null) => void;
  /** Test override for the post-settle clear quiet window (default 10s). */
  backgroundClearQuietMs = BACKGROUND_CLEAR_QUIET_MS;

  constructor(
    private lifecycle: PtyLifecycleManager,
    private hookRegistry: HookRegistry,
  ) {
    this.streams = new PtyStreamManager("PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    // Purge per-PTY bookkeeping whenever the session's PTY is released (kill,
    // LRU eviction, sweep reap, cold respawn) so these maps don't grow forever
    // in a long-running daemon. Both are meaningful only while a PTY is live and
    // are repopulated on the next spawn. lastGeom is NOT purged here — see above.
    this.lifecycle.onRelease((id) => {
      this.lastOutputAt.delete(id);
      this.spawnParams.delete(id);
      // The PTY (and its SSE proxy) died — any in-flight counts are moot.
      this.clearBackground(id);
    });
  }

  /** Single-registration callback for post-settle background activity. `info` is
   *  the live in-flight snapshot; `null` means cleared (quiet for
   *  backgroundClearQuietMs, or the session's PTY was released). Never fires
   *  while a run() is in flight for the session — the turn is already "running";
   *  only post-settle activity matters. */
  onBackgroundActivity(cb: (jinnSessionId: string, info: UpstreamActivityInfo | null) => void): void {
    this.backgroundActivityCb = cb;
  }

  onRuntimeActivity(cb: (jinnSessionId: string, info: UpstreamActivityInfo | null) => void): void {
    this.onBackgroundActivity(cb);
  }

  /** Per-PTY SSE proxy reported an in-flight change. Always record it (counts
   *  must stay truthful across the run boundary); emission is gated downstream. */
  private handleUpstreamActivity(jinnSessionId: string, info: UpstreamActivityInfo): void {
    this.lifecycle.setRuntimeActive(jinnSessionId, info.activeStreams > 0);
    let st = this.bgActivity.get(jinnSessionId);
    if (!st) {
      st = { info, emitted: false };
      this.bgActivity.set(jinnSessionId, st);
    } else {
      st.info = info;
    }
    this.maybeEmitBackground(jinnSessionId);
  }

  /** Emit the session's background state if it's post-settle and changed:
   *  active streams emit immediately (cancelling any pending clear); zero
   *  streams arm a quiet-window timer that emits `null` once, only if activity
   *  was previously reported. Suppressed entirely while a run() is in flight. */
  private maybeEmitBackground(jinnSessionId: string): void {
    const st = this.bgActivity.get(jinnSessionId);
    if (!st) return;
    if (this.active.has(jinnSessionId)) return; // in-flight turn — already "running"
    if (st.info.activeStreams > 0) {
      if (st.clearTimer) { clearTimeout(st.clearTimer); st.clearTimer = undefined; }
      st.emitted = true;
      this.backgroundActivityCb?.(jinnSessionId, { ...st.info });
      return;
    }
    if (!st.emitted) {
      // Reached 0 without ever being reported post-settle — nothing to clear.
      this.bgActivity.delete(jinnSessionId);
      return;
    }
    if (st.clearTimer) return; // quiet window already armed
    st.clearTimer = setTimeout(() => {
      const cur = this.bgActivity.get(jinnSessionId);
      if (cur !== st) return; // state was recreated/cleared since arming
      if (cur.info.activeStreams > 0) { cur.clearTimer = undefined; return; }
      this.bgActivity.delete(jinnSessionId);
      this.backgroundActivityCb?.(jinnSessionId, null);
    }, this.backgroundClearQuietMs);
    st.clearTimer.unref?.();
  }

  /** A new run() is taking the session: retract any reported background state
   *  (the session is about to be "running") but KEEP the live counts — the proxy
   *  persists across turns, and run()'s finally re-checks them post-settle. */
  private suppressBackground(jinnSessionId: string): void {
    const st = this.bgActivity.get(jinnSessionId);
    if (!st) return;
    if (st.clearTimer) { clearTimeout(st.clearTimer); st.clearTimer = undefined; }
    const wasEmitted = st.emitted;
    st.emitted = false;
    if (wasEmitted) this.backgroundActivityCb?.(jinnSessionId, null);
  }

  /** Drop all background state for a session (PTY released / killed), emitting
   *  the cleared notification if activity had been reported. */
  private clearBackground(jinnSessionId: string): void {
    this.lifecycle.setRuntimeActive(jinnSessionId, false);
    const st = this.bgActivity.get(jinnSessionId);
    if (!st) return;
    if (st.clearTimer) clearTimeout(st.clearTimer);
    this.bgActivity.delete(jinnSessionId);
    if (st.emitted) this.backgroundActivityCb?.(jinnSessionId, null);
  }

  private hasActiveUpstream(jinnSessionId: string): boolean {
    return (this.bgActivity.get(jinnSessionId)?.info.activeStreams ?? 0) > 0;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("InteractiveClaudeEngine.run requires opts.sessionId");
    const turnStartedAt = Date.now();

    // Guard: refuse a second concurrent turn for the same session.
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    // A previous turn may have left a late-recovery listener armed; this new
    // turn owns the session (and the hook registration) now.
    this.cancelLateRecovery(jinnSessionId);
    // Retract any reported post-settle background activity — the session is
    // about to be "running", which supersedes the background indicator.
    this.suppressBackground(jinnSessionId);

    let warm = this.lifecycle.getWarm(jinnSessionId);
    // Mid-chat model/effort switch: `--model`/`--effort` bind at spawn, so a warm
    // PTY would silently keep the OLD model. If the request differs from what this
    // PTY was spawned with, drop the warm PTY and cold-respawn (--resume keeps the
    // conversation) so the new model/effort actually takes effect.
    if (warm) {
      const prev = this.spawnParams.get(jinnSessionId);
      const norm = (v?: string) => (!v || v === "default" ? "" : v);
      const modelOrEffortChanged =
        !!prev && (norm(opts.model) !== norm(prev.model) || norm(opts.effortLevel) !== norm(prev.effortLevel));
      // Idle-spawned PTYs (terminal view) are born WITHOUT --append-system-prompt, so
      // they carry neither the persona/org context nor the main-agent sentinel. Force a
      // cold respawn on the first real turn so it runs on-persona AND streams to the
      // chat pane (the sentinel is what makes the SSE proxy tee). --resume preserves
      // the conversation.
      const missingPrompt = !prev || prev.appendApplied !== true;
      if (modelOrEffortChanged || missingPrompt) {
        logger.info(`InteractiveClaudeEngine: cold respawn for ${jinnSessionId} (${modelOrEffortChanged ? "model/effort changed" : "warm PTY missing --append-system-prompt"})`);
        this.lifecycle.releaseSession(jinnSessionId);
        warm = undefined;
      }
    }

    // Write the per-turn --settings file AFTER any cold-respawn release above:
    // releaseSession() fires onCleanup → cleanupSessionSettings(), which DELETES this
    // exact file. Writing it earlier meant the model/effort cold-respawn spawned
    // `claude --settings <file>` against a file we'd just unlinked → the CLI/xterm
    // view showed "Settings file not found". The settings file carries HOOKS only; the
    // system prompt + main-agent sentinel go via the --append-system-prompt CLI flag at
    // spawn() (the settings-file appendSystemPrompt KEY is ignored by claude ≥2.1.x).
    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      statusLineDir: CLAUDE_LIMITS_DIR,
    });
    // A cold-respawn release cleans the per-session MCP file. Materialize the
    // already-resolved config again at the boundary where Claude will read it.
    if (!warm && opts.resolvedMcp) {
      opts.mcpConfigPath = writeMcpConfigFile(opts.resolvedMcp, jinnSessionId);
    }
    const nativeCommand = isNativeClaudeCommand(opts.prompt);
    const resolver = new TurnResolver({
      fallbackSessionId: opts.resumeSessionId,
      assumeStarted: !!warm, // warm PTY = SessionStart already fired (turn 1 or idle spawn)
      native: nativeCommand,
      shouldDeferStopFailure: () => this.hasActiveUpstream(jinnSessionId),
    });
    const entry: ActiveTurn = {
      resolver,
      onStream: opts.onStream,
      activeTools: 0,
      startedAt: turnStartedAt,
      lastHookAt: turnStartedAt,
      // Only the warm-PTY paste has to earn this flag. The cold-spawn path carries
      // the prompt in argv, so it is submitted by construction; native commands are
      // exempt because no acknowledgement is expected for them (see injectPrompt
      // below) and awaitingSubmit must not mean "waiting for a signal we never want".
      promptSubmitted: !warm || nativeCommand,
    };
    let turnMarkedStarted = false;
    let watchdog: NodeJS.Timeout | undefined;
    let nativeCommandTimer: NodeJS.Timeout | undefined;
    let lostStopRecoveryTimer: NodeJS.Timeout | undefined;

    let result!: EngineResult;
    this.active.set(jinnSessionId, entry);
    try {
      // Register BEFORE spawning so a fast SessionStart is buffered+drained, not lost.
      this.hookRegistry.register(jinnSessionId, (h) => {
        resolver.onHook(h);
        entry.lastHookAt = Date.now();
        // Submit acknowledgement. UserPromptSubmit is the direct signal; the in-turn
        // hooks are accepted too because none of them can fire before a prompt is
        // running. SessionStart is deliberately NOT accepted — it can arrive from the
        // idle spawn that preceded this turn and would falsely confirm the submit.
        if (SUBMIT_ACK_HOOKS.has(h.hook_event_name)) {
          entry.promptSubmitted = true;
        }
        // tool_use markers + intermediate text stream from the per-PTY SSE proxy
        // in true order. The hook only supplies tool_result; SSE has no local tool
        // completion event because tools execute between assistant messages.
        if (h.hook_event_name === "PreToolUse") {
          entry.activeTools += 1;
        }
        if (h.hook_event_name === "PostToolUse") {
          entry.activeTools = Math.max(0, entry.activeTools - 1);
          for (const delta of claudeHookToDeltas(h as Record<string, unknown>)) opts.onStream?.(delta);
        }
      });

      if (warm) {
        // Mark the turn started BEFORE injecting so the sweep timer can't
        // theoretically release the PTY mid-paste if its grace window expired
        // between getWarm() above and the proc.write() inside injectPrompt.
        this.lifecycle.turnStarted(jinnSessionId);
        turnMarkedStarted = true;
        // Native commands (/compact, /clear, /model) run locally and settle via
        // nativeCommandTimer; they need not emit UserPromptSubmit at all, so
        // confirming them would re-send CRs at a prompt that already did its work.
        // Same exclusion the lost-Stop recovery makes below, for the same reason.
        entry.cancelSubmitConfirm = this.injectPrompt(warm, opts, nativeCommand ? undefined : {
          // A settled turn is no longer ours to submit — stop either way. Without
          // this the loop would outlive an early interrupt until run()'s finally.
          submitted: () => entry.promptSubmitted || resolver.isSettled,
          onRetry: (attempt) => logger.warn(
            `InteractiveClaudeEngine: prompt submit unacknowledged for ${jinnSessionId} — re-sending CR (attempt ${attempt})`,
          ),
          // Every retry failed: the CLI is not going to take this prompt. Settle the
          // turn instead of leaving run() pending forever — the heartbeat would keep
          // asserting status:"running" and no other watchdog covers a live PTY that
          // simply never started a turn. The pasted text is still in the composer, so
          // the operator (or a resume) loses nothing.
          onUnconfirmed: (attempts) => {
            logger.warn(
              `InteractiveClaudeEngine: prompt never submitted for ${jinnSessionId} after ${attempts} retries ` +
              `— settling turn as interrupted (text remains in the CLI composer)`,
            );
            resolver.interrupt("Interrupted: the engine never acknowledged the prompt (submit not confirmed)");
          },
        });
        entry.boundProc = (warm as any)._proc as pty.IPty | undefined;
      } else {
        const handle = await this.spawn(jinnSessionId, opts, settingsPath);
        this.lifecycle.adopt(jinnSessionId, handle, { turnRunning: true });
        this.lifecycle.turnStarted(jinnSessionId);
        turnMarkedStarted = true;
        entry.boundProc = (handle as any)._proc as pty.IPty | undefined;
      }

      // Watchdog: if the bound PTY dies without the resolver settling (e.g. the
      // onExit identity-guard didn't match in a kill→respawn race), the turn would
      // hang forever — runWebSession's 5s heartbeat would zombie status:"running"
      // and the completion (session:completed + notifyParentSession parent callback)
      // would never fire. Both the stuck "in progress" badge and lost child-session
      // callbacks trace to this. Force-settle once the proc is provably dead so
      // run() always resolves and the normal completion path runs.
      watchdog = setInterval(() => {
        const p = entry.boundProc as { _exitCode?: number | null } | undefined;
        if (p && p._exitCode != null) {
          resolver.interrupt("Interrupted: claude process exited");
        }
      }, 5000);
      watchdog.unref?.();

      if (nativeCommand) {
        const startedAt = Date.now();
        nativeCommandTimer = setInterval(() => {
          const now = Date.now();
          const quietFor = now - (this.lastOutputAt.get(jinnSessionId) ?? startedAt);
          const elapsed = now - startedAt;
          if ((elapsed >= NATIVE_COMMAND_MIN_MS && quietFor >= NATIVE_COMMAND_QUIET_MS) || elapsed >= NATIVE_COMMAND_MAX_MS) {
            resolver.completeNativeCommand();
          }
        }, 500);
        nativeCommandTimer.unref?.();
      }

      if (!nativeCommand) {
        const startedAt = Date.now();
        lostStopRecoveryTimer = setInterval(() => {
          if (resolver.isSettled) return;
          // A StopFailure is held in the grace window — the turn's fate is the
          // grace timer's call (Stop supersedes / expiry fails). Recovering
          // intermediate transcript text here would fabricate a wrong success.
          if (resolver.stopFailure) return;
          // Missing-Stop recovery is only safe when the model stream and local
          // tool hooks are quiet; otherwise a long-running turn can be mistaken
          // for a completed one just because transcript text exists.
          if (entry.activeTools > 0 || this.hasActiveUpstream(jinnSessionId)) return;
          const now = Date.now();
          const elapsed = now - startedAt;
          const quietFor = now - (this.lastOutputAt.get(jinnSessionId) ?? startedAt);
          if (elapsed < LOST_STOP_RECOVERY_MIN_MS || quietFor < LOST_STOP_RECOVERY_QUIET_MS) return;
          const sid = resolver.sessionId ?? opts.resumeSessionId;
          // Only attempt recovery when we can identify THIS turn's transcript.
          // Transcripts share one project dir keyed by Claude session id, so
          // guessing by mtime could attach another session's answer.
          const transcript = sid ? findTranscriptForSession(sid) : undefined;
          let transcriptIsFresh = false;
          if (transcript) {
            try { transcriptIsFresh = fs.statSync(transcript).mtimeMs >= startedAt - 1000; } catch { /* unreadable */ }
          }
          if (transcript && transcriptIsFresh) {
            const recovered = lastAssistantTextFromTranscript(transcript, startedAt);
            if (recovered?.trim()) {
              logger.warn(`InteractiveClaudeEngine: recovered completed turn for ${jinnSessionId} after missing Stop hook`);
              resolver.completeRecovered(recovered, sid);
              return;
            }
          }
          // Nothing recoverable. Settle rather than hang: an unsettled turn pins
          // the session at "running" forever and blocks its message queue. Not
          // prefixed "Interrupted:" on purpose — that triggers quiet-preempt
          // handling downstream, and a stall must surface as a real error.
          if (shouldSettleStalledTurn(elapsed, quietFor)) {
            logger.warn(
              `InteractiveClaudeEngine: turn for ${jinnSessionId} stalled — no Stop hook and no recoverable ` +
              `transcript (claudeSessionId=${sid ?? "unknown"}) after ${Math.round(elapsed / 60_000)}m, ` +
              `${Math.round(quietFor / 60_000)}m quiet. Settling so the session unsticks.`,
            );
            resolver.interrupt("Turn stalled: the engine produced no completion signal and no recoverable transcript");
          }
        }, 2000);
        lostStopRecoveryTimer.unref?.();
      }

      result = await resolver.promise;
    } finally {
      if (watchdog) clearInterval(watchdog);
      if (nativeCommandTimer) clearInterval(nativeCommandTimer);
      if (lostStopRecoveryTimer) clearInterval(lostStopRecoveryTimer);
      // MUST run before the PTY can be handed to another turn — see pasteAndSubmit.
      entry.cancelSubmitConfirm?.();
      this.hookRegistry.unregister(jinnSessionId);
      this.active.delete(jinnSessionId);
      if (turnMarkedStarted) this.lifecycle.turnEnded(jinnSessionId); // manager decides kill vs keep-warm
      else cleanupSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId);
      // Turn settled — if the CLI still has upstream requests in flight
      // (background subagents/tasks), report them now; emission was suppressed
      // while this run owned the session.
      this.maybeEmitBackground(jinnSessionId);
    }

    // Reconstruct cost from the transcript (the Stop hook carries no cost).
    const transcriptPath = resolver.transcriptPath;
    if (transcriptPath && !result.error) {
      // Scope to THIS turn: the transcript is cumulative and the caller adds
      // result.cost to the session total, so an unscoped sum over-counts.
      const cost = computeInteractiveCost(transcriptPath, opts.model, turnStartedAt);
      if (cost) { result.cost = cost.cost; result.numTurns = cost.turns; }
      // Context-meter: most recent turn's input context (input + cache), mirroring
      // headless claude.ts so interactive/CLI-view turns also populate the meter.
      const ctx = lastTurnContextTokens(transcriptPath);
      if (ctx) result.contextTokens = ctx;
    }
    // Recover lost result text: if the turn settled with no text and no API-level
    // failure, the Stop hook (which carries last_assistant_message) was dropped —
    // a gateway restart deleted gateway.json mid-turn so hook-relay.mjs couldn't
    // POST it, or the PTY died / SSE proxy dropped before it landed. The real final
    // message is still on disk in the transcript; backfill it so the parent-session
    // callback shows real output instead of "(no output)". stopFailure turns are a
    // genuine no-output API error — leave those alone.
    if (!nativeCommand && !result.error && !result.result?.trim() && !resolver.stopFailure) {
      const sid = resolver.sessionId ?? opts.resumeSessionId ?? result.sessionId;
      const recoveryPath = sid ? findTranscriptForSession(sid) : undefined;
      const recovered = recoveryPath ? lastAssistantTextFromTranscript(recoveryPath, turnStartedAt) : undefined;
      if (recovered) {
        logger.info(`Recovered ${recovered.length} chars of lost turn text for session ${jinnSessionId} from transcript (Stop hook missing)`);
        result.result = stripReasoningBlocks(recovered);
      }
    }
    // Map a StopFailure rate-limit into result.rateLimit so manager.ts's
    // wait/retry/fallback machinery engages exactly as it does for `claude -p`.
    const rl = rateLimitFromStopFailure(resolver.stopFailure);
    if (rl) result.rateLimit = rl;
    // Turn settled as an API-error failure — the CLI may still be retrying.
    // Keep listening for a late Stop so a wrong "failed" verdict self-corrects.
    if (result.error && resolver.stopFailure) {
      this.armLateRecovery(jinnSessionId, opts);
    }
    return result;
  }

  /** Build the env passed to the claude PTY: inherits process.env but strips
   *  CLAUDECODE / CLAUDE_CODE_* so the child doesn't think it's nested, then
   *  enables fullscreen rendering. Shared by spawn() and ensureIdleSpawn().
   *  When `proxyPort` is given, points ANTHROPIC_BASE_URL at the per-PTY SSE
   *  forward proxy on 127.0.0.1 — subscription OAuth token is passed separately
   *  by claude, so this stays cc_entrypoint=cli / subsidy-safe (verified Item A). */
  private buildPtyEnv(proxyPort?: number, sessionId?: string): Record<string, string> {
    const env = buildEngineChildEnv(process.env, {
      scrubClaudeCode: true,
      // Belt-and-suspenders: a stray API key/token would flip the child to metered
      // API billing instead of the Max subscription. Strip both so the PTY session
      // always resolves to subscription auth (cc_entrypoint=cli).
      // ANTHROPIC_BASE_URL is set below from our own proxy port. An inherited one
      // (gateway launched from inside another jinn claude PTY) would point the
      // child at a dead loopback proxy and, worse, fail claude's first-party host
      // check without the assertion below — silently halving its context window.
      denyExact: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
    });
    // Use claude's main-screen renderer (NOT the alt-screen fullscreen one).
    // xterm.js's `scrollback` ring only applies to the main buffer — the alt
    // screen has no scrollback at all, so wheel-scroll in our CLI view is
    // impossible while NO_FLICKER is on. Trading mild flicker for usable scroll.
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
    env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = "999999999"; // suppress "resume from summary?" picker — always full-resume
    // Auto-compact at the model's real ceiling instead of claude's default budget.
    // The auto-compact trigger is a SEPARATE budget from the model's context window:
    // it resolves from env > settings > server client-data > per-model default, and
    // that default sits near 200K even on models whose window is 1M (opus-5 declares
    // `native_1m`). Left alone, long sessions compact ~5x more often than the model
    // requires. claude clamps this to the model's own max (`min(modelWindow, value)`)
    // and only accepts 100_000..1_000_000, so asking for 1M is safe for every model:
    // a haiku-4-5 turn silently clamps back to its real 200K window. scrubClaudeCode
    // strips any inherited value, so read the operator's override off process.env.
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || "1000000";
    if (sessionId) env.JINN_SESSION_ID = sessionId;
    if (proxyPort) {
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
      // The proxy forwards every request UNCHANGED to api.anthropic.com, so this
      // still IS a first-party session. But claude decides "first party" by
      // string-matching the base-URL host: `Yd()` -> `T1e()` accepts only
      // `api.anthropic.com`. A 127.0.0.1 host fails that test, which makes the
      // 1M-context gate `OH()` return false and drops the model's context ceiling
      // to claude's 200K fallback -- even on models declaring `native_1m`. Since
      // `aY()` clamps with `min(modelWindow, requested)`, that also silently
      // neuters CLAUDE_CODE_AUTO_COMPACT_WINDOW above, so long sessions compact
      // ~5x more often than the model requires. This flag re-asserts what is
      // already true and restores the real 1M ceiling.
      env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = "1";
    }
    return env;
  }

  /** Translate parsed SSE events from a PTY's proxy into StreamDeltas and route
   *  them to the active turn's onStream. A PTY outlives its turn, so we look up
   *  the live active entry here rather than capturing onStream at spawn.
   *  Any SSE event is also proof of life for a pending StopFailure grace window. */
  private handleSseEvent(jinnSessionId: string, e: SseDataEvent): void {
    const entry = this.active.get(jinnSessionId);
    if (!entry) return; // idle PTY / no turn in flight — nothing to stream
    entry.resolver.noteActivity();
    if (!entry.onStream) return;
    // Only the main agent's events reach here (the proxy suppresses sub-agent and
    // auxiliary streams) — but compaction shares those credentials, so deltas pass
    // through the gate before reaching the transcript.
    const gate = entry.gate ?? (entry.gate = new CompactionStreamGate());
    if (e.type === "message_start") gate.reset();
    for (const d of gate.accept(sseEventToDeltas(e))) entry.onStream(d);
    if (e.type === "message_stop") for (const d of gate.end()) entry.onStream(d);
  }

  /** Allocate + start a per-PTY SSE forward proxy. Returns the proxy and its port,
   *  or {port:0} if it failed to bind — in which case the PTY is spawned WITHOUT
   *  ANTHROPIC_BASE_URL (direct to Anthropic): the turn still works, only live
   *  word-by-word streaming degrades. */
  private async startProxy(jinnSessionId: string): Promise<{ proxy: SsePtyProxy; port: number }> {
    const proxy = new SsePtyProxy(jinnSessionId, (e) => this.handleSseEvent(jinnSessionId, e), {
      // ALL requests (main + subagent + background tasks) count here — this is
      // how the gateway knows the CLI is still working after the turn settled.
      onUpstreamActivity: (info) => this.handleUpstreamActivity(jinnSessionId, info),
    });
    try {
      const port = await proxy.start();
      return { proxy, port };
    } catch (err) {
      logger.warn(`SSE proxy failed to start for session ${jinnSessionId} (streaming degraded): ${err instanceof Error ? err.message : String(err)}`);
      proxy.stop();
      return { proxy, port: 0 };
    }
  }

  /** Wrap a freshly-spawned pty.IPty in a PtyHandle and wire its output into
   *  the session's scrollback ring buffer + live subscribers. On PTY exit, if this
   *  proc is the one bound to the active turn, the resolver is interrupted (a crash
   *  with no Stop hook); a stale proc replaced by a respawn is treated as benign.
   *  `proxy` (the per-PTY SSE forward proxy) is torn down when this PTY exits. */
  private wireProcToStream(jinnSessionId: string, proc: pty.IPty, proxy?: SsePtyProxy): PtyHandle {
    const handle = createPtyHandle(proc);
    this.streams.attach(jinnSessionId, proc, () => this.lastOutputAt.set(jinnSessionId, Date.now()));
    proc.onExit((event) => {
      // Session-level cleanup MUST be identity-gated. In a kill->respawn race the
      // lifecycle/stream entries already point at the NEW PTY by the time THIS
      // (old, killed) PTY's exit fires. releaseSession is keyed by sessionId, so an
      // unguarded call here would kill the freshly-adopted PTY — whose own onExit
      // then fires the spurious second "claude process exited". Only this PTY being
      // the session's CURRENT warm handle means the cleanup is ours to do.
      const isCurrent = this.lifecycle.getWarm(jinnSessionId) === handle;
      if (isCurrent) {
        this.streams.onPtyExit(jinnSessionId, event ?? { exitCode: 0, signal: 0 });
        // Release the lifecycle entry so the dead handle isn't picked up by a future
        // run() as "warm" — that would inject into a corpse.
        this.lifecycle.releaseSession(jinnSessionId);
      }
      // Tear down THIS PTY's SSE forward proxy (one proxy per PTY) regardless.
      proxy?.stop();
      // PTY exited without a Stop hook (crash / early exit) — settle the active turn
      // as interrupted so run()'s promise doesn't hang. BUT only if this dying proc is
      // the one bound to the active turn: after a kill->respawn race the active entry
      // holds the NEW turn's resolver+proc, and this (old, released) proc must not
      // poison it. Identity mismatch => benign cleanup, no interrupt.
      const e = this.active.get(jinnSessionId);
      if (e && e.boundProc === proc) {
        e.resolver.interrupt("Interrupted: claude process exited");
      }
    });
    return handle;
  }

  /** node-pty spawn of the genuine claude binary (no -p → cc_entrypoint=cli).
   *  Allocates a per-PTY SSE forward proxy first and points the child at it. */
  private async spawn(jinnSessionId: string, opts: EngineRunOpts, settingsPath: string): Promise<PtyHandle> {
    const args = buildInteractiveArgs({
      prompt: buildPromptWithPlatformContext(opts),
      settingsPath,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      mcpConfigPath: opts.mcpConfigPath,
      cliFlags: opts.cliFlags,
      attachments: opts.attachments,
      // Persona/org context + main-agent sentinel via the CLI flag (the settings-file
      // appendSystemPrompt KEY is ignored by claude ≥2.1.x). The sentinel lets the SSE
      // proxy tee this turn's stream to the chat pane; sub-agents have no sentinel.
      appendSystemPrompt: opts.systemPrompt
        ? `${opts.systemPrompt}\n\n${MAIN_AGENT_SENTINEL}`
        : MAIN_AGENT_SENTINEL,
    });
    const { proxy, port } = await this.startProxy(jinnSessionId);
    const env = this.buildPtyEnv(port || undefined, jinnSessionId);
    const bin = resolveBin("claude", opts.bin);
    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"}, geom: ${geom ? `${geom.cols}×${geom.rows}` : "default"}, sseProxy: ${port || "off"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel, appendApplied: true });
    return this.wireProcToStream(jinnSessionId, proc, port ? proxy : undefined);
  }

  /** Spawn an idle PTY for the CLI/xterm view. If an engineSessionId is provided,
   *  resumes that session; otherwise spawns a fresh `claude` so a brand-new CLI-mode
   *  session shows the TUI before the user types anything.
   *  Does NOTHING if a warm PTY already exists or a turn is starting.
   *  Fire-and-forget (void): allocating the per-PTY SSE proxy is async, so the
   *  actual spawn happens after a microtask; `idleSpawning` guards re-entrancy. */
  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.lifecycle.getWarm(jinnSessionId)) return;
    if (this.active.has(jinnSessionId)) return; // a turn is starting/running — let run() spawn
    if (this.idleSpawning.has(jinnSessionId)) return; // an idle spawn is already in flight
    this.idleSpawning.add(jinnSessionId);

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      statusLineDir: CLAUDE_LIMITS_DIR,
    });
    const args: string[] = [
      "--chrome",
      "--dangerously-skip-permissions",
      "--disallowedTools", "AskUserQuestion", "ExitPlanMode",
      "--settings", settingsPath,
    ];
    if (opts.engineSessionId) args.unshift("--resume", opts.engineSessionId);
    if (opts.model) args.push("--model", opts.model);
    const bin = resolveBin("claude", opts.bin);
    // Caller (pty-ws) passes the client's current cols/rows. Cache them so a
    // future cold spawn through run() picks up the right geometry too.
    const cols = opts.cols ?? this.lastGeom.get(jinnSessionId)?.cols ?? 120;
    const rows = opts.rows ?? this.lastGeom.get(jinnSessionId)?.rows ?? 40;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, jinnSessionId, { cols: opts.cols, rows: opts.rows });

    void (async () => {
      try {
        const { proxy, port } = await this.startProxy(jinnSessionId);
        // Re-check after the async gap: a real turn (run) or another idle spawn may
        // have claimed the session while we awaited the proxy bind. If so, don't
        // adopt a duplicate PTY — drop our proxy and bail.
        if (this.lifecycle.getWarm(jinnSessionId) || this.active.has(jinnSessionId)) {
          proxy.stop();
          return;
        }
        const env = this.buildPtyEnv(port || undefined, jinnSessionId);
        logger.info(`InteractiveClaudeEngine ensureIdleSpawn for session ${jinnSessionId} (resume ${opts.engineSessionId || "none — fresh"}, geom ${cols}×${rows}, sseProxy: ${port || "off"})`);
        const proc = pty.spawn(bin, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: opts.cwd || JINN_HOME,
          env,
        });
        const handle = this.wireProcToStream(jinnSessionId, proc, port ? proxy : undefined);
        // Idle spawn carries no --append-system-prompt (the view-only PTY); mark it so
        // the first real turn through run() cold-respawns with the persona + sentinel.
        this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: undefined, appendApplied: false });
        this.lifecycle.adopt(jinnSessionId, handle);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`ensureIdleSpawn failed for session ${jinnSessionId}: ${message}`);
        this.streams.reportError(jinnSessionId, `failed to restore terminal: ${message}`);
      } finally {
        this.idleSpawning.delete(jinnSessionId);
      }
    })();
  }

  /** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts, confirm?: SubmitConfirmation): (() => void) | undefined {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return undefined;
    let text = buildPromptWithPlatformContext(opts);
    if (opts.attachments?.length) {
      text += buildAttachmentSuffix(opts.attachments);
    }
    return pasteAndSubmit(proc, text, confirm);
  }

  subscribeWithSnapshot(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): PtySnapshotSubscription {
    return this.streams.subscribeWithSnapshot(sessionId, cb, onControl);
  }

  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.kill(sessionId, "Interrupted: terminal restart requested");
    this.idleSpawning.delete(sessionId);
    this.ensureIdleSpawn(sessionId, opts);
  }

  /** Write raw text to the warm PTY as a bracketed-paste + CR (same /@!-guard as injectPrompt). No-op if no warm PTY. */
  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    pasteAndSubmit(proc, text);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) proc.write(data);
  }

  /** Resize the warm PTY + remember the geometry for the next cold spawn. */
  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    this.streams.resize(sessionId, cols, rows);
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* PTY gone */ }
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    this.cancelLateRecovery(sessionId);
    const e = this.active.get(sessionId);
    e?.resolver.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** Recycle idle warm PTYs only (org-reload). Never interrupts an in-flight
   *  turn: sessions in `this.active` are skipped, so the turn that wrote the org
   *  file runs to completion on its current persona and the next turn picks up
   *  the new one via cold respawn. */
  killIdle(): void {
    this.lifecycle.releaseIdle((id) => this.active.has(id));
  }

  /** True only while a turn is in flight (distinct from "PTY is warm"). */
  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Observable progress for the in-flight turn, or undefined if none is running.
   *
   *  isTurnRunning() answers "does the gateway think a turn exists" — it is a
   *  bookkeeping lookup, so it stays true for a wedged turn forever. This answers
   *  the question that actually matters: is that turn *getting anywhere*. The
   *  reconciler uses it to catch hangs the heartbeat cannot (the heartbeat runs for
   *  as long as run() is pending, so a fresh heartbeat proves only that the gateway
   *  is still waiting), and serializeSession uses it to show stall in the UI.
   *
   *  PTY output alone is a weak signal — the TUI redraws its footer while idle at
   *  the prompt — so hooks and tool state are reported alongside it and callers
   *  weigh them together. */
  turnProgress(sessionId: string): TurnProgress | undefined {
    const entry = this.active.get(sessionId);
    if (!entry) return undefined;
    return {
      turnStartedAt: entry.startedAt,
      lastProgressAt: Math.max(entry.startedAt, entry.lastHookAt, this.lastOutputAt.get(sessionId) ?? 0),
      awaitingSubmit: !entry.promptSubmitted,
      activeTools: entry.activeTools,
      activeUpstream: this.hasActiveUpstream(sessionId),
    };
  }

  /** True iff a warm PTY exists for this session (in the lifecycle manager). */
  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Track viewing state from the frontend. Called by pty-ws on `viewing` messages
   *  from CliTerminal (mount/unmount + Page Visibility). Ref-counted so multiple tabs
   *  viewing the same session keep it warm until the last one leaves. */
  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  /** InterruptibleEngine.isAlive — true if a turn OR a warm PTY exists. */
  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Keep listening for a late Stop after an API-error settle. Public visibility
   *  is for tests; used by run() and kill(). No-op when the caller didn't provide
   *  onLateRecovery. */
  armLateRecovery(jinnSessionId: string, opts: EngineRunOpts): void {
    if (!opts.onLateRecovery) return;
    this.cancelLateRecovery(jinnSessionId);
    const timer = setTimeout(() => this.cancelLateRecovery(jinnSessionId), LATE_RECOVERY_WINDOW_MS);
    timer.unref?.();
    this.lateRecovery.set(jinnSessionId, { timer });
    this.hookRegistry.register(jinnSessionId, (h) => {
      if (h.hook_event_name !== "Stop") return;
      const text = String(h.last_assistant_message ?? "");
      const sid = typeof h.session_id === "string" ? h.session_id : "";
      this.cancelLateRecovery(jinnSessionId);
      const safeText = stripReasoningBlocks(text);
      if (safeText.trim()) {
        logger.info(`InteractiveClaudeEngine: late Stop superseded failed turn for ${jinnSessionId}`);
        opts.onLateRecovery?.({ result: safeText, sessionId: sid });
      } else {
        logger.info(`InteractiveClaudeEngine: late Stop with no text for ${jinnSessionId} — recovery abandoned`);
      }
    });
  }

  /** Tear down a pending late-recovery listener (new turn starting / kill / expiry). */
  cancelLateRecovery(jinnSessionId: string): void {
    const lr = this.lateRecovery.get(jinnSessionId);
    if (!lr) return;
    clearTimeout(lr.timer);
    this.lateRecovery.delete(jinnSessionId);
    this.hookRegistry.unregister(jinnSessionId);
  }
}
