import fs from "node:fs";
import type {
  Connector,
  Employee,
  Engine,
  IncomingMessage,
  JinnConfig,
  Session,
  Target, WorkflowAttemptCommand, WorkflowAttemptCompletion, WorkflowAttemptCompletionListener,
} from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { removeCodexSessionHome } from "../engines/codex.js";
import { ptySnapshotStore } from "../engines/pty-snapshot.js";
import { buildPlatformContextRefresh, fingerprintPlatformContext } from "../engines/platform-context.js";
import {
  accumulateSessionCost, createSession, getOrCreateWorkflowAttemptSession,
  deleteSession,
  clearEngineSessionRefs,
  getEngineSessionRef,
  getSession,
  getSessionBySessionKey,
  getMessages,
  insertMessage,
  insertMessageAfter,
  getPartialMessages,
  settlePartialMessages,
  deletePartialMessages,
  recordEngineSessionId,
  updateSession,
  beginSessionAttempt, completeSessionAttempt, claimWorkflowAttemptDispatch, cancelWorkflowAttemptDispatch,
  listPendingWorkflowAttemptDispatches, interruptSessionAttempt,
  listChildSessions,
  updateSessionForAttempt,
} from "./registry.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel } from "./callbacks.js";
import { buildContext, buildPlatformContextSnapshot, type BuildContextOptions } from "./context.js";
import { SessionQueue } from "./queue.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { effortLevelsForModel, engineAvailable, isKnownEngine, engineUnavailableMessage, contextWindowForModel } from "../shared/models.js";
import { assessContextCeiling, reportContextCeiling } from "../shared/context-ceiling.js";
import { detectRateLimit, isDeadSessionError, rateLimitEngineLabel } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt, isLikelyNearClaudeUsageLimit } from "../shared/usageAwareness.js";
import { loadJobs } from "../cron/jobs.js";
import { setCronJobEnabled, triggerCronJob } from "../cron/scheduler.js";
import { checkBudget } from "../gateway/budgets.js";
import { markTranscriptSyncedThrough } from "../gateway/external-turns.js";
import { handleRateLimit } from "./rate-limit-handler.js";
import { resolveEngineRunMcp } from "./engine-run-mcp.js";
import { reconcileWorkItem } from "../work-items/reconcile.js";
import {
  createPartialStreamWriter,
  normalizeBlockDeltaForTurn,
  type PartialStreamWriter,
} from "./partial-stream.js";
import { completedStreamedBlockIds } from "../gateway/streamed-blocks.js";
import {
  isDurableWorkflowUserMessageInterruption,
  workflowAttemptInterruptionCause,
} from "./workflow-interruptions.js";

export interface RouteOptions {
  employee?: Employee;
  engine?: string;
  model?: string;
  effortLevel?: string;
  title?: string;
}

const WORKFLOW_CAPABILITIES = { threading: false, messageEdits: false, reactions: false, attachments: false };
const WORKFLOW_CONNECTOR: Connector = { name: "workflow", async start() {}, async stop() {}, getCapabilities: () => WORKFLOW_CAPABILITIES, getHealth: () => ({ status: "running", capabilities: WORKFLOW_CAPABILITIES }), reconstructTarget: () => ({ channel: "workflow" }), async sendMessage() {}, async replyMessage() {}, async addReaction() {}, async removeReaction() {}, async editMessage() {}, onMessage() {} };
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

export function mergeTransportMeta(
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
  for (const key of [
    "engineOverride",
    "engineSessions",
    "claudeSyncSince",
    "engineSyncTarget",
    "engineSyncSince",
    "transcriptSyncedThrough",
    "delegationCompletionTracked",
    "delegationCompletionContract",
  ]) {
    if (baseExisting[key] !== undefined) merged[key] = baseExisting[key];
  }

  return merged as any;
}

export class SessionManager {
  private config: JinnConfig;
  private engines: Map<string, Engine>;
  private connectorNames: string[];
  private gatewayBootId: string;
  private queue = new SessionQueue();
  private connectorProvider: () => Map<string, Connector> = () => new Map();
  private workflowAttemptCompletionListeners = new Set<WorkflowAttemptCompletionListener>();
  private emittedWorkflowAttemptCompletions = new Set<string>();

