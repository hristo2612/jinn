import { isAnswerMessage, messageMedia, finalAnswerIndices, settledDurationMs } from './final-answers'
export { finalAnswerIndices } from './final-answers'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { stripAttachedFilesBlock, type MediaAttachment, type Message } from '@/lib/conversations'
import { copyText } from '@/platform'
import { MessageMedia } from './message-media'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'
import { useMessageTts, stopMessageTts } from './use-message-tts'
import { ChatBlockInline } from './chat-blocks'
import { blockFallbackContent, isActiveDelegationStatus, type LiveBlockArrival } from '@/lib/blocks'
import { isToolDone, ToolGroup } from './tool-group'
import { parseTeammateReply, TeammateReply } from './teammate-reply'
import { parseAgentRelay, AgentRelay } from './agent-relay'
import { DispatchRow } from './dispatch-row'
import { BURST_WINDOW_MS, CallbackBurst, type BurstEntry } from './callback-burst'
import { FoldRegion } from './fold-region'
import { openTurnIds, turnIdByIndex } from './turn-ids'
import type { FoldSummaryData } from './fold-summary'
import type { CommsPeekData } from './thread-peek'
import { TodoActivityBurst } from './todo-activity-burst'
import { formatMessage } from './message-markdown'
import { useStreamingFormat } from './streaming-format'
import { UserMessageSlot } from './user-message-slot'
import { commsArrivalDelayMs, useMessageArrivals } from './message-arrival'
import { JumpToLatestButton } from './jump-to-latest'
import { TranscriptEmptyState } from './chat-transcript-empty'
import { TranscriptExpansionProvider, useTranscriptExpansionStore } from './transcript-expansion'
import { ThinkingIndicator } from './thinking-indicator'
import { turnSpacerClass } from './turn-spacer'
import {
  applyTranscriptAnchor,
  captureVirtualAnchor,
  groupKey,
  scrollTranscriptTo, takeTranscriptWriteTop,
  useTranscriptVirtualizer,
  VIRTUALIZE_THRESHOLD,
  type VirtualAnchor,
} from './transcript-virtualizer'
import { OlderPageRow } from './older-page-row'
import { useVirtualBlockOffset } from './virtual-block-offset'
import { captureVisibleAnchor, OLDER_LOAD_THRESHOLD_PX, type ScrollAnchor } from '@/lib/scroll-anchor'
import { formatTimestamp, shouldShowTimestamp, TimestampDivider } from './message-timestamps'

export { formatMessage, isFilePath, parseFenceLang } from './message-markdown'
export { TimestampDivider } from './message-timestamps'
export { collapseState, shouldCollapse, USER_COLLAPSE_PX, USER_COLLAPSE_SLACK } from './collapsible-user-text'
export { toolGlyphForName } from './tool-group'
export { turnSpacerClass } from './turn-spacer'

/* ── Tool grouping ──────────────────────────────────────── */

export type MessageItem =
  | { kind: 'message'; msg: Message; index: number }
  | { kind: 'tool-group'; msgs: Message[]; startIndex: number }
  | { kind: 'dispatch-call'; msg: Message; index: number }
  | { kind: 'callback-burst'; entries: BurstEntry[]; startIndex: number }
  | { kind: 'todo-burst'; msgs: Message[]; startIndex: number; endIndex: number }

function isDelegationToolCall(msg: Message): boolean {
  const name = msg.toolCall || ''
  return name === 'delegate_task' || name.endsWith('__delegate_task')
}

// A follow-up sent into another session (usually a delegated child). Surfaced
// as a distinct dispatch row rather than buried in the tool pile — but only in
// its generic form: the transcript's tool call carries no target or text. Once
// the gateway emits `dispatch` blocks (structured contract), those take over
// and the raw tool calls are skipped like delegation ones.
function isDispatchToolCall(msg: Message): boolean {
  const name = msg.toolCall || ''
  return name === 'send_to_session' || name.endsWith('__send_to_session')
}

const ACTIVITY_BLOCK_TYPES = new Set(['todo-activity', 'workflow-definition', 'workflow-run'])

// A completed generic tool row is redundant once its server-authored activity
// object is present in the thread. Suppress it deterministically:
//  · exact — the tool row's meta.activityReceiptId equals a present activity
//    block id (the correlated, reload-safe path);
//  · legacy — for reloads produced before correlation metadata existed, within
//    ONE user turn, suppress exactly one completed row when exactly one unmatched
//    activity block in that turn declares that tool name and exactly one completed
//    row carries it. Never an active tool, an error/read-only row (no receipt), a
//    row in another turn, or an ambiguous cardinality.
function suppressedActivityToolIds(messages: Message[]): Set<string> {
  const suppressed = new Set<string>()
  const presentBlockIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (ACTIVITY_BLOCK_TYPES.has(block.type)) presentBlockIds.add(block.id)
    }
  }
  if (presentBlockIds.size === 0) return suppressed

  const matchedBlockIds = new Set<string>()
  for (const message of messages) {
    if (!message.toolCall || !isToolDone(message) || !message.id) continue
    const receiptId = message.meta?.activityReceiptId
    if (typeof receiptId === 'string' && presentBlockIds.has(receiptId)) {
      suppressed.add(message.id)
      matchedBlockIds.add(receiptId)
    }
  }

  // Legacy 1:1 fallback, partitioned by user turn.
  let turnStart = 0
  const flushTurn = (start: number, end: number) => {
    const blockNames = new Map<string, number>()
    const rowsByName = new Map<string, Message[]>()
    for (let i = start; i < end; i++) {
      const message = messages[i]
      for (const block of message.blocks ?? []) {
        if (!ACTIVITY_BLOCK_TYPES.has(block.type) || matchedBlockIds.has(block.id)) continue
        const receipt = block.payload?.activityReceipt as { toolName?: unknown } | undefined
        const toolName = typeof receipt?.toolName === 'string' ? receipt.toolName : ''
        if (toolName) blockNames.set(toolName, (blockNames.get(toolName) ?? 0) + 1)
      }
      if (message.toolCall && isToolDone(message) && message.id
        && !suppressed.has(message.id) && message.meta?.activityReceiptId === undefined) {
        const list = rowsByName.get(message.toolCall) ?? []
        list.push(message)
        rowsByName.set(message.toolCall, list)
      }
    }
    for (const [name, count] of blockNames) {
      const rows = rowsByName.get(name)
      if (count === 1 && rows && rows.length === 1 && rows[0].id) suppressed.add(rows[0].id)
    }
  }
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && i > turnStart) {
      flushTurn(turnStart, i)
      turnStart = i
    }
  }
  flushTurn(turnStart, messages.length)

  return suppressed
}

