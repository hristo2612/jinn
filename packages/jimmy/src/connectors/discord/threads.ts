import type { Message } from "discord.js";

export function deriveSessionKey(message: Message, prefix = "discord"): string {
  if (message.channel.isDMBased()) {
    return `${prefix}:dm:${message.author.id}`;
  }
  if (message.channel.isThread()) {
    return `${prefix}:thread:${message.channel.id}`;
  }
  return `${prefix}:${message.channel.id}`;
}

export function buildReplyContext(message: Message): Record<string, string | null> {
  const threadId = message.channel.isThread() ? message.channel.id : null;
  return {
    channel: message.channel.id,
    thread: threadId,
    messageTs: message.id,
    guildId: message.guild?.id ?? null,
  };
}

export function isOldMessage(createdTimestamp: number, bootTimeMs: number): boolean {
  return createdTimestamp < bootTimeMs;
}
