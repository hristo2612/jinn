import type {
  Engine,
  Connector,
  IncomingMessage,
  Session,
  JimmyConfig,
  Employee,
  Target,
} from "../shared/types.js";
import {
  createSession,
  getSessionBySourceRef,
  updateSession,
  deleteSession,
} from "./registry.js";
import { buildContext } from "./context.js";
import { SessionQueue } from "./queue.js";
import { JIMMY_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export class SessionManager {
  private config: JimmyConfig;
  private engines: Map<string, Engine>;
  private connectorNames: string[];
  private queue = new SessionQueue();

  constructor(
    config: JimmyConfig,
    engines: Map<string, Engine>,
    connectorNames: string[] = [],
  ) {
    this.config = config;
    this.engines = engines;
    this.connectorNames = connectorNames;
  }

  /**
   * Get an engine by name.
   */
  getEngine(name: string): Engine | undefined {
    return this.engines.get(name);
  }

  /**
   * Main entry point: route an incoming message to the right session.
   */
  async route(msg: IncomingMessage, connector: Connector, employee?: Employee): Promise<void> {
    // Check for commands first
    if (await this.handleCommand(msg, connector)) return;

    const sourceRef = this.buildSourceRef(msg);
    let session = getSessionBySourceRef(sourceRef);

    if (!session) {
      session = createSession({
        engine: employee?.engine ?? this.config.engines.default,
        source: msg.source,
        sourceRef,
        employee: employee?.name ?? undefined,
        model: employee?.model ?? undefined,
      });
      logger.info(`Created new session ${session.id} for ${sourceRef}${employee ? ` (employee: ${employee.name})` : ""}`);
    }

    const target: Target = {
      channel: msg.channel,
      thread: msg.thread,
      messageTs: msg.raw?.ts,
    };

    const attachmentPaths = msg.attachments
      .map((a) => a.localPath)
      .filter((p): p is string => !!p);

    await this.queue.enqueue(sourceRef, () =>
      this.runSession(session, msg.text, msg.user, attachmentPaths, connector, target, employee),
    );
  }

  /**
   * Run engine for a session, handling reactions and status updates.
   */
  private async runSession(
    session: Session,
    prompt: string,
    user: string,
    attachments: string[],
    connector: Connector,
    target: Target,
    employee?: Employee,
  ): Promise<void> {
    const engine = this.engines.get(session.engine);
    if (!engine) {
      logger.error(`Engine "${session.engine}" not found for session ${session.id}`);
      await connector.sendMessage(target, `Error: engine "${session.engine}" not available.`);
      return;
    }

    // Add eyes reaction to the user's message
    await connector.addReaction(target, "eyes").catch(() => {});

    // Post a "thinking" placeholder message
    const thinkingTarget = { ...target };
    const thinkingTs = await connector.sendMessage(
      { channel: target.channel, thread: target.thread || target.messageTs },
      "_Thinking..._",
    ).catch(() => undefined);

    updateSession(session.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
    });

    try {
      const systemPrompt = buildContext({
        source: session.source,
        channel: target.channel,
        thread: target.thread,
        user,
        employee,
        connectors: this.connectorNames,
        config: this.config,
      });

      const engineConfig = session.engine === "codex"
        ? this.config.engines.codex
        : this.config.engines.claude;

      const result = await engine.run({
        prompt,
        resumeSessionId: session.engineSessionId ?? undefined,
        systemPrompt,
        cwd: JIMMY_HOME,
        bin: engineConfig.bin,
        model: session.model ?? engineConfig.model,
        attachments: attachments.length > 0 ? attachments : undefined,
      });

      // Edit the thinking message with the actual response, or send new if edit fails
      if (thinkingTs) {
        await connector.editMessage(
          { channel: target.channel, thread: target.thread || target.messageTs, messageTs: thinkingTs },
          result.result,
        ).catch(async () => {
          await connector.sendMessage(
            { channel: target.channel, thread: target.thread || target.messageTs },
            result.result,
          );
        });
      } else {
        await connector.sendMessage(
          { channel: target.channel, thread: target.thread || target.messageTs },
          result.result,
        );
      }

      // Remove eyes reaction
      await connector.removeReaction(target, "eyes").catch(() => {});

      // Update session with engine session id for resume
      updateSession(session.id, {
        engineSessionId: result.sessionId,
        status: "idle",
        lastActivity: new Date().toISOString(),
        lastError: result.error ?? null,
      });

      logger.info(
        `Session ${session.id} completed in ${result.durationMs ?? 0}ms` +
        (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Session ${session.id} error: ${errMsg}`);

      updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });

      // Edit thinking message with error, or send new
      if (thinkingTs) {
        await connector.editMessage(
          { channel: target.channel, thread: target.thread || target.messageTs, messageTs: thinkingTs },
          `Error: ${errMsg}`,
        ).catch(() => {});
      } else {
        await connector.sendMessage(target, `Error: ${errMsg}`).catch(() => {});
      }
      await connector.removeReaction(target, "eyes").catch(() => {});
    }
  }

  /**
   * Handle slash commands. Returns true if a command was handled.
   */
  async handleCommand(msg: IncomingMessage, connector: Connector): Promise<boolean> {
    const text = msg.text.trim();
    const target: Target = { channel: msg.channel, thread: msg.thread };

    if (text === "/new" || text.startsWith("/new ")) {
      const sourceRef = this.buildSourceRef(msg);
      this.resetSession(sourceRef);
      await connector.sendMessage(target, "Session reset. Starting fresh.");
      logger.info(`Session reset for ${sourceRef}`);
      return true;
    }

    if (text === "/status" || text.startsWith("/status ")) {
      const sourceRef = this.buildSourceRef(msg);
      const session = getSessionBySourceRef(sourceRef);
      if (session) {
        const info = [
          `Session: ${session.id}`,
          `Engine: ${session.engine}`,
          `Status: ${session.status}`,
          `Created: ${session.createdAt}`,
          `Last activity: ${session.lastActivity}`,
          session.lastError ? `Last error: ${session.lastError}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        await connector.sendMessage(target, info);
      } else {
        await connector.sendMessage(target, "No active session for this conversation.");
      }
      return true;
    }

    return false;
  }

  /**
   * Delete existing session for a source ref.
   */
  resetSession(sourceRef: string): void {
    const session = getSessionBySourceRef(sourceRef);
    if (session) {
      deleteSession(session.id);
      logger.info(`Deleted session ${session.id}`);
    }
  }

  /**
   * Build a source ref string from a message.
   */
  private buildSourceRef(msg: IncomingMessage): string {
    let ref = `${msg.source}:${msg.channel}`;
    if (msg.thread) ref += `:${msg.thread}`;
    return ref;
  }
}
