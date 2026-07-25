/**
 * Detects a declared context window that the engine does not actually honour.
 *
 * Why this exists: in July 2026 the roster declared Opus at 1M while the Claude
 * CLI — handed the bare `opus` alias instead of `opus[1m]` — enforced 200K.
 * Nothing compared the two, so sessions compaction-thrashed for weeks (63
 * compaction boundaries in one transcript) before a human noticed. Correcting
 * the number fixes that day; this makes the *next* wrong number announce itself.
 *
 * Mechanism: a peak that has stopped growing is a ceiling. We track the highest
 * context a model has ever reached and how long that peak has held; once it has
 * held across many turns without moving, and sits far below the declared
 * window, the window we were told about is not the window being enforced.
 *
 * Two earlier designs were falsified by replaying the real transcript, and both
 * failure modes are worth keeping in mind before changing the thresholds:
 *
 *  1. Classifying individual compaction events by the level they fired at.
 *     Healthy Fable compacted at 280K–494K and broken Opus at 169K — these
 *     overlap once the declared window is 1M, so it produced both a false
 *     negative and a false positive on the very incident it was written for.
 *  2. Comparing the running max against the declared window. Every model's max
 *     is low early in its life, so this warned on the healthy model long before
 *     it had climbed to its true 640K peak.
 *
 * What separates them is not the peak's height but its *stability*: below the
 * 35% line the capped model held its peak for 79 turns while the healthy one
 * never held one for more than 4 before climbing past it.
 *
 * Uses only what a turn already produced — no catalog, no network. That is a
 * hard requirement: this must work on subscription auth.
 */
import { logger } from "./logger.js";

/** A model that never exceeds this fraction of its declared window, despite
 *  sustained use, is not being given that window. Measured: broken Opus
 *  reached 0.19, healthy Fable 0.64. */
export const SUSPECT_RATIO = 0.35;

/** Absolute floor before any conclusion: below this, the model simply has not
 *  been pushed hard enough to say anything about its ceiling. */
export const MIN_EVIDENCE_TOKENS = 100_000;

/** Turns the peak must hold without growing before it counts as a ceiling
 *  rather than a still-climbing high-water mark. This is the load-bearing
 *  threshold: a low max means nothing on its own, because every model's max is
 *  low early on. Measured on the incident transcript — below the 35% line, the
 *  capped model plateaued for 79 turns while the healthy one never plateaued
 *  for more than 4 before climbing past it. */
export const MIN_TURNS_SINCE_PEAK = 25;

export interface ContextCeilingInput {
  engine: string;
  model?: string;
  /** Declared window from the model roster, if any. */
  declaredWindow?: number;
  /** Context reading from the turn that just finished. */
  currentTokens?: number | null;
  /** The prompt that drove this turn. Slash commands (`/clear`, `/compact`,
   *  `/model`) mutate context on purpose; they are excluded from evidence so a
   *  user's own housekeeping cannot be mistaken for an enforced ceiling. */
  userPrompt?: string;
}

export interface ContextCeilingVerdict {
  /** Enough evidence gathered, and it points at a smaller real window. */
  suspect: boolean;
  /** Threshold crossed and not yet reported for this model. */
  warn: boolean;
  observedCeiling?: number;
  declaredWindow?: number;
  ratio?: number;
  turns?: number;
  turnsSincePeak?: number;
}

/** Returned by value, never by reference: a shared literal would let one
 *  caller's mutation corrupt every later verdict. */
const notSuspect = (): ContextCeilingVerdict => ({ suspect: false, warn: false });

interface ModelEvidence {
  turns: number;
  maxObserved: number;
  /** Turns since maxObserved last grew — how long the peak has held. */
  turnsSincePeak: number;
}

/** Evidence per engine/model, and already-warned markers. Process-lifetime
 *  only — a restart re-arms the warning, which is also when a config change
 *  takes effect, so that is the behaviour we want. */
const evidence = new Map<string, ModelEvidence>();
const warned = new Set<string>();

/** Test seam. */
export function resetContextCeilingState(): void {
  evidence.clear();
  warned.clear();
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** A prompt beginning with a slash command — the user deliberately mutating
 *  context. Anchored to the start so "read /etc/hosts" is not mistaken for one. */
function isContextMutatingCommand(prompt?: string): boolean {
  return typeof prompt === "string" && /^\s*\//.test(prompt);
}

/**
 * Record one turn's context reading and report whether the model's declared
 * window now looks wrong. Total: every malformed input returns "not suspect"
 * rather than throwing, because this runs inside the turn-completion path and
 * must never break a turn.
 */
export function assessContextCeiling(input: ContextCeilingInput): ContextCeilingVerdict {
  const { engine, model, declaredWindow, currentTokens, userPrompt } = input;

  if (!isPositiveFinite(declaredWindow)) return notSuspect();
  if (!isPositiveFinite(currentTokens)) return notSuspect();
  // The user mutated context on purpose — not evidence about the window.
  if (isContextMutatingCommand(userPrompt)) return notSuspect();

  const key = `${engine}/${model ?? "default"}`;
  const prior = evidence.get(key) ?? { turns: 0, maxObserved: 0, turnsSincePeak: 0 };
  const grew = currentTokens > prior.maxObserved;
  const next: ModelEvidence = {
    turns: prior.turns + 1,
    maxObserved: grew ? currentTokens : prior.maxObserved,
    turnsSincePeak: grew ? 0 : prior.turnsSincePeak + 1,
  };
  evidence.set(key, next);

  // A peak that is still growing is a high-water mark, not a ceiling — every
  // model's max is low early on, so concluding here is what produced a false
  // positive on the healthy model when this was first written.
  if (next.turnsSincePeak < MIN_TURNS_SINCE_PEAK) return notSuspect();
  if (next.maxObserved < MIN_EVIDENCE_TOKENS) return notSuspect();

  const ratio = next.maxObserved / declaredWindow;
  if (ratio >= SUSPECT_RATIO) return notSuspect(); // reaches a plausible fraction — healthy

  const verdict: ContextCeilingVerdict = {
    suspect: true,
    warn: !warned.has(key),
    observedCeiling: next.maxObserved,
    declaredWindow,
    ratio,
    turns: next.turns,
    turnsSincePeak: next.turnsSincePeak,
  };
  if (verdict.warn) warned.add(key);
  return verdict;
}

/** Emit the warning for a verdict that earned one. Never throws. */
export function reportContextCeiling(engine: string, model: string | undefined, v: ContextCeilingVerdict): void {
  if (!v.warn) return;
  try {
    const pct = Math.round((v.ratio ?? 0) * 100);
    logger.warn(
      `Context window looks smaller than configured for ${engine}/${model ?? "default"}: ` +
        `across ${v.turns} turns the context never exceeded ${v.observedCeiling?.toLocaleString()} tokens, ` +
        `but the roster declares ${v.declaredWindow?.toLocaleString()} (${pct}%). ` +
        `If the engine is enforcing a smaller window, sessions will compaction-thrash. ` +
        `Verify the model id passed to the engine (Claude needs the [1m] suffix for a 1M window, e.g. "opus[1m]") ` +
        `or correct contextWindow for this model in config.yaml.`,
    );
  } catch {
    /* diagnostics must never break a turn */
  }
}
