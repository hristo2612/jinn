import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
} from "discord.js";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { TMP_DIR } from "../../shared/paths.js";
import { formatResponse, downloadAttachment } from "./format.js";
import { deriveSessionKey, buildReplyContext, isOldMessage } from "./threads.js";

export interface DiscordConnectorConfig {
  botToken: string;
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  guildId?: string;
}

export class DiscordConnector implements Connector {
  name = "discord";
  private client: Client;
  private config: DiscordConnectorConfig;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private bootTimeMs = Date.now();
  private allowedUserIds: Set<string>;
  private status: "starting" | "running" | "stopped" | "error" = "starting";
  private lastError: string | null = null;

  constructor(config: DiscordConnectorConfig) {
    this.config = config;
    this.allowedUserIds = new Set(
      Array.isArray(config.allowFrom)
        ? config.allowFrom
        : config.allowFrom
        ? [config.allowFrom]
        : [],
    );
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on("ready", () => {
      logger.info(`Discord connector ready as ${this.client.user?.tag}`);
      this.status = "running";
    });

    this.client.on("messageCreate", async (message) => {
      try {
        await this.handleMessage(message);
      } catch (err) {
        logger.error(`Discord message handler error: ${err instanceof Error ? err.message : err}`);
      }
    });

    this.client.on("error", (err) => {
      this.lastError = err.message;
      this.status = "error";
      logger.error(`Discord client error: ${err.message}`);
    });

    await this.client.login(this.config.botToken);
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    await this.client.destroy();
    logger.info("Discord connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      threading: true,
      messageEdits: true,
      reactions: true,
      attachments: true,
    };
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.status === "running" ? "running" : this.status === "error" ? "error" : "stopped",
      detail: this.lastError ?? undefined,
      capabilities: this.getCapabilities(),
    };
  }

  reconstructTarget(replyContext: Record<string, unknown> | null | undefined): Target {
    const ctx = (replyContext ?? {}) as Record<string, string | null>;
    return {
      channel: ctx.channel ?? "",
      thread: ctx.thread ?? undefined,
      messageTs: ctx.messageTs ?? undefined,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(target.channel);
      if (!channel || !channel.isTextBased()) return;
      const chunks = formatResponse(text);
      let lastId: string | undefined;
      for (const chunk of chunks) {
        const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send(chunk);
        lastId = sent.id;
      }
      return lastId;
    } catch (err) {
      logger.error(`Discord sendMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const chunks = formatResponse(text);
      let lastId: string | undefined;
      for (const chunk of chunks) {
        const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send(chunk);
        lastId = sent.id;
      }
      return lastId;
    } catch (err) {
      logger.error(`Discord replyMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async editMessage(target: Target, text: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      await msg.edit(text.slice(0, 2000));
    } catch (err) {
      logger.error(`Discord editMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async addReaction(target: Target, emoji: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      await msg.react(emoji);
    } catch {
      // non-fatal
    }
  }

  async removeReaction(target: Target, emoji: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      await msg.reactions.cache.get(emoji)?.users.remove(this.client.user?.id);
    } catch {
      // non-fatal
    }
  }

  async setTypingStatus(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).sendTyping();
      }
    } catch {
      // non-fatal
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bots (including self)
    if (message.author.bot) return;

    // Ignore old messages on boot
    if (
      this.config.ignoreOldMessagesOnBoot !== false &&
      isOldMessage(message.createdTimestamp, this.bootTimeMs)
    ) return;

    // Guild restriction
    if (this.config.guildId && message.guild?.id !== this.config.guildId) return;

    // User allowlist
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(message.author.id)) return;

    if (!this.handler) return;

    const sessionKey = deriveSessionKey(message);
    const replyContext = buildReplyContext(message);

    // Download attachments
    const attachments = await Promise.all(
      Array.from(message.attachments.values()).map(async (att) => {
        try {
          const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
          return { name: att.name, localPath, mimeType: att.contentType ?? "application/octet-stream" };
        } catch {
          return null;
        }
      }),
    ).then((results) => results.filter(Boolean) as Array<{ name: string; localPath: string; mimeType: string }>);

    const incomingMessage: IncomingMessage = {
      connector: "discord",
      source: "discord",
      sessionKey,
      channel: message.channel.id,
      thread: message.channel.isThread() ? message.channel.id : undefined,
      user: message.author.username,
      userId: message.author.id,
      text: message.content,
      attachments: attachments.map((a) => ({
        name: a.name,
        url: "",
        mimeType: a.mimeType,
        localPath: a.localPath,
      })),
      replyContext,
      messageId: message.id,
      raw: message,
      transportMeta: {
        channelName: message.channel.isTextBased() && "name" in message.channel
          ? (message.channel as TextChannel).name
          : "dm",
        guildId: message.guild?.id ?? null,
        isDM: message.channel.isDMBased(),
      },
    };

    this.handler(incomingMessage);
  }
}
