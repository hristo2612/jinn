/**
 * Shared rate-limit / fallback / wait-and-retry handler.
 *
 * Both the connector path (sessions/manager.ts → runSession) and the web path
 * (gateway/api.ts → runWebSession) need to:
 *   1. Detect an engine usage-limit response.
 *   2. Hand the turn to the first engine in the limited one's chain that can serve one.
 *   3. Otherwise enter a "waiting" loop: sleep until the reset window, retry on the same engine,
 *      keep the session's lastActivity heartbeat fresh, and loop again if still limited.
 *   4. Bail out when the deadline passes without recovery.
 *
 * The state machine, engine invocations, retry math, heartbeat cadence, deadline
 * computation, and `transportMeta.engineOverride` bookkeeping are identical between
 * the two call sites — only the transport-side UI/notification details differ.
 * This module owns the common bits; per-transport behavior is injected via hooks.
 *
 * Per-engine thread ids live in the typed `engineSessions` refs the registry owns
 * (read with getEngineSessionRef, written with nextEngineSessionFields folded into
 * this module's existing attempt fences) — never in a transport-meta blob.
 *
 * Behavior is intentionally preserved verbatim from the original inlined
 * implementations — do not "improve" the wait math, the per-step state writes,
 * or the order of side effects without auditing both call sites.
 */

import type { RateLimitHandlerOpts, RateLimitOutcome } from "./rate-limit-contract.js";
import type { RemoteTarget } from "../shared/types.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { engineAvailable, type EngineName } from "../shared/models.js";
import {
  computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit, nextUnstatedParkDelayMs,
  rateLimitEngineLabel, MAX_UNSTATED_PARK_ATTEMPTS,
} from "../shared/rateLimit.js";
import { recordClaudeRateLimit } from "../shared/usageAwareness.js";
import { readEngineHealth, recordEngineUnavailable, resolveHealthyFallbackEngine } from "../shared/engine-health.js";
import { beginEngineSubstitution } from "./engine-override.js";
import { resolveEngineRunMcp } from "./engine-run-mcp.js";
import { getSession, getMessages, updateSessionForAttempt, nextEngineSessionFields } from "./registry.js";
import { runtimeSessionSource } from "./context.js";

const WAIT_CANCEL_POLL_MS = 5000;

export type {
  RateLimitHandlerHooks, RateLimitHandlerOpts, RateLimitInfo, RateLimitOutcome,
} from "./rate-limit-contract.js";

/**
 * Drive the rate-limit recovery state machine. Returns once the situation
 * resolves (success, fallback completion, timeout, or cancellation).
 *
 * The caller has ALREADY detected the rate limit and confirmed it should be
 * handled (i.e. not a dead session, not an interrupted turn).
 */
