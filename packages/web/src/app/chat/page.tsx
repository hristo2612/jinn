"use client"
import { useState, useCallback, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { useGateway } from '@/hooks/use-gateway'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar } from '@/components/chat/chat-sidebar'
import { ChatMessages } from '@/components/chat/chat-messages'
import { ChatInput } from '@/components/chat/chat-input'
import { QueuePanel } from '@/components/chat/queue-panel'
import type { Message, MediaAttachment } from '@/lib/conversations'
import { saveIntermediateMessages, loadIntermediateMessages, clearIntermediateMessages } from '@/lib/conversations'
import { useSettings } from '@/app/settings-provider'

function getOnboardingPrompt(portalName: string, userMessage: string) {
  return `This is your first time being activated. The user just set up ${portalName} and opened the web dashboard for the first time.

Read your CLAUDE.md instructions and the onboarding skill at ~/.jinn/skills/onboarding/SKILL.md, then follow the onboarding flow:
- Greet the user warmly and introduce yourself as ${portalName}
- Briefly explain what you can do (manage cron jobs, hire AI employees, connect to Slack, etc.)
- Ask the user what they'd like to set up first

The user said: "${userMessage}"`
}

export default function ChatPageWrapper() {
  return (
    <Suspense fallback={
      <PageLayout>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
          Loading...
        </div>
      </PageLayout>
    }>
      <ChatPage />
    </Suspense>
  )
}

