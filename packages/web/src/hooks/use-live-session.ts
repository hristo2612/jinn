/**
 * Live messages, streaming events and history reconciliation for one session.
 * Shared by ChatPane and the read-only Talk child-session modal.
 *
 * ChatPane drives optimistic sends through the write API, including uploaded
 * media identities before dispatch. Read-only consumers seed loading from the
 * server and skip the editable pane's localStorage intermediate cache.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { BackgroundActivity } from '@/lib/api'
import type { Message, MediaAttachment } from '@/lib/conversations'
import {
  clearIntermediateMessages,
  messageIdentityKey,
  reconcileMessages,
} from '@/lib/conversations'
import {
  applyBlockEnvelopeToMessages,
  isActiveDelegationStatus,
  isBlockEnvelope,
  isChatBlock,
  isTerminalDelegationStatus,
  type ChatBlockStatus,
  type ChatBlockType,
  type LiveBlockArrival,
} from '@/lib/blocks'
import { beginSendMessages, clearPendingSend, markSendFailed } from '@/components/chat/message-send-state'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'

/** After a reconnect, if a turn is still 'loading' but no delta has arrived for
 *  this long, assume the session:completed frame was dropped and reconcile from
 *  the server to clear a stuck spinner. */
export const COMPLETION_WATCHDOG_MS = 8000
const INITIAL_MESSAGE_PAGE_SIZE = 150
const OLDER_MESSAGE_PAGE_SIZE = 100

/** Decide whether the post-reconnect watchdog should treat the turn as stuck
 *  (i.e. recover from a dropped completion). Pure for testing. */
export function shouldRecoverStuckTurn(args: {
  loading: boolean
  msSinceLastDelta: number
  serverStatus: string | undefined
  watchdogMs?: number
}): boolean {
  const watchdogMs = args.watchdogMs ?? COMPLETION_WATCHDOG_MS
  if (!args.loading) return false
  if (args.msSinceLastDelta < watchdogMs) return false
  return args.serverStatus !== 'running'
}

function appendStatusChunk(prev: string, next: string): string {
  if (!prev) return next
  if (!next) return prev
  if (next.startsWith('_') || prev.endsWith('_')) return `${prev}${next}`
  if (/^[,.:;!?)}\]"']/.test(next)) return `${prev}${next}`
  return `${prev} ${next}`
}