export async function handleRateLimit(opts: RateLimitHandlerOpts): Promise<RateLimitOutcome> {
  const {
    session, attemptToken, prompt, systemPrompt, platformContextRefresh, engineConfig, effortLevel, cliFlags,
    mcpConfigPath, resolvedMcp, attachments, config, engines, employee, engine,
    remoteHost, remoteUser, remoteCwd, rateLimit, originalResult, hooks,
  } = opts;

  const engineLabel = rateLimitEngineLabel(session.engine);

  // Where this turn actually runs. Read the same way `cliFlags` is below — the
  // employee record first, the explicitly passed target as the fallback — so the
  // two sources cannot silently disagree about which host owns the session.
  const remoteTarget: RemoteTarget = {
    remoteHost: employee?.remoteHost ?? remoteHost,
    remoteUser: employee?.remoteUser ?? remoteUser,
    remoteCwd: employee?.remoteCwd ?? remoteCwd,
  };

  // Both chain walkers read the generic record; Claude's store answers a different question.
  recordEngineUnavailable(session.engine, `${engineLabel} usage limit`, rateLimit.resetsAt);
  if (session.engine === "claude") recordClaudeRateLimit(rateLimit.resetsAt);

  // ── Branch A: hand the turn to this engine's chain ─────────────────────────
  const isUsable = (candidate: EngineName) => engines.has(candidate) && engineAvailable(config, candidate);
  const substituteName = resolveHealthyFallbackEngine(config, session.engine, isUsable, readEngineHealth());
  const substituteEngine = substituteName ? engines.get(substituteName) : undefined;
  // No engine but the session's own has any notion of a remote host, so handing
  // a remote employee's turn to a substitute would move it onto the gateway —
  // unattended, with --dangerously-skip-permissions, against a repository that
  // deliberately was never cloned there. Skipping Branch A leaves the turn to
  // Branch B, which waits the limit out on the host that already owns the work.
  const remoteSuppressesSubstitute = isRemoteTarget(remoteTarget);
  if (substituteName && substituteEngine && remoteSuppressesSubstitute) {
    logger.info(
      `Session ${session.id} runs on ${remoteTarget.remoteHost} — not substituting ${rateLimitEngineLabel(substituteName)} for the ${engineLabel} usage limit (no engine can run remotely); waiting for the reset instead`,
    );
  }
  if (substituteName && substituteEngine && !remoteSuppressesSubstitute) {
    const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
    const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
    const syncSince = new Date().toISOString();
    const substituteLabel = rateLimitEngineLabel(substituteName);

    await hooks.onFallbackStart?.({ resumeAt: resumeAt ?? null, until, substitute: substituteName });

    const substitution = beginEngineSubstitution({
      session, attemptToken, config, employee, substitute: substituteName, until, syncSince,
      lastError: resumeAt
        ? `${engineLabel} usage limit — using ${substituteLabel} until ${resumeAt.toISOString()}`
        : `${engineLabel} usage limit — using ${substituteLabel} temporarily`,
    });
    if (!substitution) {
      await hooks.onCancelled?.();
      return { kind: "cancelled" };
    }

    const substituteResume = substitution.resumeSessionId;
    const history = getMessages(session.id)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
    const historyText = history.slice(-12).join("\n\n");
    const fallbackPrompt = substituteResume
      ? prompt
      : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;

    const fallbackResult = await substituteEngine.run({
      prompt: fallbackPrompt,
      resumeSessionId: substituteResume,
      systemPrompt,
      cwd: JINN_HOME,
      // The substitute runs as itself: its own binary, the MCP payload resolved for it,
      // and a model it actually serves — the limited engine's would be meaningless here.
      bin: substitution.engineConfig.bin,
      model: substitution.model ?? substitution.engineConfig.model,
      effortLevel: substitution.effortLevel,
      cliFlags: employee?.cliFlags ?? cliFlags,
      ...resolveEngineRunMcp({ config, employee, engine: substituteName, sessionId: session.id }),
      attachments: attachments?.length ? attachments : undefined,
      sessionId: session.id,
      ...(hooks.onFallbackStream ? { onStream: hooks.onFallbackStream } : {}),
    });

    // Persist the substitute's thread id so future fallbacks can resume it —
    // and so the mirror stops lying about which engine the id belongs to.
    const live = getSession(session.id);
    if (live && fallbackResult.sessionId) {
      updateSessionForAttempt(session.id, attemptToken, nextEngineSessionFields(live, substituteName, fallbackResult.sessionId));
    }

    await hooks.onFallbackComplete?.(fallbackResult);

    return { kind: "fallback", result: fallbackResult };
  }
  // Nothing usable in the chain — fall through to wait-and-retry.

  // ── Branch B: wait-and-retry on the original engine ────────────────────────
  const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
  const deadlineMs = computeRateLimitDeadlineMs(
    rateLimit.resetsAt,
    rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
  );

  logger.info(
    `Session ${session.id} hit ${engineLabel} usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
  );

  const enteredWaiting = updateSessionForAttempt(session.id, attemptToken, {
    ...(originalResult.sessionId?.trim() ? nextEngineSessionFields(session, session.engine, originalResult.sessionId) : {}),
    status: "waiting",
    lastActivity: new Date().toISOString(),
    lastError: resumeAt
      ? `${engineLabel} usage limit — resumes ${resumeAt.toISOString()}`
      : `${engineLabel} usage limit — waiting for reset`,
  });
  if (!enteredWaiting) {
    await hooks.onCancelled?.();
    return { kind: "cancelled" };
  }

  await hooks.onWaitingStart?.({ resumeAt: resumeAt ?? null, rateLimit });

  // Keep lastActivity fresh while waiting (UI / status endpoints).
  const heartbeat = setInterval(() => {
    if (getSession(session.id)?.status === "waiting") {
      updateSessionForAttempt(session.id, attemptToken, { status: "waiting", lastActivity: new Date().toISOString() }, ["waiting"]);
    }
  }, 60_000);

  try {
    let attempt = 0;
    let nextDelayMs = delayMs;
    // Consecutive retries against a limit that has still named no reset. Reset
    // to zero the moment one does, so a limit that starts stating a window goes
    // back to being slept to rather than guessed at.
    let unstatedAttempts = 0;

    while (Date.now() < deadlineMs) {
      const stillWaiting = await waitWhileSessionWaiting(session.id, nextDelayMs);
      if (!stillWaiting) {
        const currentSession = getSession(session.id);
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }
      attempt++;

      // Check if session was stopped while waiting. We set status:"waiting"
      // before entering this loop, so any other status (idle from a user
      // POST /stop, error from a crash, etc.) means the user/system pulled
      // us out of the waiting state and we should NOT retry. Previously this
      // only caught "error", so user-initiated stop ("idle") leaked through
      // and the retry fired against a session the user thought was stopped.
      const currentSession = getSession(session.id);
      if (!currentSession || currentSession.status !== "waiting") {
        logger.info(`Session ${session.id} stopped while waiting for usage reset (status=${currentSession?.status ?? "deleted"})`);
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      await hooks.onRetryAttempt?.({ attempt });
      logger.info(`Session ${session.id} retrying after usage limit (attempt ${attempt})`);

      const retryStarted = updateSessionForAttempt(session.id, attemptToken, {
        status: "running",
        lastActivity: new Date().toISOString(),
      }, ["waiting"]);
      if (!retryStarted) {
        await hooks.onCancelled?.();
        return { kind: "cancelled" };
      }

      const retryResult = await engine.run({
        prompt,
        resumeSessionId: currentSession.engineSessionId ?? undefined,
        systemPrompt,
        platformContextRefresh,
        cwd: JINN_HOME,
        bin: engineConfig.bin,
        model: currentSession.model ?? engineConfig.model,
        effortLevel,
        cliFlags,
        // The retry is a fresh spawn, not a resume of the limited process, so it
        // re-states where the session runs. Omit this and a rate-limited remote
        // turn silently comes back on the gateway.
        ...remoteTarget,
        mcpConfigPath,
        resolvedMcp,
        attachments: attachments?.length ? attachments : undefined,
        sessionId: session.id,
        source: runtimeSessionSource(session.source),
        ...(hooks.onRetryStream ? { onStream: hooks.onRetryStream } : {}),
      });

      const retryInterrupted = retryResult.error?.startsWith("Interrupted");
      const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };

      if (retryRateLimit.limited) {
        recordEngineUnavailable(session.engine, `${engineLabel} usage limit`, retryRateLimit.resetsAt);
        if (session.engine === "claude") recordClaudeRateLimit(retryRateLimit.resetsAt);
        logger.info(`Session ${session.id} still rate limited (attempt ${attempt})`);

        const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
        if (next.resumeAt) {
          unstatedAttempts = 0;
          nextDelayMs = next.delayMs;
        } else {
          unstatedAttempts++;
          nextDelayMs = nextUnstatedParkDelayMs(nextDelayMs);
        }

        const waitingAgain = updateSessionForAttempt(session.id, attemptToken, {
          ...(retryResult.sessionId?.trim() ? nextEngineSessionFields(currentSession, currentSession.engine, retryResult.sessionId) : {}),
          status: "waiting",
          lastActivity: new Date().toISOString(),
          lastError: next.resumeAt
            ? `${engineLabel} usage limit — resumes ${next.resumeAt.toISOString()}`
            : `${engineLabel} usage limit — waiting for reset`,
        });
        if (!waitingAgain) {
          await hooks.onCancelled?.();
          return { kind: "cancelled" };
        }

        await hooks.onStillLimited?.({ attempt, resumeAt: next.resumeAt ?? null });
        if (unstatedAttempts >= MAX_UNSTATED_PARK_ATTEMPTS) {
          logger.warn(
            `Session ${session.id} stopping after ${unstatedAttempts} retries against a ${engineLabel} usage limit that never named a reset`,
          );
          break;
        }
        continue;
      }

      // Success (or non-rate-limit error) — hand off to caller for persistence + transport.
      await hooks.onRetrySuccess?.(retryResult);
      logger.info(`Session ${session.id} resumed after usage reset`);
      return { kind: "resumed", result: retryResult };
    }

    // Deadline exhausted, or the unstated-reset park gave up, without recovery.
    await hooks.onTimeout?.();
    logger.warn(`Session ${session.id} exhausted usage limit retries`);
    return { kind: "timeout" };
  } finally {
    clearInterval(heartbeat);
  }
}

async function waitWhileSessionWaiting(sessionId: string, delayMs: number): Promise<boolean> {
  const end = Date.now() + Math.max(0, delayMs);
  while (Date.now() < end) {
    const currentSession = getSession(sessionId);
    if (!currentSession || currentSession.status !== "waiting") return false;
    const sleepMs = Math.min(WAIT_CANCEL_POLL_MS, end - Date.now());
    if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
  }
  const currentSession = getSession(sessionId);
  return !!currentSession && currentSession.status === "waiting";
}
