import type { ChatBlock, JsonObject } from '../shared/types.js';
import { validateBlockEnvelope } from '../shared/blocks.js';

/** Attachment descriptor stored alongside a message and rendered by the web UI. */
export interface MessageMedia {
  type: 'image' | 'audio' | 'video' | 'file';
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
  /** Displayed pixel size of an image, so the client can reserve its box before
   * the bytes arrive. Absent when nothing measured it. */
  width?: number;
  height?: number;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  /** Parsed from the `media` JSON column; undefined when the message has no attachments. */
  media?: MessageMedia[];
  /** True for a live mid-turn block. Most engines replace these at turn end. */
  partial?: boolean;
  /** Tool name when this block is a tool call — lets a reloaded block render as a tool card. */
  toolCall?: string;
  /** Native engine call id used to correlate interleaved tool results. */
  toolId?: string;
  /** Structured Chat Mode blocks rendered by the web UI. */
  blocks?: ChatBlock[];
  /** Safe structured UI metadata, used for reload-stable callback attribution. */
  meta?: JsonObject;
}

export interface MessageRow {
  rowid: number;
  id: string;
  role: string;
  content: string;
  timestamp: number;
  media: string | null;
  partial: number | null;
  seq: number | null;
  tool_call: string | null;
  tool_id: string | null;
  blocks: string | null;
  meta: string | null;
}

export interface MessagePage {
  messages: SessionMessage[];
  hasOlder: boolean;
}

export interface MessagePageOptions {
  /** Fetch messages strictly older than this message id. Omit for the newest tail. */
  before?: string;
  /** Number of messages to return. Clamped to a bounded positive page size. */
  limit?: number;
}

function parseMediaColumn(value: unknown): MessageMedia[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as MessageMedia[]) : undefined;
  } catch {
    return undefined;
  }
}

export function parseBlocksColumn(value: unknown): ChatBlock[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const blocks = parsed.flatMap((block) => {
      const result = validateBlockEnvelope({ op: "put", block });
      return result.ok ? [result.envelope.block] : [];
    });
    return blocks.length > 0 ? blocks : undefined;
  } catch {
    return undefined;
  }
}

export function parseMetaColumn(value: unknown): JsonObject | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

export function rowToMessage(r: MessageRow): SessionMessage {
  const msg: SessionMessage = { id: r.id, role: r.role, content: r.content, timestamp: r.timestamp };
  const media = parseMediaColumn(r.media);
  const blocks = parseBlocksColumn(r.blocks);
  const meta = parseMetaColumn(r.meta);
  if (media) msg.media = media;
  if (blocks) msg.blocks = blocks;
  const phase = messagePhase(r, msg);
  if (phase) msg.meta = { assistantPhase: phase, ...meta };
  else if (meta) msg.meta = meta;
  if (r.partial) msg.partial = true;
  if (r.tool_call) msg.toolCall = r.tool_call;
  if (r.tool_id) msg.toolId = r.tool_id;
  return msg;
}

function messagePhase(row: MessageRow, message: SessionMessage): string | undefined {
  if (row.role !== 'assistant' || row.tool_call || message.blocks?.length || message.media?.length || !row.content.trim()) return;
  // Stream rows retain seq after settlement. Legacy histories distinguish
  // progress from canonical replies without guessing at callback arrival times.
  return row.seq === null && !row.partial ? 'final' : 'commentary';
}
