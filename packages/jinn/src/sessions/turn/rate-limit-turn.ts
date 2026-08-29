import { isInterruptibleEngine, type EngineResult, type Session } from "../../shared/types.js";
import { rateLimitEngineLabel } from "../../shared/rateLimit.js";
import type { EngineName } from "../../shared/models.js";
import { getSession, insertMessage, type UpdateSessionFields } from "../registry.js";
import { notifyOperatorChannel, notifyRateLimited, notifyRateLimitResumed } from "../callbacks.js";
import { handleRateLimit, type RateLimitHandlerHooks, type RateLimitInfo } from "../rate-limit-handler.js";
import { settleTurn, type SettleTurnInput } from "./completion.js";
import { formatResumeTime, turnDisplayText } from "./text.js";
import type { TurnInput, TurnPlan, TurnSurface } from "./types.js";

export interface RateLimitTurnArgs {
  input: TurnInput;
  plan: TurnPlan;
  surface: TurnSurface;
  systemPrompt: string;
  platformContextRefresh?: string;
  platformContextFingerprint: string;
  rateLimit: RateLimitInfo;
  originalResult: EngineResult;
  terminalFields: () => UpdateSessionFields;
}

type EngineSession = NonNullable<SettleTurnInput["engineSession"]>;

/** Session label used in every operator notification this branch sends. */
function describe(session: Session): string {
  return `Session ${session.id}${session.employee ? ` (${session.employee})` : ""}`;
}

/**
 * Settle a turn the rate-limit branch recovered — on the fallback engine or on
 * the original one after the limit cleared. Either way it is a completed turn:
 * it cost real money and produced a real answer, so it accounts and reports.
 */
async function settleRecoveredTurn(
  args: RateLimitTurnArgs,
  recovered: EngineResult,
  engineSession: EngineSession | undefined,
): Promise<Session | undefined> {
  const sessionId = args.input.session.id;
  const text = turnDisplayText(recovered.result, recovered.error);
  if (text) insertMessage(sessionId, "assistant", text);

  const settled = await settleTurn({
    sessionId,
    attemptToken: args.input.attemptToken,
    outcome: recovered.error ? "failed" : "succeeded",
    result: recovered.result,
    error: recovered.error ?? null,
    cost: recovered.cost,
    durationMs: recovered.durationMs,
    accounting: recovered,
    ...(engineSession ? { engineSession } : {}),
    fields: {
      ...args.terminalFields(),
      ...(typeof recovered.contextTokens === "number" ? { lastContextTokens: recovered.contextTokens } : {}),
    },
    employee: args.input.employee,
    surface: args.surface,
  });
  if (text) await args.surface.reply(text);
  return settled;
}

async function announceFallback(args: RateLimitTurnArgs, resumeAt: Date | null, substitute: EngineName): Promise<void> {
  const session = args.input.session;
  // The handler rewrites session.engine to the substitute only after this hook
  // returns, so what is read here is still the engine that was limited.
  const limitedEngine = session.engine;
  const limitedLabel = rateLimitEngineLabel(limitedEngine);
  const substituteLabel = rateLimitEngineLabel(substitute);
  const resumeText = formatResumeTime(resumeAt);
  notifyOperatorChannel(`⚠️ ${limitedLabel} usage limit reached. ${describe(session)} switching to ${substituteLabel}.`);
  await args.surface.notice(`⚠️ ${limitedLabel} usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to ${substituteLabel} for now.`);

  // Drop the LIMITED engine's warm PTY AND its armed late-recovery listener, so
  // the abandoned turn can't double-answer after the substitute delivers.
  const limited = args.input.engines.get(limitedEngine);
  if (limited && isInterruptibleEngine(limited)) {
    limited.kill(session.id, "Interrupted: engine switched");
  }
}

async function announceWaiting(args: RateLimitTurnArgs, resumeAt: Date | null): Promise<void> {
  const session = args.input.session;
  const engineLabel = rateLimitEngineLabel(session.engine);
  const resumeText = formatResumeTime(resumeAt);
  notifyOperatorChannel(`⚠️ ${engineLabel} usage limit reached. ${describe(session)} paused${resumeText ? ` until ${resumeText}` : ""}.`);
  await args.surface.waiting(true);
  notifyRateLimited(
    getSession(session.id) ?? session,
    resumeAt ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : undefined,
  );
  await args.surface.notice(`⏳ ${engineLabel} usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`);
}

