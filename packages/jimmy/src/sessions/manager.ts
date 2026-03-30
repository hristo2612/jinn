import fs from "node:fs";
import type {
  Connector,
  Employee,
  Engine,
  IncomingMessage,
  JinnConfig,
  Session,
  Target,
} from "../shared/types.js";
import {
  accumulateSessionCost,
  createSession,
  deleteSession,
  getSessionBySessionKey,
  getMessages,
  insertMessage,
  updateSession,
} from "./registry.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel } from "./callbacks.js";
import { buildContext } from "./context.js";
import { SessionQueue } from "./queue.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit, isDeadSessionError } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt, isLikelyNearClaudeUsageLimit, recordClaudeRateLimit } from "../shared/usageAwareness.js";
import { loadJobs } from "../cron/jobs.js";
import { setCronJobEnabled, triggerCronJob } from "../cron/scheduler.js";
import { checkBudget } from "../gateway/budgets.js";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile } from "../mcp/resolver.js";

export interface RouteOptions {
  employee?: Employee;
  engine?: string;
  model?: string;
  title?: string;
}

function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return session;
  if (until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  // Preserve the current engine session ID under its engine key
  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

function mergeTransportMeta(
  existing: Session["transportMeta"],
  incoming: IncomingMessage["transportMeta"],
): Session["transportMeta"] {
  const baseExisting = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? (existing as Record<string, unknown>)
    : {};
  const baseIncoming = (incoming && typeof incoming === "object" && !Array.isArray(incoming))
    ? (incoming as Record<string, unknown>)
    : {};

  const merged: Record<string, unknown> = { ...baseExisting, ...baseIncoming };

  // Preserve Jinn internal keys from being overwritten by transport adapters.
  for (const key of ["engineOverride", "engineSessions", "claudeSyncSince"]) {
    if (baseExisting[key] !== undefined) merged[key] = baseExisting[key];
  }

  return merged as any;
}

export class SessionManager {
  private config: JinnConfig;
  private engines: Map<string, Engine>;
  private connectorNames: string[];
  private queue = new SessionQueue();
  private connectorProvider: () => Map<string, Connector> = () => new Map();

  constructor(
    config: JinnConfig,
    engines: Map<string, Engine>,
    connectorNames: string[] = [],
  ) {
    this.config = config;
    this.engines = engines;
    this.connectorNames = connectorNames;
  }

  updateConfig(config: JinnConfig): void {
    this.config = config;
  }

  setConnectorProvider(provider: () => Map<string, Connector>): void {
    this.connectorProvider = provider;
  }

  getEngine(name: string): Engine | undefined {
    return this.engines.get(name);
  }

  getQueue(): SessionQueue {
    return this.queue;
  }

  async route(msg: IncomingMessage, connector: Connector, opts: RouteOptions = {}): Promise<{ sessionId: string } | void> {
    if (await this.handleCommand(msg, connector)) return;

    let session = getSessionBySessionKey(msg.sessionKey);
    if (!session) {
      session = createSession({
        engine: opts.engine ?? opts.employee?.engine ?? this.config.engines.default,
        source: msg.source,
        sourceRef: msg.sessionKey,
        connector: msg.connector,
        sessionKey: msg.sessionKey,
        replyContext: msg.replyContext,
        messageId: msg.messageId,
        transportMeta: msg.transportMeta,
        employee: opts.employee?.name ?? undefined,
        model: opts.model ?? opts.employee?.model ?? undefined,
        title: opts.title,
        prompt: msg.text,
        portalName: this.config.portal?.portalName,
      });
      logger.info(
        `Created new session ${session.id} for ${msg.sessionKey}` +
        (opts.employee ? ` (employee: ${opts.employee.name})` : ""),
      );
    } else {
      const mergedMeta = mergeTransportMeta(session.transportMeta, msg.transportMeta);
      session = updateSession(session.id, {
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: mergedMeta,
        ...(opts.model ? { model: opts.model } : {}),
      }) ?? session;
    }

    session = maybeRevertEngineOverride(session);

    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    const attachmentPaths = msg.attachments
      .map((attachment) => attachment.localPath)
      .filter((filePath): filePath is string => !!filePath);

    if (session.status === "waiting") {
      const expectedResetAt = getClaudeExpectedResetAt();
      const resumeText = expectedResetAt
        ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : null;
      await connector.replyMessage(
        target,
        `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. I queued this message and will respond automatically.`,
      ).catch(() => {});
    }

    if (session.status === "running" && this.queue.isRunning(msg.sessionKey) && connector.getCapabilities().reactions) {
      await connector.addReaction(target, "clock1").catch(() => {});
    }

    const sessionId = session.id;

    await this.queue.enqueue(msg.sessionKey, () =>
      this.runSession(session!, msg, attachmentPaths, connector, target, opts.employee),
    );

    return { sessionId };
  }

  private async runSession(
    session: Session,
    msg: IncomingMessage,
    attachments: string[],
    connector: Connector,
    target: Target,
    employee?: Employee,
  ): Promise<void> {
    const engine = this.engines.get(session.engine);
    if (!engine) {
      logger.error(`Engine "${session.engine}" not found for session ${session.id}`);
      await connector.replyMessage(target, `Error: engine "${session.engine}" not available.`);
      return;
    }

    insertMessage(session.id, "user", msg.text);

    const capabilities = connector.getCapabilities();
    const decorateMessages = session.source !== "cron";

    if (decorateMessages && capabilities.reactions) {
      await connector.addReaction(target, "eyes").catch(() => {});
    }

    // Set native typing indicator (Slack assistant.threads.setStatus)
    const threadTs = target.thread || target.messageTs;
    if (decorateMessages && connector.setTypingStatus) {
      await connector.setTypingStatus(target.channel, threadTs, "is thinking...").catch(() => {});
    }

    updateSession(session.id, {
      status: "running",
      replyContext: msg.replyContext,
      messageId: msg.messageId ?? null,
      transportMeta: mergeTransportMeta(session.transportMeta, msg.transportMeta),
      lastActivity: new Date().toISOString(),
    });

    // Resolve MCP config before try block so it's accessible in catch for cleanup
    let mcpConfigPath: string | undefined;

    let hierarchy: import("../shared/types.js").OrgHierarchy | undefined;
    try {
      const { scanOrg } = await import("../gateway/org.js");
      const { resolveOrgHierarchy } = await import("../gateway/org-hierarchy.js");
      hierarchy = resolveOrgHierarchy(scanOrg());
    } catch { /* fallback to filesystem scan in context builder */ }

    try {
      const systemPrompt = buildContext({
        source: session.source,
        channel: msg.channel,
        thread: msg.thread,
        user: msg.user,
        employee,
        connectors: this.connectorNames,
        config: this.config,
        sessionId: session.id,
        channelName: (msg.transportMeta?.channelName as string) || undefined,
        hierarchy,
      });

      const engineConfig = session.engine === "codex"
        ? this.config.engines.codex
        : session.engine === "gemini"
          ? this.config.engines.gemini ?? this.config.engines.claude
          : this.config.engines.claude;
      if (session.engine === "claude") {
        const mcpConfig = resolveMcpServers(this.config.mcp, employee);
        if (Object.keys(mcpConfig.mcpServers).length > 0) {
          mcpConfigPath = writeMcpConfigFile(mcpConfig, session.id);
        }
      }

      const effortLevel = resolveEffort(engineConfig, session, employee);

      // If we previously switched to GPT while Claude was rate-limited, inject a sync transcript
      // so Claude can resume with full context when it comes back online.
      const syncSinceIso = (session.transportMeta as any)?.claudeSyncSince;
      let promptToRun = msg.text;
      const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
      const syncRequested = session.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
      if (syncRequested) {
        const sinceMessages = getMessages(session.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        promptToRun =
          `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      }

      // Budget enforcement — check BEFORE engine.run()
      if (session.employee) {
        const budgetConfig = (this.config as any).budgets?.employees as Record<string, number> | undefined;
        if (budgetConfig && session.employee in budgetConfig) {
          const budgetStatus = checkBudget(session.employee, budgetConfig);
          if (budgetStatus === 'paused') {
            logger.warn(`Session ${session.id} blocked: employee "${session.employee}" has exceeded their budget`);
            const pausedMsg = `Budget limit exceeded for employee "${session.employee}". Session blocked.`;
            updateSession(session.id, {
              status: 'error',
              lastActivity: new Date().toISOString(),
              lastError: pausedMsg,
            });
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, '').catch(() => {});
            }
            await connector.replyMessage(target, `⛔ ${pausedMsg}`).catch(() => {});
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, 'eyes').catch(() => {});
            }
            return;
          }
        }
      }

      // Heuristic preflight warning: Claude usage limits don't expose a precise "remaining" budget.
      // If we've hit the limit recently and this looks like a heavy turn, warn before we spend time.
      if (decorateMessages && session.engine === "claude" && isLikelyNearClaudeUsageLimit()) {
        const modelName = (session.model ?? engineConfig.model ?? "").toLowerCase();
        const heavyEffort = ["high", "xhigh", "max"].includes((effortLevel || "").toLowerCase());
        const heavyModel = modelName.includes("opus");
        const looksBig = attachments.length > 0 || msg.text.length > 6000;
        if ((heavyEffort || heavyModel) && looksBig) {
          const expectedResetAt = getClaudeExpectedResetAt();
          const resumeText = expectedResetAt
            ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
            : null;
          await connector.replyMessage(
            target,
            `⚠️ Heads up: Claude usage limits were hit recently, and this looks like a bigger task. If you're near the limit, it may pause${resumeText ? ` until ~${resumeText}` : ""}.`,
          ).catch(() => {});
        }
      }

      const result = await engine.run({
        prompt: promptToRun,
        resumeSessionId: session.engineSessionId ?? undefined,
        systemPrompt,
        cwd: JINN_HOME,
        bin: engineConfig.bin,
        model: session.model ?? engineConfig.model,
        effortLevel,
        cliFlags: employee?.cliFlags,
        mcpConfigPath,
        attachments: attachments.length > 0 ? attachments : undefined,
        sessionId: session.id,
      });

      const wasInterrupted = result.error?.startsWith("Interrupted");

      // Dead session detection: if the engine session ID is stale (expired/invalid),
      // clear cached engine sessions from transportMeta so the next attempt starts fresh.
      // Also sets a flag so we skip the rate-limit retry loop below (a dead session
      // error can contain text like "429" that would otherwise match RATE_LIMIT_ERROR_RE).
      const isDead = !wasInterrupted && isDeadSessionError(result);
      if (isDead) {
        logger.warn(`Dead session detected for ${session.id} — clearing stale engine IDs`);
        const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
        delete meta["engineSessions"];
        delete meta["engineOverride"];
        updateSession(session.id, {
          engineSessionId: null,
          transportMeta: meta as any,
        });
        // Update local reference so subsequent code doesn't re-read stale IDs
        session = { ...session, engineSessionId: null, transportMeta: meta as any };
      }

      // Detect rate limit / usage limit errors and auto-retry.
      // Skip entirely for dead sessions — they are not rate limits.
      const rateLimit = (!wasInterrupted && !isDead) ? detectRateLimit(result) : { limited: false as const };
      if (rateLimit.limited) {
        recordClaudeRateLimit(rateLimit.resetsAt);

        const strategy = this.config.sessions?.rateLimitStrategy ?? "fallback";

        // Optional fallback: switch to GPT (Codex) while Claude resets
        if (session.engine === "claude" && strategy === "fallback") {
          const fallbackName = this.config.sessions?.fallbackEngine ?? "codex";
          const fallbackEngine = this.engines.get(fallbackName);
          if (fallbackEngine) {
            const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
            const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
            const syncSince = new Date().toISOString();
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;

            notifyDiscordChannel(
              `⚠️ Claude usage limit reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} switching to GPT.`,
            );

            await connector.replyMessage(
              target,
              `⚠️ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to GPT for now.`,
            ).catch(() => {});

            const nextMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
            const engineSessionsRaw = nextMeta.engineSessions;
            const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
              ? { ...(engineSessionsRaw as Record<string, unknown>) }
              : {};
            if (session.engineSessionId) {
              engineSessions.claude = session.engineSessionId;
            }
            nextMeta.engineSessions = engineSessions;
            nextMeta.engineOverride = { originalEngine: "claude", originalEngineSessionId: session.engineSessionId, until: until.toISOString(), syncSince };

            updateSession(session.id, {
              engine: fallbackName,
              // Keep Claude engine_session_id intact for later restore; Codex will return its own thread id.
              transportMeta: nextMeta as any,
              status: "running",
              lastActivity: new Date().toISOString(),
              lastError: resumeAt
                ? `Claude usage limit — using GPT until ${resumeAt.toISOString()}`
                : "Claude usage limit — using GPT temporarily",
            });

            const fallbackConfig = this.config.engines.codex;
            const fallbackEffort = resolveEffort(fallbackConfig, session, employee);
            const codexResume = typeof engineSessions.codex === "string" ? (engineSessions.codex as string) : undefined;
            const history = getMessages(session.id)
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
            const historyText = history.slice(-12).join("\n\n");
            const fallbackPrompt = codexResume
              ? msg.text
              : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;
            const fallbackResult = await fallbackEngine.run({
              prompt: fallbackPrompt,
              resumeSessionId: codexResume,
              systemPrompt,
              cwd: JINN_HOME,
              bin: fallbackConfig.bin,
              model: session.model ?? fallbackConfig.model,
              effortLevel: fallbackEffort,
              cliFlags: employee?.cliFlags,
              attachments: attachments.length > 0 ? attachments : undefined,
              sessionId: session.id,
            });

            const fallbackText = fallbackResult.result?.trim()
              ? fallbackResult.result
              : fallbackResult.error || "(No response from engine)";

            insertMessage(session.id, "assistant", fallbackText);
            if (fallbackResult.cost || fallbackResult.numTurns) {
              accumulateSessionCost(session.id, fallbackResult.cost ?? 0, fallbackResult.numTurns ?? 1);
            }

            // Persist Codex thread id so future fallbacks can resume it
            const nextEngineSessions = { ...engineSessions };
            if (fallbackResult.sessionId) {
              nextEngineSessions.codex = fallbackResult.sessionId;
            }
            const metaAfter = { ...(getSessionBySessionKey(msg.sessionKey)?.transportMeta || nextMeta) } as Record<string, unknown>;
            metaAfter.engineSessions = nextEngineSessions;
            updateSession(session.id, { transportMeta: metaAfter as any });

            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
            }
            await connector.replyMessage(target, fallbackText).catch(() => {});
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, "eyes").catch(() => {});
            }

            const updated = updateSession(session.id, {
              engineSessionId: fallbackResult.sessionId,
              status: fallbackResult.error ? "error" : "idle",
              replyContext: msg.replyContext,
              messageId: msg.messageId ?? null,
              transportMeta: mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta),
              lastActivity: new Date().toISOString(),
              lastError: fallbackResult.error ?? null,
            });
            if (updated) {
              notifyParentSession(updated, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            }
            return;
          }
        }

        const waitEmoji = "hourglass_flowing_sand";

        const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
        const deadlineMs = computeRateLimitDeadlineMs(
          rateLimit.resetsAt,
          rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
        );

        const resumeText = resumeAt
          ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
          : null;

        logger.info(
          `Session ${session.id} hit Claude usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
        );

        // Send hardcoded Discord notification — does not depend on LLM
        notifyDiscordChannel(
          `⚠️ Claude usage limit reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
        );

        // Clear "thinking" UI and show waiting state
        if (decorateMessages && connector.setTypingStatus) {
          await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
        }
        if (decorateMessages && capabilities.reactions) {
          await connector.removeReaction(target, "eyes").catch(() => {});
          await connector.addReaction(target, waitEmoji).catch(() => {});
        }

        const waitingSession = updateSession(session.id, {
          ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
          status: "waiting",
          lastActivity: new Date().toISOString(),
          lastError: resumeAt
            ? `Claude usage limit — resumes ${resumeAt.toISOString()}`
            : "Claude usage limit — waiting for reset",
        }) ?? session;

        notifyRateLimited(
          waitingSession,
          resumeAt
            ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : undefined,
        );

        await connector.replyMessage(
          target,
          `⏳ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`,
        ).catch(() => {});

        // Keep lastActivity fresh while waiting (UI / status endpoints)
        const heartbeat = setInterval(() => {
          updateSession(session.id, { status: "waiting", lastActivity: new Date().toISOString() });
        }, 60_000);

        try {
          let attempt = 0;
          let nextDelayMs = delayMs;

          while (Date.now() < deadlineMs) {
            await new Promise(r => setTimeout(r, nextDelayMs));
            attempt++;

            // Check if session was stopped while waiting
            const currentSession = getSessionBySessionKey(msg.sessionKey);
            if (!currentSession || currentSession.status === "error") {
              logger.info(`Session ${session.id} stopped while waiting for usage reset`);
              return;
            }

            // Show active processing again
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "is thinking...").catch(() => {});
            }
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, waitEmoji).catch(() => {});
              await connector.addReaction(target, "eyes").catch(() => {});
            }

            logger.info(`Session ${session.id} retrying after usage limit (attempt ${attempt})`);
            const retryResult = await engine.run({
              prompt: msg.text,
              resumeSessionId: currentSession.engineSessionId ?? undefined,
              systemPrompt,
              cwd: JINN_HOME,
              bin: engineConfig.bin,
              model: currentSession.model ?? engineConfig.model,
              effortLevel,
              cliFlags: employee?.cliFlags,
              mcpConfigPath,
              attachments: attachments.length > 0 ? attachments : undefined,
              sessionId: session.id,
            });

            const retryInterrupted = retryResult.error?.startsWith("Interrupted");
            const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };
            if (retryRateLimit.limited) {
              recordClaudeRateLimit(retryRateLimit.resetsAt);
              logger.info(`Session ${session.id} still rate limited (attempt ${attempt})`);

              const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
              nextDelayMs = next.delayMs;

              // Return to waiting UI state
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.addReaction(target, waitEmoji).catch(() => {});
              }

              updateSession(session.id, {
                ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
                status: "waiting",
                lastActivity: new Date().toISOString(),
                lastError: next.resumeAt
                  ? `Claude usage limit — resumes ${next.resumeAt.toISOString()}`
                  : "Claude usage limit — waiting for reset",
              });

              continue;
            }

            // Success or different error — handle normally
            const retryText = retryResult.result?.trim()
              ? retryResult.result
              : retryResult.error || "(No response from engine)";

            insertMessage(session.id, "assistant", retryText);
            if (retryResult.cost || retryResult.numTurns) {
              accumulateSessionCost(session.id, retryResult.cost ?? 0, retryResult.numTurns ?? 1);
            }

            // Clear typing indicator & reactions
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
            }
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, "eyes").catch(() => {});
              await connector.removeReaction(target, waitEmoji).catch(() => {});
            }

            await connector.replyMessage(target, retryText).catch(() => {});
            const retryUpdated = updateSession(session.id, {
              ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
              status: retryResult.error ? "error" : "idle",
              replyContext: msg.replyContext,
              messageId: msg.messageId ?? null,
              transportMeta: msg.transportMeta ?? null,
              lastActivity: new Date().toISOString(),
              lastError: retryResult.error ?? null,
            });
            if (retryUpdated) {
              notifyRateLimitResumed(retryUpdated);
              notifyDiscordChannel(
                `✅ Claude usage limit cleared. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} resumed.`,
              );
              notifyParentSession(retryUpdated, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            }
            logger.info(`Session ${session.id} resumed after usage reset`);
            return;
          }

          // Exhausted waiting window
          notifyDiscordChannel(
            `❌ Claude usage limit did not clear in time. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} has been stopped.`,
          );
          await connector.replyMessage(target, "Usage limit didn't reset in time. Please try again later.").catch(() => {});
          updateSession(session.id, {
            status: "error",
            lastActivity: new Date().toISOString(),
            lastError: "Claude usage limit did not clear in time",
          });

          // Clear reactions on failure
          if (decorateMessages && capabilities.reactions) {
            await connector.removeReaction(target, "eyes").catch(() => {});
            await connector.removeReaction(target, waitEmoji).catch(() => {});
          }
          return;
        } finally {
          clearInterval(heartbeat);
        }
      }

      const responseText = result.result?.trim()
        ? result.result
        : result.error || "(No response from engine)";

      insertMessage(session.id, "assistant", responseText);
      if (result.cost || result.numTurns) {
        accumulateSessionCost(session.id, result.cost ?? 0, result.numTurns ?? 1);
      }
      if (decorateMessages && connector.setTypingStatus) {
        await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
      }
      if (!wasInterrupted) {
        await connector.replyMessage(target, responseText);
      }
      if (decorateMessages && capabilities.reactions) {
        await connector.removeReaction(target, "eyes").catch(() => {});
      }
      const updatedSession = updateSession(session.id, {
        ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
        status: wasInterrupted ? "idle" : (result.error ? "error" : "idle"),
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: (() => {
          const merged = mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta) as Record<string, unknown>;
          if (syncRequested && !rateLimit.limited && !wasInterrupted) {
            delete merged["claudeSyncSince"];
          }
          return merged as any;
        })(),
        lastActivity: new Date().toISOString(),
        lastError: wasInterrupted ? null : (result.error ?? null),
      });
      if (updatedSession) {
        notifyParentSession(updatedSession, { result: result.result, error: wasInterrupted ? null : (result.error ?? null), cost: result.cost, durationMs: result.durationMs }, { alwaysNotify: employee?.alwaysNotify });
      }

      logger.info(
        `Session ${session.id} completed in ${result.durationMs ?? 0}ms` +
        (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Session ${session.id} error: ${errMsg}`);

      const erroredSession = updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      if (erroredSession) {
        notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
      }

      // Clear typing indicator on error
      if (decorateMessages && connector.setTypingStatus) {
        await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
      }

      await connector.replyMessage(target, `Error: ${errMsg}`).catch(() => {});

      if (decorateMessages && capabilities.reactions) {
        await connector.removeReaction(target, "eyes").catch(() => {});
        await connector.removeReaction(target, "hourglass_flowing_sand").catch(() => {});
      }
    } finally {
      // Clean up temp attachment files downloaded from Slack
      for (const filePath of attachments) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // Ignore cleanup errors — best effort
        }
      }

      if (mcpConfigPath) cleanupMcpConfigFile(session.id);
    }
  }

  async handleCommand(msg: IncomingMessage, connector: Connector): Promise<boolean> {
    const text = msg.text.trim();
    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    if (text === "/new" || text.startsWith("/new ")) {
      this.resetSession(msg.sessionKey);
      await connector.replyMessage(target, "Session reset. Starting fresh.");
      logger.info(`Session reset for ${msg.sessionKey}`);
      return true;
    }

    if (text === "/status" || text.startsWith("/status ")) {
      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      const queueDepth = this.queue.getPendingCount(session.sessionKey);
      const transportState = this.queue.getTransportState(session.sessionKey, session.status);
      const info = [
        `Session: ${session.id}`,
        `Engine: ${session.engine}`,
        `Connector: ${session.connector || session.source}`,
        `Model: ${session.model || this.config.engines[session.engine as "claude" | "codex" | "gemini"]?.model || "default"}`,
        `State: ${transportState}`,
        `Queue depth: ${queueDepth}`,
        `Created: ${session.createdAt}`,
        `Last activity: ${session.lastActivity}`,
        session.lastError ? `Last error: ${session.lastError}` : null,
      ].filter(Boolean).join("\n");

      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/model")) {
      const nextModel = text.slice("/model".length).trim();
      if (!nextModel) {
        await connector.replyMessage(target, "Usage: /model <model-name>");
        return true;
      }

      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      updateSession(session.id, {
        model: nextModel,
        lastActivity: new Date().toISOString(),
      });
      await connector.replyMessage(target, `Model updated to \`${nextModel}\` for this session.`);
      return true;
    }

    if (text === "/doctor" || text.startsWith("/doctor ")) {
      const connectors = Array.from(this.connectorProvider().values());
      const connectorLines = connectors.length > 0
        ? connectors.map((candidate) => {
            const health = candidate.getHealth();
            return `- ${candidate.name}: ${health.status}${health.detail ? ` (${health.detail})` : ""}`;
          })
        : ["- none"];
      const info = [
        `Default engine: ${this.config.engines.default}`,
        `Claude: ${this.config.engines.claude.model}`,
        `Codex: ${this.config.engines.codex.model}`,
        ...(this.config.engines.gemini ? [`Gemini: ${this.config.engines.gemini.model}`] : []),
        "Connectors:",
        ...connectorLines,
      ].join("\n");
      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/cron")) {
      return this.handleCronCommand(text, connector, target);
    }

    return false;
  }

  resetSession(sessionKey: string): void {
    const session = getSessionBySessionKey(sessionKey);
    if (session) {
      deleteSession(session.id);
      logger.info(`Deleted session ${session.id}`);
    }
  }

  private async handleCronCommand(text: string, connector: Connector, target: Target): Promise<boolean> {
    const [_, subcommand = "", ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();

    if (!subcommand || subcommand === "list") {
      const jobs = loadJobs();
      if (jobs.length === 0) {
        await connector.replyMessage(target, "No cron jobs configured.");
        return true;
      }

      const lines = jobs.map((job) =>
        `- ${job.name} (${job.id}) — ${job.enabled ? "enabled" : "disabled"} — ${job.schedule}`,
      );
      await connector.replyMessage(target, ["Cron jobs:", ...lines].join("\n"));
      return true;
    }

    if (subcommand === "run") {
      if (!arg) {
        await connector.replyMessage(target, "Usage: /cron run <job-id-or-name>");
        return true;
      }
      const job = await triggerCronJob(arg);
      await connector.replyMessage(
        target,
        job ? `Triggered cron job "${job.name}".` : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      if (!arg) {
        await connector.replyMessage(target, `Usage: /cron ${subcommand} <job-id-or-name>`);
        return true;
      }
      const job = setCronJobEnabled(arg, subcommand === "enable");
      await connector.replyMessage(
        target,
        job
          ? `Cron job "${job.name}" ${job.enabled ? "enabled" : "disabled"}.`
          : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    await connector.replyMessage(target, "Usage: /cron [list|run|enable|disable] <job-id-or-name>");
    return true;
  }
}
