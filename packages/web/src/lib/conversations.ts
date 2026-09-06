/**
 * Conversation storage and utility functions for the Jinn chat.
 * Conversations are keyed by sessionId (not agentId).
 */

import type { ChatBlock } from './blocks'

export type MediaType = 'image' | 'audio' | 'video' | 'file'

export interface MediaAttachment {
  type: MediaType
  url: string
  name?: string
  mimeType?: string
  duration?: number
  waveform?: number[]
  size?: number
  /** Displayed pixel size of an image, measured server-side at upload. Absent on
   * rows persisted before dimensions were recorded, and on urls scraped out of
   * message text, which have no stored file behind them. */
  width?: number
  height?: number
  /** Server-side file ID after upload (set by chat-pane before sending) */
  fileId?: string
  /** Original File object for upload (not serialized) */
  file?: File
}

/** MIME is authoritative for rows persisted before video became a media type. */
export function isVideoMedia(media: MediaAttachment): boolean {
  return media.type === 'video' || media.mimeType?.startsWith('video/') === true
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'notification'
  content: string
  timestamp: number
  media?: MediaAttachment[]
  toolCall?: string
  toolId?: string
  /** True for a persisted mid-turn row restored while the turn is still active. */
  partial?: boolean
  blocks?: ChatBlock[]
  /** Safe structured UI metadata persisted with notification messages. */
  meta?: Record<string, unknown>
  /** Client-only send lifecycle of an optimistic user row. Absent means settled:
   *  the resting bubble IS the "sent" signal, so there is no value for it. */
  sendState?: 'pending' | 'failed'
  /** Transport error behind `sendState: 'failed'`, surfaced on hover. */
  sendError?: string
}

/**
 * Content-identity key for a message, independent of its id. Used to recognise a
 * locally-appended optimistic message and its server-persisted twin as the SAME
 * message even though their ids differ. Upload IDs survive the local preview →
 * stored URL transition. Other attachments use their full URL: filenames are
 * display labels and collide across distinct uploads (PLA-393).
 */
export function messageIdentityKey(m: Message): string {
  const sep = '\u0000'
  const mediaFp = JSON.stringify((m.media || [])
    .map((x) => x.fileId ? `/api/files/${x.fileId}` : x.url)
    .sort())
  const blockFp = (m.blocks || [])
    .map((x) => `${x.id}:${x.type}:${x.version}`)
    .sort()
    .join('|')
  const baseKey = `${m.role}${sep}${m.content}${sep}${mediaFp}`
  return blockFp ? `${baseKey}${sep}${blockFp}` : baseKey
}

/**
 * Merge a server history snapshot with the current in-memory messages.
 *
 * A message pushed live (e.g. an agent attachment via the `session:attachment` WS
 * event) is persisted server-side, but a history refetch that races ahead of that
 * commit returns a snapshot WITHOUT it. Replacing wholesale would make the live
 * message vanish until the next reload. We therefore keep any locally-known
 * attachment (media-bearing) message that the snapshot does not yet contain, and
 * likewise any message whose send is still pending or has failed — neither has a
 * server twin yet, and a failed one never will.
 *
 * "Does not contain" is checked by BOTH id and content-identity: an optimistic
 * user message carries a client-generated random id while its persisted twin has
 * the server's canonical id, so an id-only check would wrongly preserve the local
 * copy AND show the snapshot copy → a duplicate. Matching on identity collapses
 * the two. Preserved messages are re-sorted by timestamp.
 *
 * That same client-uuid → server-id gap also causes a FLICKER: when the snapshot's
 * persisted twin replaces the optimistic row, the React key changes, remounting the
 * user bubble and every turn/fold region anchored on its id. To avoid it we adopt
 * the persisted twin's content but KEEP the optimistic id and timestamp, so the key
 * stays stable across the swap. This holds across later snapshots too (the local id
 * keeps winning), so the user message never remounts.
 *
 * Preservation is capped by age: a message that failed to persist server-side
 * would otherwise be re-appended on every reconciliation forever. Only messages
 * younger than RECONCILE_PRESERVE_MAX_AGE_MS (by their `timestamp`) are kept —
 * legit in-flight attachments are seconds old, so the window is generous.
 */
export const RECONCILE_PRESERVE_MAX_AGE_MS = 5 * 60 * 1000

