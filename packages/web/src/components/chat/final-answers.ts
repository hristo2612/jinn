import { parseMedia, type Message } from '@/lib/conversations'
import { parseTeammateReply } from './teammate-reply'
import { parseAgentRelay } from './agent-relay'
import { validTimestamp } from './message-timestamps'

/** The turn's final answer: an assistant prose message. Tool calls are not
 *  answers, and neither is any block-carrying message — blocks render as
 *  cards/objects (handoffs, dispatches, task lists), not the turn's prose.
 *  Conservative on purpose: when in doubt the evidence stays visible. */
export function isAnswerMessage(msg: Message): boolean {
  if (msg.role !== 'assistant' || msg.toolCall) return false
  if (msg.blocks?.length) return false
  if (msg.meta?.assistantPhase !== 'final' && messageMedia(msg).length) return false
  return Boolean((msg.content || '').trim())
}

export function messageMedia(msg: Message) {
  return msg.media?.length ? msg.media : parseMedia(msg.content)
}

/** A child callback ("dev replied") or an agent relay ("From dev [hop N]"): an
 *  injected notification that RE-INVOKES the model, starting a fresh engine turn
 *  inside the same logical (user) turn. It closes the previous segment so the
 *  earlier reply stays visible, and folds into the engine turn it triggers. */
export function isReinvocationBoundary(msg: Message): boolean {
  return msg.role === 'notification' && Boolean(parseTeammateReply(msg) || parseAgentRelay(msg))
}

/**
 * For each raw message index, the answer that closes its engine-turn segment.
 * Canonical final metadata is authoritative even when callbacks arrived while
 * that turn was still running. Legacy clients without metadata retain the
 * last-prose/boundary fallback. -1 means no closing answer is available.
 *
 * One logical (user) turn can hold several engine turns: the model replies and
 * stops, a child callback re-invokes it, it replies again. Each engine turn keeps
 * its OWN closing answer, so the fold before it is scoped to just that segment's
 * work — the earlier reply and its "Worked for" fold are preserved rather than
 * swallowed by one region reaching the turn's very last block. Interim prose
 * WITHIN one engine turn still folds; each canonical final is a boundary.
 * Exported for tests.
 */
export function finalAnswerIndices(messages: Message[]): number[] {
  const out = new Array<number>(messages.length).fill(-1)
  let nextReply = -1
  // After a re-invocation boundary the NEXT prose above it closes a fresh
  // segment — a preserved reply. But a segment that produced NO prose (pure tool
  // work before a callback) must keep folding toward the downstream reply, so we
  // only re-point `nextReply` when that armed prose actually appears; tools-only
  // work therefore stays in one fold instead of orphaning as bare rows.
  let armed = false
  for (let j = messages.length - 1; j >= 0; j--) {
    if (messages[j].role === 'user') {
      nextReply = -1
      armed = false
      out[j] = -1
      continue
    }
    if (isReinvocationBoundary(messages[j])) {
      // The trigger folds into the engine turn it started (the segment below),
      // and arms the next prose above it as that turn's preserved reply.
      out[j] = nextReply
      armed = true
      continue
    }
    // A restored `partial` prose row is still middle evidence. The first
    // non-partial prose after a boundary (or the turn's first) is a preserved
    // reply; later prose in the same engine turn is interim and folds toward it.
    if (isCompletedAnswer(messages[j])
      && (messages[j].meta?.assistantPhase === 'final' || nextReply === -1 || armed)) {
      nextReply = j
      armed = false
    }
    out[j] = nextReply
  }
  return out
}

function isCompletedAnswer(message: Message): boolean {
  return !message.partial && message.meta?.assistantPhase !== 'commentary' && isAnswerMessage(message)
}

/** Locate the durable start of the engine segment closed by `answerIndex`.
 * The initiating user starts the first segment. After a completed reply, a
 * callback/relay starts the next one; callbacks that arrive before any reply
 * remain evidence inside the still-open initial segment. */
function settledSegmentStartIndex(messages: Message[], answerIndex: number): number {
  let userIndex = -1
  for (let index = answerIndex - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      userIndex = index
      break
    }
  }

  let startIndex = userIndex
  let completedReply = false
  for (let index = userIndex + 1; index < answerIndex; index++) {
    const message = messages[index]
    if (isReinvocationBoundary(message)) {
      if (completedReply) {
        startIndex = index
        completedReply = false
      }
      continue
    }
    if (isCompletedAnswer(message)) completedReply = true
  }
  return startIndex
}

/** A settled fold measures one durable engine segment: initiating user or
 * callback/relay boundary → canonical final assistant row. Legacy rows may lack
 * one boundary; in that case, recover only from timestamped evidence inside
 * the same segment. A single evidence row cannot establish an interval. */
export function settledDurationMs(messages: Message[], answerIndex: number): number | null {
  if (answerIndex < 0 || answerIndex >= messages.length) return null

  const recorded = recordedDuration(messages, answerIndex)
  if (recorded !== undefined) return recorded
  const segmentStart = settledSegmentStartIndex(messages, answerIndex)
  const start = firstTimestamp(messages, Math.max(0, segmentStart), answerIndex, 1)
  const end = firstTimestamp(messages, answerIndex, segmentStart, -1)
  if (!start || !end || start.index === end.index || end.time < start.time) return null
  return end.time - start.time
}

function firstTimestamp(messages: Message[], from: number, until: number, step: 1 | -1) {
  for (let index = from; index !== until; index += step) {
    const time = validTimestamp(messages[index].timestamp)
    if (time !== null) return { index, time }
  }
  return null
}

function recordedDuration(messages: Message[], answerIndex: number): number | null | undefined {
  const answer = messages[answerIndex]
  const meta = answer.meta ?? {}
  const recordedStart = typeof meta.turnStartedAt === 'number' ? validTimestamp(meta.turnStartedAt) : null
  if (recordedStart !== null) return Math.max(0, answer.timestamp - recordedStart)
  // A queued callback's arrival is not its execution start. Legacy consecutive
  // canonical answers have no exact start evidence for the later turn.
  if (meta.assistantPhase !== 'final') return undefined
  for (let index = answerIndex - 1; index >= 0; index--) {
    if (messages[index].role === 'user' || isReinvocationBoundary(messages[index])) break
    if (messages[index].meta?.assistantPhase === 'final') return null
  }
  return undefined
}