function createdTodoRootId(item: MessageItem): string | null {
  if (item.kind !== 'message' || item.msg.role !== 'assistant' || item.msg.toolCall) return null
  const blocks = item.msg.blocks ?? []
  if (blocks.length !== 1 || blocks[0].type !== 'todo-activity') return null
  const block = blocks[0]
  return block.payload.action === 'created' && typeof block.payload.rootId === 'string' && block.payload.rootId
    ? block.payload.rootId
    : null
}

function groupTodoCreationBursts(items: MessageItem[]): MessageItem[] {
  const grouped: MessageItem[] = []
  let i = 0
  while (i < items.length) {
    const rootId = createdTodoRootId(items[i])
    if (!rootId) {
      grouped.push(items[i])
      i++
      continue
    }
    const start = i
    const msgs: Message[] = []
    while (i < items.length && createdTodoRootId(items[i]) === rootId) {
      const item = items[i]
      if (item.kind !== 'message') break
      msgs.push(item.msg)
      i++
    }
    if (msgs.length >= 2) {
      const first = items[start]
      const last = items[i - 1]
      grouped.push({
        kind: 'todo-burst',
        msgs,
        startIndex: first.kind === 'message' ? first.index : start,
        endIndex: last.kind === 'message' ? last.index : i - 1,
      })
    } else {
      grouped.push(items[start])
    }
  }
  return grouped
}

export function groupMessages(messages: Message[]): MessageItem[] {
  const items: MessageItem[] = []
  const suppressedToolIds = suppressedActivityToolIds(messages)
  const hasDelegationBlock = messages.some((message) =>
    message.blocks?.some((block) => block.type === 'delegation'),
  )
  const hasDispatchBlock = messages.some((message) =>
    message.blocks?.some((block) => block.type === 'dispatch'),
  )
  let i = 0
  while (i < messages.length) {
    if (hasDelegationBlock && messages[i].role === 'assistant' && messages[i].toolCall && isDelegationToolCall(messages[i])) {
      i++
      continue
    }
    if (messages[i].role === 'assistant' && messages[i].toolCall && isDispatchToolCall(messages[i])) {
      if (!hasDispatchBlock) items.push({ kind: 'dispatch-call', msg: messages[i], index: i })
      i++
      continue
    }
    if (messages[i].role === 'assistant' && messages[i].toolCall) {
      const toolMsgs: Message[] = []
      const start = i
      while (
        i < messages.length && messages[i].role === 'assistant' && messages[i].toolCall
        && !isDispatchToolCall(messages[i])
      ) {
        const suppressedByReceipt = Boolean(messages[i].id && suppressedToolIds.has(messages[i].id as string))
        if ((!hasDelegationBlock || !isDelegationToolCall(messages[i])) && !suppressedByReceipt) {
          toolMsgs.push(messages[i])
        }
        i++
      }
      if (toolMsgs.length > 0) items.push({ kind: 'tool-group', msgs: toolMsgs, startIndex: start })
    } else {
      // T3 burst grouping: 2+ consecutive callbacks landing within the burst
      // window compose into ONE grouped entry — the pile gets quieter as it
      // grows instead of louder.
      const callback = messages[i].role === 'notification' ? parseTeammateReply(messages[i]) : null
      if (callback) {
        const start = i
        const entries: BurstEntry[] = [{ data: callback, msg: messages[i], messageId: messages[i].id || `idx-${i}` }]
        i++
        while (i < messages.length && messages[i].role === 'notification') {
          if (messages[i].timestamp - messages[i - 1].timestamp > BURST_WINDOW_MS) break
          const next = parseTeammateReply(messages[i])
          if (!next) break
          entries.push({ data: next, msg: messages[i], messageId: messages[i].id || `idx-${i}` })
          i++
        }
        if (entries.length >= 2) {
          items.push({ kind: 'callback-burst', entries, startIndex: start })
        } else {
          items.push({ kind: 'message', msg: messages[start], index: start })
        }
        continue
      }
      items.push({ kind: 'message', msg: messages[i], index: i })
      i++
    }
  }
  return groupTodoCreationBursts(items)
}

/* ── The post-turn fold — partitioning ──────────────────── */

/** A centered bell banner: a notification that is neither a callback nor a
 *  relay. Banners stay OUTSIDE the fold (they're addressed to the user, not
 *  part of the model's work) — a mid-turn banner splits the region. */
function isSystemBanner(msg: Message): boolean {
  return msg.role === 'notification' && !parseTeammateReply(msg) && !parseAgentRelay(msg)
}

function itemHasAssistantMedia(item: MessageItem): boolean {
  const messages = item.kind === 'tool-group' || item.kind === 'todo-burst'
    ? item.msgs
    : item.kind === 'callback-burst'
      ? item.entries.map((entry) => entry.msg)
      : [item.msg]
  return messages.some((message) => message.role === 'assistant' && messageMedia(message).length > 0)
}

function itemFirstMsg(item: MessageItem): Message {
  if (item.kind === 'tool-group' || item.kind === 'todo-burst') return item.msgs[0]
  if (item.kind === 'callback-burst') return item.entries[0].msg
  return item.msg
}

function itemFirstRawIndex(item: MessageItem): number {
  if (item.kind === 'tool-group' || item.kind === 'callback-burst' || item.kind === 'todo-burst') return item.startIndex
  return item.index
}

function itemLastRawIndex(item: MessageItem): number {
  if (item.kind === 'tool-group') return item.startIndex + item.msgs.length - 1
  if (item.kind === 'todo-burst') return item.endIndex
  if (item.kind === 'callback-burst') return item.startIndex + item.entries.length - 1
  return item.index
}

