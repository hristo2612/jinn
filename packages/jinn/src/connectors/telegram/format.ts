import { convertOutsideCode, formatAndChunk } from "../shared/format.js";

const TELEGRAM_MAX_LENGTH = 4096;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Convert standard markdown to Telegram Markdown format.
 * Handles headings, bold, italic, strikethrough, links, and bullet lists.
 * Preserves code blocks and inline code untouched.
 */
export function markdownToTelegram(text: string): string {
  return convertOutsideCode(text, (segment) =>
    segment
      // Headings: ## text → bold (placeholder to avoid italic capture)
      .replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content) => `\x00BOLD${content}\x00BOLD`)
      // Bold: **text** or __text__ → placeholder
      .replace(/\*\*(.+?)\*\*/g, "\x00BOLD$1\x00BOLD")
      .replace(/__(.+?)__/g, "\x00BOLD$1\x00BOLD")
      // Italic: *text* → _text_ (after bold is extracted)
      .replace(/\*(.+?)\*/g, "_$1_")
      // Restore bold markers → *text*
      .replace(/\x00BOLD(.+?)\x00BOLD/g, "*$1*")
      // Strikethrough: ~~text~~ → ~text~
      .replace(/~~(.+?)~~/g, "~$1~")
      // Bullet lists: - item or * item → • item
      .replace(/^(\s*)[-*]\s+/gm, "$1• "),
  );
}

/**
 * Strip Telegram Markdown markers (*bold*, _italic_, ~strikethrough~) outside
 * code segments. Used for the plain-text retry when a parse_mode send fails,
 * so users don't see literal formatting characters.
 */
export function stripTelegramMarkdown(text: string): string {
  return convertOutsideCode(text, (segment) => {
    // Protect URLs so auth links survive the plain-text fallback unchanged.
    const urls: string[] = [];
    const protectedSegment = segment.replace(URL_PATTERN, (url) => {
      const placeholder = `\x00URL${urls.length}\x00`;
      const suffix = url.match(/[*_~]+$/)?.[0] ?? "";
      const safeUrl = suffix ? url.slice(0, -suffix.length) : url;
      urls.push(safeUrl);
      return `${placeholder}${suffix}`;
    });
    const stripped = protectedSegment
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/_(.+?)_/g, "$1")
      .replace(/~(.+?)~/g, "$1");
    return stripped.replace(/\x00URL(\d+)\x00/g, (match, index) => urls[Number(index)] ?? match);
  });
}

/**
 * Split text into chunks that fit within Telegram's message length limit (4096 chars).
 * Converts markdown to Telegram format before chunking.
 */
export function formatResponse(text: string): string[] {
  return formatAndChunk(text, TELEGRAM_MAX_LENGTH, markdownToTelegram);
}
