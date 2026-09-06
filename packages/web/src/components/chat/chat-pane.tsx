import { lazy, Suspense, useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo, type ReactNode } from 'react'
import { api, type DelegatedActivity } from '@/lib/api'
import { useOrg } from '@/hooks/use-employees'
import { ChatMessages } from '@/components/chat/chat-messages'
import type { CommsPeekData } from '@/components/chat/thread-peek'
import { ChatInput } from '@/components/chat/chat-input'
import { CliKeybar } from '@/components/chat/cli-keybar'
import { ChatEmployeePicker } from '@/components/chat/chat-employee-picker'
import { ChatHydrationOverlay, useHydrationSpinner } from '@/components/chat/chat-hydration'
import { SessionQueueContext, useSessionQueue } from '@/components/chat/use-session-queue'
import { BackgroundActivityStatus } from '@/components/chat/background-activity-status'
import { ModelSelectorRow, type SelectorValue } from '@/components/chat/model-selector-row'
import { useLiveSession } from '@/hooks/use-live-session'
import { useStaleChatNotice, type FreshChatSourceSession } from '@/components/chat/use-stale-chat-notice'
import { useFileDrop } from '@/hooks/use-file-drop'
import { FileDropOverlay } from '@/components/ui/file-drop-overlay'
import { ChatPaneTitleBar, paneTitleBarState, paneViewControls } from '@/components/chat/chat-pane-title-bar'
import { ChatCopyToast } from '@/components/chat/chat-copy-toast'
import type { PaneSessionActions } from '@/components/chat/pane-session-actions'
import { useOnboardingSeed } from '@/components/chat/use-onboarding-seed'

const CliTerminal = lazy(() => import('@/components/cli-terminal').then(m => ({ default: m.CliTerminal })))
import type { CliTerminalHandle } from '@/components/cli-terminal'
import { buildNewSessionParams, resolveNewSessionSelector, shouldPersistNewSessionSelector } from '@/components/chat/new-chat-helpers'
import { readNewSessionSelector, writeNewSessionSelector } from '@/components/chat/new-session-selector'
import { Slot } from '@/contrib/slot'
import { AREAS } from '@/contrib/types'
import type { EnginesResponse } from '@/lib/api'
import type { Message, MediaAttachment } from '@/lib/conversations'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'

// The live read pipeline (load/WS/reconnect/watchdog) now lives in
// useLiveSession; shouldRecoverStuckTurn moved there too. Re-export it so the
// existing completion-watchdog test (imports from this module) keeps working.
export { shouldRecoverStuckTurn } from '@/hooks/use-live-session'

