import type { ModelUsage } from '../shared/model-pricing.js';
import { CODEX_SESSIONS_DIR, forEachCodexTokenCount } from './codex-transcript.js';

/**
 * Most-recent-turn input-context size from a codex per-turn usage object.
 * codex's `cached_input_tokens` is a SUBSET of `input_tokens` (OpenAI semantics),
 * so the window fill is `input_tokens` alone — summing would double-count.
 * Best-effort: returns undefined on any shape mismatch.
 */
export function extractCodexContextTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const last = (usage as Record<string, unknown>).last_token_usage;
  if (last && typeof last === "object") {
    return positiveTokens((last as Record<string, unknown>).input_tokens);
  }
  const n = Number((usage as Record<string, unknown>).input_tokens ?? 0);
  // Some Codex CLI builds report cumulative/billed input tokens here, not the
  // active context window. A value above any supported Codex window is unusable
  // for the UI context meter, so omit it instead of showing impossible values
  // like 9282k/272k.
  if (n > 1_000_000) return undefined;
  return positiveTokens(n);
}

function positiveTokens(value: unknown): number | undefined {
  const tokens = Number(value ?? 0);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function extractCodexTokenUsage(usage: unknown): CodexTokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const inputTokens = Number(record.input_tokens ?? 0);
  const cachedInputTokens = Number(record.cached_input_tokens ?? 0);
  const outputTokens = Number(record.output_tokens ?? 0);
  if (![inputTokens, cachedInputTokens, outputTokens].every(Number.isFinite)) return undefined;
  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

export function codexUsageDelta(start: CodexTokenUsage, end: CodexTokenUsage): ModelUsage {
  const inputTokens = Math.max(0, end.inputTokens - start.inputTokens);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, end.cachedInputTokens - start.cachedInputTokens),
  );
  return {
    inputTokens: inputTokens - cachedInputTokens,
    cachedInputTokens,
    outputTokens: Math.max(0, end.outputTokens - start.outputTokens),
  };
}





export function lastCodexTranscriptContextTokens(sessionId: string, root = CODEX_SESSIONS_DIR): number | undefined {
  let last: number | undefined;
  forEachCodexTokenCount(sessionId, root, (payload) => {
    const ctx = extractCodexContextTokens(payload.info?.last_token_usage);
    if (ctx) last = ctx;
  });
  return last;
}
