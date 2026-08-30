import TelegramBot, { type SendMessageParams } from "node-telegram-bot-api";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Attachment,
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  ReplyContext,
  Target,
  TelegramConnectorConfig,
} from "../../shared/types.js";
import { deriveSessionKey, buildReplyContext, isOldTelegramMessage } from "./threads.js";
import { formatResponse, stripTelegramMarkdown } from "./format.js";
import { logger } from "../../shared/logger.js";
import { STT_SETTINGS_FILE, TMP_DIR } from "../../shared/paths.js";
import { getEffectiveSttSettings } from "../../stt/settings-store.js";
import {
  transcribe as sttTranscribe,
  getModelPath,
} from "../../stt/stt.js";

import { createTelegramAuth, type TelegramAuth } from "./auth.js";
import { scrubUnauthorizedTelegramAuth } from "./auth-message.js";
type SendMessageOptions = Omit<SendMessageParams, "chat_id" | "text">;

export class TelegramConnector implements Connector {
  name = "telegram";
  id: string;
  private bot: TelegramBot;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private readonly allowedUsers: Set<number> | null;
  private readonly ignoreOldMessagesOnBoot: boolean;
  private readonly bootTimeMs = Date.now();
  private started = false;
  private lastError: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly auth?: TelegramAuth;

  private readonly capabilities: ConnectorCapabilities = {
    threading: false,
    messageEdits: true,
    reactions: false,
    attachments: true,
  };

  private readonly sttConfig?: TelegramConnectorConfig["stt"];
  private sttChain: Promise<unknown> = Promise.resolve();
  private sttPending = 0;

  constructor(config: TelegramConnectorConfig) {
    this.id = config.id || "telegram";
    this.bot = new TelegramBot(config.botToken, { polling: false });
    this.ignoreOldMessagesOnBoot = config.ignoreOldMessagesOnBoot !== false;
    this.allowedUsers =
      config.allowFrom && config.allowFrom.length > 0
        ? new Set(config.allowFrom)
        : null;
    this.sttConfig = config.stt;
    if (config.telegramAuth?.enabled === true) {
      this.auth = createTelegramAuth(this.bot, config.telegramAuth, this.allowedUsers);
    }
  }

