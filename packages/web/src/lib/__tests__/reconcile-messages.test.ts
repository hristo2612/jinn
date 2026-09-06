import { describe, it, expect } from 'vitest'
import { reconcileMessages, RECONCILE_PRESERVE_MAX_AGE_MS } from '@/lib/conversations'
import type { Message } from '@/lib/conversations'

// Fixtures carry small epoch timestamps, so tests pass an explicit `now` close
// to them — otherwise the age cap (vs the real Date.now()) would drop them all.
const NOW = 2000

const userMsg: Message = { id: 'u1', role: 'user', content: 'make a chart', timestamp: 1000 }
const attachment: Message = {
  id: 'a1',
  role: 'assistant',
  content: 'chart',
  timestamp: 1500,
  media: [{ type: 'image', url: '/api/files/x', name: 'chart.png' }],
}
const resultMsg: Message = { id: 'r1', role: 'assistant', content: 'done', timestamp: 2000 }

describe('reconcileMessages — attachment disappear regression', () => {
  it('keeps a live-pushed attachment when the refreshed snapshot lacks it', () => {
    // Local state after the WS session:attachment append.
    const current = [userMsg, attachment]
    // History refetch races ahead of the DB commit → snapshot has no attachment yet.
    const staleSnapshot = [userMsg]

    const merged = reconcileMessages(current, staleSnapshot, NOW)

    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(merged.find((m) => m.id === 'a1')?.media?.[0].url).toBe('/api/files/x')
  })

  it('does NOT duplicate the attachment once the snapshot catches up', () => {
    const current = [userMsg, attachment]
    // Snapshot now includes the persisted attachment (same id) plus the final result.
    const freshSnapshot = [userMsg, attachment, resultMsg]

    const merged = reconcileMessages(current, freshSnapshot, NOW)

    const attachmentCount = merged.filter((m) => m.id === 'a1').length
    expect(attachmentCount).toBe(1)
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'r1'])
  })

  it('re-sorts preserved attachments by timestamp', () => {
    const current = [attachment] // pushed at t=1500
    const snapshot = [userMsg, resultMsg] // t=1000, t=2000, no attachment
    const merged = reconcileMessages(current, snapshot, NOW)
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'r1']) // attachment slots between by ts
  })

  it('returns the snapshot untouched when there are no media messages to preserve', () => {
    const current = [userMsg]
    const snapshot = [userMsg, resultMsg]
    expect(reconcileMessages(current, snapshot)).toBe(snapshot)
  })

  it('does not resurrect transient non-media messages missing from the snapshot', () => {
    const streamingBubble: Message = { id: 's1', role: 'assistant', content: 'thinking…', timestamp: 1200 }
    const current = [userMsg, streamingBubble]
    const snapshot = [userMsg, resultMsg]
    const merged = reconcileMessages(current, snapshot)
    expect(merged.find((m) => m.id === 's1')).toBeUndefined()
  })
})

