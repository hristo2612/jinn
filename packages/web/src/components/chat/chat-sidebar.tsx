"use client"
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Session {
  id: string
  employee?: string
  title?: string
  status?: string
  source?: string
  lastActivity?: string
  createdAt?: string
  [key: string]: unknown
}

interface ChatSidebarProps {
  selectedId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete?: (id: string) => void
  refreshKey: number
  onSessionsLoaded?: (sessions: Session[]) => void
}

function formatTime(dateStr?: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return 'now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
  if (diff < 86400000) return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getReadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem('jimmy-read-sessions')
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

function markSessionRead(id: string) {
  const read = getReadSessions()
  read.add(id)
  // Keep only the last 500 to avoid bloat
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem('jimmy-read-sessions', JSON.stringify(arr))
}

export function ChatSidebar({
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
  refreshKey,
  onSessionsLoaded,
}: ChatSidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [readSessions, setReadSessions] = useState<Set<string>>(new Set())

  // Load read state from localStorage
  useEffect(() => {
    setReadSessions(getReadSessions())
  }, [])

  // Mark selected session as read
  useEffect(() => {
    if (selectedId) {
      markSessionRead(selectedId)
      setReadSessions(prev => {
        const next = new Set(prev)
        next.add(selectedId)
        return next
      })
    }
  }, [selectedId])

  useEffect(() => {
    setLoading(true)
    api
      .getSessions()
      .then((data) => {
        const filtered = (data as Session[]).filter(
          (s) => s.source === 'web' || !s.source
        )
        filtered.sort((a, b) => {
          const ta = a.lastActivity || a.createdAt || ''
          const tb = b.lastActivity || b.createdAt || ''
          return tb.localeCompare(ta)
        })
        setSessions(filtered)
        onSessionsLoaded?.(filtered)
      })
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [refreshKey])

  async function handleDelete(sessionId: string) {
    try {
      await api.deleteSession(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      if (onDelete) onDelete(sessionId)
      else if (selectedId === sessionId) onNewChat()
    } catch { /* ignore */ }
    setConfirmDelete(null)
  }

  const displayed = search.trim()
    ? sessions.filter((s) => {
        const q = search.toLowerCase()
        return (
          s.id.toLowerCase().includes(q) ||
          (s.employee && s.employee.toLowerCase().includes(q)) ||
          (s.title && s.title.toLowerCase().includes(q))
        )
      })
    : sessions

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--sidebar-bg)',
      borderRight: '1px solid var(--separator)',
    }}>
      {/* Header */}
      <div style={{
        padding: 'var(--space-4) var(--space-4) var(--space-3)',
        borderBottom: '1px solid var(--separator)',
        background: 'var(--material-thick)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-3)',
        }}>
          <h2 style={{
            fontSize: 'var(--text-title3)',
            fontWeight: 'var(--weight-bold)',
            letterSpacing: '-0.5px',
            color: 'var(--text-primary)',
            margin: 0,
          }}>
            Chats
          </h2>
          <button
            onClick={onNewChat}
            aria-label="New chat"
            style={{
              padding: 'var(--space-1) var(--space-3)',
              fontSize: 'var(--text-footnote)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--accent-contrast)',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New
          </button>
        </div>

        {/* Search */}
        <div style={{
          background: 'var(--fill-tertiary)',
          borderRadius: 'var(--radius-md)',
          padding: '7px var(--space-3)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
        }}>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0 }}
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions..."
            aria-label="Search sessions"
            style={{
              flex: 1,
              fontSize: 'var(--text-footnote)',
              color: 'var(--text-primary)',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              padding: 0,
              margin: 0,
              lineHeight: 1.4,
            }}
          />
          {search.trim() && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              style={{
                padding: 2,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-tertiary)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Session list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-1) 0' }}>
        {loading ? (
          <div style={{ padding: 'var(--space-8) var(--space-4)', textAlign: 'center' }}>
            <span style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-quaternary)' }}>
              Loading sessions...
            </span>
          </div>
        ) : displayed.length === 0 ? (
          <div style={{ padding: 'var(--space-8) var(--space-4)', textAlign: 'center' }}>
            <span style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-quaternary)' }}>
              {search.trim() ? 'No matching sessions' : 'No conversations yet'}
            </span>
          </div>
        ) : (
          displayed.map((session) => {
            const isActive = session.id === selectedId
            const isHovered = session.id === hoveredId
            const isRunning = session.status === 'running'
            const isRead = readSessions.has(session.id)
            const isError = session.status === 'error'
            const timeLabel = formatTime(session.lastActivity || session.createdAt)

            let dotColor: string
            if (isRunning) dotColor = 'var(--system-blue)'
            else if (isError) dotColor = 'var(--system-red)'
            else if (isRead) dotColor = 'var(--text-quaternary)'
            else dotColor = 'var(--system-green)'

            return (
              <button
                key={session.id}
                onClick={() => onSelect(session.id)}
                onMouseEnter={() => setHoveredId(session.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) var(--space-4)',
                  background: isActive ? 'var(--fill-secondary)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                  position: 'relative',
                }}
              >
                {/* Status indicator */}
                <div style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: dotColor,
                  flexShrink: 0,
                  animation: isRunning ? 'sidebar-pulse 2s ease-in-out infinite' : 'none',
                  boxShadow: isRunning ? `0 0 6px ${dotColor}` : 'none',
                }} />

                {/* Text content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    marginBottom: 2,
                  }}>
                    <span style={{
                      fontSize: 'var(--text-footnote)',
                      fontWeight: isRead && !isActive ? 'var(--weight-medium)' : 'var(--weight-semibold)',
                      color: 'var(--text-primary)',
                      letterSpacing: '-0.2px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                      minWidth: 0,
                    }}>
                      {session.title || session.employee || 'Jimmy'}
                    </span>
                    <span style={{
                      fontSize: 'var(--text-caption2)',
                      color: 'var(--text-tertiary)',
                      flexShrink: 0,
                      marginLeft: 'var(--space-1)',
                    }}>
                      {timeLabel}
                    </span>
                  </div>
                  <div style={{
                    fontSize: 'var(--text-caption1)',
                    color: 'var(--text-tertiary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {session.employee || 'Jimmy'}
                  </div>
                </div>

                {/* Delete button on hover */}
                {isHovered && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(session.id) }}
                    aria-label="Delete session"
                    style={{
                      padding: 4,
                      borderRadius: 'var(--radius-sm)',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--text-tertiary)',
                      display: 'flex',
                      alignItems: 'center',
                      flexShrink: 0,
                      transition: 'color 150ms ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--system-red)')}
                    onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                )}
              </button>
            )
          })
        )}
      </div>

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setConfirmDelete(null)}
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
                onClick={() => setConfirmDelete(null)}
                style={{
                  padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)',
                  background: 'var(--fill-tertiary)', color: 'var(--text-primary)',
                  border: 'none', cursor: 'pointer', fontSize: 'var(--text-body)',
                }}
              >Cancel</button>
              <button
                onClick={() => handleDelete(confirmDelete)}
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

      {/* Pulse animation for running sessions */}
      <style>{`
        @keyframes sidebar-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
      `}</style>
    </div>
  )
}