function capStatusText(text: string): string {
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

export interface SessionMetaUpdate {
  sessionId?: string
  engine?: string
  engineSessionId?: string
  model?: string
  title?: string
  employee?: string
  archivedAt?: string | null
}

export interface UseLiveSessionOptions {
  /** Gateway subscribe for WS events. */
  subscribe: (fn: GatewayEventListener) => () => void
  /** Gateway connection seq — bumping it triggers reconnect backfill. */
  connectionSeq?: number
  /** Read-only consumers (the Talk modal) seed loading from running state and
   *  never write the localStorage intermediate cache. */
  readOnly?: boolean
  /** Initial optimistic message (just-created-from-new-chat user bubble). */
  pendingUserMessage?: Message
  /** Notified when session meta is loaded (sidebar/tab labels). */
  onMeta?: (meta: SessionMetaUpdate) => void
  /** Notified when a turn completes (sidebar refresh). */
  onRefresh?: () => void
}

export interface UseLiveSessionResult {
  messages: Message[]
  streamingText: string
  loading: boolean
  /** True until a real terminal assistant response is available for this turn. */
  turnPending: boolean
  /** Row id created from the latest live terminal response; null for persistence loads. */
  liveFinalResponseId: string | null
  /** True only for the initial cold fetch of an uncached selected session. */
  hydrating: boolean
  session: Record<string, unknown> | null
  /** Set when the last load failed (so read-only consumers don't hang on a
   *  "Loading…" state forever). Cleared at the start of each load attempt. */
  error: Error | null
  liveContextTokens: number | null
  /** Background work (subagents/background tasks) still running while the
   *  session is officially idle. null = none. Seeded from the session fetch,
   *  kept live via the session:background WS event. */
  backgroundActivity: BackgroundActivity | null
  /** Whether the server has older history before the first loaded message. */
  hasOlderMessages: boolean
  /** True while an older history page is being prepended. */
  loadingOlderMessages: boolean
  /** Set when loading older history fails. */
  olderMessagesError: Error | null
  /** One-use, UI-only provenance for first-time live delegation/dispatch puts. */
  blockArrivals: ReadonlyMap<string, LiveBlockArrival>
  /** Delegations that settled live while this pane was mounted. */
  liveTerminalDelegationIds: ReadonlySet<string>
  /** Coalesced polite live-region copy for rapid live-block batches. */
  blockAnnouncement: string
  /** Re-load (reconcile) a session from the server. */
  reload: (id: string) => Promise<void>
  /** Load and prepend the next older message page. */
  loadOlderMessages: () => Promise<void>
  // --- write API (editable pane only) ---
  /** Optimistically append the user message + arm loading for a send. */
  beginSend: (userMsg: Message) => void
  /** Associate uploaded file identities with the optimistic row before dispatch. */
  updateSendMedia: (messageId: string, media: MediaAttachment[]) => void
  /** A send failed: clear loading + mark that user message failed. */
  failSend: (reason: string) => void
  /** Append a local-only message (status replies, etc.). */
  appendLocal: (msg: Message) => void
  /** Clear the pane (new chat). */
  reset: () => void
}

const SESSION_SNAPSHOT_CACHE_MAX = 16
const SESSION_SNAPSHOT_CACHE_TTL_MS = 10 * 60 * 1000
/** How long a resting snapshot may stand in for a revisit without a refetch. */
export const SESSION_SNAPSHOT_REVISIT_TTL_MS = 30_000

export interface LiveSessionSnapshot {
  messages: Message[]
  streamingText: string
  loading: boolean
  turnPending?: boolean
  session: Record<string, unknown> | null
  liveContextTokens: number | null
  backgroundActivity: BackgroundActivity | null
  hasOlderMessages?: boolean
  updatedAt: number
}

type SnapshotInput = Omit<LiveSessionSnapshot, 'updatedAt'>

const liveSessionSnapshotCache = new Map<string, LiveSessionSnapshot>()

function cloneMessages(messages: Message[]): Message[] {
  return messages.map((message) => ({ ...message }))
}

function messageMeta(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function pruneLiveSessionSnapshotCache(now = Date.now()) {
  for (const [id, snapshot] of liveSessionSnapshotCache) {
    if (now - snapshot.updatedAt > SESSION_SNAPSHOT_CACHE_TTL_MS) {
      liveSessionSnapshotCache.delete(id)
    }
  }

  while (liveSessionSnapshotCache.size > SESSION_SNAPSHOT_CACHE_MAX) {
    let oldestId: string | null = null
    let oldestAt = Infinity
    for (const [id, snapshot] of liveSessionSnapshotCache) {
      if (snapshot.updatedAt < oldestAt) {
        oldestAt = snapshot.updatedAt
        oldestId = id
      }
    }
    if (!oldestId) break
    liveSessionSnapshotCache.delete(oldestId)
  }
}

function readLiveSessionSnapshot(id: string): LiveSessionSnapshot | null {
  pruneLiveSessionSnapshotCache()
  const snapshot = liveSessionSnapshotCache.get(id)
  if (!snapshot) return null
  return {
    ...snapshot,
    messages: cloneMessages(snapshot.messages),
    session: snapshot.session ? { ...snapshot.session } : null,
    backgroundActivity: snapshot.backgroundActivity ? { ...snapshot.backgroundActivity } : null,
  }
}

/** Read a defensive clone from the handoff cache. Preview and destination use
 * this one source so opening full chat never needs a second transcript GET. */
export function readPrefetchedLiveSessionSnapshot(id: string): LiveSessionSnapshot | null {
  return readLiveSessionSnapshot(id)
}

function writeLiveSessionSnapshot(id: string, input: SnapshotInput) {
  if (!input.session && input.messages.length === 0 && !input.streamingText) return
  liveSessionSnapshotCache.set(id, {
    ...input,
    messages: cloneMessages(input.messages),
    session: input.session ? { ...input.session } : null,
    backgroundActivity: input.backgroundActivity ? { ...input.backgroundActivity } : null,
    updatedAt: Date.now(),
  })
  pruneLiveSessionSnapshotCache()
}

/**
 * True when a cached snapshot can stand in for a revisit WITHOUT an immediate
 * refetch: recently current, at rest (not loading, no streaming tail), and a
 * known terminal status. Fails closed for anything uncertain (running,
 * unknown status, missing session) so those still revalidate. Back/forward
 * hops across sessions must not re-issue a full transcript GET per hop.
 */
export function isRestingSnapshot(snapshot: LiveSessionSnapshot, now = Date.now()): boolean {
  if (now - snapshot.updatedAt > SESSION_SNAPSHOT_REVISIT_TTL_MS) return false
  if (snapshot.loading || snapshot.streamingText) return false
  const status = snapshot.session?.status
  return status === 'idle' || status === 'error'
}

/**
 * Drop a session's cached snapshot. Called from the chat page's gateway
 * subscription when a session changes while no pane for it is mounted — started,
 * completed, stopped, errored, renamed, deleted — so the next revisit takes the
 * cold-fetch path instead of trusting a stale snapshot.
 */
export function invalidateLiveSessionSnapshot(id: string) {
  liveSessionSnapshotCache.delete(id)
}

/** Session-record → header/tab meta (shared by the fetch and revisit paths). */
function sessionMetaOf(session: Record<string, unknown>): SessionMetaUpdate {
  return {
    engine: session.engine ? String(session.engine) : undefined,
    engineSessionId: session.engineSessionId ? String(session.engineSessionId) : undefined,
    model: session.model ? String(session.model) : undefined,
    title: session.title ? String(session.title) : undefined,
    employee: session.employee ? String(session.employee) : undefined,
    archivedAt: typeof session.archivedAt === 'string' ? session.archivedAt : null,
  }
}

function normalizeHistoryTimestamp(value: unknown): number {
  const timestamp = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0
}

function normalizeHistoryMessages(history: unknown): { messages: Message[]; firstPartialIndex: number } {
  const rows = Array.isArray(history) ? history as Record<string, unknown>[] : []
  const firstPartialIndex = rows.findIndex((m) => m.partial === true)
  const messages = rows.map((m) => {
    const blocks = Array.isArray(m.blocks) ? m.blocks.filter(isChatBlock) : []
    return {
      id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
      role: (m.role as 'user' | 'assistant' | 'notification') || 'assistant',
      content: String(m.content || m.text || ''),
      // Zero is an explicit "unknown" sentinel. Using Date.now() here makes a
      // legacy row appear to have happened at hydration time and fabricates
      // elapsed work whenever the transcript is reloaded.
      timestamp: normalizeHistoryTimestamp(m.timestamp),
      ...(m.partial === true ? { partial: true } : {}),
      ...(typeof m.toolCall === 'string' && m.toolCall ? { toolCall: m.toolCall } : {}),
      ...(typeof m.toolId === 'string' && m.toolId ? { toolId: m.toolId } : {}),
      ...(Array.isArray(m.media) && m.media.length > 0
        ? { media: m.media as MediaAttachment[] }
        : {}),
      ...(blocks.length > 0
        ? { blocks }
        : {}),
      ...(messageMeta(m.meta) ? { meta: messageMeta(m.meta) } : {}),
    } satisfies Message
  })
  return { messages, firstPartialIndex }
}

function delegationStatesOf(messages: Message[]): Map<string, ChatBlockStatus | undefined> {
  const states = new Map<string, ChatBlockStatus | undefined>()
  for (const message of messages) {
    for (const block of message.blocks || []) {
      if (block.type === 'delegation') states.set(block.id, block.status)
    }
  }
  return states
}

function liveArrivalBlockIdsOf(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const block of message.blocks || []) {
      if (block.type === 'delegation' || block.type === 'dispatch') ids.add(block.id)
    }
  }
  return ids
}

function hasFinalAssistantAfterLastUser(messages: Message[]): boolean {
  let userIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userIndex = i
      break
    }
  }
  if (userIndex < 0) return false
  return messages.slice(userIndex + 1).some((message) =>
    message.role === 'assistant'
    && !message.partial
    && !message.toolCall
    && !message.blocks?.length
    && Boolean(message.content.trim()),
  )
}

function formatTerminalAssistantError(error: unknown): string {
  return `Error: ${String(error)}`
}

export function reconcileCompletedTurnMessages(args: {
  messages: Message[]
  turnStart: number
  finalMessage: Message
  exactResult?: string
}): Message[] {
  const turnStart = args.turnStart >= 0
    ? Math.min(args.turnStart, args.messages.length)
    : args.messages.length
  const exactResult = args.exactResult?.trim() ?? ''
  const preserved = args.messages.slice(turnStart)
    .filter((message) =>
      message.role === 'user'
      || Boolean(message.media?.length)
      || Boolean(message.toolCall)
      || message.role === 'notification'
      || Boolean(message.blocks?.some((block) => block.type === 'delegation' || block.type === 'dispatch'))
      || (message.role === 'assistant' && !message.blocks?.length
        && Boolean(message.content.trim())
        && (!exactResult || message.content.trim() !== exactResult)))
    .map((message) => message.toolCall && !message.content.startsWith('Used ')
      ? { ...message, content: `Used ${message.toolCall}` }
      : message)

  return [
    ...args.messages.slice(0, turnStart),
    ...preserved,
    args.finalMessage,
  ]
}