  constructor(
    config: JinnConfig,
    engines: Map<string, Engine>,
    connectorNames: string[] = [],
    gatewayBootId = "",
    private readonly employeeProvider: (id: string) => Employee | undefined = () => undefined,
  ) {
    this.config = config;
    this.engines = engines;
    this.connectorNames = connectorNames;
    this.gatewayBootId = gatewayBootId;
    this.recoverWorkflowAttemptDispatches();
  }

  private recoverWorkflowAttemptDispatches(): void {
    for (const item of listPendingWorkflowAttemptDispatches()) { const session = getSession(item.sessionId); const employee = session?.employee ? this.employeeProvider(session.employee) : undefined;
      if (session && employee) { const claim = claimWorkflowAttemptDispatch(session.id, session.sessionKey, item.prompt); if (claim) this.enqueueWorkflowAttempt(session, item.prompt, employee, claim); } }
  }
  setConnectorProvider(provider: () => Map<string, Connector>): void {
    this.connectorProvider = provider;
  }

  setConfig(config: JinnConfig): void {
    this.config = config;
  }

  getEngine(name: string): Engine | undefined {
    return this.engines.get(name);
  }

  getEngines(): Map<string, Engine> {
    return this.engines;
  }

  getQueue(): SessionQueue {
    return this.queue;
  }

