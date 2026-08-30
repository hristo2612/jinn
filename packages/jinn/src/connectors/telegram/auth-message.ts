import type { TelegramAuth } from "./auth.js";

interface TelegramMessage {
  from?: { id?: number };
  chat: { type: string; id: number | string };
  message_id?: number | string;
}

export async function scrubUnauthorizedTelegramAuth(
  auth: TelegramAuth | undefined,
  message: TelegramMessage,
  text: string,
): Promise<void> {
  await auth?.scrubExplicitPayload({
    userId: message.from?.id ?? "",
    chatType: message.chat.type,
    chatId: message.chat.id,
    messageId: message.message_id,
    text,
  });
}
