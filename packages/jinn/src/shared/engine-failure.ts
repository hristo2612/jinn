/**
 * What an engine's failure prose actually says.
 *
 * Three places used to answer this question with their own regex set — the
 * rate-limit detector, the workflow retry boundary, and the respawn auth guard —
 * and they disagreed with each other in ways that were load-bearing rather than
 * accidental. "overloaded" is a quota window to one of them and an upstream
 * fault to another, and both readings are correct: the provider is saying two
 * things at once.
 *
 * So a classification here is a SET, not a verdict. This module says which
 * signals the text carries; each consumer keeps its own reading of them.
 */

export type EngineFailureClass =
  | "rate-limit"
  | "quota"
  | "provider-outage"
  | "network"
  | "auth-terminal"
  | "invalid-model"
  | "terminal";

export interface EngineFailureClassification {
  /** Every class the text carries. Ambiguous prose carries more than one. */
  classes: ReadonlySet<EngineFailureClass>;
  /** Unix seconds, and only when the engine stated a time itself. */
  resetsAt?: number;
}

/** The account is out of allowance — a window that clears on its own clock. */
const QUOTA_SIGNATURES: readonly RegExp[] = [
  /usage.*limit/i,
  /exceeded.*limit/i,
  /out of extra usage/i,
];

/** The request was throttled. `overloaded` lives here AND in provider-outage:
 *  the provider is refusing load, which reads as both to different callers. */
const RATE_LIMIT_SIGNATURES: readonly RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
  /429/,
  /overloaded/i,
];

/**
 * The provider itself is faulting. Fault codes are surfaced verbatim by the
 * engines (e.g. the Claude PTY's "Interactive turn failed: server_error").
 */
const PROVIDER_OUTAGE_SIGNATURES: readonly RegExp[] = [
  /\b(?:server_error|api_error)\b/i,
  /overloaded/i,
  /\bselected model is at capacity\b/i,
  // HTTP 5xx, but only in status context — a bare "503" in a diagnostic is not a
  // status code, and matching one would misread a genuine failure as an outage.
  /\b(?:HTTP|status)(?:\s+code)?\s*[:=]?\s*5\d\d\b/i,
  /\b(?:bad gateway|service unavailable|gateway time-?out|internal server error)\b/i,
];

/** Socket and DNS faults from the fetch/PTY transport. */
const NETWORK_SIGNATURES: readonly RegExp[] = [
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN)\b/,
  /\b(?:socket hang up|fetch failed|network error)\b/i,
];

/** Errors no retry can fix, because the credentials themselves are the problem. */
const AUTH_TERMINAL_SIGNATURES: readonly RegExp[] = [
  /unauthori[sz]|unauthenticated|forbidden|\b401\b|\b403\b|invalid[ _-]?(api[ _-]?)?key|invalid[ _-]?token|expired[ _-]?(token|credential|session)|credential|authenticat|not logged in|please log in|oauth/i,
];

/**
 * The engine refused the model id it was handed. Ours to fix, not the provider's
 * verdict on the work: the id came from our config or from our own discovery, and
 * the turn never ran.
 */
const INVALID_MODEL_SIGNATURES: readonly RegExp[] = [
  /\b(?:invalid|unknown|unsupported) model\b/i,
  /\bmodel[ _]not[ _]found\b/i,
];

const SIGNATURES: readonly (readonly [EngineFailureClass, readonly RegExp[]])[] = [
  ["quota", QUOTA_SIGNATURES],
  ["rate-limit", RATE_LIMIT_SIGNATURES],
  ["provider-outage", PROVIDER_OUTAGE_SIGNATURES],
  ["network", NETWORK_SIGNATURES],
  ["auth-terminal", AUTH_TERMINAL_SIGNATURES],
  ["invalid-model", INVALID_MODEL_SIGNATURES],
];

/**
 * When an engine names the moment its window reopens, it says so in prose. The
 * captured tail runs to the first real sentence break, so a following clause
 * does not poison the parse — and a period inside a timestamp does not end it.
 */
const RESET_PROSE_RE = /(?:try again|retry|resets?)\s+(?:at|on)\s+([^;)\n]+?)(?=[;)\n]|\.(?:\s|$)|$)/i;

function resetsAtFromProse(text: string): number | undefined {
  const stated = RESET_PROSE_RE.exec(text)?.[1]?.trim();
  if (!stated) return undefined;
  const parsed = Date.parse(stated);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

/**
 * Every class the given failure text carries. `terminal` is present exactly when
 * nothing else matched: an unrecognised failure is a verdict, not a maybe, and
 * guessing generously spends real money on real failures.
 */
export function classifyEngineFailureText(
  text: string | null | undefined,
): EngineFailureClassification {
  const classes = new Set<EngineFailureClass>();
  if (typeof text !== "string" || !text) return { classes: new Set(["terminal"]) };

  for (const [failureClass, signatures] of SIGNATURES) {
    if (signatures.some((signature) => signature.test(text))) classes.add(failureClass);
  }
  if (classes.size === 0) classes.add("terminal");

  const resetsAt = resetsAtFromProse(text);
  return { classes, ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/** Whether a classification carries any of the given classes. */
export function hasEngineFailureClass(
  classification: EngineFailureClassification,
  ...classes: EngineFailureClass[]
): boolean {
  return classes.some((failureClass) => classification.classes.has(failureClass));
}