  subscribeWorkflowAttemptCompletion(listener: WorkflowAttemptCompletionListener): () => void {
    this.workflowAttemptCompletionListeners.add(listener); let active = true; return () => { if (!active) return; active = false; this.workflowAttemptCompletionListeners.delete(listener); };
  }
  async runWorkflowAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    const employee = this.employeeProvider(command.employeeId); if (!employee) throw new Error(`Workflow employee "${command.employeeId}" is not available.`);
    const key = `workflow:${command.owner.workflowId}:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`;
    const session = getOrCreateWorkflowAttemptSession({ engine: command.engine, source: "workflow", sourceRef: key, connector: "workflow", sessionKey: key, employee: command.employeeId, model: command.model,
      effortLevel: command.effort, prompt: command.prompt, workflowProvenance: { kind: "phase", workflowId: command.owner.workflowId, workflowName: command.owner.workflowId,
        runId: command.owner.runId, triggerSource: "workflow", phase: { nodeId: command.owner.nodeId, name: command.owner.nodeId, index: 1, round: 1, attempt: command.owner.attempt } } });
    const claim = claimWorkflowAttemptDispatch(session.id, session.sessionKey, command.prompt); if (claim) this.enqueueWorkflowAttempt(session, command.prompt, employee, claim);
    return { sessionId: session.id };
  }
  private enqueueWorkflowAttempt(session: Session, prompt: string, employee: Employee, claim: string): void {
    const msg: IncomingMessage = { connector: "workflow", source: "workflow", sessionKey: session.sessionKey, replyContext: {}, channel: session.id, user: "workflow", userId: "workflow", text: prompt, attachments: [], raw: null };
    setImmediate(() => { void this.queue.enqueue(session.sessionKey, async () => { await this.runSession(session, msg, [], WORKFLOW_CONNECTOR, { channel: session.id }, employee);
      this.emitWorkflowAttemptTurnCompletion(session.id); }, claim).catch((error) => logger.error(`Workflow session ${session.id} dispatch failed: ${String(error)}`)); });
  }
  async remindWorkflowAttempt(sessionId: string, text: string): Promise<void> {
    const session = getSession(sessionId);
    if (!session || session.workflowProvenance?.kind !== "phase" || !session.employee) {
      throw new Error(`Workflow attempt session "${sessionId}" is not available.`);
    }
    const employee = this.employeeProvider(session.employee);
    if (!employee) throw new Error(`Workflow employee "${session.employee}" is not available.`);
    const claim = claimWorkflowAttemptDispatch(session.id, session.sessionKey, text);
    if (!claim) throw new Error(`Workflow attempt session "${sessionId}" is not idle.`);
    this.enqueueWorkflowAttempt(session, text, employee, claim);
  }
  workflowAttemptState(sessionId: string): { idle: boolean; runningChildren: number } | null {
    const session = getSession(sessionId);
    if (!session || session.workflowProvenance?.kind !== "phase") return null;
    const idle = session.status === "idle"
      && !this.queue.isRunning(session.sessionKey)
      && this.queue.getPendingCount(session.sessionKey) === 0;
    const runningChildren = listChildSessions(sessionId).filter((child) => {
      const transport = this.queue.getTransportState(child.sessionKey, child.status);
      return child.status === "running" || transport === "running" || transport === "queued";
    }).length;
    return { idle, runningChildren };
  }
  async stopWorkflowAttempt(input: { sessionId: string; reason: string }): Promise<void> {
    const session = getSession(input.sessionId); if (!session || session.workflowProvenance?.kind !== "phase") return;
    const stopped = interruptSessionAttempt(session.id, input.reason, new Date().toISOString()); if (!stopped) return; cancelWorkflowAttemptDispatch(stopped.id);
    this.queue.clearQueue(stopped.sessionKey); const engine = this.engines.get(stopped.engine);
    if (engine && isInterruptibleEngine(engine)) engine.kill(stopped.id, input.reason); this.emitWorkflowAttemptCompletion(stopped, "attempt-stop");
  }
  emitWorkflowAttemptTurnCompletion(sessionId: string): void {
    this.emitWorkflowAttemptCompletion(getSession(sessionId));
  }
  private emitWorkflowAttemptCompletion(
    session?: Session,
    interruptionCause?: import("../shared/types.js").WorkflowAttemptInterruptionCause,
  ): void {
    const provenance = session?.workflowProvenance; if (!session?.attemptOutcome || provenance?.kind !== "phase" || !provenance.phase) return; const terminalVersion = session.attemptTerminalVersion ?? 0;
    const turn = session.attemptTurn ?? 0; const key = `${session.id}:${turn}`;
    if (terminalVersion < 1 || turn < 1 || this.emittedWorkflowAttemptCompletions.has(key)) return;
    const finalText = [...getMessages(session.id)].reverse().find((message) => message.role === "assistant")?.content;
    const event: WorkflowAttemptCompletion = { sessionId: session.id, owner: { workflowId: provenance.workflowId, runId: provenance.runId, nodeId: provenance.phase.nodeId,
      attempt: provenance.phase.attempt }, turn, terminalVersion: 1, outcome: session.attemptOutcome, completedAt: session.lastActivity,
      ...(session.attemptOutcome === "interrupted" ? {
        interruptionCause: interruptionCause
          ?? workflowAttemptInterruptionCause(session.lastError, session, turn),
      } : {}),
      ...(finalText ? { finalText } : {}), ...(session.lastError ? { error: session.lastError } : {}) };
    this.emittedWorkflowAttemptCompletions.add(key); for (const listener of this.workflowAttemptCompletionListeners)
      void Promise.resolve().then(() => listener(event)).catch((error) => logger.warn(`Workflow completion listener failed: ${String(error)}`));
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
        effortLevel: opts.effortLevel ?? opts.employee?.effortLevel ?? undefined,
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
        ...(opts.effortLevel ? { effortLevel: opts.effortLevel } : {}),
      }) ?? session;
    }

    session = maybeRevertEngineOverride(session);
    this.queue.clearCancelled(msg.sessionKey);

    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    const attachmentPaths = msg.attachments
      .map((attachment) => attachment.localPath)
      .filter((filePath): filePath is string => !!filePath);

    if (session.status === "waiting") {
      // A new user message on a rate-limit-paused session is an explicit "retry
      // now" (e.g. the user cleared the limit provider-side). handleRateLimit's
      // wait loop is sleeping until the engine's own reported resetsAt while
      // holding this session's serial queue slot, so queueing behind it would
      // park the message on a now-stale reset and keep replying "still limited".
      // Flip out of `waiting` so that loop unwinds as cancelled and frees the
      // queue; the enqueue below then runs immediately on the now-available engine.
      session = updateSession(session.id, {
        status: "idle",
        lastActivity: new Date().toISOString(),
        lastError: null,
      }) ?? session;
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
    const liveSession = getSession(session.id);
    if (!liveSession) {
      logger.warn(`Skipping queued turn for deleted session ${session.id}`);
      return;
    }
    session = liveSession;

    const engine = this.engines.get(session.engine);
    if (!engine) {
      logger.error(`Engine "${session.engine}" not found for session ${session.id}`);
      await connector.replyMessage(target, `Error: engine "${session.engine}" not available.`);
      return;
    }

    insertMessage(session.id, "user", msg.text);

    // Pre-flight: fail fast with an actionable error if the engine's CLI binary
    // isn't installed. Otherwise the (interactive PTY) engine spawns a missing
    // command, exits silently, and the turn produces no output and no error.
    if (isKnownEngine(session.engine) && !engineAvailable(this.config, session.engine)) {
      const errMsg = engineUnavailableMessage(this.config, session.engine);
      logger.error(`Session ${session.id} blocked: ${errMsg}`);
      const erroredSession = updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      insertMessage(session.id, "assistant", `⛔ ${errMsg}`);
      await connector.replyMessage(target, `⛔ ${errMsg}`).catch(() => {});
      // Wake the parent COO if this was a delegated child session (parity with
      // the normal error path; no-op for top-level sessions).
      if (erroredSession) {
        notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
      }
      return;
    }

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

    // Resolve MCP config before try block so it's accessible in catch for cleanup
    let mcpConfigPath: string | undefined;
    let resolvedMcp: import("../shared/types.js").ResolvedMcpConfig | undefined;
    let partialStream: PartialStreamWriter | undefined;

    let hierarchy: import("../shared/types.js").OrgHierarchy | undefined;
    try {
      const { scanOrg } = await import("../gateway/org.js");
      const { resolveOrgHierarchy } = await import("../gateway/org-hierarchy.js");
      hierarchy = resolveOrgHierarchy(scanOrg());
    } catch { /* fallback to filesystem scan in context builder */ }

    let engineAtTurnStart = session.engine;
    let attemptToken = "";
    try {
      engineAtTurnStart = session.engine;
      const resumeRefAtTurnStart = getEngineSessionRef(session, engineAtTurnStart);
      ({ mcpConfigPath, resolvedMcp } = resolveEngineRunMcp({
        config: this.config,
        employee,
        engine: session.engine,
        sessionId: session.id,
        workflowAttempt: session.workflowProvenance?.kind === "phase",
      }));

      // Per-engine config keyed by engine name; unconfigured optional engines
      // resolve to {} (engine falls back to dynamic bin/model resolution).
      const engineConfig =
        (this.config.engines as unknown as Record<string, { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string } | undefined>)[
          session.engine
        ] ?? {};

      const effortLevel = session.workflowProvenance?.kind === "phase" ? session.effortLevel ?? undefined
        : resolveEffort(engineConfig, session, employee, effortLevelsForModel(this.config, session.engine, session.model ?? undefined));
      const modelForTurn = session.model ?? engineConfig.model;
      const contextOptions: BuildContextOptions = {
        source: session.source,
        channel: msg.channel,
        thread: msg.thread,
        user: msg.user,
        employee,
        engine: session.engine,
        connectors: this.connectorNames,
        config: this.config,
        gatewayBootId: this.gatewayBootId,
        sessionId: session.id,
        model: modelForTurn,
        effortLevel,
        channelName: (msg.transportMeta?.channelName as string) || undefined,
        hierarchy,
        // The diet keys off the built-in jinn server specifically — custom MCP
        // servers don't carry the company tools.
        jinnMcpAttached: Boolean(resolvedMcp?.mcpServers?.["jinn"]),
      };
      const platformContext = buildPlatformContextSnapshot(contextOptions);
      const platformContextFingerprint = fingerprintPlatformContext(platformContext);
      const platformContextRefresh = resumeRefAtTurnStart.id
        && resumeRefAtTurnStart.platformContextFingerprint !== platformContextFingerprint
        ? buildPlatformContextRefresh(platformContext)
        : undefined;
      const systemPrompt = buildContext(contextOptions);

      // Mark running only after preflight (system prompt / engine config / effort)
      // succeeded — and inside the try, so any failure transitions to "error" in the
      // catch below instead of leaving the session stuck looking "running".
      const startedAttempt = beginSessionAttempt(session.id, {
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: mergeTransportMeta(session.transportMeta, msg.transportMeta),
        lastActivity: new Date().toISOString(),
      });
      if (!startedAttempt?.attemptToken) return;
      session = startedAttempt;
      attemptToken = startedAttempt.attemptToken;

      // If we previously switched to GPT while Claude was rate-limited, inject a sync transcript
      // so Claude can resume with full context when it comes back online.
      const syncMeta = (session.transportMeta || {}) as Record<string, unknown>;
      const switchSyncTarget = typeof syncMeta.engineSyncTarget === "string" ? syncMeta.engineSyncTarget : null;
      const switchSyncSinceIso = typeof syncMeta.engineSyncSince === "string" ? syncMeta.engineSyncSince : null;
      const switchSyncSinceMs = switchSyncSinceIso ? new Date(switchSyncSinceIso).getTime() : NaN;
      const engineSyncRequested =
        switchSyncTarget === engineAtTurnStart &&
        typeof switchSyncSinceIso === "string" &&
        Number.isFinite(switchSyncSinceMs);
      const syncSinceIso = typeof syncMeta.claudeSyncSince === "string" ? syncMeta.claudeSyncSince : null;
      let promptToRun = msg.text;
      const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
      const claudeSyncRequested = engineAtTurnStart === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
      const syncRequested = engineSyncRequested || claudeSyncRequested;
      if (syncRequested) {
        const sinceMs = engineSyncRequested ? switchSyncSinceMs : syncSinceMs;
        const recentMessages = getMessages(session.id).filter((m) => m.timestamp >= sinceMs);
        const sinceMessages = recentMessages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        const latestMessage = recentMessages.at(-1);
        const currentPromptWasIncluded =
          latestMessage &&
          (latestMessage.role === "user" || latestMessage.role === "assistant") &&
          latestMessage.content === msg.text;
        const currentPrompt = currentPromptWasIncluded || !msg.text.trim()
          ? ""
          : `CURRENT MESSAGE:\n${msg.text}`;
        const intro = engineSyncRequested
          ? `We switched engines in this Jinn session. Sync your context with this transcript (most recent last), then respond to the current message.`
          : `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the current message.`;
        promptToRun =
          [intro, transcript, currentPrompt].filter(Boolean).join("\n\n");
      }

      // Budget enforcement — check BEFORE engine.run()
      if (session.employee) {
        const budgetConfig = (this.config as any).budgets?.employees as Record<string, number> | undefined;
        if (budgetConfig && session.employee in budgetConfig) {
          const budgetStatus = checkBudget(session.employee, budgetConfig);
          if (budgetStatus === 'paused') {
            logger.warn(`Session ${session.id} blocked: employee "${session.employee}" has exceeded their budget`);
            const pausedMsg = `Budget limit exceeded for employee "${session.employee}". Session blocked.`;
            completeSessionAttempt(session.id, attemptToken, {
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

      const turnStartedAt = Date.now();
      let lastStreamHeartbeatAt = 0;
      partialStream = createPartialStreamWriter(session.id);
      const result = await engine.run({
        prompt: promptToRun,
        resumeSessionId: resumeRefAtTurnStart.id ?? undefined,
        systemPrompt,
        platformContextRefresh,
        cwd: JINN_HOME,
        bin: engineConfig.bin,
        model: modelForTurn,
        effortLevel,
        cliFlags: employee?.cliFlags,
        mcpConfigPath,
        resolvedMcp,
        attachments: attachments.length > 0 ? attachments : undefined,
        sessionId: session.id,
        source: session.source,
        onStream: (delta) => {
          if (!getSession(session.id)) return;
          const normalized = normalizeBlockDeltaForTurn(delta, turnStartedAt);
          if (!normalized.ok) {
            logger.warn(`Dropped invalid block delta for session ${session.id}: ${normalized.error}`);
            return;
          }
          const outgoingDelta = normalized.delta;
          if (outgoingDelta.type === "context") {
            const contextTokens = Number(outgoingDelta.content);
            if (Number.isFinite(contextTokens) && contextTokens > 0) {
              updateSessionForAttempt(session.id, attemptToken, {
                lastContextTokens: contextTokens,
              });
            }
          }
          const now = Date.now();
          if (now - lastStreamHeartbeatAt >= 2000) {
            lastStreamHeartbeatAt = now;
            updateSessionForAttempt(session.id, attemptToken, {
              status: "running",
              lastActivity: new Date(now).toISOString(),
            });
          }
          try {
            partialStream?.persist(outgoingDelta);
          } catch (error) {
            logger.warn(`Failed to persist partial block for session ${session.id}: ${
              error instanceof Error ? error.message : String(error)
            }`);
          }
        },
        onLateRecovery: ({ result: lateText, sessionId: engineSid }) => {
          const recovered = updateSessionForAttempt(session.id, attemptToken, {
            status: "idle",
            attemptOutcome: "succeeded",
            lastActivity: new Date().toISOString(),
            lastError: null,
          }, ["error"]);
          if (!recovered || recovered.engine !== engineAtTurnStart) return;
          insertMessage(session.id, "assistant", lateText);
          if (engineSid.trim()) {
            recordEngineSessionId(session.id, engineAtTurnStart, engineSid, {
              model: session.model ?? engineConfig.model,
              effortLevel,
              lastSyncedAt: new Date().toISOString(),
              platformContextFingerprint,
            });
          }
          // The parent/channel already saw this turn fail — label the late answer
          // so it reads as a supersede, not a fresh unprompted turn.
          const labelled = `(recovered — this supersedes the earlier reported failure)\n\n${lateText}`;
          notifyParentSession(recovered, { result: labelled, error: null }, { alwaysNotify: employee?.alwaysNotify });
          void connector.replyMessage(target, labelled).catch(() => {});
          logger.info(`Session ${session.id} recovered by late Stop after a failed turn`);
        },
      }).finally(() => {
        partialStream?.finish();
      });

      const liveAfterRun = getSession(session.id);
      if (!liveAfterRun) {
        deletePartialMessages(session.id);
        logger.warn(`Dropping engine result for deleted session ${session.id}`);
        return;
      }
      if (liveAfterRun.engine !== engineAtTurnStart) {
        deletePartialMessages(session.id);
        logger.info(
          `Dropping stale ${engineAtTurnStart} result for session ${session.id}; session now uses ${liveAfterRun.engine}`,
        );
        return;
      }

      const completionTurn = (liveAfterRun.attemptTurn ?? 0) + 1;
      const wasInterrupted = isDurableWorkflowUserMessageInterruption(liveAfterRun, completionTurn)
        || result.error?.startsWith("Interrupted")
        || liveAfterRun.attemptToken !== attemptToken
        || liveAfterRun.status !== "running";

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
        clearEngineSessionRefs(session.id, engineAtTurnStart);
        updateSession(session.id, {
          transportMeta: meta as any,
        });
        // Update local reference so subsequent code doesn't re-read stale IDs
        session = { ...session, engineSessionId: null, engineSessions: null, transportMeta: meta as any };
      }

      // Detect rate limit / usage limit errors and auto-retry.
      // Skip entirely for dead sessions — they are not rate limits.
      const rateLimit = (!wasInterrupted && !isDead) ? detectRateLimit(result) : { limited: false as const };
      const streamedBlocks = getPartialMessages(session.id);
      const preservedMessageIds = completedStreamedBlockIds({
        quietPreempted: wasInterrupted,
        rateLimited: rateLimit.limited,
        result: result.result,
        error: result.error,
        streamedBlocks,
      });
      settlePartialMessages(session.id, preservedMessageIds);
      const streamedThrough = streamedBlocks.reduce(
        (latest, message) => Math.max(latest, message.timestamp),
        0,
      );
      if (rateLimit.limited) {
        const waitEmoji = "hourglass_flowing_sand";

        const outcome = await handleRateLimit({
          session,
          attemptToken,
          prompt: msg.text,
          systemPrompt,
          platformContextRefresh,
          engineConfig,
          effortLevel,
          cliFlags: employee?.cliFlags,
          mcpConfigPath,
          resolvedMcp,
          attachments,
          config: this.config,
          engines: this.engines,
          employee,
          engine,
          rateLimit,
          originalResult: result,
          hooks: {
            onFallbackStart: async ({ resumeAt }) => {
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

              // Switching away from Claude — drop any warm Claude PTY so it isn't orphaned.
              const claudeEngine = this.engines.get("claude");
              if (claudeEngine && isInterruptibleEngine(claudeEngine)) {
                claudeEngine.kill(session.id, "Interrupted: engine switched");
              }
            },
            onFallbackComplete: async (fallbackResult) => {
              const fallbackText = fallbackResult.result?.trim()
                ? fallbackResult.result
                : fallbackResult.error || "(No response from engine)";

              insertMessage(session.id, "assistant", fallbackText);
              if (fallbackResult.cost || fallbackResult.numTurns) {
                accumulateSessionCost(session.id, fallbackResult.cost ?? 0, fallbackResult.numTurns ?? 1);
              }

              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              await connector.replyMessage(target, fallbackText).catch(() => {});
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
              }

              const fallbackCompletedAt = new Date().toISOString();
              if (fallbackResult.sessionId?.trim()) {
                const fallbackEngineName = getSession(session.id)?.engine ?? session.engine;
                recordEngineSessionId(session.id, fallbackEngineName, fallbackResult.sessionId, {
                  model: session.model ?? engineConfig.model,
                  effortLevel,
                  lastSyncedAt: fallbackCompletedAt,
                });
              }
              const updated = completeSessionAttempt(session.id, attemptToken, {
                ...(typeof fallbackResult.contextTokens === "number" ? { lastContextTokens: fallbackResult.contextTokens } : {}),
                status: fallbackResult.error ? "error" : "idle",
                attemptOutcome: fallbackResult.error ? "failed" : "succeeded",
                replyContext: msg.replyContext,
                messageId: msg.messageId ?? null,
                transportMeta: mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta),
                lastActivity: fallbackCompletedAt,
                lastError: fallbackResult.error ?? null,
              });
              if (updated) {
                notifyParentSession(updated, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
              }
            },
            onWaitingStart: async ({ resumeAt }) => {
              const engineLabel = rateLimitEngineLabel(session.engine);
              const resumeText = resumeAt
                ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
                : null;

              // Send hardcoded Discord notification — does not depend on LLM
              notifyDiscordChannel(
                `⚠️ ${engineLabel} usage limit reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
              );

              // Clear "thinking" UI and show waiting state
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.addReaction(target, waitEmoji).catch(() => {});
              }

              const waitingSession = getSessionBySessionKey(msg.sessionKey) ?? session;
              notifyRateLimited(
                waitingSession,
                resumeAt
                  ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
                  : undefined,
              );

              await connector.replyMessage(
                target,
                `⏳ ${engineLabel} usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`,
              ).catch(() => {});
            },
            onRetryAttempt: async () => {
              // Show active processing again
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "is thinking...").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, waitEmoji).catch(() => {});
                await connector.addReaction(target, "eyes").catch(() => {});
              }
            },
            onStillLimited: async () => {
              // Return to waiting UI state
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.addReaction(target, waitEmoji).catch(() => {});
              }
            },
            onRetrySuccess: async (retryResult) => {
              const engineLabel = rateLimitEngineLabel(session.engine);
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
              const retryCompletedAt = new Date().toISOString();
              if (!retryResult.error && retryResult.sessionId?.trim()) {
                recordEngineSessionId(session.id, engineAtTurnStart, retryResult.sessionId, {
                  model: session.model ?? engineConfig.model,
                  effortLevel,
                  lastSyncedAt: retryCompletedAt,
                  platformContextFingerprint,
                });
              }
              const retryUpdated = completeSessionAttempt(session.id, attemptToken, {
                ...(typeof retryResult.contextTokens === "number" ? { lastContextTokens: retryResult.contextTokens } : {}),
                status: retryResult.error ? "error" : "idle",
                attemptOutcome: retryResult.error ? "failed" : "succeeded",
                replyContext: msg.replyContext,
                messageId: msg.messageId ?? null,
                transportMeta: mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta),
                lastActivity: retryCompletedAt,
                lastError: retryResult.error ?? null,
              });
              if (retryUpdated) {
                notifyRateLimitResumed(retryUpdated);
                notifyDiscordChannel(
                  `✅ ${engineLabel} usage limit cleared. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} resumed.`,
                );
                notifyParentSession(retryUpdated, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
              }
            },
            onTimeout: async () => {
              const engineLabel = rateLimitEngineLabel(session.engine);
              const timeoutError = `${engineLabel} usage limit did not clear in time`;
              notifyDiscordChannel(
                `❌ ${timeoutError}. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} has been stopped.`,
              );
              await connector.replyMessage(target, "Usage limit didn't reset in time. Please try again later.").catch(() => {});
              updateSessionForAttempt(session.id, attemptToken, {
                status: "error",
                lastActivity: new Date().toISOString(),
                lastError: timeoutError,
              }, ["waiting", "running"]);

              // Clear reactions on failure
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.removeReaction(target, waitEmoji).catch(() => {});
              }
            },
          },
        });

        void outcome; // outcome handled entirely via hooks
        return;
      }

      const responseText = result.result?.trim()
        ? result.result
        : result.error || "(No response from engine)";

      if (!wasInterrupted) {
        insertMessageAfter(session.id, "assistant", responseText, streamedThrough);
      }
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
      const completedAt = new Date().toISOString();
      const acceptedNativeId = result.sessionId?.trim() || resumeRefAtTurnStart.id;
      if (!wasInterrupted && !result.error && acceptedNativeId) {
        recordEngineSessionId(session.id, engineAtTurnStart, acceptedNativeId, {
          model: modelForTurn,
          effortLevel,
          lastSyncedAt: completedAt,
          platformContextFingerprint,
        });
      }
      // The highest context a model ever reaches is the ceiling it is actually
      // being allowed. If it never approaches the window the roster declares,
      // the model id we passed is not getting the window we think it is (e.g.
      // Claude's bare `opus` alias caps at 200K where `opus[1m]` gives 1M) and
      // sessions will compaction-thrash. Warns once per model; never throws.
      reportContextCeiling(
        engineAtTurnStart,
        modelForTurn,
        assessContextCeiling({
          engine: engineAtTurnStart,
          model: modelForTurn,
          // `exact`: a model missing from the roster would otherwise report the
          // engine default's window, and comparing one model's context against
          // another's declared window is worse than not checking at all.
          declaredWindow: contextWindowForModel(this.config, engineAtTurnStart, modelForTurn, { exact: true }),
          currentTokens: result.contextTokens,
          userPrompt: msg.text,
        }),
      );
      const updatedSession = completeSessionAttempt(session.id, attemptToken, {
        ...(typeof result.contextTokens === "number" ? { lastContextTokens: result.contextTokens } : {}),
        status: wasInterrupted ? "interrupted" : (result.error ? "error" : "idle"),
        attemptOutcome: wasInterrupted ? "interrupted" : (result.error ? "failed" : "succeeded"),
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: (() => {
          const merged = mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta) as Record<string, unknown>;
          if (syncRequested && !rateLimit.limited && !wasInterrupted) {
            delete merged["claudeSyncSince"];
            delete merged["engineSyncTarget"];
            delete merged["engineSyncSince"];
          }
          return merged as any;
        })(),
        lastActivity: completedAt,
        lastError: wasInterrupted ? (result.error ?? "Interrupted") : (result.error ?? null),
      });
      if (!wasInterrupted && engineAtTurnStart === "claude") {
        markTranscriptSyncedThrough(session.id, result.sessionId);
      }
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
      deletePartialMessages(session.id);

      const live = getSession(session.id);
      if (!live) {
        logger.info(`Skipping error handling for deleted session ${session.id}: ${errMsg}`);
        return;
      }
      if (live.engine !== engineAtTurnStart) {
        logger.info(
          `Dropping stale ${engineAtTurnStart} error for session ${session.id}; session now uses ${live.engine}`,
        );
        return;
      }

      const erroredSession = attemptToken ? completeSessionAttempt(session.id, attemptToken, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      }) : undefined;
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

      // NOTE: neither the interactive engine's per-session --settings file NOR its
      // --mcp-config file is cleaned up here. A warm PTY survives across turns and
      // keeps both paths on its command line for its entire life (a cold respawn on
      // model/effort change re-reads --mcp-config). Their lifetime is owned by
      // PtyLifecycleManager (onCleanup), not the per-turn runSession lifecycle.
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
        `Model: ${session.model || this.config.engines[session.engine as "claude" | "codex" | "antigravity" | "grok" | "pi"]?.model || "default"}`,
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
        ...(this.config.engines.antigravity ? [`Antigravity: ${this.config.engines.antigravity.model ?? "Gemini 3.5 Flash (Medium)"}`] : []),
        ...(this.config.engines.grok ? [`Grok: ${this.config.engines.grok.model ?? "grok-build"}`] : []),
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
      // Tear down any live/warm engine process before deleting or preserving the session.
      for (const engine of this.engines.values()) {
        if (isInterruptibleEngine(engine)) {
          engine.kill(session.id, "Interrupted: session reset");
        }
      }
      this.queue.clearQueue(session.sessionKey || session.sourceRef || session.id);
      ptySnapshotStore.deleteSync(session.id);
      if (session.workItemId) {
        const unresolved = !session.attemptOutcome || session.status === "running" || session.status === "waiting";
        updateSession(session.id, {
          // Detach the retained evidence from the connector thread so /new still
          // creates a fresh conversational session on the next message.
          sessionKey: `archived:${session.id}`,
          ...(unresolved ? {
            status: "interrupted" as const,
            attemptOutcome: "interrupted" as const,
            lastError: "Interrupted: session reset",
          } : {}),
          lastActivity: new Date().toISOString(),
        });
        reconcileWorkItem(session.workItemId);
        logger.info(`Preserved linked session ${session.id} as Todo execution evidence`);
        return;
      }
      deleteSession(session.id);
      // Remove any per-session Codex CODEX_HOME overlay (no-op for non-codex
      // sessions). Safe here because the session is ending — the thread rollout
      // under it is no longer needed. Idempotent.
      removeCodexSessionHome(session.id);
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
