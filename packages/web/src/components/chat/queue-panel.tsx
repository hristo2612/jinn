"use client"

import { useEffect, useState, useCallback } from 'react'
import { X, Pause, Play, Trash2 } from 'lucide-react'
import { api, type QueueItem } from '@/lib/api'

interface QueuePanelProps {
  sessionId: string | null
  events: Array<{ event: string; payload: unknown }>
  paused?: boolean
}

export function QueuePanel({ sessionId, events, paused: initialPaused = false }: QueuePanelProps) {
  const [items, setItems] = useState<QueueItem[]>([])
  const [paused, setPaused] = useState(initialPaused)

  const refresh = useCallback(async () => {
    if (!sessionId) return
    try {
      const data = await api.getSessionQueue(sessionId)
      setItems(data)
    } catch {
      // non-fatal
    }
  }, [sessionId])

  useEffect(() => { refresh() }, [refresh])

  // Refresh on queue:updated WS event
  useEffect(() => {
    if (!events.length) return
    const latest = events[events.length - 1]
    if (latest.event === 'queue:updated') {
      refresh()
      const payload = latest.payload as Record<string, unknown>
      if (typeof payload?.paused === 'boolean') {
        setPaused(payload.paused as boolean)
      }
    }
  }, [events, refresh])

  const pendingItems = items.filter(i => i.status === 'pending')

  if (!sessionId || pendingItems.length === 0) return null

  async function handleCancel(itemId: string) {
    if (!sessionId) return
    try {
      await api.cancelQueueItem(sessionId, itemId)
      await refresh()
    } catch { /* non-fatal */ }
  }

  async function handleClear() {
    if (!sessionId) return
    try {
      await api.clearSessionQueue(sessionId)
      setItems([])
    } catch { /* non-fatal */ }
  }

  async function handlePauseResume() {
    if (!sessionId) return
    try {
      if (paused) {
        await api.resumeSessionQueue(sessionId)
        setPaused(false)
      } else {
        await api.pauseSessionQueue(sessionId)
        setPaused(true)
      }
    } catch { /* non-fatal */ }
  }

  return (
    <div style={{
      borderTop: '1px solid var(--separator)',
      padding: 'var(--space-2) var(--space-4)',
      background: 'var(--fill-quaternary)',
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 'var(--space-1)',
      }}>
        <span style={{
          fontSize: 'var(--text-caption2)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}>
          {pendingItems.length} queued {paused && '· Paused'}
        </span>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          <button
            onClick={handlePauseResume}
            title={paused ? 'Resume queue' : 'Pause queue'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', padding: '2px',
              display: 'flex', alignItems: 'center',
            }}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
          <button
            onClick={handleClear}
            title="Clear all queued messages"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-secondary)', padding: '2px',
              display: 'flex', alignItems: 'center',
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {pendingItems.map((item) => (
          <div key={item.id} style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            padding: '3px var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--fill-tertiary)',
          }}>
            <span style={{
              fontSize: 'var(--text-caption2)',
              color: 'var(--text-tertiary)',
              minWidth: 16,
            }}>
              {item.position}.
            </span>
            <span style={{
              flex: 1,
              fontSize: 'var(--text-caption1)',
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {item.prompt.length > 60 ? item.prompt.slice(0, 57) + '...' : item.prompt}
            </span>
            <button
              onClick={() => handleCancel(item.id)}
              title="Cancel this message"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-tertiary)', padding: '1px',
                display: 'flex', alignItems: 'center', flexShrink: 0,
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