  async start(): Promise<void> {
    try {
      const me = await this.bot.getMe();
      logger.info(`[telegram] Bot started: @${me.username} (id: ${me.id})`);
      this.bot.startPolling();
      this.started = true;
      this.lastError = null;
      this.auth?.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      logger.error(`[telegram] Failed to start: ${msg}`);
      return;
    }

    this.bot.on("message", async (telegramMsg) => {
      // Skip bot messages
      if (telegramMsg.from?.is_bot) {
        logger.debug("[telegram] Skipping bot message");
        return;
      }

      if (!this.auth && !this.handler) {
        logger.debug("[telegram] No handler registered, dropping message");
        return;
      }
      if (
        this.ignoreOldMessagesOnBoot &&
        isOldTelegramMessage(telegramMsg.date, this.bootTimeMs)
      ) {
        logger.debug(`[telegram] Ignoring old message ${telegramMsg.message_id}`);
        return;
      }

      const userId = telegramMsg.from?.id;
      const rawMessageText = this.auth
        ? messageTextFromTelegram(telegramMsg)
        : undefined;
      const allowedUser = !this.allowedUsers
        || (userId !== undefined && this.allowedUsers.has(userId));
      if (!allowedUser) {
        await scrubUnauthorizedTelegramAuth(this.auth, telegramMsg, rawMessageText ?? "");
        logger.debug(`[telegram] Ignoring message from unauthorized user ${userId}`);
        return;
      }

      if (this.auth && await this.auth.handleIncoming(userId ?? "", telegramMsg.chat.type, telegramMsg.chat.id, telegramMsg.message_id, rawMessageText ?? "")) return;

      if (!this.handler) {
        logger.debug("[telegram] No handler registered, dropping message");
        return;
      }

      const sessionKey = deriveSessionKey(telegramMsg, this.id);
      const replyContext = buildReplyContext(telegramMsg);

      const username =
        telegramMsg.from?.username || telegramMsg.from?.first_name || "unknown";

      let messageText: string =
        rawMessageText ?? messageTextFromTelegram(telegramMsg);

      // File attachments: download via bot token and push to msg.attachments.
      // sessions/manager.ts pulls localPath and engines auto-inject
      // "Attached files: …" — no manual text formatting needed here.
      const tg = telegramMsg as any;
      type Spec = { file_id: string; name?: string; mime?: string };
      const specs: Spec[] = [];
      if (tg.document) {
        specs.push({
          file_id: tg.document.file_id,
          name: tg.document.file_name,
          mime: tg.document.mime_type,
        });
      }
      if (tg.photo && tg.photo.length > 0) {
        // Telegram returns size variants; the last is the largest.
        specs.push({
          file_id: tg.photo[tg.photo.length - 1].file_id,
          mime: "image/jpeg",
        });
      }
      if (tg.video) {
        specs.push({
          file_id: tg.video.file_id,
          name: tg.video.file_name,
          mime: tg.video.mime_type || "video/mp4",
        });
      }
      // video_note is intentionally NOT attached here — the STT block below
      // transcribes it instead (avoids double-handling the same message).
      if (tg.animation) {
        specs.push({
          file_id: tg.animation.file_id,
          name: tg.animation.file_name,
          mime: tg.animation.mime_type || "video/mp4",
        });
      }
      if (tg.sticker) {
        specs.push({
          file_id: tg.sticker.file_id,
          mime: tg.sticker.is_animated
            ? "application/x-tgsticker"
            : "image/webp",
        });
      }

      const attachments: Attachment[] = [];
      if (specs.length > 0) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        for (const spec of specs) {
          try {
            const downloaded: string = await (this.bot as any).downloadFile(
              spec.file_id,
              TMP_DIR,
            );
            // Rename to a UUID so repeat Telegram basenames don't collide
            // (matches the Slack connector's downloadAttachment pattern).
            const ext =
              path.extname(downloaded) ||
              (spec.name ? path.extname(spec.name) : "");
            const localPath = path.join(TMP_DIR, `${randomUUID()}${ext}`);
            fs.renameSync(downloaded, localPath);
            attachments.push({
              name: spec.name || path.basename(downloaded),
              url: localPath,
              mimeType: spec.mime || "application/octet-stream",
              localPath,
            });
          } catch (err) {
            logger.warn(
              `[telegram] Failed to download attachment: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }

      // Voice / audio / video_note → transcribe via STT module.
      // If STT can't run for any reason, drop the message with a user-facing
      // explanation rather than forwarding empty text downstream (which would
      // crash session resume — see #54).
      const voiceLike =
        (telegramMsg as any).voice ||
        (telegramMsg as any).audio ||
        (telegramMsg as any).video_note;

      if (voiceLike) {
        const settings = getEffectiveSttSettings(this.sttConfig, STT_SETTINGS_FILE, logger.warn);
        let unavailable: string | null = null;
        if (!settings.enabled) {
          unavailable = "voice transcription is not enabled on this gateway";
        } else if (!getModelPath(settings.model)) {
          unavailable = `STT model '${settings.model}' is not downloaded`;
        }

        if (unavailable) {
          logger.warn(`[telegram] Dropping voice message: ${unavailable}`);
          try {
            await this.bot.sendMessage(
              telegramMsg.chat.id,
              `⚠️ Couldn't transcribe your voice message — ${unavailable}. Please type instead.`,
            );
          } catch {
            /* non-fatal */
          }
          return;
        }

        const language = settings.languages.length === 1 ? settings.languages[0] : "auto";

        // Serialize transcriptions: parallel whisper-cli runs OOM on small hosts.
        // If another transcription is already in flight, send a one-line ack so
        // the user doesn't sit through ~duration × queue position in silence.
        this.sttPending++;
        if (this.sttPending > 1) {
          try {
            await this.bot.sendMessage(
              telegramMsg.chat.id,
              "⏳ Transcribing a previous voice message — yours is queued.",
            );
          } catch {
            /* non-fatal */
          }
        }

        const myTurn = this.sttChain.then(async () => {
          try {
            await this.bot.sendChatAction(telegramMsg.chat.id, "typing");
          } catch {
            /* non-fatal */
          }
          logger.info(
            `[telegram] Transcribing voice message (${voiceLike.duration}s, lang=${language})`,
          );
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-stt-"));
          try {
            const localPath = await (this.bot as any).downloadFile(
              voiceLike.file_id,
              tmpDir,
            );
            return await sttTranscribe(localPath, settings.model, language);
          } finally {
            try {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {
              /* non-fatal */
            }
          }
        });
        this.sttChain = myTurn
          .catch(() => undefined)
          .finally(() => {
            this.sttPending = Math.max(0, this.sttPending - 1);
          });

        let transcript: string | undefined;
        try {
          transcript = await myTurn;
        } catch (err) {
          logger.error(
            `[telegram] STT failed: ${err instanceof Error ? err.message : err}`,
          );
          try {
            await this.bot.sendMessage(
              telegramMsg.chat.id,
              "⚠️ Couldn't transcribe your voice message. Please try again or type instead.",
            );
          } catch {
            /* non-fatal */
          }
          return;
        }

        if (transcript) {
          messageText = messageText
            ? `${messageText}\n\n${transcript}`
            : transcript;
          logger.info(`[telegram] Transcribed ${transcript.length} chars`);
        } else {
          logger.warn("[telegram] Transcription returned empty text");
          try {
            await this.bot.sendMessage(
              telegramMsg.chat.id,
              "⚠️ Couldn't make out anything in your voice message. Please try again or type instead.",
            );
          } catch {
            /* non-fatal */
          }
          return;
        }
      }

      const msg: IncomingMessage = {
        connector: this.id,
        source: "telegram",
        sessionKey,
        replyContext,
        messageId: String(telegramMsg.message_id),
        channel: String(telegramMsg.chat.id),
        user: username,
        userId: String(userId ?? "unknown"),
        text: messageText,
        attachments,
        raw: telegramMsg,
        transportMeta: {
          chatType: telegramMsg.chat.type,
        },
      };

      this.handler(msg);
    });
  }

