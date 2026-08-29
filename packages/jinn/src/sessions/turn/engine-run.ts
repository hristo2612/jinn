import { JINN_HOME } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";
import { selectClaudeModelFallback } from "../../shared/model-fallback.js";
import { getModelRegistry, refreshClaudeModels } from "../../shared/models.js";
import type { EngineResult, StreamDelta } from "../../shared/types.js";
import { getSession, insertMessage, updateSessionForAttempt } from "../registry.js";
import { normalizeBlockDeltaForTurn, type PartialStreamWriter } from "../partial-stream.js";
import { settleTurn } from "./completion.js";
import type { TurnHeartbeat } from "./heartbeat.js";
import type { TurnInput, TurnPlan, TurnSurface } from "./types.js";

/** One engine invocation plus the context that was built for it. */
export interface EngineAttempt {
  result: EngineResult;
  fingerprint: string;
  contextRefresh: string | undefined;
  systemPrompt: string;
}

export interface EngineAttemptArgs {
  input: TurnInput;
  plan: TurnPlan;
  surface: TurnSurface;
  heartbeat: TurnHeartbeat;
  partialStream: PartialStreamWriter;
  turnStartedAt: number;
  model: string | undefined;
}

/**
 * Run the engine once for this turn. The system prompt is rebuilt per attempt
 * because a model fallback changes the platform context, and the context
 * fingerprint recorded against the resumed engine session must match the prompt
 * the engine actually saw.
 */
export async function runEngineAttempt(args: EngineAttemptArgs): Promise<EngineAttempt> {
  const { input, plan, surface, partialStream } = args;
  const sessionId = input.session.id;
  const prepared = plan.prepareContext(args.model);

  const result = await plan.engine.run({
    prompt: plan.promptToRun,
    resumeSessionId: plan.resumeSessionId,
    systemPrompt: prepared.systemPrompt,
    platformContextRefresh: prepared.refresh,
    cwd: JINN_HOME,
    bin: plan.engineConfig.bin,
    model: args.model,
    effortLevel: plan.effortLevel,
    cliFlags: input.employee?.cliFlags,
    // `cwd` above stays JINN_HOME: it is the gateway-side working directory and
    // is meaningless on the remote host. The engine branches on `remoteHost` and
    // uses `remoteCwd` instead — passing both is what lets one code path serve
    // a local and a remote employee.
    remoteHost: input.employee?.remoteHost,
    remoteUser: input.employee?.remoteUser,
    remoteCwd: input.employee?.remoteCwd,
    mcpConfigPath: plan.mcpConfigPath,
    resolvedMcp: plan.resolvedMcp,
    attachments: input.attachments.length ? input.attachments : undefined,
    sessionId,
    source: plan.runtimeSource,
    onStream: (delta) => handleStreamDelta(args, delta),
    onLateRecovery: ({ result: lateText, sessionId: engineSid }) => {
      void recoverLateTurn({ input, plan, surface, lateText, engineSid, fingerprint: prepared.fingerprint });
    },
  }).finally(() => {
    // Stop any pending debounced text flush so it can't re-insert a partial row
    // after the turn-end cleanup deletes them.
    partialStream.finish();
  });

  return {
    result,
    fingerprint: prepared.fingerprint,
    contextRefresh: prepared.refresh,
    systemPrompt: prepared.systemPrompt,
  };
}

/**
 * Mirror one live block into the session: refresh the context meter, keep the
 * heartbeat alive, push it to the transport, and persist it so a page refresh
 * restores the in-progress turn.
 */
function handleStreamDelta(args: EngineAttemptArgs, delta: StreamDelta): void {
  const sessionId = args.input.session.id;
  // A delta can arrive after the user deleted the session; never resurrect
  // registry state for it.
  if (!getSession(sessionId)) return;
  const normalized = normalizeBlockDeltaForTurn(delta, args.turnStartedAt);
  if (!normalized.ok) {
    logger.warn(`Dropped invalid block delta for session ${sessionId}: ${normalized.error}`);
    return;
  }
  const outgoing = normalized.delta;
  // Live context-meter: message_start.usage arrives as a `context` delta, once
  // per assistant message, so persisting it here is cheap and makes the meter
  // tick during the turn rather than only at completion.
  if (outgoing.type === "context") {
    const contextTokens = Number(outgoing.content);
    if (Number.isFinite(contextTokens) && contextTokens > 0) {
      updateSessionForAttempt(sessionId, args.input.attemptToken, { lastContextTokens: contextTokens });
    }
  }
  args.heartbeat.beat();
  args.surface.delta(outgoing);
  try {
    args.partialStream.persist(outgoing);
  } catch (err) {
    logger.warn(`Failed to persist partial block for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Claude occasionally rejects a model that was valid when the session was
 * created. Re-read the registry once and name a live substitute rather than
 * failing the turn on a stale model id. Returns the model to retry with, or
 * undefined when this turn should stand as it is.
 */
export async function resolveModelFallback(
  input: TurnInput,
  plan: TurnPlan,
  result: EngineResult,
  modelForTurn: string | undefined,
): Promise<string | undefined> {
  if (plan.engineName !== "claude" || !result.error || result.result.trim()) return undefined;
  const live = getSession(input.session.id);
  if (live?.attemptToken !== input.attemptToken || live.status !== "running") return undefined;

  await refreshClaudeModels(input.config);
  const fallbackModel = selectClaudeModelFallback({
    engine: plan.engineName,
    requestedModel: modelForTurn,
    error: result.error,
    models: getModelRegistry(input.config).claude?.models ?? [],
  });
  if (!fallbackModel) return undefined;
  logger.warn(`Claude model "${modelForTurn}" failed availability check; retrying session ${input.session.id} with "${fallbackModel}"`);
  return fallbackModel;
}

/**
 * A turn that settled as failed but whose CLI later finished delivers its text
 * here. Restore a clean idle status and label the answer as a supersede, unless
 * the session is gone or a newer turn already owns it.
 */
async function recoverLateTurn(args: {
  input: TurnInput;
  plan: TurnPlan;
  surface: TurnSurface;
  lateText: string;
  engineSid: string;
  fingerprint: string;
}): Promise<void> {
  const { input, plan, surface } = args;
  const sessionId = input.session.id;
  const live = getSession(sessionId);
  if (!live || live.engine !== plan.engineName) return;

  // The parent/channel already saw this turn fail — label the late answer so it
  // reads as a supersede, not a fresh unprompted turn.
  const labelled = `(recovered — this supersedes the earlier reported failure)\n\n${args.lateText}`;
  const recovered = await settleTurn({
    sessionId,
    attemptToken: input.attemptToken,
    outcome: "succeeded",
    result: labelled,
    error: null,
    ...(args.engineSid.trim()
      ? {
        engineSession: {
          engine: plan.engineName,
          nativeId: args.engineSid,
          meta: { model: plan.model, effortLevel: plan.effortLevel, platformContextFingerprint: args.fingerprint },
        },
      }
      : {}),
    // A recovery settles the failed turn's own row, so it lands out of `error`
    // rather than the default running-only fence.
    expectedStatuses: ["error"],
    employee: input.employee,
    surface,
  });
  if (!recovered) return;

  insertMessage(sessionId, "assistant", args.lateText);
  await surface.reply(labelled);
  logger.info(`Session ${sessionId} recovered by late Stop after a failed turn`);
}
