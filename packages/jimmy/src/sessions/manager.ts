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
  insertMessage,
  updateSession,
} from "./registry.js";
import { buildContext } from "./context.js";
import { SessionQueue } from "./queue.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { loadJobs } from "../cron/jobs.js";
import { setCronJobEnabled, triggerCronJob } from "../cron/scheduler.js";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile } from "../mcp/resolver.js";

export interface RouteOptions {
  employee?: Employee;
  engine?: string;
  model?: string;
  title?: string;
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
      session = updateSession(session.id, {
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: msg.transportMeta ?? null,
        ...(opts.model ? { model: opts.model } : {}),
      }) ?? session;
    }

    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    const attachmentPaths = msg.attachments
      .map((attachment) => attachment.localPath)
      .filter((filePath): filePath is string => !!filePath);

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
      transportMeta: msg.transportMeta ?? null,
      lastActivity: new Date().toISOString(),
    });

    // Resolve MCP config before try block so it's accessible in catch for cleanup
    let mcpConfigPath: string | undefined;

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
      });

      const engineConfig = session.engine === "codex"
        ? this.config.engines.codex
        : this.config.engines.claude;
      if (session.engine === "claude") {
        const mcpConfig = resolveMcpServers(this.config.mcp, employee);
        if (Object.keys(mcpConfig.mcpServers).length > 0) {
          mcpConfigPath = writeMcpConfigFile(mcpConfig, session.id);
        }
      }

      const effortLevel = resolveEffort(engineConfig, session, employee);

      const result = await engine.run({
        prompt: msg.text,
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

      const responseText = result.result?.trim()
        ? result.result
        : result.error || "(No response from engine)";

      const wasInterrupted = result.error?.startsWith("Interrupted");

      insertMessage(session.id, "assistant", responseText);
      if (mcpConfigPath) cleanupMcpConfigFile(session.id);
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
      updateSession(session.id, {
        engineSessionId: result.sessionId,
        status: wasInterrupted ? "idle" : (result.error ? "error" : "idle"),
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: msg.transportMeta ?? null,
        lastActivity: new Date().toISOString(),
        lastError: wasInterrupted ? null : (result.error ?? null),
      });

      logger.info(
        `Session ${session.id} completed in ${result.durationMs ?? 0}ms` +
        (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Session ${session.id} error: ${errMsg}`);

      // Clean up temp MCP config on error
      if (mcpConfigPath) cleanupMcpConfigFile(session.id);

      updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });

      // Clear typing indicator on error
      if (decorateMessages && connector.setTypingStatus) {
        await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
      }

      await connector.replyMessage(target, `Error: ${errMsg}`).catch(() => {});

      if (decorateMessages && capabilities.reactions) {
        await connector.removeReaction(target, "eyes").catch(() => {});
      }
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
        `Model: ${session.model || this.config.engines[session.engine as "claude" | "codex"]?.model || "default"}`,
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