function isPersistedTerminalAssistantError(message: Message | undefined, error: unknown): boolean {
  if (!message || message.role !== 'assistant') return false
  const detail = String(error)
  return message.content === formatTerminalAssistantError(detail) || message.content === `⛔ ${detail}`
}

function readHasOlderMessages(payload: Record<string, unknown>): boolean {
  const page = payload.messagesPage
  return Boolean(page && typeof page === 'object' && !Array.isArray(page) && (page as { hasOlder?: unknown }).hasOlder === true)
}

function mergeOlderMessages(older: Message[], current: Message[]): Message[] {
  if (older.length === 0) return current
  const seen = new Set<string>()
  const merged: Message[] = []
  for (const message of [...older, ...current]) {
    if (message.id && seen.has(message.id)) continue
    if (message.id) seen.add(message.id)
    merged.push(message)
  }
  return merged
}

function mergePagedSnapshot(current: Message[], snapshot: Message[], preserveOlderLoaded: boolean): Message[] {
  const reconciled = reconcileMessages(current, snapshot)
  if (!preserveOlderLoaded || snapshot.length === 0) return reconciled
  const ids = new Set(reconciled.map((m) => m.id))
  const keys = new Set(reconciled.map(messageIdentityKey))
  const firstSnapshot = snapshot[0]
  const olderLoaded = current.filter((m) =>
    !ids.has(m.id) &&
    !keys.has(messageIdentityKey(m)) &&
    m.timestamp <= firstSnapshot.timestamp,
  )
  return mergeOlderMessages(olderLoaded, reconciled)
}

function hasUnmergedLocalTail(current: Message[], snapshot: Message[]): boolean {
  if (snapshot.length === 0) return current.length > 0
  const snapshotIds = new Set(snapshot.map((m) => m.id))
  const lastSnapshot = snapshot[snapshot.length - 1]
  return current.some((m) =>
    !snapshotIds.has(m.id) &&
    m.timestamp >= lastSnapshot.timestamp &&
    !(m.media && m.media.length > 0),
  )
}

export function __clearLiveSessionSnapshotCacheForTests() {
  liveSessionSnapshotCache.clear()
}

export function __cacheLiveSessionSnapshotForTests(id: string, input: SnapshotInput) {
  writeLiveSessionSnapshot(id, input)
}

export function __getLiveSessionSnapshotCacheSizeForTests() {
  pruneLiveSessionSnapshotCache()
  return liveSessionSnapshotCache.size
}

