import { App } from "@slack/bolt";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  ReplyContext,
  SlackConnectorConfig,
  Target,
} from "../../shared/types.js";
import { buildReplyContext, deriveSessionKey, isOldSlackMessage } from "./threads.js";
import { formatResponse, downloadAttachment } from "./format.js";
import { TMP_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

export class SlackConnector implements Connector {
  name = "slack";
  private app: App;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private readonly allowedUsers: Set<string> | null;
  private readonly ignoreOldMessagesOnBoot: boolean;
  private readonly bootTimeMs = Date.now();
  private started = false;
  private lastError: string | null = null;
  private channelNameCache = new Map<string, { name: string; cachedAt: number }>();
  private botUserId: string | null = null;
  private static CHANNEL_CACHE_TTL_MS = 3600_000; // 1 hour

  private readonly capabilities: ConnectorCapabilities = {
    threading: true,
    messageEdits: true,
    reactions: true,
    attachments: true,
  };

  /**
   * Set the AI assistant typing status in a thread.
   * Uses Slack's assistant.threads.setStatus API for native animated indicator.
   */
  async setTypingStatus(channelId: string, threadTs: string | undefined, status: string): Promise<void> {
    if (!threadTs) return;
    const payload = {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    };
    try {
      const client = this.app.client as any;
      if (client.assistant?.threads?.setStatus) {
        await client.assistant.threads.setStatus(payload);
      } else if (typeof client.apiCall === "function") {
        await client.apiCall("assistant.threads.setStatus", payload);
      }
    } catch (err) {
      logger.debug(`Slack typing status failed: ${err}`);
    }
  }

  constructor(config: SlackConnectorConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
    this.ignoreOldMessagesOnBoot = config.ignoreOldMessagesOnBoot !== false;
    const allowFrom = Array.isArray(config.allowFrom)
      ? config.allowFrom
      : typeof config.allowFrom === "string"
        ? config.allowFrom.split(",").map((value) => value.trim()).filter(Boolean)
        : [];
    this.allowedUsers = allowFrom.length > 0 ? new Set(allowFrom) : null;
  }

  private async resolveChannelName(channelId: string): Promise<string | undefined> {
    const cached = this.channelNameCache.get(channelId);
    if (cached && Date.now() - cached.cachedAt < SlackConnector.CHANNEL_CACHE_TTL_MS) {
      return cached.name;
    }
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const name = result.channel?.name;
      if (name) {
        this.channelNameCache.set(channelId, { name, cachedAt: Date.now() });
        return name;
      }
    } catch (err) {
      logger.debug(`Failed to resolve channel name for ${channelId}: ${err}`);
    }
    return undefined;
  }

  async start() {
    this.app.message(async ({ event }) => {
      logger.info(`[slack] Received message event: user=${(event as any).user} channel=${(event as any).channel} text="${((event as any).text || "").slice(0, 50)}"`);
      // Skip bot's own messages
      if ((event as any).bot_id) {
        logger.info(`[slack] Skipping bot message`);
        return;
      }
      // Skip ghost events from URL unfurls (user=undefined, text="")
      if (!(event as any).user) {
        logger.debug(`[slack] Skipping event with no user (likely URL unfurl)`);
        return;
      }
      if (!this.handler) {
        logger.info(`[slack] No handler registered, dropping message`);
        return;
      }
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage((event as any).ts, this.bootTimeMs)) {
        logger.debug(`Ignoring old Slack message ${(event as any).ts}`);
        return;
      }
      if (this.allowedUsers && !this.allowedUsers.has((event as any).user)) {
        logger.debug(`Ignoring Slack message from unauthorized user ${(event as any).user}`);
        return;
      }

      // In channels, only process thread replies (continuing a conversation).
      // Root channel messages are handled by app_mention instead.
      if ((event as any).channel_type !== "im" && !(event as any).thread_ts) {
        logger.debug(`[slack] Skipping root channel message (use @mention instead)`);
        return;
      }

      const sessionKey = deriveSessionKey(event as any);
      const replyContext = buildReplyContext(event as any);

      // Fetch parent message for thread replies so the session has full context
      let parentContext = "";
      const threadTs = (event as any).thread_ts;
      if (threadTs && threadTs !== (event as any).ts) {
        try {
          const parentResult = await this.app.client.conversations.replies({
            channel: (event as any).channel,
            ts: threadTs,
            limit: 1,
            inclusive: true,
          });
          const parentMsg = parentResult.messages?.[0];
          if (parentMsg?.text) {
            parentContext = `[Thread context — parent message: "${parentMsg.text}"]\n\n`;
          }
        } catch (err) {
          logger.debug(`Failed to fetch parent message: ${err}`);
        }
      }

      // Download attachments if present
      const attachments = [];
      if ((event as any).files) {
        for (const file of (event as any).files) {
          try {
            const localPath = await downloadAttachment(
              file.url_private,
              this.app.client.token!,
              TMP_DIR,
            );
            attachments.push({
              name: file.name,
              url: file.url_private,
              mimeType: file.mimetype,
              localPath,
            });
          } catch (err) {
            logger.warn(`Failed to download attachment: ${err}`);
          }
        }
      }

      const channelName = await this.resolveChannelName((event as any).channel);

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext,
        messageId: (event as any).ts,
        channel: (event as any).channel,
        thread: (event as any).thread_ts,
        user: (event as any).user,
        userId: (event as any).user,
        text: parentContext + ((event as any).text || ""),
        attachments,
        raw: event,
        transportMeta: {
          channelType: ((event as any).channel_type as string) || "channel",
          team: ((event as any).team as string) || null,
          channelName: channelName || null,
        },
      };

      this.handler(msg);
    });

    // Handle @mentions in channels
    this.app.event("app_mention", async ({ event }) => {
      logger.info(`[slack] Received app_mention: user=${event.user} channel=${event.channel} text="${(event.text || "").slice(0, 50)}"`);

      if (!this.handler) {
        logger.info(`[slack] No handler registered, dropping mention`);
        return;
      }
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage(event.ts, this.bootTimeMs)) {
        logger.debug(`Ignoring old Slack mention ${event.ts}`);
        return;
      }
      if (this.allowedUsers && !this.allowedUsers.has(event.user)) {
        logger.debug(`Ignoring Slack mention from unauthorized user ${event.user}`);
        return;
      }

      // Strip the @mention from the text
      const mentionText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!mentionText) {
        logger.debug(`[slack] Empty mention text after stripping @, ignoring`);
        return;
      }

      const sessionKey = deriveSessionKey(event as any);
      const replyContext = buildReplyContext(event as any);
      const channelName = await this.resolveChannelName(event.channel);

      // Download attachments if present
      const attachments = [];
      if ((event as any).files) {
        for (const file of (event as any).files) {
          try {
            const localPath = await downloadAttachment(
              file.url_private,
              this.app.client.token!,
              TMP_DIR,
            );
            attachments.push({
              name: file.name,
              url: file.url_private,
              mimeType: file.mimetype,
              localPath,
            });
          } catch (err) {
            logger.warn(`Failed to download attachment: ${err}`);
          }
        }
      }

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext,
        messageId: event.ts,
        channel: event.channel,
        thread: (event as any).thread_ts,
        user: event.user,
        userId: event.user,
        text: mentionText,
        attachments,
        raw: event,
        transportMeta: {
          channelType: (event as any).channel_type || "channel",
          team: (event as any).team || null,
          channelName: channelName || null,
        },
      };

      this.handler(msg);
    });

    // In channels, only process thread replies (continuing a conversation).
    // Root channel messages are handled by app_mention instead.
    // This is added as a post-filter in the existing app.message() handler above.

    // Fetch bot's own user ID for filtering self-reactions
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id ?? null;
      logger.info(`[slack] Bot user ID: ${this.botUserId}`);
    } catch (err) {
      logger.warn(`[slack] Failed to get bot user ID: ${err}`);
    }

    this.app.event("reaction_added", async ({ event }) => {
      // Only handle reactions on messages (not files, etc.)
      if (event.item.type !== "message") return;

      // Skip bot's own reactions
      if (this.botUserId && event.user === this.botUserId) return;

      if (!this.handler) return;

      // Check allowed users
      if (this.allowedUsers && !this.allowedUsers.has(event.user)) {
        logger.debug(`Ignoring reaction from unauthorized user ${event.user}`);
        return;
      }

      const channelId = event.item.channel;
      const messageTs = event.item.ts;
      const emoji = event.reaction;

      // Skip old reactions replayed on boot
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage(messageTs, this.bootTimeMs)) {
        logger.debug(`Ignoring old Slack reaction on ${messageTs}`);
        return;
      }

      logger.info(`[slack] Reaction :${emoji}: by ${event.user} on ${channelId}:${messageTs}`);

      // Fetch the reacted-to message text
      // Try conversations.history first (works for root messages),
      // fall back to conversations.replies (for threaded messages)
      let messageText = "";
      try {
        const histResult = await this.app.client.conversations.history({
          channel: channelId,
          latest: messageTs,
          oldest: messageTs,
          inclusive: true,
          limit: 1,
        });
        messageText = histResult.messages?.[0]?.text || "";

        // If not found in history, try as a threaded reply
        if (!messageText) {
          const replyResult = await this.app.client.conversations.replies({
            channel: channelId,
            ts: messageTs,
            limit: 1,
            inclusive: true,
          });
          messageText = replyResult.messages?.[0]?.text || "";
        }
      } catch (err) {
        logger.warn(`[slack] Failed to fetch reacted-to message: ${err}`);
        return;
      }

      if (!messageText) {
        logger.debug(`[slack] Reacted-to message has no text, skipping`);
        return;
      }

      // Resolve channel name
      const channelName = await this.resolveChannelName(channelId);
      const channelDisplay = channelName ? `#${channelName}` : channelId;

      // Build the prompt with reaction context
      const prompt = `[Reaction :${emoji}: on message in ${channelDisplay}]\n\nOriginal message:\n"${messageText}"\n\nThe user reacted with :${emoji}: to this message. Interpret and act on the reaction.`;

      const sessionKey = `slack:reaction:${channelId}:${messageTs}`;

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext: {
          channel: channelId,
          thread: messageTs,
          messageTs,
        },
        messageId: messageTs,
        channel: channelId,
        thread: messageTs,
        user: event.user,
        userId: event.user,
        text: prompt,
        attachments: [],
        raw: event,
        transportMeta: {
          channelType: "channel",
          team: null,
          channelName: channelName || null,
        },
      };

      this.handler(msg);
    });

    await this.app.start();
    this.started = true;
    this.lastError = null;
    logger.info("Slack connector started (socket mode)");
  }

  async stop() {
    await this.app.stop();
    this.started = false;
    logger.info("Slack connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.lastError ? "error" : this.started ? "running" : "stopped",
      detail: this.lastError ?? undefined,
      capabilities: this.capabilities,
    };
  }

  reconstructTarget(replyContext: ReplyContext): Target {
    return {
      channel: typeof replyContext.channel === "string" ? replyContext.channel : "",
      thread: typeof replyContext.thread === "string" ? replyContext.thread : undefined,
      messageTs: typeof replyContext.messageTs === "string" ? replyContext.messageTs : undefined,
      replyContext,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const chunks = formatResponse(text);
    let lastTs: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const res = await this.app.client.chat.postMessage({
        channel: target.channel,
        text: chunk,
      });
      lastTs = res.ts;
    }
    return lastTs;
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const threadTs = target.thread || target.messageTs;
    const chunks = formatResponse(text);
    let lastTs: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const res = await this.app.client.chat.postMessage({
        channel: target.channel,
        thread_ts: threadTs,
        text: chunk,
      });
      lastTs = res.ts;
    }
    return lastTs;
  }

  async addReaction(target: Target, emoji: string) {
    if (!target.messageTs) return;
    try {
      await this.app.client.reactions.add({
        channel: target.channel,
        timestamp: target.messageTs,
        name: emoji,
      });
    } catch (err) {
      logger.warn(`Failed to add reaction: ${err}`);
    }
  }

  async removeReaction(target: Target, emoji: string) {
    if (!target.messageTs) return;
    try {
      await this.app.client.reactions.remove({
        channel: target.channel,
        timestamp: target.messageTs,
        name: emoji,
      });
    } catch (err) {
      logger.warn(`Failed to remove reaction: ${err}`);
    }
  }

  async editMessage(target: Target, text: string) {
    if (!target.messageTs) return;
    if (!text || !text.trim()) return;
    await this.app.client.chat.update({
      channel: target.channel,
      ts: target.messageTs,
      text,
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void) {
    this.handler = handler;
  }
}