describe('reconcileMessages — inbound user-message duplicate regression (v0.16.0)', () => {
  // Optimistic user message with image + video, appended with a CLIENT random id
  // and base64 preview urls, with IDs returned by the completed uploads.
  const optimisticUserMsg: Message = {
    id: 'client-random-uuid',
    role: 'user',
    content: 'what you see here?',
    timestamp: 5000,
    media: [
      { type: 'image', url: 'data:image/jpeg;base64,AAAA', fileId: 'img-id', name: 'chest-front.jpg' },
      { type: 'file', url: 'data:video/mp4;base64,BBBB', fileId: 'vid-id', name: 'clip.mp4' },
    ],
  }
  // Server-persisted twin: DIFFERENT (canonical) id, /api/files urls, same names.
  const serverUserMsg: Message = {
    id: 'server-canonical-id',
    role: 'user',
    content: 'what you see here?',
    timestamp: 5001,
    media: [
      { type: 'image', url: '/api/files/img-id', name: 'chest-front.jpg' },
      { type: 'file', url: '/api/files/vid-id', name: 'clip.mp4' },
    ],
  }

  it('shows the user message with 2 media (incl. video) EXACTLY once, not twice', () => {
    const merged = reconcileMessages([optimisticUserMsg], [serverUserMsg], 5001)
    const userMsgs = merged.filter((m) => m.role === 'user' && m.content === 'what you see here?')
    expect(userMsgs).toHaveLength(1)
    // The surviving copy takes the server's canonical /api/files media urls, but
    // KEEPS the optimistic id so the React key is stable (no first-send remount
    // flicker). The base64 data: urls are gone; the id is the local one.
    expect(userMsgs[0].id).toBe('client-random-uuid')
    expect(userMsgs[0].media).toHaveLength(2)
    expect(userMsgs[0].media?.every((x) => x.url.startsWith('/api/files/'))).toBe(true)
  })

  it('reconciles an attached user message with a Unicode filename to exactly one row', () => {
    const filename = 'тест документ.pdf'
    const optimistic: Message = {
      id: 'client-unicode-id',
      role: 'user',
      content: 'check the document',
      timestamp: 6000,
      media: [{ type: 'file', url: 'blob:local-preview', fileId: 'file-id', name: filename }],
    }
    const persisted: Message = {
      id: 'server-unicode-id',
      role: 'user',
      content: 'check the document',
      timestamp: 6001,
      media: [{ type: 'file', url: '/api/files/file-id', name: filename }],
    }

    const merged = reconcileMessages([optimistic], [persisted], 6001)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'client-unicode-id',
      media: [{ name: filename, url: '/api/files/file-id' }],
    })
  })

  it('still preserves an outbound agent attachment that the snapshot lacks (no regression)', () => {
    const merged = reconcileMessages([attachment], [userMsg], NOW)
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('does not collapse two genuinely different files with empty captions', () => {
    const a: Message = { id: 's-a', role: 'assistant', content: '', timestamp: 10, media: [{ type: 'file', url: '/api/files/a', name: 'a.zip' }] }
    const b: Message = { id: 'local-b', role: 'assistant', content: '', timestamp: 11, media: [{ type: 'file', url: '/api/files/b', name: 'b.zip' }] }
    // snapshot has only A; B is a distinct local attachment not yet in snapshot → preserved
    const merged = reconcileMessages([a, b], [a], 100)
    expect(merged.map((m) => m.id)).toEqual(['s-a', 'local-b'])
  })
})

describe('reconcileMessages — repeated identical content (id-collision regression)', () => {
  it('maps each server twin to a DISTINCT optimistic id, never collapsing two identical messages onto one id', () => {
    const u1: Message = { id: 'client-a', role: 'user', content: 'yes', timestamp: 100 }
    const reply: Message = { id: 'srv-r', role: 'assistant', content: 'ok', timestamp: 150 }
    const u2: Message = { id: 'client-b', role: 'user', content: 'yes', timestamp: 200 }
    const current = [u1, reply, u2]
    // The server persisted BOTH "yes" messages under canonical ids.
    const snapshot: Message[] = [
      { id: 'srv-1', role: 'user', content: 'yes', timestamp: 101 },
      reply,
      { id: 'srv-2', role: 'user', content: 'yes', timestamp: 201 },
    ]
    const merged = reconcileMessages(current, snapshot, 300)

    // Each "yes" keeps its own optimistic id (stable, distinct keys) — not both
    // collapsed onto client-a, which would duplicate React keys and turn anchors.
    expect(merged.filter((m) => m.content === 'yes').map((m) => m.id)).toEqual(['client-a', 'client-b'])
    // No duplicate ids anywhere in the merged transcript.
    expect(new Set(merged.map((m) => m.id)).size).toBe(merged.length)
  })
})

