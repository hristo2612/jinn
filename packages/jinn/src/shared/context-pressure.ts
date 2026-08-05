/**
 * Deterministic context-pressure handoff for worker sessions.
 *
 * A long-lived agent session re-sends its whole accumulated context every turn.
 * Measured on this codebase's own fleet: worker sessions averaged ~337K tokens
 * per turn, of which only ~9% was conversation — the rest was tool results,
 * tool inputs, and thinking. Sessions ran for days and thousands of turns.
 *
 * The wrong fixes, and why:
 *   - `/clear` destroys working state with nothing externalised first.
 *   - `/compact` is already automatic in Claude Code, and it is lossy in a way
 *     the *model* chooses, leaving the surviving state trapped in a transcript.
 *
 * The right fix reuses the delegation contract the org already runs on: every
 * delegation ends with `DONE` or `BLOCKED: <exact need>`, and work items are the
 * durable ledger. Under context pressure we fire that contract early, so the
 * agent decides what matters and writes it somewhere queryable. A session that
 * needs compaction is evidence its state was never externalised.
 *
 * Delivery is deliberately passive: this only decides *that* a nudge is owed and
 * records it. The text rides the next real turn's prompt, so it costs no extra
 * turn and is silently dropped if the session never runs again.
 */

/** Fraction of the context window at which each nudge fires. Escalating, and
 *  each level fires at most once per session. */
export const HANDOFF_LEVELS = [
  { level: "wrap-up" as const, at: 0.70 },
  { level: "urgent" as const, at: 0.85 },
];

export type HandoffLevel = (typeof HANDOFF_LEVELS)[number]["level"];

export interface ContextPressureInput {
  /** Most recent turn's input-context size. */
  contextTokens?: number | null;
  /** Declared window for the model actually in use. */
  contextWindow?: number;
  /** Worker sessions only. An operator chat (no employee) cannot hand off —
   *  the state is in the operator's head, so it is surfaced in the UI instead. */
  employee?: string | null;
  /** Highest level already delivered for this session, if any. */
  alreadyNudged?: HandoffLevel | null;
}

export interface ContextPressureVerdict {
  level: HandoffLevel;
  ratio: number;
  contextTokens: number;
  contextWindow: number;
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Rank so an escalation can be compared against what was already sent. */
function rank(level: HandoffLevel | null | undefined): number {
  if (!level) return -1;
  return HANDOFF_LEVELS.findIndex((l) => l.level === level);
}

/**
 * Decide whether this session is owed a handoff nudge. Pure and total: any
 * malformed input yields null rather than throwing, because this runs on the
 * turn-completion path and must never break a turn.
 */
export function assessContextPressure(input: ContextPressureInput): ContextPressureVerdict | null {
  const { contextTokens, contextWindow, employee, alreadyNudged } = input;

  // Operator chat: no employee means Genie, which has no one to hand off to.
  if (!employee || !employee.trim()) return null;
  if (!isPositiveFinite(contextTokens) || !isPositiveFinite(contextWindow)) return null;

  const ratio = contextTokens / contextWindow;

  // Highest level whose threshold is met.
  let hit: HandoffLevel | null = null;
  for (const l of HANDOFF_LEVELS) if (ratio >= l.at) hit = l.level;
  if (!hit) return null;

  // Escalate only — never repeat a level already delivered.
  if (rank(hit) <= rank(alreadyNudged)) return null;

  return { level: hit, ratio, contextTokens, contextWindow };
}

/* --- transportMeta state machine ------------------------------------------
 * The nudge travels across turns in transportMeta. These three functions are
 * the whole transition set; manager.ts calls them rather than open-coding the
 * key handling, so the tests exercise the same code the gateway runs.
 */

export const HANDOFF_PENDING_KEY = "contextHandoffPending";
export const HANDOFF_PENDING_LEVEL_KEY = "contextHandoffPendingLevel";
export const HANDOFF_DELIVERED_KEY = "contextHandoffDelivered";

/** transportMeta keys this feature owns — manager.ts must preserve all of them
 *  across connector merges, or a lost level turns "nudge once" into "nudge
 *  every turn". */
export const HANDOFF_META_KEYS = [
  HANDOFF_PENDING_KEY,
  HANDOFF_PENDING_LEVEL_KEY,
  HANDOFF_DELIVERED_KEY,
] as const;

/** The nudge owed to this session's next prompt, if any. */
export function pendingNudgeText(meta: Record<string, unknown> | null | undefined): string | null {
  const v = meta?.[HANDOFF_PENDING_KEY];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Record that a carried nudge reached the model: drop it and remember the
 *  level so later assessments escalate instead of repeating. Mutates in place. */
export function markNudgeDelivered(
  meta: Record<string, unknown>,
  levelFromTurnStart?: unknown,
): void {
  delete meta[HANDOFF_PENDING_KEY];
  const level =
    typeof levelFromTurnStart === "string" ? levelFromTurnStart
    : typeof meta[HANDOFF_PENDING_LEVEL_KEY] === "string" ? (meta[HANDOFF_PENDING_LEVEL_KEY] as string)
    : null;
  if (level) meta[HANDOFF_DELIVERED_KEY] = level;
  delete meta[HANDOFF_PENDING_LEVEL_KEY];
}

/** Queue a nudge onto the session's next prompt. Mutates in place. */
export function queueNudge(meta: Record<string, unknown>, verdict: ContextPressureVerdict): void {
  meta[HANDOFF_PENDING_KEY] = handoffNudgeText(verdict);
  meta[HANDOFF_PENDING_LEVEL_KEY] = verdict.level;
}

/** Highest level already delivered for this session. */
export function deliveredLevel(meta: Record<string, unknown> | null | undefined): HandoffLevel | null {
  const v = meta?.[HANDOFF_DELIVERED_KEY];
  return typeof v === "string" ? (v as HandoffLevel) : null;
}

/** The text prepended to the session's next real prompt. */
export function handoffNudgeText(v: ContextPressureVerdict): string {
  const pct = Math.round(v.ratio * 100);
  const used = v.contextTokens.toLocaleString();
  const win = v.contextWindow.toLocaleString();
  const when =
    v.level === "urgent"
      ? "Stop taking on new work and wrap up now."
      : "At your next safe stopping point, wrap up.";
  return [
    `[Jinn] Context checkpoint — you are at ${pct}% of your context window (${used} of ${win} tokens). ${when}`,
    `Write your current state to the work item before you finish: what you found, what you decided, what remains, and the exact next action. Then end with \`DONE\` or \`BLOCKED: <exact need>\` so a fresh session can resume from the ledger without re-deriving anything.`,
    `Do not run \`/clear\` or \`/compact\` — externalising to the work item is what preserves the work; compaction only shortens the transcript.`,
  ].join("\n\n");
}