function itemHasActiveDelegation(item: MessageItem): boolean {
  const rows = item.kind === 'tool-group' || item.kind === 'todo-burst'
    ? item.msgs
    : item.kind === 'callback-burst'
      ? item.entries.map((entry) => entry.msg)
      : [item.msg]
  return rows.some((message) => message.blocks?.some((block) =>
    (block.type === 'delegation' || block.payload.kind === 'native-agents') && isActiveDelegationStatus(block.status),
  ))
}

export function buildFoldSummary(run: MessageItem[], messages: Message[], answerIndex: number): FoldSummaryData {
  let tools = 0
  let updates = 0
  const teammates = new Set<string>()
  const nativeAgents = new Set<string>()
  for (const item of run) {
    if (item.kind === 'tool-group') {
      tools += item.msgs.length
      continue
    }
    if (item.kind === 'dispatch-call') {
      tools += 1
      continue
    }
    if (item.kind === 'callback-burst') {
      for (const entry of item.entries) {
        teammates.add(entry.data.employee)
      }
      continue
    }
    if (item.kind === 'todo-burst') continue
    const msg = item.msg
    if (msg.role === 'notification') {
      const callback = parseTeammateReply(msg)
      if (callback) {
        teammates.add(callback.employee)
        continue
      }
      const relay = parseAgentRelay(msg)
      if (relay) {
        teammates.add(relay.fromLabel)
      }
      continue
    }
    // Interim prose the model wrote on the way to the answer.
    if (isAnswerMessage(msg) && messageMedia(msg).length === 0) updates += 1
    for (const block of msg.blocks || []) {
      if (block.payload.kind === 'native-agents' && Array.isArray(block.payload.items)) {
        for (const agent of block.payload.items) {
          if (agent && typeof agent === 'object' && !Array.isArray(agent) && typeof agent.id === 'string') nativeAgents.add(agent.id)
        }
      }
      const employee = block.payload?.employee
      if (typeof employee === 'string' && employee) {
        teammates.add(employee)
      }
    }
  }
  return { durationMs: settledDurationMs(messages, answerIndex), tools, teammates: teammates.size, updates, ...(nativeAgents.size ? { nativeAgents: nativeAgents.size } : {}) }
}

export type RenderGroup =
  | { kind: 'plain'; item: MessageItem }
  | { kind: 'fold'; id: string; items: MessageItem[]; answered: boolean; liveCompletion: boolean; collapseRequested: boolean; summary: FoldSummaryData; answerIdx: number }

/** A later ask exists, so this answered region is a candidate to file itself
 *  away. Whether it actually may is geometry the region owns — see
 *  `foldIsAboveViewport`: a send moves nothing the reader can see. */
export function hasLaterAsk(messages: Message[], answerIndex: number): boolean {
  return answerIndex >= 0 && messages.slice(answerIndex + 1).some((message) => message.role === 'user')
}

export function partitionForFold(
  items: MessageItem[],
  messages: Message[],
  incompleteTurnIds: ReadonlySet<string>,
  liveFinalResponseId: string | null,
  liveTerminalDelegationIds: ReadonlySet<string>,
): RenderGroup[] {
  const answerIdx = finalAnswerIndices(messages)
  const turnIds = turnIdByIndex(messages)

  // A fold wraps the work leading up to each visible answer: tool calls,
  // interim prose, the triggering callbacks/relays, delegation and dispatch
  // rows BEFORE that segment's answer. The answer stays outside, and the work
  // after it opens a NEW fold — so one logical turn can hold several
  // (fold → visible reply) segments (reply, child re-invoke, reply again).
  // System banners and media-bearing assistant rows stay outside too; either
  // one splits a mid-turn region without orphaning the work around it.
  const folds = (item: MessageItem): boolean => {
    const msg = itemFirstMsg(item)
    if (msg.role === 'user') return false
    if (item.kind === 'message' && isSystemBanner(item.msg)) return false
    if (itemHasAssistantMedia(item)) return false
    if (itemHasActiveDelegation(item)) return false
    if (incompleteTurnIds.has(turnIds[itemFirstRawIndex(item)])) return false
    const answer = answerIdx[itemFirstRawIndex(item)]
    // No true final answer means no fold DOM at all: active evidence renders in
    // the ordinary stream until completion creates the completed-turn region.
    if (answer === -1) return false
    return itemLastRawIndex(item) < answer
  }

  const groups: RenderGroup[] = []
  const turnSeq = new Map<string, number>()
  let i = 0
  while (i < items.length) {
    if (!folds(items[i])) {
      groups.push({ kind: 'plain', item: items[i] })
      i++
      continue
    }
    // Consecutive foldable items form one region. A run never crosses a
    // segment boundary by construction: the user message, each segment's
    // answer, and any interim reply are all non-foldable, so they break it.
    const run: MessageItem[] = []
    while (i < items.length && folds(items[i])) {
      run.push(items[i])
      i++
    }
    const answer = answerIdx[itemFirstRawIndex(run[0])]
    const answered = answer !== -1
    // Region identity is TURN-scoped with a per-turn sequence, never
    // first-item-scoped: a turn can hold several folds (one before each
    // answer), and streaming can grow a run's first evidence row — a
    // first-item key would remount the region as a fresh instance resting
    // folded, snap-collapsing the middle instead of playing the anchored fold.
    // The (anchorId, seq) pair keeps each fold stable across those changes.
    let turnAnchor = -1
    for (let j = itemFirstRawIndex(run[0]); j >= 0; j--) {
      if (messages[j].role === 'user') {
        turnAnchor = j
        break
      }
    }
    const anchorId = turnAnchor >= 0 ? (messages[turnAnchor].id || `t${turnAnchor}`) : 'head'
    const seq = turnSeq.get(anchorId) ?? 0
    turnSeq.set(anchorId, seq + 1)
    groups.push({
      kind: 'fold',
      id: `${anchorId}-${seq}`,
      items: run,
      answered,
      liveCompletion: messages[answer]?.id === liveFinalResponseId || run.some((item) => {
        const rows = item.kind === 'tool-group' || item.kind === 'todo-burst'
          ? item.msgs
          : item.kind === 'callback-burst'
            ? item.entries.map((entry) => entry.msg)
            : [item.msg]
        return rows.some((message) => message.blocks?.some((block) => liveTerminalDelegationIds.has(block.id)))
      }),
      collapseRequested: hasLaterAsk(messages, answer),
      summary: buildFoldSummary(run, messages, answer),
      answerIdx: answer,
    })
  }
  // When an exempt row splits one turn into several regions they all answer at
  // the same instant, so only the region nearest the answer states the settled
  // duration; the earlier siblings drop it rather than repeat it.
  const seenAnswers = new Set<number>()
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]
    if (group.kind !== 'fold' || group.answerIdx === -1) continue
    if (seenAnswers.has(group.answerIdx)) {
      group.summary = { ...group.summary, durationMs: null }
    }
    seenAnswers.add(group.answerIdx)
  }
  return groups
}