describe('reconcileMessages — age cap on preserved messages', () => {
  const now = 10_000_000
  const mediaMsg = (id: string, timestamp: number): Message => ({
    id,
    role: 'assistant',
    content: `attachment ${id}`,
    timestamp,
    media: [{ type: 'image', url: `/api/files/${id}`, name: `${id}.png` }],
  })

  it('preserves a seconds-old in-flight attachment (the feature\'s purpose)', () => {
    const fresh = mediaMsg('fresh', now - 3000)
    const merged = reconcileMessages([userMsg, fresh], [userMsg], now)
    expect(merged.map((m) => m.id)).toContain('fresh')
  })

  it('preserves an attachment exactly at the age limit', () => {
    const edge = mediaMsg('edge', now - RECONCILE_PRESERVE_MAX_AGE_MS)
    const merged = reconcileMessages([userMsg, edge], [userMsg], now)
    expect(merged.map((m) => m.id)).toContain('edge')
  })

  it('drops a media message older than the limit (never persisted server-side)', () => {
    const stale = mediaMsg('stale', now - RECONCILE_PRESERVE_MAX_AGE_MS - 1)
    const merged = reconcileMessages([userMsg, stale], [userMsg], now)
    expect(merged.find((m) => m.id === 'stale')).toBeUndefined()
  })

  it('returns the snapshot untouched when all pending media messages are stale', () => {
    const stale = mediaMsg('stale', now - RECONCILE_PRESERVE_MAX_AGE_MS - 60_000)
    const snapshot = [userMsg]
    expect(reconcileMessages([userMsg, stale], snapshot, now)).toBe(snapshot)
  })

  it('keeps fresh attachments while dropping stale ones in the same pass', () => {
    const fresh = mediaMsg('fresh', now - 1000)
    const stale = mediaMsg('stale', now - RECONCILE_PRESERVE_MAX_AGE_MS - 1)
    const merged = reconcileMessages([userMsg, stale, fresh], [userMsg], now)
    expect(merged.map((m) => m.id)).toEqual(['u1', 'fresh'])
  })

  it('defaults `now` to Date.now() so real call sites get the cap for free', () => {
    const fresh = mediaMsg('fresh', Date.now())
    const stale = mediaMsg('stale', Date.now() - RECONCILE_PRESERVE_MAX_AGE_MS - 60_000)
    const merged = reconcileMessages([userMsg, fresh, stale], [userMsg])
    expect(merged.map((m) => m.id)).toContain('fresh')
    expect(merged.find((m) => m.id === 'stale')).toBeUndefined()
  })
})

describe('reconcileMessages — failed sends', () => {
  const now = 2000
  const failed: Message = { id: 'f1', role: 'user', content: 'lost', timestamp: 1500, sendState: 'failed' }

  it('keeps a failed send: no snapshot will ever carry it, and it owns the retry', () => {
    const merged = reconcileMessages([userMsg, failed], [userMsg], now)
    expect(merged.map((m) => m.id)).toEqual(['u1', 'f1'])
    expect(merged.find((m) => m.id === 'f1')?.sendState).toBe('failed')
  })

  it('still drops one past the age cap, so it cannot be re-appended forever', () => {
    const stale = { ...failed, timestamp: now - RECONCILE_PRESERVE_MAX_AGE_MS - 1 }
    expect(reconcileMessages([userMsg, stale], [userMsg], now).find((m) => m.id === 'f1')).toBeUndefined()
  })

  it('does not resurrect a failed row once the retry has superseded it', () => {
    // beginSendMessages drops the failed row before re-sending, so it is not in
    // `current` any more and the retry's server twin carries the same text.
    const merged = reconcileMessages([userMsg], [userMsg, { ...failed, id: 's1', sendState: undefined }], now)
    expect(merged.filter((m) => m.content === 'lost')).toHaveLength(1)
  })
})

describe('reconcileMessages — repeated text', () => {
  const now = 2000
  const settled: Message = { id: 'y1', role: 'user', content: 'yes', timestamp: 1400 }

  it('does not let an older settled row stand in for a newer failed one', () => {
    const failed: Message = { id: 'y2', role: 'user', content: 'yes', timestamp: 1500, sendState: 'failed' }
    const merged = reconcileMessages([settled, failed], [settled], now)
    expect(merged.map((m) => m.id)).toEqual(['y1', 'y2'])
    expect(merged.find((m) => m.id === 'y2')?.sendState).toBe('failed')
  })

  it('keeps an in-flight send the snapshot has not caught up with', () => {
    const pending: Message = { id: 'y2', role: 'user', content: 'yes', timestamp: 1500, sendState: 'pending' }
    const merged = reconcileMessages([settled, pending], [settled], now)
    expect(merged.map((m) => m.id)).toEqual(['y1', 'y2'])
  })

  it('shows the in-flight send exactly once when its server twin lands', () => {
    const pending: Message = { id: 'y2', role: 'user', content: 'yes', timestamp: 1500, sendState: 'pending' }
    const twin: Message = { id: 'srv', role: 'user', content: 'yes', timestamp: 1600 }
    const merged = reconcileMessages([settled, pending], [settled, twin], now)
    expect(merged.filter((m) => m.content === 'yes')).toHaveLength(2)
    expect(merged.map((m) => m.id)).toEqual(['y1', 'y2'])
  })
})