export function reconcileMessages(
  current: Message[],
  snapshot: Message[],
  now: number = Date.now(),
): Message[] {
  // Queue local rows by identity so each snapshot row adopts AT MOST ONE local id.
  // messageIdentityKey is content-only, so repeated identical messages ("ok",
  // "yes") share a key; consuming per match keeps two "yes" server rows from both
  // adopting the same optimistic id (which would collide React keys and turn
  // anchors). Order is stable: both arrays are timestamp-sorted.
  const localByKey = new Map<string, Message[]>()
  for (const m of current) {
    const key = messageIdentityKey(m)
    const arr = localByKey.get(key)
    if (arr) arr.push(m)
    else localByKey.set(key, [m])
  }
  let rekeyed = false
  const aligned = snapshot.map((m) => {
    const arr = localByKey.get(messageIdentityKey(m))
    if (!arr || arr.length === 0) return m
    // An exact-id match is a normal already-synced row: consume it (so a later
    // identical row can't reuse it) and leave it untouched.
    const exactIdx = arr.findIndex((x) => x.id === m.id)
    if (exactIdx !== -1) {
      arr.splice(exactIdx, 1)
      return m
    }
    // Otherwise the first queued local row is this server row's optimistic twin.
    // Keep the server content (canonical urls/blocks); adopt the local id +
    // timestamp so the React key never changes across the re-id.
    const twin = arr.shift()!
    rekeyed = true
    return { ...m, id: twin.id, timestamp: twin.timestamp }
  })
  // Preserve reference identity when nothing was re-keyed: callers rely on
  // `=== snapshot` to skip re-renders when the merge is a no-op.
  const base = rekeyed ? aligned : snapshot

  const preserved = unsyncedRows(current, base, now)
  if (preserved.length === 0) return base
  return [...base, ...preserved].sort((a, b) => a.timestamp - b.timestamp)
}

/** Worth keeping past a snapshot that omits it: an in-flight or failed send has
 *  no server twin yet, and a live-pushed attachment may just be racing the commit. */
function isUnsynced(m: Message, now: number): boolean {
  const unsettled = m.sendState === 'pending' || m.sendState === 'failed'
  const carriesMedia = Boolean(m.media && m.media.length > 0)
  return (unsettled || carriesMedia) && now - m.timestamp <= RECONCILE_PRESERVE_MAX_AGE_MS
}

/**
 * The local rows `base` does not account for.
 *
 * Coverage is COUNTED, not tested for membership: identity keys are content-only,
 * so a single older settled "yes" would otherwise stand in for every later "yes"
 * and silently swallow a newer pending or failed one. Walking `current` in order
 * lets each row consume at most one base row, mirroring the per-match queue in
 * `reconcileMessages`.
 */
function unsyncedRows(current: Message[], base: Message[], now: number): Message[] {
  const baseIds = new Set(base.map((m) => m.id))
  const credits = new Map<string, number>()
  for (const m of base) {
    const key = messageIdentityKey(m)
    credits.set(key, (credits.get(key) ?? 0) + 1)
  }
  const preserved: Message[] = []
  for (const m of current) {
    if (!m.id) continue
    const key = messageIdentityKey(m)
    const covered = credits.get(key) ?? 0
    if (covered > 0) credits.set(key, covered - 1)
    if (baseIds.has(m.id) || covered > 0) continue
    if (isUnsynced(m, now)) preserved.push(m)
  }
  return preserved
}

// --- Intermediate message persistence (localStorage) ---

const INTERMEDIATE_PREFIX = 'jinn-intermediate-'

export function clearIntermediateMessages(sessionId: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(`${INTERMEDIATE_PREFIX}${sessionId}`)
  } catch { /* ignore */ }
}

/**
 * Remove the engine-only "Attached files:\n- /abs/path" block that the gateway
 * appends to the prompt for the CLI. It must never be shown in the chat bubble —
 * attachments render as chips/thumbnails instead. Safe on text without the block.
 */
export function stripAttachedFilesBlock(text: string): string {
  return text.replace(/\n*Attached files:\n(?:- .*(?:\n|$))+/g, '').trimEnd()
}

// --- Media parsing ---

export function parseMedia(content: string): MediaAttachment[] {
  const media: MediaAttachment[] = []

  // Markdown images: ![alt](url)
  const imgRegex =
    /!\[([^\]]*)\]\((https?:\/\/[^)]+\.(jpg|jpeg|png|gif|webp|svg)(\?[^)]*)?)\)/gi
  let m: RegExpExecArray | null
  while ((m = imgRegex.exec(content)) !== null) {
    media.push({ type: 'image', url: m[2], name: m[1] || 'Image' })
  }

  // Bare image URLs not already captured
  const bareImgRegex =
    /(?<!\]\()https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?\S*)?\b/gi
  while ((m = bareImgRegex.exec(content)) !== null) {
    const url = m[0]
    if (!media.find((x) => x.url === url)) {
      media.push({ type: 'image', url })
    }
  }

  // Audio URLs
  const audioRegex = /https?:\/\/\S+\.(mp3|wav|ogg|m4a|aac)(\?\S*)?\b/gi
  while ((m = audioRegex.exec(content)) !== null) {
    media.push({ type: 'audio', url: m[0], name: m[0].split('/').pop() })
  }

  return media
}