/* ── Shared assistant row shell ─────────────────────────── */

// ONE shell, used byte-identically by the streaming container and the final
// MessageRow that replaces it. The structural-parity guarantee (the swap can
// never move the text) holds because both sides render THIS component — no
// hand-copied class strings that can drift apart.

export function AssistantRowShell({ transcript, entering, children }: { transcript?: React.ReactNode; entering?: boolean; children?: React.ReactNode }) {
  return (
    <div className="assistant-msg-row flex min-w-0 justify-start mb-[var(--space-1)]">
      {/* A row that is all blocks has no transcript to carry the enter mark,
          so the bubble carries it — the same keyframe, one element out. */}
      <div data-msg-enter={(transcript == null && entering) || undefined} className="assistant-msg-bubble flex min-w-0 flex-col">
        {transcript != null && (
          <div data-msg-enter={entering || undefined} className="assistant-transcript py-[var(--space-1)] text-[var(--text-primary)] text-[length:var(--text-body)]">
            {transcript}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/* ── MessageActions — subtle copy/retry row under a message ─ */

const ACTION_BTN =
  'inline-flex h-[40px] w-[40px] md:h-[26px] md:w-[26px] items-center justify-center rounded-[7px] border-none bg-transparent text-[var(--text-quaternary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-quaternary)]'
const MESSAGE_ACTIONS_ROW = 'msg-actions mt-0.5 -ml-1 flex h-[40px] md:h-[26px] items-center gap-0.5'

function MessageActions({ id, text, onRetry, retryDisabled }: { id: string; text: string; onRetry?: () => void; retryDisabled?: boolean }) {
  const [copied, setCopied] = useState(false)
  const tts = useMessageTts(id, text)
  const speaking = tts.phase === 'playing'
  const loading = tts.phase === 'loading'
  function handleCopy() {
    if (!text) return
    void copyText(text).then((result) => {
      if (result.status !== 'performed') return
      setCopied(true); setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div className={MESSAGE_ACTIONS_ROW}>
      <button onClick={handleCopy} aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy'} className={ACTION_BTN}>
        {copied ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      {/* Read aloud — toggles play↔pause. Custom (Kokoro) TTS with a browser
          Web Speech fallback; only one message speaks at a time. */}
      <button
        onClick={tts.toggle}
        aria-label={speaking ? 'Pause' : loading ? 'Loading audio' : 'Read aloud'}
        aria-pressed={speaking || loading}
        title={speaking ? 'Pause' : 'Read aloud'}
        className={ACTION_BTN}
      >
        {loading ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : speaking ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="6 3 20 12 6 21 6 3" />
          </svg>
        )}
      </button>
      {onRetry && (
        <button onClick={onRetry} disabled={retryDisabled} aria-label="Retry" title="Resend the previous message" className={ACTION_BTN}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4v6h6M23 20v-6h-6" />
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
          </svg>
        </button>
      )}
    </div>
  )
}

/* ── MessageRow — memoized per-message renderer ─────────── */

/** Row-position facts for each message, resolved once per transcript commit. */
export interface RowMeta {
  showTimestamp: boolean
  prevRole: Message['role'] | null
  /** The user message a retry on this row would resend. */
  prevUserText: string
  /** This row closes its engine segment of a FINISHED turn: it is the answer
   *  the reader acts on. A turn still running — or interrupted with a half
   *  written row in it — has no such row; its newest prose is still interim. */
  isFinalAnswer: boolean
}

export function buildRowMeta(messages: Message[], pendingTurnId: string | null): RowMeta[] {
  const answers = finalAnswerIndices(messages)
  const turnIds = turnIdByIndex(messages)
  const openTurns = openTurnIds(messages, turnIds, answers)
  let lastUserText = ''
  return messages.map((msg, i) => {
    const meta: RowMeta = {
      showTimestamp: shouldShowTimestamp(messages, i),
      prevRole: i > 0 ? messages[i - 1].role : null,
      prevUserText: lastUserText,
      isFinalAnswer: answers[i] === i && (msg.meta?.assistantPhase === 'final'
        || (turnIds[i] !== pendingTurnId && !openTurns.has(turnIds[i]))),
    }
    if (msg.role === 'user' && msg.content.trim()) lastUserText = msg.content
    return meta
  })
}

interface MessageRowProps {
  msg: Message
  index: number
  /** Row-position facts, resolved by the transcript. Passing the whole message
   *  array instead would re-render every memoised row on every append. */
  showTimestamp: boolean
  prevRole: Message['role'] | null
  prevUserText: string
  isFinalAnswer: boolean
  loading?: boolean
  onRetry?: (text: string, media?: MediaAttachment[]) => void
  onPeek?: (peek: CommsPeekData) => void
  /** Live-arrival stagger index for comms rows (null = not arriving). */
  arrival?: number | null
  /** The row arrived live and owes its one enter animation. */
  entering?: boolean
  blockArrivals?: ReadonlyMap<string, LiveBlockArrival>
}

const MessageRow = React.memo(function MessageRow({ msg, index: i, showTimestamp, prevRole, prevUserText, isFinalAnswer, loading, onRetry, onPeek, arrival, entering, blockArrivals }: MessageRowProps) {
  const isUser = msg.role === 'user'
  const isNotification = msg.role === 'notification'
  const media = messageMedia(msg)
  const blocks = msg.blocks || []
  const hasBlocks = blocks.length > 0
  const teammate = useMemo(() => parseTeammateReply(msg), [msg])
  const relay = useMemo(() => (teammate ? null : parseAgentRelay(msg)), [msg, teammate])

  // Strip media URLs from text for display
  let textContent = msg.content
  if (media.length > 0 && !msg.media) {
    media.forEach(m => {
      textContent = textContent.replace(m.url, '')
      textContent = textContent.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    })
    textContent = textContent.trim()
  }
  // Defensive: never show the engine-only "Attached files:\n- /abs/path" block that
  // gets appended to the prompt for the CLI. Attachments render as chips/thumbnails.
  textContent = stripAttachedFilesBlock(textContent)
  // Hide auto-generated content labels for media-only messages
  if (msg.media && msg.media.length > 0) {
    const isAutoLabel = textContent.startsWith('[') && textContent.endsWith(']')
    if (isAutoLabel) textContent = ''
  }
  const isBlockFallbackText = hasBlocks && blocks.some((block) => {
    const content = textContent.trim()
    return content === blockFallbackContent(block).trim()
      || content === (block.title || '').trim()
      || content === (block.summary || '').trim()
  })
  if (isBlockFallbackText) textContent = ''

  // Memoize the expensive formatting — re-runs only when textContent changes.
  // User bubbles render tight lines (a single Enter is a line break, not a
  // paragraph); assistant markdown keeps its paragraph rhythm.
  const formattedContent = useMemo(
    () => formatMessage(textContent, isUser ? { tightLines: true } : undefined),
    [textContent, isUser],
  )

  // Memoize timestamp formatting — avoids Date allocations on every parent re-render
  const formattedTimestamp = useMemo(() => formatTimestamp(msg.timestamp), [msg.timestamp])

  return (
    <div key={msg.id || i} data-message-id={msg.id || `idx-${i}`} data-final-answer={isFinalAnswer || undefined}>
      {/* Timestamp divider */}
      {showTimestamp && <TimestampDivider label={formattedTimestamp} />}

      {/* Spacing between role switches — shared with the streaming container
          (turnSpacerClass) so the stream→final swap cannot move the text. */}
      {!showTimestamp && prevRole && (
        <div className={turnSpacerClass(prevRole, msg.role)} />
      )}

      {/* Notification message — centered system-style banner */}
      {isNotification && !teammate && !relay && (
        <div className="flex justify-center px-[var(--space-4)] mb-[var(--space-1)]">
          <div className="notification-msg-bubble flex items-start gap-[var(--space-2)] py-[var(--space-3)] px-[var(--space-4)] rounded-[var(--radius-md)] bg-[var(--fill-secondary)] text-[var(--text-secondary)] text-[length:var(--text-caption1)] leading-[var(--leading-relaxed)] max-w-[85%]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 opacity-60">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span>{formattedContent}</span>
          </div>
        </div>
      )}

      {teammate && (
        <div className="assistant-msg-row min-w-0">
          <TeammateReply
            data={teammate}
            timestamp={msg.timestamp}
            messageId={msg.id || `idx-${i}`}
            onPeek={onPeek}
            arriving={arrival != null}
            arrivalDelayMs={arrival != null ? commsArrivalDelayMs(arrival) : undefined}
          />
        </div>
      )}

      {relay && (
        <div className="assistant-msg-row min-w-0">
          <AgentRelay
            data={relay}
            timestamp={msg.timestamp}
            messageId={msg.id || `idx-${i}`}
            onPeek={onPeek}
            arriving={arrival != null}
            arrivalDelayMs={arrival != null ? commsArrivalDelayMs(arrival) : undefined}
          />
        </div>
      )}

      {/* User message */}
      {isUser && (
        <UserMessageSlot
          msg={msg}
          messageId={msg.id || `idx-${i}`}
          text={textContent}
          content={formattedContent}
          media={media}
          entering={entering}
          onRetry={onRetry}
        />
      )}

      {/* Assistant message — same shell as the streaming container. */}
      {!isUser && !isNotification && (
        <AssistantRowShell transcript={textContent ? formattedContent : undefined} entering={entering}>
          {blocks.length > 0 && (
            <div className="mt-1.5 flex min-w-0 max-w-full flex-col items-start gap-1.5">
              {blocks.map((block) => (
                <ChatBlockInline
                  key={block.id}
                  block={block}
                  onPeek={onPeek}
                  arrival={blockArrivals?.get(block.id)}
                />
              ))}
            </div>
          )}

          {/* Media attachments */}
          {media.length > 0 && <MessageMedia media={media} isUser={false} />}

          {/* Copy / read aloud / retry, once per COMPLETED turn: the answer the
              reader acts on carries it, and the interim prose the fold puts
              away reserves no band for one it never shows. A turn still
              running has no answer yet, so none of its rows carries it. */}
          {textContent && isFinalAnswer && (
            <div>
              <div className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-secondary)]">{msg.meta?.turnOutcome === 'error' ? 'Turn failed' : 'Final answer'}</div>
              <MessageActions
              id={msg.id || `idx-${i}`}
              text={textContent}
              onRetry={onRetry && prevUserText ? () => onRetry(prevUserText) : undefined}
              retryDisabled={loading}
              />
            </div>
          )}
        </AssistantRowShell>
      )}
    </div>
  )
})

/* ── StreamingBubble — always re-renders on every token ── */

// Structural parity rule: the streaming row shares the final row's prefix, shell
// and action-row footprint. Mid-stream it IS the presumptive answer, so it
// reserves the band the answer will carry and a bottom-pinned stream→final swap
// cannot move its first line. A stream that resolves into interim prose keeps no
// band, and only because more content landed under it.
function StreamingBubble({ streamingText, prevMessage, startedAt }: {
  streamingText: string
  prevMessage?: Message
  startedAt: number
}) {
  const formattedContent = useStreamingFormat(streamingText)
  const showTimestamp = !prevMessage || startedAt - prevMessage.timestamp > 5 * 60 * 1000
  return (
    <div data-streaming>
      {showTimestamp && <TimestampDivider label={formatTimestamp(startedAt)} />}
      {!showTimestamp && prevMessage && (
        <div className={turnSpacerClass(prevMessage.role, 'assistant')} />
      )}
      <AssistantRowShell
        transcript={(
          <>
            {formattedContent}
            <span className="stream-caret" aria-hidden="true" />
          </>
        )}
      >
        <div data-message-actions-reserve aria-hidden="true" className={MESSAGE_ACTIONS_ROW} />
      </AssistantRowShell>
    </div>
  )
}

/* ── Component ──────────────────────────────────────────── */

interface ChatMessagesProps {
  messages: Message[]
  loading: boolean
  /** The session's history is still arriving — it is not an empty conversation. */
  hydrating?: boolean
  /** The latest turn has started but has not produced a terminal assistant response. */
  turnPending?: boolean
  /** The assistant row appended by the live terminal response event. */
  liveFinalResponseId?: string | null
  streamingText?: string
  /** Resend a prior user message (assistant action-row "retry"). */
  onRetry?: (text: string, media?: MediaAttachment[]) => void
  hasOlderMessages?: boolean
  loadingOlderMessages?: boolean
  olderMessagesError?: Error | null
  onLoadOlderMessages?: () => Promise<void> | void
  /** Open the read-only report panel for a comms ledger line. */
  onPeek?: (peek: CommsPeekData) => void
  blockArrivals?: ReadonlyMap<string, LiveBlockArrival>
  liveTerminalDelegationIds?: ReadonlySet<string>
  blockAnnouncement?: string
  /** Final in-thread object. It remains inside the transcript scroll owner. */
  footer?: React.ReactNode
  /** Shown in place of the message list while there is nothing to show yet. */
  emptyState?: React.ReactNode
  /** Where the reader left this transcript. Opens there rather than at the bottom. */
  initialScrollTop?: number
}

function latestTurnId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].id || `t${i}`
  }
  return null
}

export function ChatMessages({
  messages,
  loading,
  hydrating = false,
  turnPending = loading,
  liveFinalResponseId = null,
  streamingText,
  onRetry,
  hasOlderMessages = false,
  loadingOlderMessages = false,
  olderMessagesError = null,
  onLoadOlderMessages,
  onPeek,
  blockArrivals = new Map(),
  liveTerminalDelegationIds = new Set(),
  blockAnnouncement = '',
  footer,
  emptyState,
  initialScrollTop,
}: ChatMessagesProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const pendingAnchorRef = useRef<ScrollAnchor | null>(null)
  const pendingVirtualAnchorRef = useRef<VirtualAnchor | null>(null)
  const firstMessageIdRef = useRef<string | null>(null)
  firstMessageIdRef.current = messages[0]?.id ?? null
  const olderRequestInFlightRef = useRef(false)

  // The hook owns terminal-response lifecycle independently of `loading`, which
  // can clear for waiting/idle/stopped states. Until a real final response lands,
  // the latest turn remains ordinary stream content with no fold DOM.
  const previousTurnPendingRef = useRef(turnPending)
  const turnJustCompleted = previousTurnPendingRef.current && !turnPending
  useEffect(() => {
    previousTurnPendingRef.current = turnPending
  }, [turnPending])
  const latestMessage = messages.at(-1)
  const effectiveLiveFinalResponseId = liveFinalResponseId ?? (
    turnJustCompleted && latestMessage?.role === 'assistant' && !latestMessage.partial
      ? latestMessage.id ?? null
      : null
  )
  const currentTurnId = latestTurnId(messages)
  const liveFinalPresent = effectiveLiveFinalResponseId === null
    || messages.some((message) => message.id === effectiveLiveFinalResponseId)
  // The row facts key off the id, not the set: a fresh Set per render would
  // rebuild them on every streamed token — the whole transcript, per token.
  const pendingTurnId = turnPending || !liveFinalPresent ? currentTurnId : null
  const incompleteTurnIds = pendingTurnId ? new Set([pendingTurnId]) : new Set<string>()

  // Memoize grouped messages to avoid re-running on streaming-only re-renders
  const groupedMessages = useMemo(() => groupMessages(messages), [messages])
  const renderGroups = partitionForFold(
    groupedMessages,
    messages,
    incompleteTurnIds,
    effectiveLiveFinalResponseId,
    liveTerminalDelegationIds,
  )

  // Windowing. The threshold counts ROWS, not groups: three groups can be 500
  // rows. The footer branch stays plain — no room for a total-size spacer.
  const groupKeys = useMemo(() => renderGroups.map(groupKey), [renderGroups])
  const groupKeysRef = useRef(groupKeys)
  groupKeysRef.current = groupKeys
  const virtualized = !footer && groupedMessages.length >= VIRTUALIZE_THRESHOLD
  const virtualizedRef = useRef(virtualized)
  virtualizedRef.current = virtualized
  // The block's offset goes back in as `scrollMargin`: it is the only way the
  // virtualizer's row offsets and the scroller's own `scrollTop` describe the
  // same place, and a re-measured row is classified by comparing the two.
  const getScrollElement = useCallback(() => scrollContainerRef.current, [])
  const virtualBlockRef = useRef<HTMLDivElement>(null)
  const virtualBlockOffset = useVirtualBlockOffset(virtualBlockRef, getScrollElement)
  const virtualizer = useTranscriptVirtualizer(renderGroups, groupKeys, virtualized, getScrollElement, virtualBlockOffset)
  const expansionStore = useTranscriptExpansionStore()

  // The true bottom of a virtualised thread is only known once the last row has
  // measured: `scrollToIndex` on the last row resolves to the scroller's own maximum.
  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const count = groupKeysRef.current.length
    if (count > 0) scrollTranscriptTo(virtualizer, (v) => v.scrollToIndex(count - 1, { align: 'end', behavior }))
  }, [virtualizer])

  // Stick-to-bottom: one hook owns follow-intent, growth-follow, resize/keyboard,
  // tab-return, the open, and the jump affordance. See use-stick-to-bottom.ts.
  const { containerRef, showJump, unreadCount, scrollToBottom } = useStickToBottom({
    streamingText,
    messageCount: messages.length,
    latestMessageKey: messages.at(-1)?.id ?? null,
    scrollToEnd: virtualized ? scrollToEnd : undefined,
    takeLastWriteTop: virtualized ? () => takeTranscriptWriteTop(virtualizer) : undefined,
    initialScrollTop,
    contentSize: virtualized ? () => virtualizer.getTotalSize() : undefined,
  })
  const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node
    setScrollEl(node)
    containerRef(node)
  }, [containerRef])

  useEffect(() => {
    olderRequestInFlightRef.current = loadingOlderMessages
  }, [loadingOlderMessages])

  // `MessageRow` is memoised, so a caller that rebuilds `onRetry` on every render
  // re-renders the entire transcript on every streaming token. Hand the rows one
  // identity and read the live callback through a ref.
  const onRetryRef = useRef(onRetry)
  onRetryRef.current = onRetry
  const stableRetry = useCallback((text: string, media?: MediaAttachment[]) => onRetryRef.current?.(text, media), [])
  const retry = onRetry ? stableRetry : undefined

  const requestOlderMessages = useCallback(() => {
    const node = scrollContainerRef.current
    if (!node || !hasOlderMessages || !onLoadOlderMessages || olderRequestInFlightRef.current) return
    pendingAnchorRef.current = captureVisibleAnchor(node, 'data-message-id', firstMessageIdRef.current)
    pendingVirtualAnchorRef.current = virtualizedRef.current
      ? captureVirtualAnchor(node, virtualizer, groupKeysRef.current)
      : null
    olderRequestInFlightRef.current = true
    // No restore here: the anchor is only correct once the prepended rows are in
    // the DOM, and the layout effect below is the one place that is true.
    Promise.resolve(onLoadOlderMessages())
      .catch(() => { /* hook owns the visible error state */ })
      .finally(() => { olderRequestInFlightRef.current = false })
  }, [hasOlderMessages, onLoadOlderMessages, virtualizer])

  useEffect(() => {
    if (!scrollEl) return
    const onScroll = () => {
      if (scrollEl.scrollTop <= OLDER_LOAD_THRESHOLD_PX) requestOlderMessages()
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', onScroll)
  }, [requestOlderMessages, scrollEl])

  // Only the prepend the anchor was taken for may spend it. A reply arriving
  // below while the page is still in flight also changes `messages`, and
  // correcting for that commit — which moved nothing above the read position —
  // used to consume the anchor and leave the real prepend uncorrected.
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current
    const node = scrollContainerRef.current
    if (!anchor || !node || messages[0]?.id === anchor.firstId) return
    // Once virtualised the anchored row is a hundred rows above the window by the
    // time the page lands, so it is unmounted and has no rect to measure. That
    // takes two commits, and this effect is deliberately unkeyed so the second
    // one — the commit the coarse scroll causes — is a render this runs after.
    const spent = applyTranscriptAnchor({
      node,
      virtualizer,
      keys: groupKeysRef.current,
      anchor,
      virtual: pendingVirtualAnchorRef.current,
    })
    if (!spent) return
    pendingAnchorRef.current = null
    pendingVirtualAnchorRef.current = null
  })

  const { commsArrivals, commsArrival, isEntering } = useMessageArrivals(messages, streamingText ?? '', groupedMessages)

  // Captured when the first token lands so the streaming container can render
  // the same timestamp-divider decision as the final row that will replace it.
  const streamStartRef = useRef<number | null>(null)
  if (streamingText && streamStartRef.current == null) streamStartRef.current = Date.now()
  if (!streamingText && streamStartRef.current != null) streamStartRef.current = null
  const activeToolGroupStart = useMemo(() => {
    if (!loading) return -1
    for (let i = groupedMessages.length - 1; i >= 0; i--) {
      const item = groupedMessages[i]
      if (item.kind === 'tool-group' && item.msgs.some((msg) => !isToolDone(msg))) {
        return item.startIndex
      }
    }
    return -1
  }, [groupedMessages, loading])

  // Stop any in-progress read-aloud when the chat view unmounts (navigation away).
  // A row scrolling out of the virtual window is not that: the read-aloud
  // controller lives outside the tree, so playback and its controls both survive.
  useEffect(() => () => stopMessageTts(), [])

  // Row-position facts, resolved once per commit instead of inside every row. A
  // memoised row that reads the whole message array re-renders on every append,
  // which on a long transcript is the whole transcript per message.
  const rowMeta = useMemo(() => buildRowMeta(messages, pendingTurnId), [messages, pendingTurnId])

  // ONE renderer, used by both paths, so the windowed and plain transcripts
  // cannot drift apart.
  const renderItem = (item: MessageItem) => {
    if (item.kind === 'tool-group' || item.kind === 'dispatch-call' || item.kind === 'callback-burst' || item.kind === 'todo-burst') {
      const firstMsg = itemFirstMsg(item)
      const startIndex = item.kind === 'dispatch-call' ? item.index : item.startIndex
      const showTimestamp = shouldShowTimestamp(messages, startIndex)
      const prevMsg = startIndex > 0 ? messages[startIndex - 1] : null
      const rowId = firstMsg.id || `tg-${startIndex}`
      return (
        <div key={`tg-${firstMsg.id || startIndex}`} data-message-id={rowId}>
          {showTimestamp && <TimestampDivider label={formatTimestamp(firstMsg.timestamp)} />}
          {!showTimestamp && prevMsg && (
            <div className={turnSpacerClass(prevMsg.role, 'assistant')} />
          )}
          {item.kind === 'tool-group' && (
            <ToolGroup
              msgs={item.msgs}
              isActive={item.startIndex === activeToolGroupStart}
              groupId={rowId}
              arrivals={commsArrivals}
              isEntering={isEntering}
            />
          )}
          {item.kind === 'dispatch-call' && (
            <div className="assistant-msg-row mb-[var(--space-1)] min-w-0">
              <DispatchRow />
            </div>
          )}
          {item.kind === 'callback-burst' && (
            <div className="assistant-msg-row mb-[var(--space-1)] min-w-0">
              <CallbackBurst
                entries={item.entries}
                onPeek={onPeek}
                arrivals={commsArrivals}
              />
            </div>
          )}
          {item.kind === 'todo-burst' && (
            <div className="assistant-msg-row mb-[var(--space-1)] min-w-0">
              <TodoActivityBurst
                blocks={item.msgs.flatMap((message) => message.blocks ?? [])}
              />
            </div>
          )}
        </div>
      )
    }

    const { msg, index: i } = item
    const meta = rowMeta[i]
    return (
      <MessageRow
        key={msg.id || i}
        msg={msg}
        index={i}
        showTimestamp={meta.showTimestamp}
        prevRole={meta.prevRole}
        prevUserText={meta.prevUserText}
        isFinalAnswer={meta.isFinalAnswer}
        loading={loading}
        onRetry={retry}
        onPeek={onPeek}
        arrival={commsArrival(msg.id)}
        entering={isEntering(msg.id)}
        blockArrivals={blockArrivals}
      />
    )
  }

  const renderGroup = (group: RenderGroup) => {
    if (group.kind === 'plain') return renderItem(group.item)
    return (
      <FoldRegion
        key={`fold-${group.id}`}
        answered={group.answered}
        liveCompletion={group.liveCompletion}
        collapseRequested={group.collapseRequested}
        summary={group.summary}
        windowed={virtualized}
      >
        {group.items.map(renderItem)}
      </FoldRegion>
    )
  }

  return (
    <TranscriptExpansionProvider value={expansionStore}>
    <div className="relative flex-1 min-h-0 bg-[var(--bg)]">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {blockAnnouncement}
      </span>
      {/* Not while hydrating: a transcript still on its way is not an empty one. */}
      {messages.length === 0 && !loading && !hydrating && <TranscriptEmptyState>{emptyState}</TranscriptEmptyState>}
      <div ref={setScrollContainerRef} style={{ overflowAnchor: 'auto' }} className="chat-messages-scroll h-full overflow-y-auto overflow-x-hidden bg-[var(--bg)] min-h-0">
        <div className={`mx-auto w-full max-w-[var(--chat-measure)] pt-[72px] lg:pt-[88px] ${footer ? 'flex min-h-full flex-col justify-end pb-0' : 'pb-[var(--space-6)]'}`}>
          {hasOlderMessages && <OlderPageRow loading={loadingOlderMessages} error={olderMessagesError} />}
          {virtualized ? (
            <div ref={virtualBlockRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((row) => (
                // `data-index` is what the virtualizer measures by, so the row's
                // own `data-message-id` stays where scroll-anchor.ts looks for it.
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  // `row.start` counts from the scrollport's top now that
                  // `scrollMargin` is declared, and the block is already there.
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start - virtualBlockOffset}px)` }}
                >
                  {renderGroup(renderGroups[row.index])}
                </div>
              ))}
            </div>
          ) : renderGroups.map(renderGroup)}

          {/* Streaming message — shows text as it arrives, always re-renders */}
          {streamingText && (
            <StreamingBubble
              streamingText={streamingText}
              prevMessage={messages.at(-1)}
              startedAt={streamStartRef.current ?? Date.now()}
            />
          )}

          {/* Running indicator — pre-first-token only; once streamingText arrives the
              caret carries the "live" signal, so suppress this to avoid a double cue. */}
          {loading && messages.length > 0 && !streamingText && (
            <ThinkingIndicator prevRole={messages[messages.length - 1].role} />
          )}

          {footer && (
            <div className="mt-[var(--space-5)] px-[var(--space-3)] lg:px-[var(--space-8)]">
              {footer}
            </div>
          )}

        </div>
      </div>

      {/* Jump-to-latest — outside the scrollable transcript so it stays pinned
          above the composer instead of moving with the message content. */}
      <JumpToLatestButton
        show={showJump}
        unreadCount={unreadCount}
        onClick={() => scrollToBottom('smooth')}
      />

      {/* Keyframe animations + responsive bubble widths */}
      <style>{`
        @keyframes jinn-pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes jinn-jump-in {
          from { opacity: 0; transform: translateY(8px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes jinn-jump-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(6px) scale(0.98); }
        }
        .assistant-msg-bubble { max-width: 100%; overflow-wrap: break-word; word-break: break-word; }
        .user-msg-bubble { max-width: 90%; overflow-wrap: break-word; word-break: break-word; }
        .notification-msg-bubble { overflow-wrap: break-word; word-break: break-word; white-space: pre-wrap; }
        .assistant-msg-row { padding: 0 var(--space-3) !important; }
        @media (min-width: 1024px) {
          .assistant-msg-bubble { max-width: 100%; }
          .user-msg-bubble { max-width: 82%; }
          .assistant-msg-row { padding: 0 var(--space-8) !important; }
        }
        /* Streaming caret — CSS-only, theme-aware via currentColor. */
        .stream-caret {
          display: inline-block;
          width: 0.5em;
          height: 1em;
          margin-left: 1px;
          vertical-align: text-bottom;
          background: currentColor;
          border-radius: 1px;
          opacity: 0.55;
          animation: jinn-caret 1.05s steps(1) infinite;
        }
        @keyframes jinn-caret { 0%, 50% { opacity: 0.55; } 50.01%, 100% { opacity: 0; } }
        /* Message actions — always visible by default (touch). On hover-capable
           pointers, hide at rest and reveal on row hover/focus. No !important. */
        .msg-actions { opacity: 1; transition: opacity 150ms ease; }
        @media (hover: hover) {
          .assistant-msg-row .msg-actions { opacity: 0; }
          .assistant-msg-row:hover .msg-actions,
          .assistant-msg-row:focus-within .msg-actions { opacity: 1; }
        }
        @media (hover: none) {
          .msg-actions button { min-height: 36px; min-width: 36px; }
        }
      `}</style>
    </div>
    </TranscriptExpansionProvider>
  )
}
