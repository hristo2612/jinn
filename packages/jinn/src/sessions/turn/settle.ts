import { logger } from "../../shared/logger.js";
import { markTranscriptSyncedThrough } from "../../gateway/external-turns.js";
import {
  clearEngineSessionRefs,
  deletePartialMessages,
  getSession,
  insertMessage,
  insertMessageAfter,
  updateSession,
  type UpdateSessionFields,
} from "../registry.js";
import { settleTurn, type SettleTurnInput } from "./completion.js";
import type { EngineAttempt } from "./engine-run.js";
import { withSyncMarkersCleared } from "./preflight.js";
import {
  clearSupersededTurnMeta,
  retainUnseenInterruptedPrompt,
  withUnseenInterruptedPromptsCleared,
} from "./superseded.js";
import { shouldPersistFinalAssistantMessage, turnDisplayText } from "./text.js";
import type { TurnInput, TurnRun, TurnSurface } from "./types.js";

/** Preflight refused: record the reason everywhere the turn would have landed. */
export async function settleRefusedTurn(
  input: TurnInput,
  surface: TurnSurface,
  error: string,
  terminalFields: () => UpdateSessionFields,
): Promise<void> {
  logger.error(`Session ${input.session.id} blocked: ${error}`);
  insertMessage(input.session.id, "assistant", `⛔ ${error}`);
  await settleTurn({
    sessionId: input.session.id,
    attemptToken: input.attemptToken,
    outcome: "failed",
    error,
    fields: terminalFields(),
    employee: input.employee,
    // `waiting` alongside the default `running`, for the same reason the
    // rate-limit path widens it: the remote-host gate moves the session to
    // `waiting` while a desktop boots, and a refusal out of that state has to
    // land. Without it the fenced write is rejected, settleTurn returns before
    // notifying the parent and the transport, and the session is pinned at
    // `waiting` forever — the silent stall this feature is built to avoid.
    expectedStatuses: ["running", "waiting"],
    surface,
  });
  await surface.reply(`⛔ ${error}`);
}

/** What the runner observed about how this turn ended, beyond its result. */
export interface TurnVerdict {
  quietPreempted: boolean;
  streamedThrough: number;
  /** A newer user message displaced this turn. */
  superseded: boolean;
  /** The engine got far enough to have this turn's prompt in its own transcript. */
  enginePromptRead: boolean;
}

