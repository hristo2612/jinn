import { logger } from "../../shared/logger.js";
import { detectRateLimit, isDeadSessionError } from "../../shared/rateLimit.js";
import type { EngineResult, Session } from "../../shared/types.js";
import { completedStreamedBlockIds } from "../../gateway/streamed-blocks.js";
import {
  deletePartialMessages,
  getPartialMessages,
  getSession,
  settlePartialMessages,
  updateSession,
  type UpdateSessionFields,
} from "../registry.js";
import { createPartialStreamWriter } from "../partial-stream.js";
import { isDurableWorkflowUserMessageInterruption } from "../workflow-interruptions.js";
import { runEngineAttempt, resolveModelFallback, type EngineAttempt } from "./engine-run.js";
import { armTurnHeartbeat } from "./heartbeat.js";
import { preflightTurn, warnIfNearUsageLimit } from "./preflight.js";
import { ensureRemoteHostReady } from "./remote-ready.js";
import { runRateLimitTurn } from "./rate-limit-turn.js";
import { clearDeadEngineSession, settleAnsweredTurn, settleRefusedTurn, settleThrownTurn } from "./settle.js";
import { clearSupersededTurnMeta, isTurnSuperseded } from "./superseded.js";
import type { TurnInput, TurnRun, TurnSurface } from "./types.js";

/**
 * Run one turn, from preflight to terminal receipt, for every transport.
 *
 * The caller has already begun the attempt and owns the queue slot; this owns
 * everything between. Both the connector runner and the web runner call it, and
 * the only thing they supply differently is the `TurnSurface`.
 */
export async function runTurn(input: TurnInput, surface: TurnSurface): Promise<void> {
  const sessionId = input.session.id;
  const terminalFields = (): UpdateSessionFields => input.terminalFields?.() ?? {};

  const plan = preflightTurn(input);
  if (!plan.ok) {
    await settleRefusedTurn(input, surface, plan.error, terminalFields);
    return;
  }

  // A remote employee's host may be asleep. Wake it and wait for it BEFORE the
  // turn is announced as started, so the session reads as `waiting` rather than
  // `running` against a machine that is still booting. No-op for local employees.
  const remoteReady = await ensureRemoteHostReady(input);
  if (!remoteReady.ok) {
    await settleRefusedTurn(input, surface, remoteReady.error, terminalFields);
    return;
  }

  logger.info(`Session ${sessionId} running engine "${plan.engineName}" (model: ${plan.model || "default"})`);
  await surface.started();
  await warnIfNearUsageLimit(input, plan, surface);

  const run: TurnRun = {
    input,
    plan,
    surface,
    heartbeat: armTurnHeartbeat(sessionId, input.attemptToken),
    partialStream: createPartialStreamWriter(sessionId),
    turnStartedAt: Date.now(),
    terminalFields,
  };

  try {
    const { attempt, model } = await runEngineWithModelFallback(run);
    run.heartbeat.stop();
    await concludeTurn(run, attempt, model);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Session ${sessionId} error: ${errMsg}`);
    if (claimSettleableSession(run, "error")) await settleThrownTurn(run, errMsg);
  } finally {
    run.heartbeat.stop();
  }
}

/** Run the engine, retrying once on a model Claude has since withdrawn. */
async function runEngineWithModelFallback(run: TurnRun): Promise<{ attempt: EngineAttempt; model: string | undefined }> {
  let model = run.plan.model;
  let attempt = await runEngineAttempt({ ...run, model });

  const retryModel = await resolveModelFallback(run.input, run.plan, attempt.result, model);
  if (retryModel) {
    deletePartialMessages(run.input.session.id);
    model = retryModel;
    updateSession(run.input.session.id, { model: retryModel, lastError: null });
    attempt = await runEngineAttempt({ ...run, model });
  }
  return { attempt, model };
}

/**
 * The session this turn belongs to, or undefined when the result no longer has
 * anywhere to land: the session was deleted, or it has since switched engines
 * and this answer came from the old one.
 */
function claimSettleableSession(run: TurnRun, what: "result" | "error"): Session | undefined {
  const sessionId = run.input.session.id;
  const live = getSession(sessionId);
  if (!live) {
    deletePartialMessages(sessionId);
    logger.warn(`Dropping engine ${what} for deleted session ${sessionId}`);
    return undefined;
  }
  if (live.engine !== run.plan.engineName) {
    deletePartialMessages(sessionId);
    clearSupersededTurnMeta(sessionId);
    logger.info(`Dropping stale ${run.plan.engineName} ${what} for session ${sessionId}; session now uses ${live.engine}`);
    return undefined;
  }
  return live;
}

/**
 * Was this turn's answer preempted before it could land? A newer user message,
 * a stop, a workflow interruption, or another turn taking the attempt all mean
 * the same thing: settle as interrupted and say nothing to anyone.
 */
function wasQuietlyPreempted(run: TurnRun, live: Session, result: EngineResult, superseded: boolean): boolean {
  const completionTurn = (live.attemptTurn ?? 0) + 1;
  if (isDurableWorkflowUserMessageInterruption(live, completionTurn)) return true;
  if (result.error?.startsWith("Interrupted")) return true;
  if (live.attemptToken !== run.input.attemptToken || live.status !== "running") return true;
  return superseded;
}

/** Settle whichever terminal class this turn landed in. */
async function concludeTurn(run: TurnRun, attempt: EngineAttempt, model: string | undefined): Promise<void> {
  const sessionId = run.input.session.id;
  const live = claimSettleableSession(run, "result");
  if (!live) return;

  const result = attempt.result;
  const superseded = isTurnSuperseded(sessionId, run.turnStartedAt);
  const quietPreempted = wasQuietlyPreempted(run, live, result, superseded);

  // A stale engine-session id can carry text like "429" that would otherwise
  // read as a rate limit, so dead sessions are cleared before that check.
  const dead = !quietPreempted && isDeadSessionError(result);
  if (dead) clearDeadEngineSession(sessionId, run.plan.engineName);
  const rateLimit = !quietPreempted && !dead ? detectRateLimit(result) : { limited: false as const };

  // Keep the same completed evidence the live view kept — interim prose, tools,
  // media, delegation blocks — and drop exact streamed copies of the result,
  // which the canonical final row replaces.
  const streamedBlocks = getPartialMessages(sessionId);
  settlePartialMessages(sessionId, completedStreamedBlockIds({
    quietPreempted,
    rateLimited: rateLimit.limited,
    result: result.result,
    error: result.error,
    streamedBlocks,
  }));

  if (rateLimit.limited) {
    await runRateLimitTurn({
      input: run.input,
      plan: run.plan,
      surface: run.surface,
      systemPrompt: attempt.systemPrompt,
      platformContextRefresh: attempt.contextRefresh,
      platformContextFingerprint: attempt.fingerprint,
      rateLimit,
      originalResult: result,
      terminalFields: run.terminalFields,
    });
    return;
  }

  const streamedThrough = streamedBlocks.reduce((latest, message) => Math.max(latest, message.timestamp), 0);
  // A turn killed before it emitted anything is one the engine never began, so
  // its prompt is absent from the engine's own transcript. Anything it did emit
  // proves the engine read the prompt and recorded it.
  const enginePromptRead = !quietPreempted || streamedBlocks.length > 0;
  await settleAnsweredTurn(run, attempt, model, { quietPreempted, streamedThrough, superseded, enginePromptRead });
}