/** The limit never lifted inside the deadline: settle out of `waiting`. */
async function settleTimedOutTurn(args: RateLimitTurnArgs): Promise<void> {
  const session = args.input.session;
  const timeoutError = `${rateLimitEngineLabel(session.engine)} usage limit did not clear in time`;
  notifyOperatorChannel(`❌ ${timeoutError}. ${describe(session)} has been stopped.`);
  await settleTurn({
    sessionId: session.id,
    attemptToken: args.input.attemptToken,
    outcome: "failed",
    error: timeoutError,
    // This turn settles out of `waiting`, not `running`, so the receipt widens
    // the fence the other terminal classes use.
    expectedStatuses: ["waiting", "running"],
    employee: args.input.employee,
    surface: args.surface,
  });
  await args.surface.reply("Usage limit didn't reset in time. Please try again later.");
}

function rateLimitHooks(args: RateLimitTurnArgs): RateLimitHandlerHooks {
  const { plan, surface } = args;
  return {
    onFallbackStart: ({ resumeAt, substitute }) => announceFallback(args, resumeAt, substitute),
    onFallbackStream: (delta) => surface.delta(delta),
    onFallbackComplete: async (fallbackResult) => {
      // The fallback answered on a DIFFERENT engine, so its native id is filed
      // under whichever engine the switch landed on — and without a platform
      // context fingerprint, which belongs to the engine that was limited.
      const fallbackEngine = getSession(args.input.session.id)?.engine ?? args.input.session.engine;
      await settleRecoveredTurn(args, fallbackResult, fallbackResult.sessionId?.trim() ? {
        engine: fallbackEngine,
        nativeId: fallbackResult.sessionId,
        meta: { model: plan.model, effortLevel: plan.effortLevel },
      } : undefined);
    },
    onWaitingStart: ({ resumeAt }) => announceWaiting(args, resumeAt),
    onRetryAttempt: () => surface.waiting(false),
    onStillLimited: () => surface.waiting(true),
    onRetryStream: (delta) => surface.delta(delta),
    onRetrySuccess: async (retryResult) => {
      const settled = await settleRecoveredTurn(args, retryResult, !retryResult.error && retryResult.sessionId?.trim() ? {
        engine: plan.engineName,
        nativeId: retryResult.sessionId,
        meta: { model: plan.model, effortLevel: plan.effortLevel, platformContextFingerprint: args.platformContextFingerprint },
      } : undefined);
      if (!settled) return;
      notifyRateLimitResumed(settled);
      notifyOperatorChannel(`✅ ${rateLimitEngineLabel(args.input.session.engine)} usage limit cleared. ${describe(args.input.session)} resumed.`);
    },
    onTimeout: () => settleTimedOutTurn(args),
  };
}

/**
 * The rate-limit branch of a turn: hand off to the wait/retry/fallback handler
 * and settle whichever of its outcomes lands.
 */
export async function runRateLimitTurn(args: RateLimitTurnArgs): Promise<void> {
  const { input, plan } = args;
  await handleRateLimit({
    session: input.session,
    attemptToken: input.attemptToken,
    prompt: input.prompt,
    systemPrompt: args.systemPrompt,
    platformContextRefresh: args.platformContextRefresh,
    engineConfig: plan.engineConfig,
    effortLevel: plan.effortLevel,
    cliFlags: input.employee?.cliFlags,
    remoteHost: input.employee?.remoteHost,
    remoteUser: input.employee?.remoteUser,
    remoteCwd: input.employee?.remoteCwd,
    mcpConfigPath: plan.mcpConfigPath,
    resolvedMcp: plan.resolvedMcp,
    attachments: input.attachments.length ? input.attachments : undefined,
    config: input.config,
    engines: input.engines,
    employee: input.employee,
    engine: plan.engine,
    rateLimit: args.rateLimit,
    originalResult: args.originalResult,
    hooks: rateLimitHooks(args),
  });
}