/** Settle a turn that reached the engine, whether or not its answer is wanted. */
export async function settleAnsweredTurn(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
  verdict: TurnVerdict,
): Promise<void> {
  const sessionId = run.input.session.id;
  const { engineName } = run.plan;
  const result = attempt.result;
  const { quietPreempted } = verdict;

  const displayText = quietPreempted ? "" : turnDisplayText(result.result, result.error);
  if (shouldPersistFinalAssistantMessage({ resultText: result.result, quietPreempted }) || displayText) {
    insertMessageAfter(sessionId, "assistant", displayText, verdict.streamedThrough);
  }

  const settled = await settleTurn({
    ...answeredReceipt(run, attempt, model, verdict),
    surface: run.surface,
  });

  holdPromptTheEngineNeverRead(run, verdict);
  if (!quietPreempted && engineName === "claude") markTranscriptSyncedThrough(sessionId, result.sessionId);
  clearSupersededTurnMeta(sessionId);
  if (settled && displayText) await run.surface.reply(displayText);

  logger.info(
    `Session ${sessionId} completed` +
    (result.durationMs ? ` in ${result.durationMs}ms` : "") +
    (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
  );
}

/**
 * A newer message can cut a turn off before the engine reads its prompt, which
 * leaves the engine with no record of it at all. Hold it for the next turn to
 * carry, or it is lost from the conversation the engine sees.
 */
function holdPromptTheEngineNeverRead(run: TurnRun, verdict: TurnVerdict): void {
  if (!verdict.superseded || verdict.enginePromptRead) return;
  retainUnseenInterruptedPrompt(run.input.session.id, run.input.prompt);
}

/** The receipt a turn that reached the engine writes, preempted or not. */
function answeredReceipt(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
  verdict: TurnVerdict,
): Omit<SettleTurnInput, "surface"> {
  const { quietPreempted } = verdict;
  const result = attempt.result;
  // A turn that failed on its own files nothing. A preempted one still files,
  // because it may have minted the thread the interrupted message now lives in.
  const filesEngineSession = quietPreempted || !result.error;
  return {
    sessionId: run.input.session.id,
    attemptToken: run.input.attemptToken,
    outcome: quietPreempted ? "interrupted" : (result.error ? "failed" : "succeeded"),
    result: quietPreempted ? null : result.result,
    error: quietPreempted ? null : (result.error ?? null),
    cost: result.cost,
    durationMs: result.durationMs,
    accounting: result,
    ...(filesEngineSession ? filedEngineSession(run, attempt, model, quietPreempted) : {}),
    fields: buildTerminalFields(run, result.contextTokens, verdict),
    employee: run.input.employee,
    // An interrupted turn stays silent upward: whoever interrupted it reports.
    notifyParent: !quietPreempted,
  };
}

/**
 * The engine session this turn files for the next resume, if any.
 *
 * A turn that answered files the thread it used, falling back to the one it
 * resumed from so a turn that answered without echoing its own session id does
 * not orphan the engine session it actually used.
 *
 * A turn a newer message cut off files only a thread it MINTED. That thread
 * holds whatever the engine recorded of the interrupted message, and nothing
 * else will ever resume it — on a fresh session that is the whole of message
 * one. The id it merely resumed from is already the successor's, and rewriting
 * it here would stamp this turn's context fingerprint onto a refresh the engine
 * never finished consuming.
 */
function filedEngineSession(
  run: TurnRun,
  attempt: EngineAttempt,
  model: string | undefined,
  quietPreempted: boolean,
): Pick<SettleTurnInput, "engineSession"> {
  const echoed = attempt.result.sessionId?.trim();
  const nativeId = quietPreempted
    ? (echoed === run.plan.resumeNativeId ? undefined : echoed)
    : (echoed || run.plan.resumeNativeId);
  if (!nativeId) return {};
  return {
    engineSession: {
      engine: run.plan.engineName,
      nativeId,
      meta: { model, effortLevel: run.plan.effortLevel, platformContextFingerprint: attempt.fingerprint },
    },
  };
}

/** The turn threw: settle it as failed. The caller has confirmed it can land. */
export async function settleThrownTurn(run: TurnRun, errMsg: string): Promise<void> {
  const sessionId = run.input.session.id;
  deletePartialMessages(sessionId);
  await settleTurn({
    sessionId,
    attemptToken: run.input.attemptToken,
    outcome: "failed",
    error: errMsg,
    fields: run.terminalFields(),
    employee: run.input.employee,
    surface: run.surface,
  });
  await run.surface.reply(`Error: ${errMsg}`);
}

function buildTerminalFields(run: TurnRun, contextTokens: number | undefined, verdict: TurnVerdict): UpdateSessionFields {
  const fields: UpdateSessionFields = { ...run.terminalFields() };
  if (typeof contextTokens === "number") fields.lastContextTokens = contextTokens;
  const clearSyncMarkers = run.plan.syncRequested && !verdict.quietPreempted;
  // The held prompts this turn put in front of the engine are owed no longer,
  // and only the engine having read them settles that.
  const clearCarriedPrompts = run.plan.carriedInterruptedPrompts && verdict.enginePromptRead;
  if (clearSyncMarkers || clearCarriedPrompts) {
    let meta: unknown = fields.transportMeta ?? getSession(run.input.session.id)?.transportMeta;
    if (clearSyncMarkers) meta = withSyncMarkersCleared(meta);
    if (clearCarriedPrompts) meta = withUnseenInterruptedPromptsCleared(meta);
    fields.transportMeta = meta as UpdateSessionFields["transportMeta"];
  }
  return fields;
}

/**
 * A stale engine-session id makes every resume fail. Drop this engine's typed ref
 * so the next attempt starts a fresh engine session instead of retrying a dead one,
 * and drop any rate-limit override that would otherwise restore the dead id.
 */
export function clearDeadEngineSession(sessionId: string, engineName: string): void {
  logger.warn(`Dead session detected for ${sessionId} — clearing stale engine IDs`);
  const meta = { ...(getSession(sessionId)?.transportMeta || {}) } as Record<string, unknown>;
  delete meta["engineOverride"];
  clearEngineSessionRefs(sessionId, engineName);
  updateSession(sessionId, { transportMeta: meta as UpdateSessionFields["transportMeta"] });
}
