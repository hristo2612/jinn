import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { JINN_HOME } from "../../shared/paths.js";
import { formatResponse } from "./format.js";
import path from "node:path";
import fs from "node:fs";

export interface WhatsAppConnectorConfig {
  /** Where to store session credentials (default: JINN_HOME/.whatsapp-auth) */
  authDir?: string;
  /** Allowed phone numbers in JID format (e.g. "447700900000@s.whatsapp.net") — empty = allow all */
  allowFrom?: string[];
  ignoreOldMessagesOnBoot?: boolean;
}

// Minimal ILogger implementation that routes Baileys noise to silence
const silentLogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class WhatsAppConnector implements Connector {
  name = "whatsapp";
  private sock: WASocket | null = null;
  private config: WhatsAppConnectorConfig;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private bootTimeMs = Date.now();
  private allowedJids: Set<string>;
  private connectionStatus: "starting" | "running" | "stopped" | "error" | "qr_pending" = "starting";
  private lastError: string | null = null;
  private authDir: string;

  private readonly capabilities: ConnectorCapabilities = {
    threading: false,
    messageEdits: false,
    reactions: false,
    attachments: true,
  };

  constructor(config: WhatsAppConnectorConfig) {
    this.config = config;
    this.authDir = config.authDir ?? path.join(JINN_HOME, ".whatsapp-auth");
    this.allowedJids = new Set(config.allowFrom ?? []);
    fs.mkdirSync(this.authDir, { recursive: true });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: silentLogger as never,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.connectionStatus = "qr_pending";
        logger.info("WhatsApp QR code generated — scan with your WhatsApp app to connect");
      }
      if (connection === "open") {
        this.connectionStatus = "running";
        this.lastError = null;
        logger.info("WhatsApp connector connected");
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.info(`WhatsApp connection closed (${statusCode}), reconnecting: ${shouldReconnect}`);
        if (shouldReconnect && this.connectionStatus !== "stopped") {
          setTimeout(() => this.connect(), 5000);
        } else {
          this.connectionStatus = "stopped";
        }
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        try {
          await this.handleMessage(message);
        } catch (err) {
          logger.error(`WhatsApp message handler error: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.connectionStatus = "stopped";
    await this.sock?.end(undefined);
    logger.info("WhatsApp connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.connectionStatus === "running" ? "running" : "stopped",
      detail: this.connectionStatus === "qr_pending"
        ? "Scan QR code in Jinn logs to connect"
        : (this.lastError ?? undefined),
      capabilities: this.capabilities,
    };
  }

  reconstructTarget(replyContext: Record<string, unknown> | null | undefined): Target {
    const ctx = (replyContext ?? {}) as Record<string, string | null>;
    return {
      channel: (typeof ctx.channel === "string" ? ctx.channel : "") ?? "",
      thread: undefined,
      messageTs: typeof ctx.messageTs === "string" ? ctx.messageTs : undefined,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    return this.replyMessage(target, text);
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!this.sock || this.connectionStatus !== "running") return;
    try {
      const chunks = formatResponse(text);
      for (const chunk of chunks) {
        await this.sock.sendMessage(target.channel, { text: chunk });
      }
    } catch (err) {
      logger.error(`WhatsApp replyMessage error: ${err instanceof Error ? err.message : err}`);
    }
    return undefined;
  }

  async editMessage(_target: Target, _text: string): Promise<void> {
    // WhatsApp doesn't support editing via Baileys reliably — no-op
  }

  async addReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op: reactions are supported in WA but complex to map from Slack emoji names
  }

  async removeReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op
  }

  private async handleMessage(message: WAMessage): Promise<void> {
    // Skip messages from self
    if (message.key.fromMe) return;

    // Skip old messages on boot
    const msgTimestampMs = Number(message.messageTimestamp ?? 0) * 1000;
    if (
      this.config.ignoreOldMessagesOnBoot !== false &&
      msgTimestampMs < this.bootTimeMs
    ) return;

    const jid = message.key.remoteJid;
    if (!jid) return;

    // Skip group messages — only handle 1:1 DMs
    if (jid.endsWith("@g.us")) return;

    // Allowlist check
    if (this.allowedJids.size > 0 && !this.allowedJids.has(jid)) return;

    if (!this.handler) return;

    // Extract text content
    const text =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      message.message?.documentMessage?.caption ||
      "";

    if (!text.trim()) return;

    // Download media attachment if present
    const attachments: Array<{ name: string; localPath: string; mimeType: string; url: string }> = [];
    const hasMedia = message.message?.imageMessage || message.message?.documentMessage || message.message?.audioMessage;
    if (hasMedia && this.sock) {
      try {
        const buffer = await downloadMediaMessage(message, "buffer", {}, {
          logger: silentLogger as never,
          reuploadRequest: this.sock.updateMediaMessage,
        });
        const ext = message.message?.imageMessage ? "jpg"
          : message.message?.audioMessage ? "ogg"
          : "bin";
        const filename = `wa-attachment-${message.key.id}.${ext}`;
        const tmpDir = path.join(JINN_HOME, "tmp");
        const localPath = path.join(tmpDir, filename);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(localPath, buffer as Buffer);
        const mimeType = ext === "jpg" ? "image/jpeg"
          : ext === "ogg" ? "audio/ogg"
          : "application/octet-stream";
        attachments.push({ name: filename, localPath, mimeType, url: localPath });
      } catch {
        // Non-fatal: continue without attachment
      }
    }

    const sessionKey = `whatsapp:${jid}`;
    const replyContext = { channel: jid, thread: null, messageTs: message.key.id ?? null };

    const incomingMessage: IncomingMessage = {
      connector: "whatsapp",
      source: "whatsapp",
      sessionKey,
      channel: jid,
      thread: undefined,
      user: jid.replace("@s.whatsapp.net", ""),
      userId: jid,
      text,
      attachments,
      replyContext,
      messageId: message.key.id ?? undefined,
      transportMeta: { jid },
      raw: message,
    };

    this.handler(incomingMessage);
  }
}