interface ChatPaneProps {
  sessionId: string | null
  isActive: boolean
  onFocus: () => void
  /** Notify parent when a new session is created (e.g. first message in new chat) */
  onSessionCreated?: (sessionId: string, pendingUserMessage?: Message) => void
  /** Open the parent-level new-chat composer. */
  onNewChat?: () => void
  /** If set on mount, used as the initial user message before loadSession resolves — for the just-created-from-new-chat case. */
  pendingUserMessage?: Message
  /** Notify parent when session meta changes */
  onSessionMetaChange?: (meta: { sessionId?: string; title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string; archivedAt?: string | null }) => void
  /** Notify parent to refresh sidebar */
  onRefresh?: () => void
  /** Portal name from settings */
  portalName?: string
  /** Gateway subscribe function for WS events */
  subscribe: (fn: GatewayEventListener) => () => void
  engineRegistry?: EnginesResponse // supportsPty decides the CLI/xterm affordance
  /** Gateway connection seq number - triggers reload on reconnect */
  connectionSeq?: number
  /** Gateway skills version */
  skillsVersion?: number
  /** Gateway events array */
  events: GatewayEvent[]
  /** View mode: chat or cli transcript */
  viewMode?: 'chat' | 'cli'
  /** Incrementing counter that triggers input focus */
  focusTrigger?: number
  /** Pre-selected employee for a NEW chat (e.g. contacting a session-less employee or an ?employee= deep-link). */
  initialEmployee?: string | null
  /** Ask the page-owned stable read-only preview controller to open. */
  onPeek?: (peek: CommsPeekData) => void
  /** First meaningful destination paint; used to release a preview handoff. */
  onContentReady?: (sessionId: string) => void
  /** Where the reader left this transcript. Opens there rather than at the bottom. */
  initialScrollTop?: number
  /** Live list-derived descendant activity. `null` is authoritative rest;
   *  `undefined` falls back to the session detail payload. */
  delegatedActivity?: DelegatedActivity | null
  /** Create and navigate to a continuation of the current session. */
  onStartFreshChat?: (session: FreshChatSourceSession) => Promise<void>
  newChatEmptyState?: ReactNode
  /** Pane-owned identity chrome appears only when the desktop grid has siblings. */
  multiPane?: boolean
  /** Warm list/meta fallback while the pane's authoritative session detail loads. */
  paneTitle?: string
  paneEmployee?: string
  onClose?: () => void; sessionActions?: PaneSessionActions; paneBackTo?: { label: string; onClick: () => void }; copyNotice?: boolean
}
export type { FreshChatSourceSession }
export function ChatPane({
  sessionId, isActive, onFocus,
  onSessionCreated,
  onSessionMetaChange,
  onRefresh,
  portalName = 'Jinn',
  subscribe,
  engineRegistry,
  connectionSeq,
  skillsVersion,
  events,
  viewMode = 'chat',
  focusTrigger,
  pendingUserMessage,
  initialEmployee,
  onPeek,
  onContentReady,
  initialScrollTop,
  delegatedActivity,
  onStartFreshChat,
  newChatEmptyState,
  multiPane = false,
  paneTitle, paneEmployee,
  onClose, sessionActions, paneBackTo, copyNotice,
}: ChatPaneProps) {
  const seedFromOnboarding = useOnboardingSeed(sessionId, pendingUserMessage)

  // useLiveSession owns reads; this pane layers the composer and optimistic writes.
  const live = useLiveSession(sessionId, {
    subscribe,
    connectionSeq,
    pendingUserMessage: pendingUserMessage ?? seedFromOnboarding,
    onMeta: onSessionMetaChange,
    onRefresh,
  })
  const {
    messages,
    streamingText,
    loading,
    turnPending,
    liveFinalResponseId,
    hydrating,
    session: currentSession,
    liveContextTokens,
    backgroundActivity,
    hasOlderMessages,
    loadingOlderMessages,
    olderMessagesError,
    blockArrivals,
    liveTerminalDelegationIds,
    blockAnnouncement,
    loadOlderMessages,
    beginSend,
    updateSendMedia,
    failSend,
    appendLocal,
    reset: resetPane,
    reload: reloadSession,
  } = live
  const sessionQueue = useSessionQueue(sessionId, subscribe)
  const { notice: staleChatNotice, answerBySending: answerStaleChatBySending } = useStaleChatNotice({
    sessionId,
    session: currentSession,
    viewMode,
    liveContextTokens,
    turnRunning: loading || turnPending,
    onStartFreshChat,
  })

  // Kept local for handleSelectorChange so it stays a stable ([]) callback that
  // reads the current session id at call time (mirrors the previous behaviour).
  const sessionIdRef = useRef(sessionId)
  const selectorPatchSeq = useRef(0)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  // CLI → chat view switch: turns typed directly into the xterm may never have
  // reached the chat transcript (or a session:external-turn WS frame was
  // missed while the chat view was unmounted), so run a cheap one-shot
  // reconcile through the same load path session:external-turn uses.
  const prevViewModeRef = useRef(viewMode)
  useEffect(() => {
    const prev = prevViewModeRef.current
    prevViewModeRef.current = viewMode
    if (prev === 'cli' && viewMode === 'chat' && sessionId) {
      reloadSession(sessionId)
    }
  }, [viewMode, sessionId, reloadSession])

  // Employee picker state for new chat. Seeded from initialEmployee so a
  // "contact this employee" click / ?employee= deep-link opens the new chat
  // with that employee preselected (the pane is remounted via key on change).
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(initialEmployee ?? null)
  const { data: orgData } = useOrg()
  const pickerEmployees = Array.isArray(orgData?.employees)
    ? orgData.employees.map((emp) => ({
        name: emp.name,
        displayName: emp.displayName,
        department: emp.department,
        rank: emp.rank,
        engine: emp.engine,
        model: emp.model,
        effortLevel: emp.effortLevel,
      }))
    : []
  const employeeDisplayNames = useMemo(
    () => Object.fromEntries((orgData?.employees ?? []).map((employee) => [employee.name, employee.displayName])),
    [orgData],
  )
  // Reset the employee picker when there is no session (the live read pipeline
  // clears its own state on a null sessionId; this is the pane-local part).
  // Falls back to initialEmployee so a preselected contact survives the reset.
  useEffect(() => { if (!sessionId) setSelectedEmployee(initialEmployee ?? null) }, [sessionId, initialEmployee])

  // Engine/Model/Effort selector state (composer). Engine is editable on a new
  // chat only; model + effort are editable in existing chats too.
  const [selector, setSelector] = useState<SelectorValue>(() => readNewSessionSelector())
  const selectorRef = useRef(selector)
  const newSessionSelectorDirtyRef = useRef(false)
  const previousSessionIdForSelectorRef = useRef(sessionId)
  useEffect(() => { selectorRef.current = selector }, [selector])
  useEffect(() => {
    if (previousSessionIdForSelectorRef.current && !sessionId) {
      newSessionSelectorDirtyRef.current = false
    }
    previousSessionIdForSelectorRef.current = sessionId
  }, [sessionId])
  const [effortPendingNote, setEffortPendingNote] = useState(false)
  const [selectorError, setSelectorError] = useState<string | null>(null)
  const cliTerminalRef = useRef<CliTerminalHandle | null>(null)

  // Pre-fill for a NEW chat. Explicit employee selection uses employee config;
  // direct/COO chats reuse the operator's last composer choice.
  useEffect(() => {
    if (sessionId) return
    const emp = selectedEmployee && Array.isArray(orgData?.employees)
      ? orgData.employees.find((e) => e.name === selectedEmployee)
      : undefined
    setSelector(resolveNewSessionSelector({
      selectedEmployee: emp ?? null,
      storedSelector: readNewSessionSelector(),
      currentSelector: selectorRef.current,
      manuallyChanged: newSessionSelectorDirtyRef.current,
    }))
    setEffortPendingNote(false)
    setSelectorError(null)
  }, [selectedEmployee, sessionId, orgData])

  // Pre-fill for an EXISTING chat from the loaded session.
  useEffect(() => {
    if (!sessionId || !currentSession) return
    setSelector({
      engine: currentSession.engine as string | undefined,
      model: currentSession.model as string | undefined,
      effortLevel: (currentSession.effortLevel ?? currentSession.effort_level) as string | undefined,
    })
    setEffortPendingNote(false)
    setSelectorError(null)
  }, [sessionId, currentSession])

  // Apply a selector change. New chat: just track it (sent on first message).
  // Existing chat: persist model/effort via PATCH (engine is fixed mid-chat).
  const handleSelectorChange = useCallback((next: SelectorValue) => {
    const sid = sessionIdRef.current
    if (sid) {
      const previous = selector
      const lockedGrokModel =
        currentSession?.engine === 'grok' &&
        next.engine === currentSession.engine &&
        Boolean(currentSession.engineSessionId) &&
        Boolean(next.model) &&
        Boolean(previous.model) &&
        next.model !== previous.model

      if (lockedGrokModel) {
        setSelectorError('Grok model changes require a new session.')
        setEffortPendingNote(false)
        return
      }

      const seq = ++selectorPatchSeq.current
      setSelector(next)
      setSelectorError(null)
      setEffortPendingNote(false)
      api.updateSession(sid, { engine: next.engine, model: next.model, effortLevel: next.effortLevel })
        .then(() => {
          if (selectorPatchSeq.current === seq) setEffortPendingNote(true)
        })
        .catch((err) => {
          if (selectorPatchSeq.current !== seq) return
          setSelector(previous)
          setEffortPendingNote(false)
          setSelectorError(err instanceof Error ? err.message : 'Model update failed')
        })
    } else {
      newSessionSelectorDirtyRef.current = true
      setSelector(next)
      setSelectorError(null)
      writeNewSessionSelector(next)
    }
  }, [selector, currentSession?.engine, currentSession?.engineSessionId])

  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return
    try {
      await api.stopSession(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId])

  const handleSend = useCallback(
    async (message: string, media?: MediaAttachment[], interrupt?: boolean, speech?: boolean) => {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        media,
      }
      // Optimistic append + arm loading + mark activity (for the watchdog).
      beginSend(userMsg)
      answerStaleChatBySending()

      try {
        let attachmentIds: string[] | undefined
        if (media && media.length > 0) {
          const uploadedMedia = await Promise.all(media.map(async (att) => {
            if (!att.file) return att
            const uploaded = await api.uploadFile(att.file, sessionIdRef.current || undefined)
            return { ...att, fileId: uploaded.id }
          }))
          attachmentIds = uploadedMedia.flatMap((att) => att.fileId ? [att.fileId] : [])
          userMsg.media = uploadedMedia
          updateSendMedia(userMsg.id, uploadedMedia)
        }

        let sid = sessionId

        if (!sid) {
          const params = buildNewSessionParams({
            message,
            selectedEmployee,
            attachmentIds,
            engine: selector.engine,
            model: selector.model,
            effortLevel: selector.effortLevel,
            speech,
          })
          if (viewMode === 'cli' && (!selector.engine || engineRegistry?.engines?.[selector.engine]?.supportsPty)) (params as Record<string, unknown>).mode = 'interactive'
          const session = (await api.createSession(params)) as Record<string, unknown>
          if (shouldPersistNewSessionSelector({ selectedEmployee, manuallyChanged: newSessionSelectorDirtyRef.current })) {
            writeNewSessionSelector(selector)
          }
          sid = String(session.id)
          onSessionCreated?.(sid, userMsg)
          onRefresh?.()
        } else {
          // CLI view → route to the interactive PTY engine so the user sees the prompt
          // get injected into the live xterm + claude's streaming response.
          const mode = viewMode === 'cli' && engineRegistry?.engines?.[String(currentSession?.engine ?? '')]?.supportsPty ? 'interactive' : undefined
          sessionQueue.adopt(userMsg.id, await api.sendMessage(sid, { message, interrupt: interrupt || undefined, attachments: attachmentIds, mode, speech: speech || undefined }))
          onRefresh?.()
        }
        return true
      } catch (err) {
        failSend(err instanceof Error ? err.message : 'Failed to send message')
        return false
      }
    },
    // Keep viewMode and stale-notice handling fresh across chat↔CLI sends.
    [sessionId, selectedEmployee, onSessionCreated, onRefresh, viewMode, selector, currentSession?.engine, engineRegistry, beginSend, updateSendMedia, failSend, answerStaleChatBySending, sessionQueue]
  )

  const handleStatusRequest = useCallback(async () => {
    if (!sessionId) {
      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'No active session. Send a message to start one.',
        timestamp: Date.now(),
      })
      return
    }

    try {
      const session = (await api.getSession(sessionId)) as Record<string, unknown>
      const info = [
        '**Session Info**',
        `ID: \`${session.id}\``,
        `Status: ${session.status || 'unknown'}`,
        session.employee ? `Employee: ${session.employee}` : null,
        session.engine ? `Engine: ${session.engine}` : null,
        session.model ? `Model: ${session.model}` : null,
        session.createdAt ? `Created: ${session.createdAt}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: info,
        timestamp: Date.now(),
      })
    } catch {
      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Failed to fetch session status.',
        timestamp: Date.now(),
      })
    }
  }, [sessionId, appendLocal])

  const handleNewSession = useCallback(() => {
    // This just clears the pane state — parent handles actual new session flow
    resetPane()
  }, [resetPane])

  // Before paint, not a frame after it: what "ready" releases touches the scroller.
  const readySessionRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!sessionId || hydrating || readySessionRef.current === sessionId || (!currentSession && messages.length === 0 && !streamingText)) return
    readySessionRef.current = sessionId
    onContentReady?.(sessionId)
  }, [sessionId, hydrating, currentSession, messages.length, streamingText, onContentReady])

  const fileDrop = useFileDrop()
  // A threshold, not a default: a load that resolves inside the delay never
  // announces itself, and the transcript stays mounted underneath either way.
  const showSessionHydration = useHydrationSpinner(Boolean(sessionId && hydrating && messages.length === 0 && !streamingText))
  const titleBarState = paneTitleBarState({ sessionId, currentSession, loading, turnPending,
    backgroundActivity, delegatedActivity, paneTitle, paneEmployee, portalName })
  const titleBarViewControls = paneViewControls(titleBarState.session, engineRegistry)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--bg)',
        position: 'relative',
      }}
      data-chat-pane-session={sessionId ?? 'new'} data-chat-pane-active={String(isActive)}
      onClick={(event) => { if (!(event.target as Element).closest('[data-pane-focus-preserving]')) onFocus() }} onFocusCapture={(event) => { if (!(event.target as Element).closest('[data-pane-focus-preserving]')) onFocus() }}
      className="group/chat-pane"
      {...fileDrop.handlers}
    >
      {fileDrop.dragOver && <FileDropOverlay />}
      {multiPane && onClose ? (
        <ChatPaneTitleBar {...titleBarState} {...titleBarViewControls} active={isActive} backTo={paneBackTo} onClose={onClose} sessionActions={sessionId ? sessionActions : undefined} viewMode={viewMode} />
      ) : null}
      {multiPane && copyNotice ? <ChatCopyToast placement="pane" /> : null}
      {showSessionHydration && <ChatHydrationOverlay />}

      {/* Messages / CLI transcript — CliTerminal is display-only; ChatInput below
          sends. The transcript mounts on a blank composer too, with the employee
          picker as its empty state (any view mode — the CLI terminal mounts once
          the first message has created the session). Mounting it up front is what
          lets the first message land in a node that was already on screen. */}
      {viewMode === 'cli' && sessionId ? (
        // Reserve flex space during lazy-chunk load so the ChatInput below stays
        // pinned to the bottom instead of flashing to the top for a frame.
        <Suspense fallback={<div style={{ flex: 1, minHeight: 0, background: 'var(--bg)' }} />}>
          <CliTerminal ref={cliTerminalRef} sessionId={sessionId} />
        </Suspense>
      ) : (
        <SessionQueueContext.Provider value={sessionQueue}>
          <ChatMessages
            initialScrollTop={initialScrollTop}
            messages={messages}
            loading={loading}
            hydrating={hydrating}
            turnPending={turnPending}
            liveFinalResponseId={liveFinalResponseId}
            streamingText={streamingText}
            onRetry={(t, m) => void handleSend(t, m)}
            hasOlderMessages={hasOlderMessages}
            loadingOlderMessages={loadingOlderMessages}
            olderMessagesError={olderMessagesError}
            onLoadOlderMessages={loadOlderMessages}
            onPeek={onPeek}
            blockArrivals={blockArrivals}
            liveTerminalDelegationIds={liveTerminalDelegationIds}
            blockAnnouncement={blockAnnouncement}
            footer={staleChatNotice}
            emptyState={sessionId ? undefined : newChatEmptyState ?? (
              <ChatEmployeePicker
                employees={pickerEmployees}
                selectedEmployee={selectedEmployee}
                onSelect={setSelectedEmployee}
                portalName={portalName}
              />
            )}
          />
        </SessionQueueContext.Provider>
      )}

      {/* Contributed chat surface. Composer-adjacent rather than in the message
          list, because this is mounted for every view including CLI — a
          contribution's visibility does not depend on host state it cannot see. */}
      <Slot
        area={AREAS.chatComposer}
        variant="chip"
        className="flex shrink-0 flex-wrap items-center gap-1 px-[var(--space-4)] py-[var(--space-1)]"
      />

      {/* Input — chat-style composer for every view, including CLI (the PTY engine
          accepts attachments + the prompt is injected into xterm via bracketed-paste). */}
      <ChatInput sessionId={sessionId} isActive={isActive}
        disabled={false}
        loading={loading}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        onNewSession={handleNewSession}
        onStatusRequest={handleStatusRequest}
        skillsVersion={skillsVersion}
        events={events}
        droppedFiles={fileDrop.droppedFiles}
        onDroppedFilesConsumed={fileDrop.clearDroppedFiles}
        focusTrigger={focusTrigger}
        statusSlot={
          // Background-work StateLine — the session is officially idle but
          // subagents / background tasks are still running. Informational only
          // (input stays live); hidden while a foreground turn is streaming
          // (the "Thinking" indicator owns that) and in the CLI view.
          !(viewMode === 'cli' && sessionId) && !loading ? (
            <BackgroundActivityStatus
              activity={backgroundActivity}
              delegatedActivity={
                delegatedActivity === undefined
                  ? (currentSession?.delegatedActivity as DelegatedActivity | null | undefined) ?? null
                  : delegatedActivity
              }
              employeeDisplayNames={employeeDisplayNames}
            />
          ) : undefined
        }
        selectorSlot={
          <ModelSelectorRow
            mode={sessionId ? 'existing' : 'new'}
            value={selector}
            onChange={handleSelectorChange}
            pendingNote={effortPendingNote}
            errorNote={selectorError ?? undefined}
            disabled={loading}
            contextTokens={liveContextTokens ?? (currentSession?.lastContextTokens as number | null | undefined) ?? undefined}
          />
        }
        terminalActionsSlot={
          viewMode === 'cli' && sessionId ? (
            <CliKeybar onKey={(data) => cliTerminalRef.current?.sendKey(data)} />
          ) : undefined
        }
      />
    </div>
  )
}