const liveSessionPrefetches = new Map<string, Promise<Record<string, unknown>>>()

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function waitForPrefetch(
  promise: Promise<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(abortError())
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Warm the same bounded snapshot cache the destination ChatPane consumes.
 * Concurrent requests share one GET; an aborted caller never commits cache. */
export async function prefetchLiveSessionSnapshot(id: string, signal?: AbortSignal): Promise<void> {
  if (readLiveSessionSnapshot(id)) return
  let request = liveSessionPrefetches.get(id)
  if (!request) {
    request = api.getSession(id, { last: INITIAL_MESSAGE_PAGE_SIZE })
    liveSessionPrefetches.set(id, request)
    void request.finally(() => {
      if (liveSessionPrefetches.get(id) === request) liveSessionPrefetches.delete(id)
    }).catch(() => {})
  }
  const session = await waitForPrefetch(request, signal)
  if (signal?.aborted) throw abortError()
  const history = session.messages || session.history || []
  const { messages } = normalizeHistoryMessages(history)
  const running = session.status === 'running'
  const waiting = session.status === 'waiting'
  writeLiveSessionSnapshot(id, {
    messages,
    streamingText: '',
    loading: running,
    turnPending: running || waiting || !hasFinalAssistantAfterLastUser(messages),
    session,
    liveContextTokens: null,
    backgroundActivity: (session.backgroundActivity as BackgroundActivity | null) ?? null,
    hasOlderMessages: readHasOlderMessages(session),
  })
}

export function useLiveSession(
  sessionId: string | null,
  opts: UseLiveSessionOptions,
): UseLiveSessionResult {
  const { subscribe, connectionSeq, readOnly = false } = opts
  const initialSnapshotRef = useRef<LiveSessionSnapshot | null | undefined>(undefined)
  if (initialSnapshotRef.current === undefined) {
    initialSnapshotRef.current = sessionId ? readLiveSessionSnapshot(sessionId) : null
  }
  const initialSnapshot = initialSnapshotRef.current
  const pendingUserMessageRef = useRef<Message | null>(opts.pendingUserMessage ?? null)

  const reconcilePendingUserMessage = useCallback((snapshot: Message[]) => {
    const pending = pendingUserMessageRef.current
    if (!pending) return snapshot
    const pendingKey = messageIdentityKey(pending)
    if (snapshot.some((message) => message.id === pending.id || messageIdentityKey(message) === pendingKey)) {
      pendingUserMessageRef.current = null
      return snapshot
    }
    return [...snapshot, pending].sort((a, b) => a.timestamp - b.timestamp)
  }, [])

  const [messages, setMessages] = useState<Message[]>(() =>
    opts.pendingUserMessage ? [opts.pendingUserMessage] : initialSnapshot?.messages ?? [],
  )
  // Seed loading=true when mounting with a pendingUserMessage (just-created new chat
  // where the OLD pane's setLoading(true) was lost in the remount). Otherwise the
  // thinking indicator wouldn't show until the first WS delta arrives.
  const [loading, setLoading] = useState<boolean>(() => !!opts.pendingUserMessage || initialSnapshot?.loading === true)
  const [turnPending, setTurnPending] = useState<boolean>(() =>
    !!opts.pendingUserMessage
    || initialSnapshot?.turnPending === true
    || initialSnapshot?.loading === true
    || initialSnapshot?.session?.status === 'running'
    || initialSnapshot?.session?.status === 'waiting',
  )
  const [liveFinalResponseId, setLiveFinalResponseId] = useState<string | null>(null)
  const [hydrating, setHydrating] = useState<boolean>(() => Boolean(sessionId && !opts.pendingUserMessage && !initialSnapshot))
  const loadingRef = useRef(loading)
  useEffect(() => { loadingRef.current = loading }, [loading])
  const lastDeltaAtRef = useRef<number>(0)
  const streamingTextRef = useRef(initialSnapshot?.streamingText ?? '')
  const [streamingText, setStreamingText] = useState(initialSnapshot?.streamingText ?? '')
  const [liveContextTokens, setLiveContextTokens] = useState<number | null>(initialSnapshot?.liveContextTokens ?? null)
  const [backgroundActivity, setBackgroundActivity] = useState<BackgroundActivity | null>(initialSnapshot?.backgroundActivity ?? null)
  const [hasOlderMessages, setHasOlderMessages] = useState<boolean>(() => initialSnapshot?.hasOlderMessages === true)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [olderMessagesError, setOlderMessagesError] = useState<Error | null>(null)
  const intermediateStartRef = useRef<number>(-1)
  const statusMessageIdRef = useRef<string | null>(null)
  const [currentSession, setCurrentSession] = useState<Record<string, unknown> | null>(initialSnapshot?.session ?? null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const sessionIdRef = useRef(sessionId)
  const justCompletedAtRef = useRef<number>(0)
  const loadTokenRef = useRef(0)
  const messagesRef = useRef<Message[]>(messages)
  const hasOlderMessagesRef = useRef(hasOlderMessages)
  const loadingOlderMessagesRef = useRef(false)
  const initialDelegationStates = delegationStatesOf(initialSnapshot?.messages ?? [])
  const seenArrivalBlockIdsRef = useRef(liveArrivalBlockIdsOf(initialSnapshot?.messages ?? []))
  const delegationStatusRef = useRef(initialDelegationStates)
  const blockNonceRef = useRef(0)
  const blockBatchRef = useRef({ startedAt: 0, count: 0 })
  const blockArrivalTimersRef = useRef(new Map<string, number>())
  const terminalDelegationTimersRef = useRef(new Map<string, number>())
  const blockAnnouncementTimerRef = useRef<number | undefined>(undefined)
  const blockAnnouncementCountRef = useRef({ delegation: 0, dispatch: 0 })
  const [blockArrivals, setBlockArrivals] = useState<Map<string, LiveBlockArrival>>(() => new Map())
  const [liveTerminalDelegationIds, setLiveTerminalDelegationIds] = useState<Set<string>>(() => new Set())
  const [blockAnnouncement, setBlockAnnouncement] = useState('')

  const rememberLiveBlockStates = useCallback((nextMessages: Message[]) => {
    for (const id of liveArrivalBlockIdsOf(nextMessages)) seenArrivalBlockIdsRef.current.add(id)
    for (const [id, status] of delegationStatesOf(nextMessages)) {
      delegationStatusRef.current.set(id, status)
    }
  }, [])

  const markLiveBlockArrival = useCallback((blockId: string, blockType: ChatBlockType) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const batch = blockBatchRef.current
    if (batch.count === 0 || now - batch.startedAt > 80) {
      batch.startedAt = now
      batch.count = 0
    }
    const delayMs = Math.min(2, batch.count) * 60
    batch.count += 1
    const arrival = { nonce: ++blockNonceRef.current, delayMs }
    setBlockArrivals((current) => {
      const next = new Map(current)
      next.set(blockId, arrival)
      return next
    })

    window.clearTimeout(blockArrivalTimersRef.current.get(blockId))
    blockArrivalTimersRef.current.set(blockId, window.setTimeout(() => {
      blockArrivalTimersRef.current.delete(blockId)
      setBlockArrivals((current) => {
        if (!current.has(blockId)) return current
        const next = new Map(current)
        next.delete(blockId)
        return next
      })
    }, delayMs + 420))

    if (blockType !== 'delegation' && blockType !== 'dispatch') return
    blockAnnouncementCountRef.current[blockType] += 1
    setBlockAnnouncement('')
    window.clearTimeout(blockAnnouncementTimerRef.current)
    blockAnnouncementTimerRef.current = window.setTimeout(() => {
      const { delegation, dispatch } = blockAnnouncementCountRef.current
      blockAnnouncementCountRef.current = { delegation: 0, dispatch: 0 }
      const parts = [
        delegation === 0 ? '' : delegation === 1 ? 'Delegation started' : `${delegation} delegations started`,
        dispatch === 0 ? '' : dispatch === 1 ? 'Follow-up sent' : `${dispatch} follow-ups sent`,
      ].filter(Boolean)
      setBlockAnnouncement(parts.join(', '))
    }, 80)
  }, [])

  const markLiveTerminalDelegation = useCallback((blockId: string) => {
    setLiveTerminalDelegationIds((current) => new Set(current).add(blockId))
    window.clearTimeout(terminalDelegationTimersRef.current.get(blockId))
    terminalDelegationTimersRef.current.set(blockId, window.setTimeout(() => {
      terminalDelegationTimersRef.current.delete(blockId)
      setLiveTerminalDelegationIds((current) => {
        if (!current.has(blockId)) return current
        const next = new Set(current)
        next.delete(blockId)
        return next
      })
    }, 1_200))
  }, [])

  const clearLiveBlockArrivalState = useCallback(() => {
    for (const timer of blockArrivalTimersRef.current.values()) window.clearTimeout(timer)
    blockArrivalTimersRef.current.clear()
    window.clearTimeout(blockAnnouncementTimerRef.current)
    blockAnnouncementTimerRef.current = undefined
    blockAnnouncementCountRef.current = { delegation: 0, dispatch: 0 }
    blockBatchRef.current = { startedAt: 0, count: 0 }
    setBlockArrivals((current) => current.size === 0 ? current : new Map())
    setBlockAnnouncement('')
  }, [])

  useEffect(() => () => {
    for (const timer of blockArrivalTimersRef.current.values()) window.clearTimeout(timer)
    for (const timer of terminalDelegationTimersRef.current.values()) window.clearTimeout(timer)
    window.clearTimeout(blockAnnouncementTimerRef.current)
  }, [])

  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { hasOlderMessagesRef.current = hasOlderMessages }, [hasOlderMessages])

  const readOnlyRef = useRef(readOnly)
  useEffect(() => { readOnlyRef.current = readOnly }, [readOnly])
  const onMetaRef = useRef(opts.onMeta)
  useEffect(() => { onMetaRef.current = opts.onMeta }, [opts.onMeta])
  const onRefreshRef = useRef(opts.onRefresh)
  useEffect(() => { onRefreshRef.current = opts.onRefresh }, [opts.onRefresh])

  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  const clearStatusMessage = useCallback(() => {
    const id = statusMessageIdRef.current
    if (!id) return
    statusMessageIdRef.current = null
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const upsertStatusMessage = useCallback((raw: string) => {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text) return
    const replace = /^(thinking:|plan:|grok retrying)/i.test(text)
    const now = Date.now()
    setMessages((prev) => {
      if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
      const existingId = statusMessageIdRef.current
      const existing = existingId ? prev.find((m) => m.id === existingId) : undefined
      const previousThinking = existing?.content.match(/^Thinking:\s*(.*)$/i)?.[1] ?? ''
      const content = replace
        ? text
        : `Thinking: ${capStatusText(appendStatusChunk(previousThinking, text))}`
      if (existingId && prev.some((m) => m.id === existingId)) {
        return prev.map((m) => m.id === existingId ? { ...m, content, timestamp: now } : m)
      }
      const id = crypto.randomUUID()
      statusMessageIdRef.current = id
      return [
        ...prev,
        {
          id,
          role: 'notification' as const,
          content,
          timestamp: now,
        },
      ]
    })
  }, [])


  // Listen for session events via subscribe
  useEffect(() => {
    return subscribe((frame: GatewayEvent) => {
      const { event, payload } = frame
      const p = payload as Record<string, unknown>
      const sid = sessionIdRef.current
      if (!sid || p.sessionId !== sid) return
      // The first frame of the turn IS the acknowledgement of the send, so the
      // bubble settles here rather than waiting for the reply to finish.
      if (event === 'session:started' || event === 'session:delta') setMessages(clearPendingSend)

      if (event === 'session:started') {
        setLoading(true)
        setTurnPending(true)
        setLiveFinalResponseId(null)
        setCurrentSession((prev) => prev ? { ...prev, status: 'running' } : prev)
      }

      if (event === 'session:delta') {
        setTurnPending(true)
        lastDeltaAtRef.current = Date.now()
        // Read-only consumers have no send path to arm loading; a delta means
        // the session is actively running, so reflect that as the spinner.
        if (readOnlyRef.current) setLoading(true)
        const deltaType = String(p.type || 'text')

        if (deltaType === 'text') {
          clearStatusMessage()
          const chunk = String(p.content || '')
          streamingTextRef.current += chunk
          setStreamingText(streamingTextRef.current)
        } else if (deltaType === 'text_snapshot') {
          clearStatusMessage()
          // A snapshot is the authoritative current answer — replace
          // unconditionally. A shorter/rewritten snapshot (e.g. a hermes
          // redaction transform) must win; the old length gate left the
          // pre-redaction streamed text visible for the rest of the turn.
          const snapshot = String(p.content || '')
          streamingTextRef.current = snapshot
          setStreamingText(snapshot)
        } else if (deltaType === 'tool_use') {
          clearStatusMessage()
          if (streamingTextRef.current) {
            const flushed = streamingTextRef.current
            streamingTextRef.current = ''
            setStreamingText('')
            setMessages((prev) => {
              if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
              const updated = [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content: flushed,
                  timestamp: Date.now(),
                },
              ]
              return updated
            })
          }
          const toolName = String(p.toolName || 'tool')
          const toolId = typeof p.toolId === 'string' && p.toolId ? p.toolId : undefined
          setMessages((prev) => {
            if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
            const updated = [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `Using ${toolName}`,
                timestamp: Date.now(),
                toolCall: toolName,
                ...(toolId ? { toolId } : {}),
              },
            ]
            return updated
          })
        } else if (deltaType === 'tool_result') {
          setMessages((prev) => {
            const updated = [...prev]
            const toolId = typeof p.toolId === 'string' && p.toolId ? p.toolId : undefined
            const toolName = typeof p.toolName === 'string' && p.toolName ? p.toolName : undefined
            const activityReceiptId = typeof p.activityReceiptId === 'string' && p.activityReceiptId
              ? p.activityReceiptId
              : undefined
            let targetIndex = -1
            if (toolId) {
              targetIndex = updated.findIndex((m) =>
                m.role === 'assistant' &&
                m.toolCall &&
                m.toolId === toolId &&
                !m.content.startsWith('Used '),
              )
            } else if (toolName) {
              for (let i = updated.length - 1; i >= 0; i--) {
                const m = updated[i]
                if (
                  m.role === 'assistant' &&
                  m.toolCall === toolName &&
                  !m.content.startsWith('Used ')
                ) {
                  targetIndex = i
                  break
                }
              }
            }
            if (targetIndex >= 0) {
              const target = updated[targetIndex]
              updated[targetIndex] = {
                ...target,
                content: `Used ${target.toolCall}`,
                ...(activityReceiptId
                  ? { meta: { ...(target.meta ?? {}), activityReceiptId } }
                  : {}),
              }
            }
            return updated
          })
        } else if (deltaType === 'block') {
          clearStatusMessage()
          const envelope = isBlockEnvelope(p.block) ? p.block : null
          if (!envelope) return
          const liveArrivalBlock = envelope.block.type === 'delegation' || envelope.block.type === 'dispatch'
          const seenArrival = seenArrivalBlockIdsRef.current.has(envelope.block.id)
          if (liveArrivalBlock && envelope.op === 'put' && !seenArrival) {
            markLiveBlockArrival(envelope.block.id, envelope.block.type)
          }
          if (liveArrivalBlock && envelope.op !== 'remove') {
            seenArrivalBlockIdsRef.current.add(envelope.block.id)
          }
          if (envelope.block.type === 'delegation') {
            const id = envelope.block.id
            const previousStatus = delegationStatusRef.current.get(id)
            if (envelope.op !== 'remove') {
              const nextStatus = envelope.block.status ?? previousStatus
              delegationStatusRef.current.set(id, nextStatus)
              if (
                seenArrival
                && isActiveDelegationStatus(previousStatus)
                && isTerminalDelegationStatus(nextStatus)
              ) {
                markLiveTerminalDelegation(id)
              }
            }
          }
          if (streamingTextRef.current) {
            const flushed = streamingTextRef.current
            streamingTextRef.current = ''
            setStreamingText('')
            setMessages((prev) => {
              if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
              return [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content: flushed,
                  timestamp: Date.now(),
                },
              ]
            })
          }
          setMessages((prev) => {
            if (intermediateStartRef.current < 0) intermediateStartRef.current = prev.length
            const fallback = envelope.op === 'patch' && envelope.block.type === 'delegation'
              ? ''
              : String(p.content || '')
            return applyBlockEnvelopeToMessages(prev, envelope, fallback, Date.now())
          })
        } else if (deltaType === 'context') {
          const n = Number(p.content)
          if (Number.isFinite(n) && n > 0) setLiveContextTokens(n)
        } else if (deltaType === 'status') {
          upsertStatusMessage(String(p.content || ''))
        }
      }

      if (event === 'session:notification') {
        const notifMessage = String(p.message || '')
        if (notifMessage) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'notification' as const,
              content: notifMessage,
              timestamp: Date.now(),
              ...(messageMeta(p.meta) ? { meta: messageMeta(p.meta) } : {}),
            },
          ])
        }
      }

      if (event === 'session:attachment') {
        const media = Array.isArray(p.media) ? (p.media as MediaAttachment[]) : []
        // Use the server's canonical message id so the next history fetch merges
        // (not duplicates) this message. Guard against re-append if the event fires twice.
        const attachmentId = typeof p.id === 'string' ? p.id : crypto.randomUUID()
        if (media.length > 0) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === attachmentId)) return prev
            return [
              ...prev,
              {
                id: attachmentId,
                role: 'assistant' as const,
                content: String(p.content || ''),
                timestamp: p.timestamp ? Number(p.timestamp) : Date.now(),
                media,
              },
            ]
          })
        }
      }

      if (event === 'session:interrupted') {
        streamingTextRef.current = ''
        setStreamingText('')
        clearStatusMessage()
      }

      if (event === 'session:stopped') {
        setLoading(false)
        setStreamingText('')
        setLiveContextTokens(null)
        clearStatusMessage()
      }

      if (event === 'session:completed') {
        clearStatusMessage()
        const intermediateStart = intermediateStartRef.current
        streamingTextRef.current = ''
        setStreamingText('')
        setLoading(false)
        setLiveContextTokens(null)
        intermediateStartRef.current = -1
        justCompletedAtRef.current = Date.now()

        const completedSessionId = sid || (p.sessionId ? String(p.sessionId) : null)
        if (completedSessionId && !readOnlyRef.current) {
          clearIntermediateMessages(completedSessionId)
        }

        if (p.result) {
          const resultStr = String(p.result)
          const finalResponseId = crypto.randomUUID()
          setTurnPending(false)
          setLiveFinalResponseId(finalResponseId)
          setMessages((prev) => reconcileCompletedTurnMessages({
            messages: prev,
            turnStart: intermediateStart,
            exactResult: resultStr,
            finalMessage: {
              id: finalResponseId,
              role: 'assistant' as const,
              content: resultStr,
              timestamp: Date.now(),
            },
          }))
        }
        if (p.error && !p.result) {
          const finalResponseId = crypto.randomUUID()
          setTurnPending(false)
          setLiveFinalResponseId(finalResponseId)
          setMessages((prev) => reconcileCompletedTurnMessages({
            messages: prev,
            turnStart: intermediateStart,
            finalMessage: {
              id: finalResponseId,
              role: 'assistant' as const,
              content: formatTerminalAssistantError(p.error),
              timestamp: Date.now(),
            },
          }))
        }
        // Refresh the current session record so post-turn fields (notably
        // lastContextTokens for the context meter, and status) update without a
        // manual reload. Light getSession only — does NOT touch messages (we just
        // set them above; loadSession would re-reconcile and could flicker).
        if (completedSessionId && completedSessionId === sid) {
          api.getSession(completedSessionId, { messages: false })
            .then((s) => setCurrentSession(s as Record<string, unknown>))
            .catch(() => { /* best-effort; next load will pick it up */ })
        }
        onRefreshRef.current?.()
      }

      if (event === 'session:background') {
        // Fired on every change, including the cleared case (null).
        setBackgroundActivity((p.backgroundActivity as BackgroundActivity | null) ?? null)
      }

      if (event === 'session:external-turn') {
        // The gateway persisted messages that did NOT come from a normal web
        // turn (e.g. the user typed in the CLI view). Reconcile from the
        // server via the same load path the completion watchdog uses.
        loadSession(sid)
      }
    })
  }, [subscribe])

  // Load session data
  const loadSession = useCallback(async (id: string, options?: { suppressHydrating?: boolean }) => {
    const myToken = ++loadTokenRef.current
    setLoadError(null) // fresh attempt
    if (!options?.suppressHydrating && !readLiveSessionSnapshot(id)) setHydrating(true)
    try {
      const session = (await api.getSession(id, { last: INITIAL_MESSAGE_PAGE_SIZE })) as Record<string, unknown>
      if (myToken !== loadTokenRef.current) {
        return
      }
      setHydrating(false)
      setCurrentSession(session)
      setHasOlderMessages(readHasOlderMessages(session))
      setOlderMessagesError(null)
      // Seed background-activity from the authoritative fetch (absent → null);
      // session:background WS events keep it live from here.
      setBackgroundActivity((session.backgroundActivity as BackgroundActivity | null) ?? null)
      onMetaRef.current?.({ ...sessionMetaOf(session), sessionId: id })

      const history = session.messages || session.history || []
      const { messages: normalizedMessages, firstPartialIndex } = normalizeHistoryMessages(history)
      const backendMessages = reconcilePendingUserMessage(normalizedMessages)
      rememberLiveBlockStates(backendMessages)
      const isPagedHistory = Boolean(session.messagesPage && typeof session.messagesPage === 'object')
      if (session.status === 'error' && session.lastError) {
        const lastMessage = backendMessages[backendMessages.length - 1]
        const errorText = formatTerminalAssistantError(session.lastError)
        if (!isPersistedTerminalAssistantError(lastMessage, session.lastError)) {
          backendMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: errorText,
            // This row repairs legacy display only; there is no persisted
            // terminal boundary from which an honest elapsed interval exists.
            timestamp: 0,
          })
        }
      }

      const isRunning = session.status === 'running'
      const isWaiting = session.status === 'waiting'
      const hasFinalResponse = hasFinalAssistantAfterLastUser(backendMessages)
      setTurnPending(isRunning || isWaiting || !hasFinalResponse)
      setLiveFinalResponseId(null)

      // Seed from authoritative running state for read-only views and for editable
      // views that did not initiate the turn locally (reload/tab switch/reconnect).
      if (readOnlyRef.current || (isRunning && Date.now() - justCompletedAtRef.current > 1000)) {
        setLoading(isRunning)
      }

      // A gateway restart marks the in-flight session "interrupted" — there is no
      // turn running anymore, but the WS session:completed/stopped event that would
      // normally clear the spinner died with the old gateway. Clear the stuck
      // loading state here so the conversation is immediately usable again; the
      // next message resumes the session via the engine's --resume.
      if (session.status === 'interrupted') {
        setLoading(false)
        streamingTextRef.current = ''
        setStreamingText('')
      }

      if (isRunning) {
        // The server now persists mid-turn partial blocks, so the backend snapshot
        // already carries in-progress output — no localStorage replay needed. This is
        // what makes a mid-turn refresh restore the streamed blocks on any device.
        // The turn-start marker must be an index into the array actually rendered,
        // not the (possibly ≤150-row) server snapshot — anchor it by message id and
        // remap it inside the updater against whichever array we return. Otherwise a
        // snapshot-space index truncates already-rendered history at turn completion.
        const turnStartAnchorId = firstPartialIndex >= 0 ? backendMessages[firstPartialIndex].id : null
        setMessages((current) => {
          // If the tail snapshot is stale and misses newer live rows, keep current.
          // Older already-loaded rows are still preserved by mergePagedSnapshot.
          if (backendMessages.length < current.length && hasUnmergedLocalTail(current, backendMessages)) {
            const anchorIdx = turnStartAnchorId ? current.findIndex((m) => m.id === turnStartAnchorId) : -1
            if (anchorIdx >= 0) intermediateStartRef.current = anchorIdx
            else if (intermediateStartRef.current < 0) intermediateStartRef.current = current.length
            return current
          }
          const next = backendMessages.length > 0 ? backendMessages : current
          const merged = mergePagedSnapshot(current, next, isPagedHistory)
          const anchorIdx = turnStartAnchorId ? merged.findIndex((m) => m.id === turnStartAnchorId) : -1
          intermediateStartRef.current = anchorIdx >= 0 ? anchorIdx : merged.length
          return merged
        })
        // Loading state is owned by handleSend (sets true) + WS session:completed/stopped (sets false).
        // loadSession must NEVER set loading=true — a stale GET arriving after completion would
        // re-arm the spinner and stick (the WS completion event has already passed).
      } else {
        const hadLocalInFlightState =
          loadingRef.current ||
          Boolean(streamingTextRef.current) ||
          intermediateStartRef.current >= 0

        setLoading(false)
        streamingTextRef.current = ''
        setStreamingText('')
        setLiveContextTokens(null)
        if (!readOnlyRef.current) clearIntermediateMessages(id)
        intermediateStartRef.current = -1
        setMessages((current) => {
          // If a stale tail misses locally-known newer rows, keep them; if the local
          // state was mid-turn, the idle backend snapshot is canonical collapse.
          if (
            backendMessages.length < current.length &&
            !hadLocalInFlightState &&
            hasUnmergedLocalTail(current, backendMessages)
          ) {
            return current
          }
          const next = backendMessages.length > 0 ? backendMessages : current
          return mergePagedSnapshot(current, next, isPagedHistory)
        })
      }
    } catch (err) {
      if (myToken !== loadTokenRef.current) return
      setHydrating(false)
      setMessages([])
      setCurrentSession(null)
      setHasOlderMessages(false)
      intermediateStartRef.current = -1
      setLoadError(err instanceof Error ? err : new Error("Failed to load session"))
    }
  }, [])

  // Load on session change
  useEffect(() => {
    // A cached resting target can skip loadSession entirely, so changing ids
    // must still invalidate any request started for the previous session.
    loadTokenRef.current += 1
    clearLiveBlockArrivalState()
    if (!sessionId) {
      setMessages([])
      setLoading(false)
      setTurnPending(false)
      setLiveFinalResponseId(null)
      setHydrating(false)
      setCurrentSession(null)
      setLoadError(null)
      setBackgroundActivity(null)
      setHasOlderMessages(false)
      setLoadingOlderMessages(false)
      loadingOlderMessagesRef.current = false
      setOlderMessagesError(null)
      statusMessageIdRef.current = null
      streamingTextRef.current = ''
      setStreamingText('')
      intermediateStartRef.current = -1
      return
    }
    const cached = readLiveSessionSnapshot(sessionId)
    const pending = opts.pendingUserMessage
    // Live completion identity belongs only to the session where its terminal
    // event arrived. A restored snapshot is historical from this hook's point
    // of view and must never inherit another session's animation sentinel.
    setLiveFinalResponseId(null)
    if (cached) {
      rememberLiveBlockStates(cached.messages)
      setMessages(reconcilePendingUserMessage(cached.messages))
      setLoading(cached.loading)
      setTurnPending(
        cached.turnPending === true
        || cached.loading
        || cached.session?.status === 'running'
        || cached.session?.status === 'waiting',
      )
      setCurrentSession(cached.session)
      setLoadError(null)
      setLiveContextTokens(cached.liveContextTokens)
      setBackgroundActivity(cached.backgroundActivity)
      setHasOlderMessages(cached.hasOlderMessages === true)
      setLoadingOlderMessages(false)
      loadingOlderMessagesRef.current = false
      setOlderMessagesError(null)
      streamingTextRef.current = cached.streamingText
      setStreamingText(cached.streamingText)
      setHydrating(false)
    } else if (pending) {
      setMessages([pending])
      setLoading(true)
      setTurnPending(true)
      setCurrentSession(null)
      setLoadError(null)
      setLiveContextTokens(null)
      setBackgroundActivity(null)
      setHasOlderMessages(false)
      setLoadingOlderMessages(false)
      loadingOlderMessagesRef.current = false
      setOlderMessagesError(null)
      streamingTextRef.current = ''
      setStreamingText('')
      setHydrating(false)
    } else {
      setMessages([])
      setLoading(false)
      setTurnPending(false)
      setCurrentSession(null)
      setLoadError(null)
      setLiveContextTokens(null)
      setHasOlderMessages(false)
      setLoadingOlderMessages(false)
      loadingOlderMessagesRef.current = false
      setOlderMessagesError(null)
      setHydrating(true)
    }
    // Don't carry the previous session's background indicator across a switch;
    // loadSession re-seeds it from the fresh fetch.
    if (!cached) setBackgroundActivity(null)
    // Clear streaming state immediately to avoid stale content flash on cold loads.
    if (!cached) {
      streamingTextRef.current = ''
      setStreamingText('')
    }
    // NOTE: do NOT setLoading(false) here. Loading is owned by handleSend (true) and
    // WS session:completed/stopped (false). Clearing here would clobber the lazy-init
    // loading=true set by useState() when this pane mounted with pendingUserMessage.
    //
    // A RESTING snapshot stands in fully: emit header/tab meta from the cached
    // session and skip the refetch. WS lifecycle events invalidate snapshots
    // of sessions that change while unmounted, so anything uncertain falls
    // through to the (non-blocking) revalidate below.
    if (cached && !pending && isRestingSnapshot(cached)) {
      // Deferred a microtask: this effect belongs to the freshly-mounted CHILD
      // pane, and child effects flush before the parent page's ref-sync effects.
      // The payload names its own session, so the emit can no longer be filed
      // under the previous one; the guard just drops it if the pane has moved on.
      const cachedSession = cached.session
      if (cachedSession) queueMicrotask(() => {
        if (sessionIdRef.current === sessionId) onMetaRef.current?.({ ...sessionMetaOf(cachedSession), sessionId })
      })
      return
    }
    loadSession(sessionId, { suppressHydrating: Boolean(pending && !cached) })
  }, [sessionId]) // loadSession is stable (useCallback with [] deps)

  // Reload on reconnect — only fires when WS genuinely reconnects (connectionSeq changes).
  // Reloads running AND interrupted sessions: a gateway restart marks the open session
  // "interrupted", and without a refetch the UI keeps a stuck spinner (the clearing
  // session:completed/stopped WS event died with the old gateway). Completed/idle
  // sessions don't need a refetch on every WS hiccup.
  // Debounced 300ms so a burst of connectionSeq bumps collapses into a single loadSession.
  useEffect(() => {
    if (!connectionSeq || !sessionIdRef.current) return
    const st = currentSession?.status
    // Also backfill when a turn is in flight LOCALLY (loadingRef): handleSend sets
    // loading=true without setting status='running' (status is only refreshed from
    // the server later), so a reconnect mid-turn would otherwise skip the backfill
    // and never recover the deltas missed while the socket was dead. Read via ref so
    // the effect still only re-runs on a real reconnect or status change.
    if (st !== 'running' && st !== 'interrupted' && !loadingRef.current) return
    const handle = setTimeout(() => {
      loadSession(sessionIdRef.current!)
    }, 300)
    return () => clearTimeout(handle)
  }, [connectionSeq, currentSession?.status]) // loadSession is stable; sessionIdRef.current is read at call time

  // Completion watchdog — recover from a DROPPED session:completed frame.
  // session:completed is a single point of failure: if that one WS frame dies with
  // a half-open socket right at completion, loading stays true forever (loadSession
  // deliberately won't clear it, and no other event will). After a reconnect, if
  // we're still loading and have been silent past the watchdog window, verify
  // against the server and clear the stuck spinner if the turn actually finished.
  useEffect(() => {
    if (!connectionSeq) return
    if (!loadingRef.current) return
    const id = sessionIdRef.current
    if (!id) return
    const timer = setTimeout(async () => {
      if (!loadingRef.current) return
      if (Date.now() - lastDeltaAtRef.current < COMPLETION_WATCHDOG_MS) return // still actively streaming
      try {
        const session = (await api.getSession(id, { messages: false })) as Record<string, unknown>
        if (shouldRecoverStuckTurn({
          loading: loadingRef.current,
          msSinceLastDelta: Date.now() - lastDeltaAtRef.current,
          serverStatus: session.status as string | undefined,
        })) {
          // Missed the terminal event — clear the stuck spinner and reconcile
          // messages from the authoritative server snapshot.
          setLoading(false)
          streamingTextRef.current = ''
          setStreamingText('')
          setLiveContextTokens(null)
          intermediateStartRef.current = -1
          await loadSession(id)
        }
      } catch {
        // best-effort; a later interaction will reconcile
      }
    }, COMPLETION_WATCHDOG_MS)
    return () => clearTimeout(timer)
  }, [connectionSeq]) // loadSession is stable; refs read at fire time

  // Poll while the UI thinks a turn is running. This covers the case where the
  // single terminal WS frame is dropped but the socket itself never reconnects,
  // so the reconnect-only watchdog above never gets a chance to reconcile.
  useEffect(() => {
    if (!loading) return
    const id = sessionIdRef.current
    if (!id) return
    const interval = setInterval(async () => {
      if (!loadingRef.current) return
      const currentId = sessionIdRef.current
      if (!currentId) return
      try {
        const session = (await api.getSession(currentId, { messages: false })) as Record<string, unknown>
        if (session.status !== 'running') {
          setLoading(false)
          streamingTextRef.current = ''
          setStreamingText('')
          setLiveContextTokens(null)
          intermediateStartRef.current = -1
          await loadSession(currentId)
        }
      } catch {
        // best-effort; normal WS/reconnect paths can still recover later
      }
    }, 10_000)
    return () => clearInterval(interval)
  }, [loading, loadSession])

  // --- write API (editable pane) ---
  const beginSend = useCallback((userMsg: Message) => {
    loadTokenRef.current += 1
    setMessages((prev) => {
      const next = beginSendMessages(prev, userMsg)
      // The ref carries the same row the transcript holds, pending flag and all:
      // a stale snapshot re-appends this copy, and a bare one would read as sent.
      pendingUserMessageRef.current = next[next.length - 1]
      intermediateStartRef.current = next.length
      return next
    })
    setLoading(true)
    setTurnPending(true)
    setLiveFinalResponseId(null)
    // Mark fresh activity so the completion watchdog doesn't treat a just-sent
    // turn as "silent" if a reconnect lands before the first delta arrives.
    lastDeltaAtRef.current = Date.now()
  }, [])

  const updateSendMedia = useCallback((messageId: string, media: MediaAttachment[]) => {
    if (pendingUserMessageRef.current?.id === messageId) {
      pendingUserMessageRef.current = { ...pendingUserMessageRef.current, media }
    }
    setMessages((prev) => prev.map((message) => message.id === messageId ? { ...message, media } : message))
  }, [])

  const failSend = useCallback((reason: string) => {
    const failed = pendingUserMessageRef.current
    pendingUserMessageRef.current = null
    setLoading(false)
    setTurnPending(false)
    setMessages((prev) => markSendFailed(prev, failed?.id, reason))
  }, [])

  const appendLocal = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg])
  }, [])

  const loadOlderMessages = useCallback(async () => {
    const id = sessionIdRef.current
    if (!id || !hasOlderMessagesRef.current || loadingOlderMessagesRef.current) return
    const before = messagesRef.current[0]?.id
    if (!before) return

    loadingOlderMessagesRef.current = true
    setLoadingOlderMessages(true)
    setOlderMessagesError(null)
    try {
      const page = await api.getSessionMessages(id, { before, limit: OLDER_MESSAGE_PAGE_SIZE })
      const { messages: olderMessages } = normalizeHistoryMessages(page.messages || [])
      rememberLiveBlockStates(olderMessages)
      setMessages((current) => mergeOlderMessages(olderMessages, current))
      setHasOlderMessages(page.hasOlder === true)
    } catch (err) {
      setOlderMessagesError(err instanceof Error ? err : new Error("Failed to load older messages"))
    } finally {
      loadingOlderMessagesRef.current = false
      setLoadingOlderMessages(false)
    }
  }, [])

  const reset = useCallback(() => {
    pendingUserMessageRef.current = null
    setMessages([])
    setLoading(false)
    setTurnPending(false)
    setLiveFinalResponseId(null)
    setHydrating(false)
    setCurrentSession(null)
    setBackgroundActivity(null)
    setHasOlderMessages(false)
    setLoadingOlderMessages(false)
    loadingOlderMessagesRef.current = false
    setOlderMessagesError(null)
    streamingTextRef.current = ''
    setStreamingText('')
    intermediateStartRef.current = -1
  }, [])

  useEffect(() => {
    if (!sessionId) return
    writeLiveSessionSnapshot(sessionId, {
      messages,
      streamingText,
      loading,
      turnPending,
      session: currentSession,
      liveContextTokens,
      backgroundActivity,
      hasOlderMessages,
    })
  }, [sessionId, messages, streamingText, loading, turnPending, currentSession, liveContextTokens, backgroundActivity, hasOlderMessages])

  return {
    messages,
    streamingText,
    loading,
    turnPending,
    liveFinalResponseId,
    hydrating,
    session: currentSession,
    error: loadError,
    liveContextTokens,
    backgroundActivity,
    hasOlderMessages,
    loadingOlderMessages,
    olderMessagesError,
    blockArrivals,
    liveTerminalDelegationIds,
    blockAnnouncement,
    reload: loadSession,
    loadOlderMessages,
    beginSend,
    updateSendMedia,
    failSend,
    appendLocal,
    reset,
  }
}
