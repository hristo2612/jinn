/**
 * The contract `handleRateLimit` runs against: what it is told about the limited
 * turn, the hooks each transport implements, and the outcomes it can settle on.
 *
 * Separate from the state machine because they are read by different people —
 * a transport author reads only this file, and the handler's own control flow
 * reads none of it.
 */

import type { Employee, Engine, EngineResult, JinnConfig, RemoteTarget, ResolvedMcpConfig, Session, StreamDelta } from "../shared/types.js";
import type { EngineName } from "../shared/models.js";

/** What detectRateLimit returned for the original turn. */
export interface RateLimitInfo {
  /** Unix timestamp (seconds) when the limit is expected to reset, if known. */
  resetsAt?: number;
}

/** Outcome categories returned by handleRateLimit so callers can drive transport-side completion. */
export type RateLimitOutcome =
  | { kind: "fallback"; result: EngineResult }
  | { kind: "resumed"; result: EngineResult }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface RateLimitHandlerHooks {
  /**
   * Called when entering the fallback branch (before the substitute engine runs).
   * Use this to: notify the user we're switching engines (UI message, Discord, etc.).
   *
   * `substitute` is the engine the switch actually landed on. It is passed rather
   * than re-derived because the chain walk that chose it already happened here,
   * and a transport re-walking it could disagree with the engine that then runs.
   */
  onFallbackStart?: (info: { resumeAt: Date | null; until: Date; substitute: EngineName }) => void | Promise<void>;

  /**
   * Optional stream callback for the fallback engine's run (web emits deltas here).
   */
  onFallbackStream?: (delta: StreamDelta) => void;

  /**
   * Called after the fallback engine finishes, before the handler returns.
   * The persistence of the assistant message and any "completed" event emission
   * is done here (caller-specific).
   */
  onFallbackComplete?: (result: EngineResult) => void | Promise<void>;

  /**
   * Called once when entering the wait-and-retry loop. Use this to: switch UI
   * to "waiting", post a "I'll continue automatically" message, notify Discord, etc.
   */
  onWaitingStart?: (info: { resumeAt: Date | null; rateLimit: RateLimitInfo }) => void | Promise<void>;

  /**
   * Called each retry iteration BEFORE the retry engine.run — switch UI back
   * to "thinking" state.
   */
  onRetryAttempt?: (info: { attempt: number }) => void | Promise<void>;

  /**
   * Called each iteration when the retry was STILL rate-limited — switch UI
   * back to "waiting" state, log, etc.
   */
  onStillLimited?: (info: { attempt: number; resumeAt: Date | null }) => void | Promise<void>;

  /**
   * Optional stream callback for the retry engine's run (web emits deltas).
   */
  onRetryStream?: (delta: StreamDelta) => void;

  /**
   * Called when a retry succeeds (or fails with a non-rate-limit error).
   * Persist the assistant message + emit completion event here.
   */
  onRetrySuccess?: (result: EngineResult) => void | Promise<void>;

  /**
   * Called when the deadline expires before the limit clears. Notify the user,
   * mark session errored, emit completion event with the timeout error.
   */
  onTimeout?: () => void | Promise<void>;

  /**
   * Called when the session was deleted/cancelled while waiting. The handler
   * has already returned — this is just a hook to log or emit cleanup.
   */
  onCancelled?: () => void | Promise<void>;
}

/**
 * Extends {@link RemoteTarget} because the retry is a fresh spawn, not a resume
 * of the process that was limited: without the target the retried turn lands on
 * the gateway, which is exactly the machine the remote feature exists to keep
 * repositories off. See the suppression note in rate-limit-handler.ts.
 */
export interface RateLimitHandlerOpts extends RemoteTarget {
  session: Session;
  /** Generation token minted when this turn entered running state. */
  attemptToken: string;
  /** The original prompt that hit the rate limit — used unchanged for retries. */
  prompt: string;
  systemPrompt?: string;
  /** Explicit refresh for retries on the same resumed native transcript. Never
   *  forwarded to a different fallback engine. */
  platformContextRefresh?: string;
  /** Engine config used by the original turn (bin + model + …). */
  engineConfig: { bin?: string; model?: string };
  effortLevel?: string;
  /** Optional employee-level CLI flag overrides (passed to retry engine.run calls). */
  cliFlags?: string[];
  /** Path to MCP config JSON file, if applicable to the original turn. */
  mcpConfigPath?: string;
  /** In-memory resolved MCP server set from the original turn (preserved on retry
   *  so the payload is not silently dropped; a substitute engine resolves its own). */
  resolvedMcp?: ResolvedMcpConfig;
  /** Optional attachment file paths from the original turn (preserved on retry). */
  attachments?: string[];
  /** The current jinn config (used to look up the fallback chain + the substitute's engine config). */
  config: JinnConfig;
  /** Map of available engines (for substitute lookup). */
  engines: Map<string, Engine>;
  /** Optional employee record (for substitute effort + cliFlags). */
  employee?: Employee;
  /** The engine used for retries — the engine that returned the rate-limited result. */
  engine: Engine;
  /** Result of detectRateLimit() on the original turn. */
  rateLimit: RateLimitInfo;
  /** The original failed result — used for its sessionId field when recording the engine's thread id. */
  originalResult: EngineResult;
  hooks: RateLimitHandlerHooks;
}
