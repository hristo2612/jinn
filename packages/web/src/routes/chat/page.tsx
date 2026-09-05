import { useState, useCallback, useEffect, useRef, useMemo, Suspense, lazy } from 'react'
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import {
  initialMobileView,
  parseSelectedSession,
  parseThreadOrigin,
  resolveDeepLink,
  selectedDelegatedActivityFromList,
  sessionPath,
  threadOriginLabel,
  type ThreadOrigin,
} from '@/components/chat/chat-route-helpers'
import { useGateway } from '@/hooks/use-gateway'
import { useModelRegistry } from '@/hooks/use-model-registry'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar, type SidebarOrder } from '@/components/chat/chat-sidebar'
import { NavRibbon } from '@/components/pill-nav'
import { MobileTabBar } from '@/components/chat/mobile-tab-bar'
import type { FreshChatSourceSession } from '@/components/chat/chat-pane'
import { ThreadPeek, type CommsPeekData } from '@/components/chat/thread-peek'
import { PeekPanel } from '@/components/peek/peek-panel'
import { PeekProvider } from '@/components/peek/peek-stack'
import { ChatErrorBoundary } from './chat-error-boundary'
import { ChatHeaderMenu } from './chat-header-menu'
import { MultiChatGrid } from './multi-chat-grid'
import { deriveChatGridIds } from './grid-placement'
import { usePaneIdentity } from './pane-identity'
import { useChatPaneState } from './use-chat-pane-state'
import { historyRecord, parseHistoryPreview } from './chat-history'
import { ChatGridDropOverlay } from './chat-grid-drop'
import { useChatGridAdd } from './use-chat-grid-add'
import { ChatPageHeader } from './chat-page-header'
import { removeWorkingSetSession } from './working-set'
import { formatMessage } from '@/components/chat/chat-messages'
import { useChatGridWorkspace } from './use-chat-grid-workspace'
import { chatHeaderTitle } from './header-title'
import { useMobileWorkingSet } from './use-mobile-working-set'
import { adjacentSessionId } from './session-navigation'
import { usePaneSessionActions } from './use-pane-session-actions'
import { useCopyFeedback } from './use-copy-feedback'
import { useSessionLifecycleActions } from './use-session-lifecycle-actions'
// Lazy so the file viewer's syntax-highlighter grammars + react-markdown are
// fetched only when a file tab is actually opened — not on the landing route.
const FileView = lazy(() =>
  import('@/components/chat/file-view').then((m) => ({ default: m.FileView })),
)
import { FileOpenContext } from '@/components/chat/file-open-context'
import { ShortcutOverlay } from '@/components/chat/shortcut-overlay'
import { useChatTabs, type ChatTab } from '@/hooks/use-chat-tabs'
import { invalidateLiveSessionSnapshot, prefetchLiveSessionSnapshot } from '@/hooks/use-live-session'
import { useKeyboardShortcuts, type ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { buildShortcuts } from '@/lib/shortcut-catalog'
import { useDuplicateSession, useSessions } from '@/hooks/use-sessions'
import type { Message } from '@/lib/conversations'
import { useSettings } from '@/routes/settings-provider'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import type { ViewMode } from '@/lib/view-mode'
import type { GatewayEvent } from '@jinn/gateway-events'
import { shareDebugLog, clearDebugLog } from '@/lib/debug-log'
import { buildNewSessionParams } from '@/components/chat/new-chat-helpers'
import { buildContinuationPrompt } from '@/lib/stale-chat'

export default function ChatPageWrapper() {
  return (
    <ChatErrorBoundary>
      <Suspense fallback={
        <PageLayout>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Loading...
          </div>
        </PageLayout>
      }>
        <ChatPage />
      </Suspense>
    </ChatErrorBoundary>
  )
}

function ChatPage() {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? 'Jinn'
  // The URL is the single source of truth for the selected session
  // (`/?session=<id>`) — selecting is a navigation, so browser back/forward
  // walk the session trail, refresh restores the thread, and links carry it.
  // A thread drill-in's history entry also carries its origin (the back chip);
  // Jinn ships in chrome-less Tauri shells, so every drill-in needs an in-app
  // way back while browser back keeps working on the web.
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const selectedId = useMemo(() => parseSelectedSession(location.search), [location.search])
  const threadOrigin = useMemo(() => parseThreadOrigin(location.state), [location.state])
  const selectedIdRef = useRef<string | null>(selectedId)
  const preservePaneFocusRef = useRef<string | null>(null)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  // Router location updates are React TRANSITIONS (react-router wraps them in
  // startTransition), so our own urgent state (openTab, closeTab) can commit a
  // frame BEFORE the URL. While one of our navigations is in flight, the
  // tab→URL reconciler must stand down or it re-navigates against the stale
  // URL and clobbers the entry (state included). undefined = nothing pending.
  const pendingNavRef = useRef<string | null | undefined>(undefined)
  // Mobile opens on the THREAD when the URL already selects a session
  // (refresh / deep link / direct open) and on the LIST for bare `/` — the
  // pane derives from the URL at mount, not only from tap events.
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>(
    () => initialMobileView(location.search),
  )
  // Sibling sessions for the currently selected employee (empty if direct/single session)
  const [, setEmployeeSessions] = useState<Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>>([])
  // When true, user explicitly started a new chat — don't auto-select first session
  const newChatIntentRef = useRef(false)
  const [systemPrimedId, setSystemPrimedId] = useState<string | null>(null)
  // Employee to preselect for a brand-new chat (contacting a session-less
  // employee from the sidebar, or via an ?employee= deep-link). Null = none.
  const [pendingEmployee, setPendingEmployee] = useState<string | null>(null)
  const sessionsQuery = useSessions()
  // Which pane the route shows, when it may show it, and the optimistic bubble handed to the session the pane creates.
  const { paneKey, committedId, awaitingOpen, pendingMessage, paneSlotRef, revealSelection, adoptSession, startComposer } = usePaneIdentity(selectedId, pendingEmployee, { newChatIntent: newChatIntentRef.current, sessionsPending: sessionsQuery.isPending, sessionCount: sessionsQuery.data?.length ?? 0 })
  const { workingSet, gridPicker, gridState, releaseMobilePicker } = useChatGridWorkspace(committedId, sessionsQuery.data, systemPrimedId)
  const removeWorkingSetPane = workingSet.remove
  const { viewport, focusedSessionId, mountedSessionIds, mobileSessionIds } = gridState
  const paneState = useChatPaneState(committedId, focusedSessionId)
  const sessionMeta = paneState.meta
  // Show-both: the slim nav ribbon is always mounted (desktop); only the 280px
  // chat list folds. The ribbon's top toggle drives listOpen (persisted), so nav
  // never leaves the rail. There is no list⇄nav swap any more.
  const [listOpen, setListOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('jinn-chat-list-open') !== 'false' } catch { return true }
  })
  const toggleList = useCallback(() => {
    setListOpen((prev) => {
      const next = !prev
      try { localStorage.setItem('jinn-chat-list-open', String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])
  // Mobile: pop from the thread back to the chat list (the tab bar's Chat screen).
  const backToList = useCallback(() => { releaseMobilePicker(); setMobileView('sidebar') }, [releaseMobilePicker])
  const [threadPreview, setThreadPreview] = useState<CommsPeekData | null>(() => parseHistoryPreview(location.state))
  const previewHandoffTargetRef = useRef<string | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  const previewSourceRef = useRef<{ sessionId: string | null; messageId: string; element: HTMLElement | null } | null>(null)
  const sessionScrollRef = useRef(new Map<string, number>())
  const returnFocusPendingRef = useRef(false)
  const destinationFocusPendingRef = useRef(false)

  const viewMode = paneState.viewMode
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const { copiedField, copiedPaneId, copyToClipboard, copyChat } = useCopyFeedback()
  const copyFromHeader = useCallback((text: string, field: string) => {
    copyToClipboard(text, field); setShowMoreMenu(false)
  }, [copyToClipboard])
  const { events, connectionSeq, skillsVersion, subscribe } = useGateway()
  const { data: engineRegistry } = useModelRegistry() // PTY capability per engine — drives the CLI view toggle
  const chatTabs = useChatTabs()
  const duplicateSessionMutation = useDuplicateSession()
  const focusedDelegatedActivity = useMemo(
    () => selectedDelegatedActivityFromList(sessionsQuery.data, focusedSessionId),
    [focusedSessionId, sessionsQuery.data],
  )
  const qc = useQueryClient()
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
  const sidebarOrderRef = useRef<SidebarOrder>({ sessionIds: [], employeeNames: [], employeeSessionMap: {} })
  const handleOrderComputed = useCallback((order: SidebarOrder) => { sidebarOrderRef.current = order }, [])


  // Close more menu on outside click. The moreMenu JSX is shared between the
  // desktop tab bar and the mobile header (rendered twice in the DOM, one
  // hidden via CSS), so a single ref points to only one copy — mobile taps
  // would be seen as "outside" and close the menu. Use a data-attribute
  // ancestor check instead so both copies count as "inside".
  useEffect(() => {
    if (!showMoreMenu) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (showMoreMenu && target && !target.closest('[data-more-menu]')) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMoreMenu])

  // D4: open the existing global search (⌘K). GlobalSearch listens for a
  // meta/ctrl+K keydown on window, so synthesize one — same mechanism the old
  // header search button used. Desktop lost its only visible search entry when
  // the header became pills; this restores it inside the ⋯ menu.
  const openGlobalSearch = useCallback(() => {
    setShowMoreMenu(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))
  }, [])

  // Update tab label/status when session meta changes.
  // Guarded by `sessionMeta.sessionId === selectedId` so we never cross-write
  // the previous session's meta onto the newly active tab during a switch
  // (a switch remounts ChatPane, which re-emits meta).
  const { updateTabStatus, closeTabBySessionId, reconcileTabs } = chatTabs
  useEffect(() => {
    if (!selectedId || !sessionMeta) return
    if (sessionMeta.sessionId !== selectedId) return
    updateTabStatus(selectedId, {
      label: sessionMeta.title || sessionMeta.employee || portalName,
      employeeName: sessionMeta.employee || undefined,
    })
  }, [selectedId, sessionMeta, portalName, updateTabStatus])

  // Subscribe to session lifecycle events so chat tabs reflect real-time
  // running/idle/error status, get their label updated on rename, and close
  // automatically when the underlying session is deleted (e.g. from sidebar
  // bulk-delete or another client). Without this, `status: 'running'` set by
  // handleSessionCreated never flips back, leaving a stale blue dot.
  useEffect(() => {
    const unsub = subscribe((frame: GatewayEvent) => {
      const { event, payload } = frame
      const p = (payload || {}) as { sessionId?: string; title?: string }
      const sid = p.sessionId
      if (!sid) return
      switch (event) {
        case 'session:started':
          updateTabStatus(sid, { status: 'running' })
          break
        case 'session:completed':
        case 'session:stopped':
          updateTabStatus(sid, { status: 'idle' })
          break
        case 'session:deleted':
          closeTabBySessionId(sid)
          break
        case 'session:updated':
          // Gateway currently emits {sessionId} only — handle title defensively
          // in case future emitters carry it. Stale labels after rename are
          // also reconciled via the useSessions() effect below.
          if (p.title) updateTabStatus(sid, { label: p.title })
          break
        default:
          return
      }
      // Every event above changed the session, so its snapshot is dropped: one
      // that changed while no pane for it was mounted — a child that STARTED
      // while its peek was closed included — takes a cold fetch on the next
      // visit instead of trusting a stale snapshot. The MOUNTED pane is
      // unaffected: it heard the same event and rewrites its own snapshot.
      invalidateLiveSessionSnapshot(sid)
    })
    return unsub
  }, [subscribe, updateTabStatus, closeTabBySessionId])

  // Reconcile persisted tabs against the authoritative sessions list:
  //   - drop orphan tabs whose sessions were deleted while the app was closed
  //     (or by another client before our WS reconnected)
  //   - normalize stale `status: 'running'` (persists across reloads otherwise)
  //   - pick up renames the WS event didn't carry a title for
  useEffect(() => {
    const sessions = sessionsQuery.data as
      | Array<{ id: string; title?: string; status?: string; employee?: string }>
      | undefined
    if (!sessions) return
    reconcileTabs(sessions)
  }, [sessionsQuery.data, reconcileTabs])

  const handleEmployeeSessionsAvailable = useCallback(
    (sessions: Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>) => {
      setEmployeeSessions(sessions.length > 1 ? sessions : [])
    },
    []
  )

  // The single session-navigation helper — every selection funnels here
  // (sidebar, open-thread jumps, keyboard nav, tab shortcuts). User-initiated
  // selections PUSH a history entry; system-initiated callers (auto-select,
  // tab restore) pass `replace`. `from` is a drill-in's origin, carried in
  // history state for the back chip.
  const handleSelect = useCallback(
    (id: string, opts?: { navigateMobile?: boolean; replace?: boolean; from?: ThreadOrigin; system?: boolean }) => {
      const currentId = selectedIdRef.current
      const currentScroller = document.querySelector<HTMLElement>('.chat-messages-scroll') // display-toggled away on a phone, where it reports scrollTop 0
      if (currentId && currentScroller?.clientHeight) sessionScrollRef.current.set(currentId, currentScroller.scrollTop)
      newChatIntentRef.current = false; setSystemPrimedId(opts?.system ? id : null); releaseMobilePicker()
      // On mobile, opening a session pushes from the list into the thread, and the
      // pane arrives with it (see revealSelection). The one exception is the
      // background auto-select of the most-recent session (handleSessionsLoaded):
      // it primes selectedId for the desktop thread but must NOT drop a phone user
      // into a chat when they tapped the Chat tab — always the LIST (GRS-023).
      if (opts?.navigateMobile !== false) { revealSelection(id); setMobileView('chat') }
      // Open a tab — label will be updated once session meta loads
      chatTabs.openTab({ sessionId: id, label: 'Loading...', status: 'idle', unread: false })
      // Skip when already selected — and dedupe PUSH re-fires while the same
      // navigation is still in flight (double-click, repeated auto-select).
      // REPLACE navigations pass through: they are idempotent, and the delete
      // routine pre-claims the sentinel before issuing its replace.
      if (id !== selectedIdRef.current && (opts?.replace || pendingNavRef.current !== id)) {
        pendingNavRef.current = id
        navigate(sessionPath(id), {
          replace: opts?.replace,
          state: opts?.from ? { from: opts.from } : undefined,
        })
      }
    },
    [chatTabs, navigate, releaseMobilePicker, revealSelection]
  )

  const handleFocusPane = useCallback((sessionId: string) => {
    workingSet.focus(sessionId)
    if (sessionId !== selectedIdRef.current) {
      preservePaneFocusRef.current = sessionId
      handleSelect(sessionId, { navigateMobile: false })
    }
  }, [handleSelect, workingSet])

  const handleMobileWorkingSetSelect = useCallback((sessionId: string) => {
    handleSelect(sessionId, { navigateMobile: false })
  }, [handleSelect])

  const gridAdd = useChatGridAdd(workingSet.add, workingSet.insert, selectedId, handleSelect, { workingSet: workingSet.state, primaryPaneKey: paneKey, committedSessionId: committedId, pickerPaneKey: gridPicker.paneKey, viewport })
  const handleRemovePane = useCallback((sessionId: string) => {
    const next = removeWorkingSetSession(workingSet.state, sessionId)
    workingSet.remove(sessionId)
    if (workingSet.state.focusedId === sessionId && next.focusedId) {
      handleSelect(next.focusedId, { replace: true, navigateMobile: false })
    }
  }, [handleSelect, workingSet])

  // URL → tab/intent sync: covers selections that did NOT come through
  // handleSelect — back/forward (POP), deep links, manual URL edits. openTab
  // dedupes and bails when already active, so re-running after a handleSelect
  // push is a no-op.
  const didMountRef = useRef(false)
  useEffect(() => {
    pendingNavRef.current = undefined
    if (navigationType === 'POP') setSystemPrimedId(null)
    if (selectedId) {
      newChatIntentRef.current = false
      chatTabs.openTab({ sessionId: selectedId, label: 'Loading...', status: 'idle', unread: false })
    } else if (didMountRef.current) {
      // Landed on bare `/` mid-session. On history traversal, arm the new-chat
      // intent so the auto-select can't hijack the back button — and on mobile,
      // "before any selection" means the chat LIST, so land there.
      if (navigationType === 'POP') {
        newChatIntentRef.current = true
        setMobileView('sidebar')
      }
      chatTabs.clearActiveTab()
    }
    didMountRef.current = true
    // openTab/clearActiveTab are stable; depending on the whole chatTabs memo
    // would re-fire this on every tab mutation.
  }, [selectedId, navigationType, chatTabs.openTab, chatTabs.clearActiveTab])

  // Auto-focus the input on any session change (sidebar click, tab switch,
  // keyboard nav, "+ New"). The bump lands after ChatPane has settled, so it
  // reaches the ChatInput whether the pane remounted or adopted the session.
  useEffect(() => {
    if (previewHandoffTargetRef.current === selectedId) return
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return
    if (preservePaneFocusRef.current) {
      const shouldPreserve = preservePaneFocusRef.current === selectedId
      preservePaneFocusRef.current = null
      if (shouldPreserve) return
    }
    paneState.bumpFocus(selectedId)
  }, [paneState.bumpFocus, selectedId])

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true; releaseMobilePicker()
    startComposer()
    setPendingEmployee(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
    // Leaving a session for the composer is a navigation — push, so back
    // returns to the thread you left. (The header names the composer, not a chat.)
    if (selectedIdRef.current) {
      pendingNavRef.current = null
      navigate('/')
    }
  }, [chatTabs, navigate, releaseMobilePicker, startComposer])

  // Start a new chat with a specific employee preselected — used when contacting
  // a session-less employee from the sidebar roster or via an ?employee= deep-link.
  // The actual session is created on first send (ChatPane → buildNewSessionParams).
  const contactEmployee = useCallback((name: string) => {
    newChatIntentRef.current = true; releaseMobilePicker()
    startComposer()
    setPendingEmployee(name)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
    // Contacting from within a session is a navigation to the composer — push.
    if (selectedIdRef.current) {
      pendingNavRef.current = null
      navigate('/')
    }
  }, [chatTabs, navigate, releaseMobilePicker, startComposer])

  // ?employee=<name> deep-link: an INTENT (compose to that employee), not a
  // location — consumed once so it doesn't re-fire or stick. ?session= is NOT
  // consumed any more: it IS the selection (see the URL model above);
  // resolveDeepLink's session-first precedence keeps a stray employee param
  // inert next to a session link.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const link = resolveDeepLink(searchParams)
    if (link?.kind !== 'employee') return
    contactEmployee(link.name)
    const next = new URLSearchParams(searchParams)
    next.delete('employee')
    setSearchParams(next, { replace: true })
  }, [searchParams, contactEmployee, setSearchParams])

  // Back target for the mobile file-view "back" button: the session that was
  // active when a file link was clicked. selectedIdRef (declared above) is read
  // at call time so the callback stays stable.
  const fileBackTargetRef = useRef<string | null>(null)

  // Open a file in an in-app tab (used by message path-links via FileOpenContext).
  const openFile = useCallback((path: string) => {
    fileBackTargetRef.current = selectedIdRef.current
    chatTabs.openFileTab(path)
    setMobileView('chat')
  }, [chatTabs])

  // Mobile-only: return from a file tab to the chat it was opened from. Switch
  // to that session's tab if it still exists; otherwise fall back to the sidebar.
  const handleFileBack = useCallback(() => {
    const backId = fileBackTargetRef.current
    if (backId) {
      const idx = chatTabs.tabs.findIndex((t) => t.kind === 'session' && t.sessionId === backId)
      if (idx >= 0) {
        chatTabs.switchTab(idx)
        setMobileView('chat')
        return
      }
    }
    setMobileView('sidebar')
  }, [chatTabs])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !newChatIntentRef.current && sessions.length > 0) {
        // Background auto-select of the most-recent session: primes the desktop
        // thread, but stays on the chat LIST on mobile (navigateMobile: false),
        // so tapping the Chat tab opens the list to pick/start a chat. REPLACE —
        // a system pick must not create a history entry.
        handleSelect(sessions[0].id, { navigateMobile: false, replace: true, system: true })
      }
    },
    [selectedId, handleSelect]
  )

  // Delete/archive own the atomic fallback navigation and working-set cleanup.
  const {
    deleteSession: handleDeleteSession,
    archiveSession: handleArchiveSession,
    unarchiveSession: handleUnarchiveSession,
  } = useSessionLifecycleActions({
    selectedIdRef,
    pendingNavRef,
    sidebarOrderRef,
    sessionRows: sessionsQuery.data,
    tabs: chatTabs,
    navigate,
    selectSession: handleSelect,
    removePane: removeWorkingSetPane,
    setMenuOpen: setShowMoreMenu,
  })

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(id) as { id?: string; title?: string; employee?: string }
      if (result?.id) {
        chatTabs.openTab({
          sessionId: result.id,
          label: result.title || 'Duplicated Chat',
          status: 'idle',
          unread: false,
          pinned: true,
          employeeName: result.employee || undefined,
        })
        // Opening the duplicate is a user navigation — push.
        pendingNavRef.current = result.id
        navigate(sessionPath(result.id))
        setShowMoreMenu(false)
        qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || 'Unknown error'}`)
    }
  }, [chatTabs, duplicateSessionMutation, qc, navigate])

  const handleDuplicateFromSidebar = useCallback((newSessionId: string) => {
    chatTabs.openTab({ sessionId: newSessionId, label: 'Duplicated Chat', status: 'idle', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])
  const paneSessionActions = usePaneSessionActions({ archive: handleArchiveSession, unarchive: handleUnarchiveSession, delete: handleDeleteSession, copyId: (sessionId) => copyToClipboard(sessionId, 'id', sessionId), duplicate: handleDuplicate, openBeside: gridPicker.open, setViewMode: paneState.setViewModeFor, copyCliResume: (sessionId, command) => copyToClipboard(command, 'cli', sessionId), shareDebugLog, clearDebugLog })

  const handleStartFreshChat = useCallback(async (previous: FreshChatSourceSession) => {
    const prompt = buildContinuationPrompt(previous.id)
    const result = await api.createSession(buildNewSessionParams({
      message: prompt,
      selectedEmployee: previous.employee ?? null,
      engine: previous.engine,
      model: previous.model,
      effortLevel: previous.effortLevel,
    }))
    const newSessionId = typeof result.id === 'string' ? result.id : ''
    if (!newSessionId) throw new Error('The gateway did not return a new session id')

    chatTabs.openTab({
      sessionId: newSessionId,
      label: typeof result.title === 'string' && result.title ? result.title : 'Continued Chat',
      status: 'running',
      unread: false,
      pinned: true,
      employeeName: previous.employee,
    })
    pendingNavRef.current = newSessionId
    navigate(sessionPath(newSessionId))
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, navigate, qc])

  // ChatPane callbacks
  const handleSessionCreated = useCallback((newId: string, pending?: Message) => {
    adoptSession(newId, pending)
    chatTabs.openTab({ sessionId: newId, label: 'New Chat', status: 'running', unread: false, pinned: true })
    // REPLACE — the composer entry BECOMES the created session (same
    // conversation); back should skip the empty composer, not revisit it.
    pendingNavRef.current = newId
    navigate(sessionPath(newId), { replace: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [adoptSession, chatTabs, qc, navigate])

  // Tag incoming meta with the sessionId it belongs to so consumers (e.g.
  // the tab-label effect) can ignore stale meta from a previous session.
  // We read selectedId via a ref (declared with the URL model above) so this
  // callback stays stable.
  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [qc])

  // Inline child affordances all request this one page-owned preview. The
  // same-URL history entry makes browser Back an honest close gesture; direct
  // sidebar/session selections continue through handleSelect without a preview.
  const sessionMetaRef = useRef(sessionMeta)
  useEffect(() => { sessionMetaRef.current = sessionMeta }, [sessionMeta])
  const requestThreadPreview = useCallback((currentId: string, peek: CommsPeekData) => {
    const escapedSessionId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(currentId)
      : currentId.replace(/["\\]/g, '\\$&')
    const scroller = document.querySelector<HTMLElement>(
      `[data-chat-pane-session="${escapedSessionId}"] .chat-messages-scroll`,
    )
    if (currentId && scroller?.clientHeight) sessionScrollRef.current.set(currentId, scroller.scrollTop)
    previewSourceRef.current = {
      sessionId: currentId,
      messageId: peek.messageId,
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    }
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    setThreadPreview(peek)
    const existing = parseHistoryPreview(location.state)
    navigate(`${location.pathname}${location.search}`, {
      replace: Boolean(existing),
      state: { ...historyRecord(location.state), threadPreview: peek },
    })
  }, [location.pathname, location.search, location.state, navigate])

  const closeThreadPreview = useCallback(() => {
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    if (parseHistoryPreview(location.state)) navigate(-1)
    else setThreadPreview(null)
  }, [location.state, navigate])

  const openPreviewFullChat = useCallback(async (childId: string) => {
    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller
    try {
      await prefetchLiveSessionSnapshot(childId, controller.signal)
      if (controller.signal.aborted) return
      previewHandoffTargetRef.current = childId
      returnFocusPendingRef.current = true
      const parentId = selectedIdRef.current
      handleSelect(childId, {
        replace: true,
        from: parentId
          ? { id: parentId, label: threadOriginLabel(sessionMetaRef.current?.employee, portalName) }
          : undefined,
      })
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      throw error
    }
  }, [handleSelect, portalName])

  // Location state owns open/Back cancellation. A route committed by the
  // handoff is the one exception: keep the shell until that exact child paints.
  useEffect(() => {
    const historyPreview = parseHistoryPreview(location.state)
    if (historyPreview) {
      setThreadPreview(historyPreview)
      return
    }
    const target = previewHandoffTargetRef.current
    if (target && selectedId === target) return
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    setThreadPreview(null)
  }, [location.state, selectedId])

  const handlePaneContentReady = useCallback((readyId: string) => {
    if (previewHandoffTargetRef.current === readyId) {
      previewAbortRef.current = null
      previewHandoffTargetRef.current = null
      destinationFocusPendingRef.current = true
      setThreadPreview(null)
      return
    }

    const source = previewSourceRef.current
    if (returnFocusPendingRef.current && source?.sessionId === readyId) {
      returnFocusPendingRef.current = false
      requestAnimationFrame(() => {
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(source.messageId)
          : source.messageId.replace(/["\\]/g, '\\$&')
        const target = source.element?.isConnected
          ? source.element
          : document.querySelector<HTMLElement>(`[data-source-message-id="${escaped}"] button, [data-block-id="${escaped}"]`)
        target?.focus({ preventScroll: true })
      })
    }
  }, [])

  const handlePreviewExited = useCallback(() => {
    if (!destinationFocusPendingRef.current) return
    destinationFocusPendingRef.current = false
    requestAnimationFrame(() => {
      if (window.innerWidth >= 1024 && focusedSessionId) paneState.bumpFocus(focusedSessionId)
      else document.querySelector<HTMLElement>('button[aria-label^="Back"]')?.focus({ preventScroll: true })
    })
  }, [focusedSessionId, paneState.bumpFocus])

  // The in-app way back for a drill-in: POP the entry the jump pushed (never
  // push a new one) — browser back and the chip walk the same trail.
  const goBackToOrigin = useCallback(() => navigate(-1), [navigate])
  const backTo = useMemo(
    () => (threadOrigin && selectedId ? { label: threadOrigin.label, onClick: goBackToOrigin } : undefined),
    [threadOrigin, selectedId, goBackToOrigin],
  )
  const backToFor = useCallback((sessionId: string) => sessionId === selectedId ? backTo : undefined, [backTo, selectedId])

  // Navigation helpers for keyboard shortcuts
  const navigateSession = useCallback((direction: 1 | -1) => {
    const target = adjacentSessionId(sidebarOrderRef.current.sessionIds, selectedId, direction)
    if (target) handleFocusPane(target)
  }, [selectedId, handleFocusPane])

  const cycleEmployee = useCallback(() => {
    const { employeeNames, employeeSessionMap } = sidebarOrderRef.current
    if (employeeNames.length === 0) return
    const currentEmployee = sessionMeta?.employee ?? null
    const currentIdx = currentEmployee ? employeeNames.indexOf(currentEmployee) : -1
    const nextIdx = (currentIdx + 1) % employeeNames.length
    const nextEmployee = employeeNames[nextIdx]
    const firstSession = employeeSessionMap[nextEmployee]?.[0]
    if (firstSession) handleSelect(firstSession)
  }, [sessionMeta, handleSelect])

  // Tab activation = session selection (pushes a history entry) for session
  // tabs; file tabs stay a pure tab-model switch (they live outside the URL).
  const activateTab = useCallback((index: number) => {
    const target = chatTabs.tabs[index]
    if (!target) return
    if (target.kind === 'session') handleSelect(target.sessionId)
    else chatTabs.switchTab(index)
  }, [chatTabs, handleSelect])

  const cycleTab = useCallback((direction: 1 | -1) => {
    const count = chatTabs.tabs.length
    if (count === 0) return
    activateTab((chatTabs.activeIndex + direction + count) % count)
  }, [chatTabs, activateTab])

  // Centralized keyboard shortcut registry. SHORTCUT_CATALOG describes the keys
  // (and is what Settings lists); this map is the behaviour behind each one.
  const shortcuts = useMemo<ShortcutDef[]>(() => {
    const deleteSession = { action: () => { if (focusedSessionId && window.confirm('Delete this session?')) handleDeleteSession(focusedSessionId) }, enabled: !!focusedSessionId }
    return buildShortcuts({
      'new-chat': { action: handleNewChat },
      'next-session': { action: () => navigateSession(1) },
      'prev-session': { action: () => navigateSession(-1) },
      'next-employee': { action: cycleEmployee },
      'delete-session': deleteSession,
      'delete-session-forward': deleteSession,
      'copy-chat': { action: () => { if (focusedSessionId) void copyChat(focusedSessionId) }, enabled: !!focusedSessionId },
      'close-overlay': { action: () => { if (showShortcutOverlay) setShowShortcutOverlay(false); else if (showMoreMenu) setShowMoreMenu(false) } },
      'focus-chat': { action: () => document.querySelector<HTMLElement>('[data-chat-pane-active="true"] [data-chat-textarea]')?.focus() },
      'keyboard-shortcuts': { action: () => setShowShortcutOverlay(v => !v) },
      'close-tab': { action: () => { if (chatTabs.activeIndex >= 0) chatTabs.closeTab(chatTabs.activeIndex) } },
      'prev-tab': { action: () => cycleTab(-1) },
      'next-tab': { action: () => cycleTab(1) },
      'toggle-chat-list': { action: toggleList },
      'toggle-chat-list-alias': { action: toggleList },
      'tab-1': { action: () => activateTab(0) },
      'tab-2': { action: () => activateTab(1) },
      'tab-3': { action: () => activateTab(2) },
      'tab-4': { action: () => activateTab(3) },
      'tab-5': { action: () => activateTab(4) },
      'tab-6': { action: () => activateTab(5) },
      'tab-7': { action: () => activateTab(6) },
      'tab-8': { action: () => activateTab(7) },
      'tab-9': { action: () => activateTab(8) },
    })
  }, [handleNewChat, navigateSession, cycleEmployee, copyChat, focusedSessionId, handleDeleteSession, showShortcutOverlay, showMoreMenu, chatTabs, toggleList, activateTab, cycleTab])

  useKeyboardShortcuts(shortcuts)

  // Tab → URL reconciliation: tab restore on mount, ⌘W close fallout, and
  // orphan-tab drops land on the tab model first — reflect them into the URL
  // with REPLACE (system-initiated, not user navigation). Gated on hydration
  // so the pre-load empty tab list can't clobber a deep link, and on the
  // active tab OBJECT actually changing: when only the URL moved (back/
  // forward, deep link), the stale active tab must not drag the URL backwards
  // — the URL wins and the openTab sync above brings the tabs along.
  const prevActiveTabRef = useRef<ChatTab | null | undefined>(undefined)
  const prevSelectedForTabSyncRef = useRef(selectedId)
  useEffect(() => {
    if (!chatTabs.hydrated) return
    // One of our navigations is still in flight (location commits are lower-
    // priority transitions) — the URL is stale; reconciling now would drag it
    // backwards. The effect re-runs when the navigation lands (selectedId dep).
    if (pendingNavRef.current !== undefined) return
    const at = chatTabs.activeTab
    const tabChanged = prevActiveTabRef.current === undefined || prevActiveTabRef.current !== at
    const urlMoved = prevSelectedForTabSyncRef.current !== selectedId
    prevActiveTabRef.current = at
    prevSelectedForTabSyncRef.current = selectedId
    // On the run where the URL itself moved, tabs FOLLOW the URL (the openTab
    // sync above lands next flush) — never the other way. Without this, a
    // fresh selection landing while its tab is still being opened (e.g. the
    // post-delete neighbour fallback, whose old tab was just closed) would be
    // bounced to '/' by the no-active-tab branch below.
    if (!tabChanged || urlMoved) return

    if (at && at.kind === 'session' && at.sessionId !== selectedId) {
      handleSelect(at.sessionId, { replace: true, navigateMobile: false, system: true })
      return
    }

    if (!at && selectedId && !newChatIntentRef.current) {
      setEmployeeSessions([])
      pendingNavRef.current = null
      navigate('/', { replace: true })
    }
    // When at.kind === 'file', leave selectedId untouched — we render FileView
    // instead of ChatPane, but the underlying session selection is preserved.
  }, [chatTabs.hydrated, chatTabs.activeTab, selectedId, handleSelect, navigate])

  const cliModeAvailable = !sessionMeta?.engine || engineRegistry?.engines?.[sessionMeta.engine]?.supportsPty === true
  const activeSessionTab = chatTabs.activeTab?.kind === 'session' ? chatTabs.activeTab : null
  const viewSwitchLocked = sessionMeta?.engine === 'codex' && activeSessionTab?.sessionId === focusedSessionId && activeSessionTab.status === 'running'
  const cliTitle = viewSwitchLocked
    ? 'Codex view switching is locked while a turn is running'
    : cliModeAvailable ? undefined : 'CLI view is not available for this engine'
  const effectiveViewMode: ViewMode = cliModeAvailable ? viewMode : 'chat'

  const moreMenu = (
    <ChatHeaderMenu
      open={showMoreMenu}
      onOpenChange={setShowMoreMenu}
      selectedId={focusedSessionId}
      sessionMeta={sessionMeta}
      openGlobalSearch={openGlobalSearch}
      effectiveViewMode={effectiveViewMode}
      cliModeAvailable={cliModeAvailable}
      viewSwitchLocked={viewSwitchLocked}
      cliTitle={cliTitle}
      setAndPersistViewMode={paneState.setViewMode}
      onDuplicate={handleDuplicate}
      duplicatePending={duplicateSessionMutation.isPending}
      onArchive={handleArchiveSession}
      onUnarchive={handleUnarchiveSession}
      onCopyToClipboard={copyFromHeader}
      onShareDebugLog={shareDebugLog}
      onClearDebugLog={clearDebugLog}
      onDeleteSession={handleDeleteSession}
      onOpenChatBeside={gridPicker.open}
    />
  )
  // The conversation title — slim inline (desktop) / centered nav bar (mobile).
  const headerTitle = chatHeaderTitle({ focusedSessionId, meta: sessionMeta, sessions: sessionsQuery.data })
  const mobileWorkingSet = useMobileWorkingSet({
    sessionIds: mobileSessionIds, activeId: focusedSessionId, sessions: sessionsQuery.data ?? [],
    subscribe, connectionSeq, onSelect: handleMobileWorkingSetSelect,
  })
  const onMobileList = mobileView === 'sidebar'
  const pickerPane = gridPicker.bind(gridAdd.addPane, workingSet.add, handleSessionCreated)
  const desktopMultiPane = chatTabs.activeTab?.kind !== 'file' && !awaitingOpen && !viewport.mobile && deriveChatGridIds({ sessionIds: mountedSessionIds, primaryPaneKey: paneKey, primarySessionId: committedId, pickerPaneKey: pickerPane?.paneKey }).length > 1
  return (
    <FileOpenContext.Provider value={openFile}>
    <PeekProvider>
    <PageLayout chromeless>
      <div className="flex overflow-hidden h-full">
        {/* Desktop keeps the slim nav ribbon while its 280px chat list folds.
            The ribbon remains outside the clipping column so its labels can
            escape over the thread, while the list itself reflows at a fixed
            width and never changes its internal measure during the fold.
            The sibling thread therefore owns the remaining width throughout. */}
        {!viewport.mobile && <div className="group/sidebar hidden h-full shrink-0 lg:flex">
          <NavRibbon listOpen={listOpen} onToggleList={toggleList} />
          {/* Fold the list by animating its width; the inner column keeps a fixed
              280px so its contents don't reflow mid-fold. */}
          <div
            className={cn(
              "h-full overflow-hidden transition-[width] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
              listOpen ? "w-[280px]" : "w-0",
            )}
            aria-hidden={!listOpen}
          >
            <div className="h-full w-[280px]">
              <ChatSidebar
                selectedId={selectedId}
                onSelect={handleSelect}
                onNewChat={handleNewChat}
                onDelete={handleDeleteSession}
                onArchive={handleArchiveSession}
                onUnarchive={handleUnarchiveSession}
                onDuplicate={handleDuplicateFromSidebar}
                onSessionsLoaded={handleSessionsLoaded}
                onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
                onOrderComputed={handleOrderComputed}
                onContactEmployee={contactEmployee}
              />
            </div>
          </div>
        </div>}

        <div className="chat-pills-layout relative min-w-0 flex-1 flex-col overflow-hidden bg-background flex">
          {/* Single-pane content scrolls beneath the theme-aware header cloud. */}
          {!desktopMultiPane && <div
            aria-hidden data-chat-top-scrim
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-[5] h-[88px]",
              onMobileList && "hidden lg:block",
            )}
            style={{ background: 'linear-gradient(to bottom, var(--bg) 0, var(--bg) 52px, color-mix(in srgb, var(--bg) 68%, transparent) 68px, transparent 100%)' }}
          />}

          {/* Mobile keeps its nav chrome; multi-pane desktop moves identity into panes. */}
          <ChatPageHeader
            hideOnMobile={onMobileList}
            title={headerTitle}
            backTo={backTo}
            onBack={backToList}
            onNew={handleNewChat}
            moreMenu={moreMenu}
            mobileWorkingSet={mobileWorkingSet}
            copiedField={desktopMultiPane ? null : copiedField}
            hideDesktop={desktopMultiPane}
          />

          {viewport.mobile && <div className={mobileView === 'sidebar' ? 'flex-1 overflow-hidden lg:hidden' : 'hidden'}>
            {/* Mobile: the chat list is the full-width body; the bottom tab bar
                (rendered below) is the persistent nav. */}
            <ChatSidebar
              variant="mobile"
              selectedId={selectedId}
              onSelect={handleSelect}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              onArchive={handleArchiveSession}
              onUnarchive={handleUnarchiveSession}
              onDuplicate={handleDuplicateFromSidebar}
              onSessionsLoaded={handleSessionsLoaded}
              onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
              onOrderComputed={handleOrderComputed}
              onContactEmployee={contactEmployee}
            />
          </div>}

          <div
            ref={paneSlotRef}
            data-chat-grid-drop-surface
            data-chat-grid-drop-state={gridAdd.drop.active ? 'eligible' : 'idle'}
            {...gridAdd.drop.handlers}
            className={cn(
            "relative flex-1 overflow-hidden flex flex-col",
            "mobile-working-set-thread",
            mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'
          )}>
            {/* File tab → render the in-app file viewer inside the same bounded
                wrapper (so scrolling is contained). Otherwise the single ChatPane,
                handling new-chat (sessionId=null) and the selected session. See
                usePaneIdentity for what the key does and does not remount. */}
            {chatTabs.activeTab?.kind === 'file' ? (
              <Suspense fallback={<div className="flex-1" />}>
                <FileView path={chatTabs.activeTab.path} embedded onBack={handleFileBack} />
              </Suspense>
            ) : awaitingOpen ? <div className="flex-1" /> : (
              <MultiChatGrid
                sessionIds={mountedSessionIds}
                focusedId={focusedSessionId}
                primary={{
                  paneKey,
                  sessionId: committedId,
                  pendingUserMessage: pendingMessage,
                  initialEmployee: committedId ? undefined : pendingEmployee,
                  onSessionCreated: handleSessionCreated,
                  onClose: () => { if (workingSet.state.focusedId) handleFocusPane(workingSet.state.focusedId) },
                  viewMode: effectiveViewMode,
                  focusTrigger: paneState.focusTriggerFor(committedId),
                  delegatedActivity: focusedDelegatedActivity,
                }}
                viewport={viewport}
                onFocus={handleFocusPane}
                onRemove={handleRemovePane}
                metaById={paneState.metaById} sessionTitleFor={(id) => sessionsQuery.data?.find((session) => String(session.id ?? '') === id)?.title}
                runtime={{ portalName, subscribe, engineRegistry, connectionSeq, skillsVersion, events }}
                sessionActions={paneSessionActions}
                backToFor={backToFor}
                copiedSessionId={desktopMultiPane ? copiedPaneId : null}
                scrollTopFor={(sessionId) => sessionScrollRef.current.get(sessionId)}
                viewModeFor={paneState.viewModeFor}
                focusTriggerFor={paneState.focusTriggerFor}
                delegatedActivityFor={(sessionId) => selectedDelegatedActivityFromList(sessionsQuery.data, sessionId)}
                onMeta={paneState.updateMeta}
                onNewMeta={paneState.updateNewMeta}
                onOpenFile={(sessionId, path) => {
                  fileBackTargetRef.current = sessionId
                  chatTabs.openFileTab(path)
                  setMobileView('chat')
                }}
                onPeek={requestThreadPreview}
                onNewChat={handleNewChat}
                onRefresh={handleRefresh}
                onContentReady={handlePaneContentReady}
                onStartFreshChat={handleStartFreshChat}
                pickerPane={pickerPane}
              />
            )}
            <ChatGridDropOverlay placement={gridAdd.drop.placement} />
          </div>

          {/* Stable above the session-keyed ChatPane: it survives route remount
              and releases only after the destination reports meaningful paint. */}
          <ThreadPeek
            peek={threadPreview}
            onClose={closeThreadPreview}
            onOpenFullChat={threadPreview?.sessionId ? openPreviewFullChat : undefined}
            onExited={handlePreviewExited}
            renderContent={formatMessage}
          />
        </div>

        {/* A sibling of the thread column, not a child of it: the rail takes its
            372px from the row so the thread reflows narrower instead of being
            covered, and the floating header pills stay over the thread. On the
            phone it portals out as a bottom sheet and occupies nothing here. */}
        <PeekPanel />
      </div>

      {/* Mobile bottom tab bar — persistent nav on the chat-list screen; hidden on
          the thread (Apple hidesBottomBarWhenPushed: the composer owns the bottom). */}
      {onMobileList && <MobileTabBar />}

      {showShortcutOverlay && (
        <ShortcutOverlay
          shortcuts={shortcuts}
          onClose={() => setShowShortcutOverlay(false)}
        />
      )}

      {/* D8: clear the floating pills/scrim by padding the scroll container itself
          and aligning scroll anchoring to the same offset. Driven by the shared
          token (pill height + gap + safe-area) so it auto-tracks notched devices —
          no fragile `:first-child` coupling or magic number. Content still scrolls
          beneath the translucent scrim. */}
      <style>{`
        .chat-pills-layout .chat-messages-scroll {
          padding-top: var(--chat-top-clearance);
          scroll-padding-top: var(--chat-top-clearance);
        }
      `}</style>
    </PageLayout>
    </PeekProvider>
    </FileOpenContext.Provider>
  )
}