function ChatPage() {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? 'Jinn'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  const [sessionMeta, setSessionMeta] = useState<{ engine?: string; engineSessionId?: string; model?: string; title?: string; employee?: string } | null>(null)
  const streamingTextRef = useRef('')
  const [streamingText, setStreamingText] = useState('')
  // Track the index in messages[] where intermediate (streaming) messages start
  const intermediateStartRef = useRef<number>(-1)
  // When true, user explicitly started a new chat — don't auto-select first session
  const newChatIntentRef = useRef(false)
  const [currentSession, setCurrentSession] = useState<Record<string, unknown> | null>(null)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const { events, connectionSeq, skillsVersion } = useGateway()
  const searchParams = useSearchParams()
  const onboardingTriggered = useRef(false)
  // When set, the current session is a stub awaiting the user's first message
  const stubSessionRef = useRef(false)

  // Close more menu on outside click
  useEffect(() => {
    if (!showMoreMenu) return
    function handleClick(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMoreMenu])

  const copyToClipboard = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setShowMoreMenu(false)
    setTimeout(() => setCopiedField(null), 1500)
  }, [])

  // Auto-trigger onboarding on first visit
  useEffect(() => {
    if (onboardingTriggered.current) return

    const shouldOnboard = searchParams.get('onboarding') === '1'

    if (shouldOnboard) {
      onboardingTriggered.current = true
      triggerOnboarding()
    } else {
      api.getOnboarding().then((data) => {
        if (data.needed && !onboardingTriggered.current) {
          onboardingTriggered.current = true
          triggerOnboarding()
        }
      }).catch(() => {})
    }
  }, [searchParams])

  function triggerOnboarding() {
    // Create a stub session with a greeting — engine does NOT run yet.
    // The real onboarding prompt fires when the user sends their first message.
    api.createStubSession({
      greeting: `Hey! 👋 Say hi when you're ready to get started.`,
      title: 'Welcome',
    }).then((session) => {
      const id = String((session as Record<string, unknown>).id)
      stubSessionRef.current = true
      setSelectedId(id)
      setRefreshKey((k) => k + 1)
    }).catch(() => {
      // Silently fail — user can still start a normal chat
    })
  }

  // Helper: persist intermediate messages to localStorage
  const persistIntermediate = useCallback((msgs: Message[], sessionId: string | null) => {
    if (!sessionId) return
    const start = intermediateStartRef.current
    if (start < 0) return
    const intermediate = msgs.slice(start)
    if (intermediate.length > 0) {
      saveIntermediateMessages(sessionId, intermediate)
    }
  }, [])

  // Listen for session events (tool calls + completion)
  useEffect(() => {
    if (events.length === 0) return
    const latest = events[events.length - 1]
    const payload = latest.payload as Record<string, unknown>

    const matchesSession = selectedId && payload.sessionId === selectedId
    if (!matchesSession) return

    if (latest.event === 'session:delta') {
      const deltaType = String(payload.type || 'text')

      if (deltaType === 'text') {
        const chunk = String(payload.content || '')
        streamingTextRef.current += chunk
        setStreamingText(streamingTextRef.current)
      } else if (deltaType === 'tool_use') {
        // If we were streaming text, flush it as a message first
        if (streamingTextRef.current) {
          const flushed = streamingTextRef.current
          streamingTextRef.current = ''
          setStreamingText('')
          setMessages((prev) => {
            // Mark where intermediate messages start (if not already set)
            if (intermediateStartRef.current < 0) {
              intermediateStartRef.current = prev.length
            }
            const updated = [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: flushed,
                timestamp: Date.now(),
              },
            ]
            persistIntermediate(updated, selectedId || (payload.sessionId as string))
            return updated
          })
        }
        const toolName = String(payload.toolName || 'tool')
        setMessages((prev) => {
          if (intermediateStartRef.current < 0) {
            intermediateStartRef.current = prev.length
          }
          const updated = [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: `Using ${toolName}`,
              timestamp: Date.now(),
              toolCall: toolName,
            },
          ]
          persistIntermediate(updated, selectedId || (payload.sessionId as string))
          return updated
        })
      } else if (deltaType === 'tool_result') {
        setMessages((prev) => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (last && last.role === 'assistant' && last.toolCall) {
            updated[updated.length - 1] = { ...last, content: `Used ${last.toolCall}` }
          }
          persistIntermediate(updated, selectedId || (payload.sessionId as string))
          return updated
        })
      }
    }

    if (latest.event === 'session:interrupted') {
      // Engine was interrupted — clear streaming, wait for new turn
      streamingTextRef.current = ''
      setStreamingText('')
    }

    if (latest.event === 'session:stopped') {
      if ((latest.payload as Record<string, unknown>)?.sessionId === selectedId) {
        setLoading(false)
        setStreamingText('')
      }
    }

    if (latest.event === 'session:completed') {
      // Clear streaming state
      streamingTextRef.current = ''
      setStreamingText('')
      setLoading(false)
      intermediateStartRef.current = -1

      // Clear intermediate messages from localStorage (keep showing in UI)
      const completedSessionId = selectedId || (payload.sessionId ? String(payload.sessionId) : null)
      if (completedSessionId) {
        clearIntermediateMessages(completedSessionId)
      }

      if (payload.result) {
        // Replace any partially-streamed message with the final complete result
        setMessages((prev) => {
          // Remove trailing non-tool assistant message if it was from streaming
          const cleaned = [...prev]
          const last = cleaned[cleaned.length - 1]
          if (last && last.role === 'assistant' && !last.toolCall) {
            cleaned.pop()
          }
          return [
            ...cleaned,
            {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: String(payload.result),
              timestamp: Date.now(),
            },
          ]
        })
      }
      if (payload.error && !payload.result) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `Error: ${payload.error}`,
            timestamp: Date.now(),
          },
        ])
      }
      setRefreshKey((k) => k + 1)
    }
  }, [events, selectedId, persistIntermediate])

  const loadSession = useCallback(async (id: string) => {
    try {
      const session = (await api.getSession(id)) as Record<string, unknown>
      setCurrentSession(session)
      setSessionMeta({
        engine: session.engine ? String(session.engine) : undefined,
        engineSessionId: session.engineSessionId ? String(session.engineSessionId) : undefined,
        model: session.model ? String(session.model) : undefined,
        title: session.title ? String(session.title) : undefined,
        employee: session.employee ? String(session.employee) : undefined,
      })
      const history = session.messages || session.history || []
      const backendMessages: Message[] = Array.isArray(history)
        ? history.map((m: Record<string, unknown>) => ({
            id: crypto.randomUUID(),
            role: (m.role as 'user' | 'assistant') || 'assistant',
            content: String(m.content || m.text || ''),
            timestamp: m.timestamp ? Number(m.timestamp) : Date.now(),
          }))
        : []
      if (session.status === 'error' && session.lastError) {
        const lastMessage = backendMessages[backendMessages.length - 1]
        const errorText = `Error: ${String(session.lastError)}`
        if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.content !== errorText) {
          backendMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: errorText,
            timestamp: Date.now(),
          })
        }
      }

      const isRunning = session.status === 'running'

      if (isRunning) {
        // Restore intermediate messages from localStorage
        const cached = loadIntermediateMessages(id)
        if (cached.length > 0) {
          intermediateStartRef.current = backendMessages.length
          setMessages([...backendMessages, ...cached])
        } else {
          intermediateStartRef.current = backendMessages.length
          setMessages(backendMessages)
        }
        setLoading(true)
      } else {
        // Session is done — clear any stale intermediate cache and just show backend messages
        clearIntermediateMessages(id)
        intermediateStartRef.current = -1
        setMessages(backendMessages)
      }
    } catch {
      setMessages([])
      setSessionMeta(null)
      setCurrentSession(null)
      intermediateStartRef.current = -1
    }
  }, [])

  useEffect(() => {
    if (!connectionSeq || !selectedId) return
    loadSession(selectedId)
  }, [connectionSeq, selectedId, loadSession])

  useEffect(() => {
    if (!selectedId || !loading) return
    const timer = setInterval(async () => {
      try {
        const session = (await api.getSession(selectedId)) as Record<string, unknown>
        if (session.status !== 'running') {
          await loadSession(selectedId)
          setLoading(false)
        }
      } catch {
        // ignore transient polling errors while WS reconnects
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [selectedId, loading, loadSession])

  const handleSelect = useCallback(
    (id: string) => {
      newChatIntentRef.current = false
      setSelectedId(id)
      setMessages([])
      setLoading(false)
      setMobileView('chat')
      loadSession(id)
    },
    [loadSession]
  )

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true
    setSelectedId(null)
    setMessages([])
    setLoading(false)
    setSessionMeta(null)
    setMobileView('chat')
    intermediateStartRef.current = -1
  }, [])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !onboardingTriggered.current && !newChatIntentRef.current && sessions.length > 0) {
        handleSelect(sessions[0].id)
      }
    },
    [selectedId, handleSelect]
  )

  const handleSend = useCallback(
    async (message: string, media?: MediaAttachment[], interrupt?: boolean) => {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        media,
      }
      setMessages((prev) => {
        intermediateStartRef.current = prev.length + 1 // after the user message
        return [...prev, userMsg]
      })
      setLoading(true)

      try {
        let sessionId = selectedId

        // If this is a stub session (lazy onboarding), the first user message
        // triggers the real onboarding prompt sent to the engine.
        if (sessionId && stubSessionRef.current) {
          stubSessionRef.current = false
          const onboardingPrompt = getOnboardingPrompt(portalName, message)
          await api.sendMessage(sessionId, { message: onboardingPrompt })
          setRefreshKey((k) => k + 1)
        } else if (!sessionId) {
          const session = (await api.createSession({
            source: 'web',
            prompt: message,
          })) as Record<string, unknown>
          sessionId = String(session.id)
          setSelectedId(sessionId)
          setRefreshKey((k) => k + 1)
        } else {
          await api.sendMessage(sessionId, { message, interrupt: interrupt || undefined })
          setRefreshKey((k) => k + 1)
        }
      } catch (err) {
        setLoading(false)
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `Error: ${err instanceof Error ? err.message : 'Failed to send message'}`,
            timestamp: Date.now(),
          },
        ])
      }
    },
    [selectedId, portalName]
  )

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(id)
      if (selectedId === id) {
        setSelectedId(null)
        setMessages([])
        setLoading(false)
        setSessionMeta(null)
        streamingTextRef.current = ''
        setStreamingText('')
        intermediateStartRef.current = -1
      }
      clearIntermediateMessages(id)
      setRefreshKey((k) => k + 1)
    } catch { /* ignore */ }
    setConfirmDelete(false)
    setShowMoreMenu(false)
  }, [selectedId])

  const handleInterrupt = useCallback(async () => {
    if (!selectedId) return
    try {
      await api.stopSession(selectedId)
    } catch {
      // best effort
    }
    setLoading(false)
    setStreamingText('')
  }, [selectedId])

  const handleStatusRequest = useCallback(async () => {
    if (!selectedId) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: 'No active session. Send a message to start one.',
          timestamp: Date.now(),
        },
      ])
      return
    }

    try {
      const session = (await api.getSession(selectedId)) as Record<string, unknown>
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

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: info,
          timestamp: Date.now(),
        },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: 'Failed to fetch session status.',
          timestamp: Date.now(),
        },
      ])
    }
  }, [selectedId])

  return (
    <PageLayout>
      <div className="h-[calc(100%-48px)] lg:h-full" style={{
        display: 'flex',
        overflow: 'hidden',
      }}>
        {/* Desktop sidebar — always visible on md+ */}
        <div className="hidden lg:block" style={{ width: 280, flexShrink: 0, height: '100%' }}>
          <ChatSidebar
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            onDelete={handleDeleteSession}
            refreshKey={refreshKey}
            connectionSeq={connectionSeq}
            onSessionsLoaded={handleSessionsLoaded}
            events={events}
          />
        </div>

        {/* Mobile: sidebar view */}
        <div
          className={mobileView === 'sidebar' ? 'block lg:hidden' : 'hidden'}
          style={{
            width: '100%',
            height: '100%',
          }}
        >
          <ChatSidebar
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={handleNewChat}
            onDelete={handleDeleteSession}
            refreshKey={refreshKey}
            connectionSeq={connectionSeq}
            onSessionsLoaded={handleSessionsLoaded}
            events={events}
          />
        </div>

        {/* Chat area */}
        <div
          style={{
            flex: 1,
            flexDirection: 'column',
            height: '100%',
            background: 'var(--bg)',
            minWidth: 0,
            overflow: 'hidden',
          }}
          className={mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'}
        >
          {/* Header */}
          <div style={{
            height: 52,
            display: 'flex',
            alignItems: 'center',
            padding: '0 var(--space-4)',
            borderBottom: '1px solid var(--separator)',
            background: 'var(--material-thick)',
            flexShrink: 0,
          }}>
            {/* Mobile back button — use Tailwind flex + lg:hidden (no inline display to avoid specificity conflict) */}
            <button
              className="flex lg:hidden"
              onClick={() => setMobileView('sidebar')}
              aria-label="Back to sessions"
              style={{
                padding: 'var(--space-1) var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                marginRight: 'var(--space-2)',
                fontSize: 'var(--text-subheadline)',
                alignItems: 'center',
                gap: 'var(--space-1)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--accent)',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Back
            </button>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 'var(--text-subheadline)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                letterSpacing: '-0.2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {selectedId
                  ? (sessionMeta?.title || sessionMeta?.employee || portalName)
                  : 'New Chat'}
              </div>
            </div>

            {/* Copied toast */}
            {copiedField && (
              <div style={{
                fontSize: 'var(--text-caption1)',
                color: 'var(--accent)',
                marginRight: 'var(--space-2)',
                whiteSpace: 'nowrap',
              }}>
                Copied!
              </div>
            )}

            {/* More menu */}
            {selectedId && (
              <div ref={moreMenuRef} style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowMoreMenu((v) => !v)}
                  aria-label="More options"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 'var(--space-1)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    transition: 'color 150ms ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="12" cy="19" r="2" />
                  </svg>
                </button>

                {showMoreMenu && (
                  <div style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 4,
                    background: 'var(--material-thick)',
                    border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    zIndex: 100,
                    minWidth: 200,
                    overflow: 'hidden',
                  }}>
                    <button
                      onClick={() => copyToClipboard(selectedId, 'id')}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: 'var(--space-2) var(--space-3)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 'var(--text-subheadline)',
                        color: 'var(--text-primary)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill-tertiary)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      Copy Session ID
                    </button>
                    {sessionMeta?.engineSessionId && (
                      <button
                        onClick={() => {
                          const cli = sessionMeta.engine === 'codex' ? 'codex' : 'claude'
                          copyToClipboard(`${cli} --resume ${sessionMeta.engineSessionId}`, 'cli')
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: 'var(--space-2) var(--space-3)',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: 'var(--text-subheadline)',
                          color: 'var(--text-primary)',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill-tertiary)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        Copy CLI Resume Command
                      </button>
                    )}
                    <div style={{ borderTop: '1px solid var(--separator)', margin: '2px 0' }} />
                    <button
                      onClick={() => { setShowMoreMenu(false); setConfirmDelete(true) }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        width: '100%',
                        padding: 'var(--space-2) var(--space-3)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 'var(--text-subheadline)',
                        color: 'var(--system-red)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill-tertiary)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      Delete Session
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Messages */}
          <ChatMessages messages={messages} loading={loading} streamingText={streamingText} />

          {/* Queue panel — shows pending messages with cancel buttons */}
          <QueuePanel
            sessionId={selectedId}
            events={events}
            paused={currentSession?.paused as boolean ?? false}
          />

          {/* Input */}
          <ChatInput
            disabled={false}
            loading={loading}
            onSend={handleSend}
            onInterrupt={handleInterrupt}
            onNewSession={handleNewChat}
            onStatusRequest={handleStatusRequest}
            skillsVersion={skillsVersion}
            events={events}
          />
        </div>
      </div>

      {/* Confirm delete dialog from header menu */}
      {confirmDelete && selectedId && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirmDelete(false)}
        >
          <div
            style={{
              background: 'var(--bg)', borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-6)', maxWidth: 400, width: '90%',
              boxShadow: 'var(--shadow-overlay)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 'var(--text-headline)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', marginBottom: 'var(--space-2)' }}>
              Delete Session?
            </h3>
            <p style={{ fontSize: 'var(--text-body)', color: 'var(--text-secondary)', marginBottom: 'var(--space-5)' }}>
              This will permanently delete the session and all its messages.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)',
                  background: 'var(--fill-tertiary)', color: 'var(--text-primary)',
                  border: 'none', cursor: 'pointer', fontSize: 'var(--text-body)',
                }}
              >Cancel</button>
              <button
                onClick={() => handleDeleteSession(selectedId)}
                style={{
                  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)',
                  background: 'var(--system-red)', color: '#fff',
                  border: 'none', cursor: 'pointer', fontSize: 'var(--text-body)',
                  fontWeight: 'var(--weight-semibold)',
                }}
              >Delete</button>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  )
}