  async stop(): Promise<void> {
    this.auth?.stop();
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.bot.stopPolling();
    this.started = false;
    logger.info("[telegram] Connector stopped");
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
      channel: String(replyContext.chatId ?? ""),
      messageTs: replyContext.messageId != null ? String(replyContext.messageId) : undefined,
      replyContext,
    };
  }

  private async safeSend(
    chatId: string,
    text: string,
    opts: SendMessageOptions = {},
  ): Promise<string | undefined> {
    try {
      const result = await this.bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        ...opts,
      });
      return String(result.message_id);
    } catch (err) {
      // On parse error, retry without Markdown formatting. Strip the markers we
      // added during conversion so users don't see literal asterisks/underscores.
      logger.warn(`[telegram] Send failed with Markdown, retrying as plain text: ${err}`);
      try {
        const result = await this.bot.sendMessage(chatId, stripTelegramMarkdown(text), opts);
        return String(result.message_id);
      } catch (retryErr) {
        logger.error(`[telegram] Send failed: ${retryErr}`);
        throw retryErr;
      }
    }
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const chunks = formatResponse(text);
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const id = await this.safeSend(target.channel, chunk);
      if (id) lastMessageId = id;
    }
    return lastMessageId;
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const replyText = this.auth?.decorateReply(target.replyContext, text) ?? text;
    const replyToId =
      target.replyContext?.messageId != null
        ? Number(target.replyContext.messageId)
        : undefined;
    const opts: SendMessageOptions = {};
    if (replyToId) {
      opts.reply_parameters = { message_id: replyToId };
    }
    const chunks = formatResponse(replyText);
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const id = await this.safeSend(target.channel, chunk, opts);
      if (id) lastMessageId = id;
    }
    return lastMessageId;
  }

  async setTypingStatus(channelId: string, _threadTs: string | undefined, status: string): Promise<void> {
    const existing = this.typingIntervals.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(channelId);
    }
    if (!status) return;
    try {
      await this.bot.sendChatAction(channelId, "typing");
      // Telegram typing expires after ~5s — refresh every 4s
      const interval = setInterval(async () => {
        try {
          await this.bot.sendChatAction(channelId, "typing");
        } catch { /* non-fatal */ }
      }, 4_000);
      this.typingIntervals.set(channelId, interval);
    } catch {
      // non-fatal
    }
  }

  async addReaction(_target: Target, _emoji: string): Promise<void> {
    // Telegram Bot API reaction support is limited; no-op for now
  }

  async removeReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op
  }

  async editMessage(target: Target, text: string): Promise<void> {
    if (!target.messageTs) return;
    if (!text || !text.trim()) return;
    // Apply the same markdown conversion as sends; edits are single-message,
    // so keep only the first chunk (truncated to the platform limit).
    const [converted] = formatResponse(text);
    await this.bot.editMessageText(converted, {
      chat_id: target.channel,
      message_id: Number(target.messageTs),
      parse_mode: "Markdown",
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }
}

function messageTextFromTelegram(telegramMsg: any): string {
  return telegramMsg.text || telegramMsg.caption || "";
}
