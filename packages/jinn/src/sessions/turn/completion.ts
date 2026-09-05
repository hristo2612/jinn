import type { Employee, EngineSessionRef, Session } from "../../shared/types.js";
import {
  completeSessionAttempt,
  nextEngineSessionFields,
  recordTurnAccounting,
  updateSessionForAttempt,
  type UpdateSessionFields,
} from "../registry.js";
import { notifyParentSessionAndWait } from "../callbacks.js";
import type { TurnSurface } from "./types.js";

/** The three ways a turn can end. Anything else is not terminal. */
export type TurnOutcome = "succeeded" | "failed" | "interrupted";

export interface SettleTurnInput {
  sessionId: string;
  attemptToken: string;
  outcome: TurnOutcome;
  result?: string | null;
  error?: string | null;
  cost?: number;
  durationMs?: number;
  /**
   * This turn's cost/turn delta. Present whenever an engine actually ran —
   * including a rate-limit fallback or retry, because a recovered turn is still
   * a turn. Absent only for aborts that never reached an engine.
   */
  accounting?: { cost?: number; numTurns?: number };
  /** Native engine-session id, filed inside the receipt's own fenced write so a
   * resume finds it and a losing turn never overwrites a newer turn's. */
  engineSession?: { engine: string; nativeId: string; meta?: Omit<EngineSessionRef, "id"> };
  /** Transport fields folded into the same write as the receipt. */
  fields?: UpdateSessionFields;
  /**
   * Statuses the attempt may settle from. The default running-only fence is
   * what makes an interrupted row immutable to a late success; the rate-limit
   * timeout widens it because that turn settles out of `waiting`.
   */
  expectedStatuses?: readonly Session["status"][];
  employee?: Employee;
  /** Interrupters pass false — they report the interrupt themselves. The status
   *  reconciler, the interrupt nobody is left to report, keeps the default. */
  notifyParent?: boolean;
  surface: TurnSurface;
}

const STATUS_FOR_OUTCOME: Record<TurnOutcome, Session["status"]> = {
  succeeded: "idle",
  failed: "error",
  interrupted: "interrupted",
};

/**
 * The single completion path. Every terminal receipt in every runner is written
 * here, in this fixed order: account for the turn, write the receipt — engine
 * session included — wake the parent, tell the transport.
 *
 * It exists because two runners each grew their own copy of that sequence and
 * drifted — one of them silently skipped accounting, which disabled employee
 * budget caps for the majority of turns. Adding a completion site anywhere else
 * re-opens exactly that hole.
 *
 * Returns the settled session, or undefined when a stop, reset, or newer turn
 * has already taken ownership of the attempt.
 */
export async function settleTurn(input: SettleTurnInput): Promise<Session | undefined> {
  const settledAt = new Date().toISOString();
  if (input.accounting) recordTurnAccounting(input.sessionId, input.accounting);

  const settled = writeReceipt(input, settledAt);
  if (!settled) return undefined;

  const report = {
    result: input.result ?? null,
    error: input.error ?? null,
    cost: input.cost,
    durationMs: input.durationMs,
  };
  if (input.notifyParent !== false) {
    await notifyParentSessionAndWait(settled, report, { alwaysNotify: input.employee?.alwaysNotify });
  }
  await input.surface.settled({ session: settled, ...report });
  return settled;
}

/**
 * The one fenced write that makes a turn terminal. The engine session merges in
 * from inside the fence, so a turn that has lost the row to a stop, a reset, or
 * a newer turn leaves that turn's resume state exactly as it found it.
 */
function writeReceipt(input: SettleTurnInput, settledAt: string): Session | undefined {
  const fields = (current: Session): UpdateSessionFields => ({
    ...input.fields,
    ...(input.engineSession
      ? nextEngineSessionFields(current, input.engineSession.engine, input.engineSession.nativeId, {
        ...input.engineSession.meta,
        lastSyncedAt: settledAt,
      })
      : {}),
    status: STATUS_FOR_OUTCOME[input.outcome],
    attemptOutcome: input.outcome,
    lastActivity: settledAt,
    lastError: input.error ?? (input.outcome === "interrupted" ? "Interrupted" : null),
  });
  return input.expectedStatuses
    ? updateSessionForAttempt(input.sessionId, input.attemptToken, fields, input.expectedStatuses)
    : completeSessionAttempt(input.sessionId, input.attemptToken, fields);
}
