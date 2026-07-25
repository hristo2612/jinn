import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFocusedSession } from '../chat-route-helpers'
import { formatStallAge, getStatusDot, getTurnStall, hasBackgroundActivity, isArchivedSession, isDirectSession, isRecentError, isVisibleSource, pickDeleteFallbackId, pickNeighborSessionId, resolveRowIdentity, shouldFloatPinned, WorkflowSessionChip } from '../chat-sidebar'

afterEach(() => {
  vi.useRealTimers()
})

describe('chat sidebar grouping helpers', () => {
  it('treats only employee-less, non-cron sessions as direct', () => {
    expect(isDirectSession({ source: 'web', sourceRef: 'web:1' })).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:2', employee: 'jinn' })).toBe(false)
    expect(isDirectSession({ source: 'cron', sourceRef: 'cron:daily' })).toBe(false)
    expect(isDirectSession({ source: 'web', sourceRef: 'cron:daily' })).toBe(false)
  })

  it('treats a session tagged with the portal slug as direct (case-insensitive)', () => {
    // ~30 child sessions were created with employee === portal slug; there is no
    // org employee by that name, so they must bucket into the direct/COO group
    // rather than spawn a phantom duplicate group.
    expect(isDirectSession({ source: 'web', sourceRef: 'web:3', employee: 'jimbo' }, 'jimbo')).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:4', employee: 'Jimbo' }, 'jimbo')).toBe(true)
    // a real org employee is never folded into direct
    expect(isDirectSession({ source: 'web', sourceRef: 'web:5', employee: 'jinn' }, 'jimbo')).toBe(false)
    // a portal-slug row is still a separate group when no slug is supplied
    expect(isDirectSession({ source: 'web', sourceRef: 'web:6', employee: 'jimbo' })).toBe(false)
  })
})

describe('workflow sessions in the chat sidebar', () => {
  it('keeps workflow sessions visible under their employee group and out of direct/focused lanes', () => {
    const session = {
      source: 'workflow',
      sourceRef: 'workflow:daily-report:run-42:writer:1',
      employee: 'writer',
    }

    expect(isVisibleSource(session)).toBe(true)
    expect(isDirectSession(session, 'jimbo')).toBe(false)
    expect(isFocusedSession(session)).toBe(false)
  })

  it('links a workflow chip to the owning run parsed from sourceRef', () => {
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(WorkflowSessionChip, { session: {
          source: 'workflow',
          sourceRef: 'workflow:daily-report:run-42:writer:1',
        } }),
      ),
    )

    expect(screen.getByRole('link', { name: 'Workflow' }).getAttribute('href'))
      .toBe('/workflow/daily-report/runs/run-42')
  })

  it('degrades a malformed workflow sourceRef to a non-link chip', () => {
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(WorkflowSessionChip, {
          session: { source: 'workflow', sourceRef: 'workflow:incomplete' },
        }),
      ),
    )

    expect(screen.getByText('Workflow')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('chat sidebar archive state', () => {
  it('recognizes a search result retained in the archive', () => {
    expect(isArchivedSession({ archivedAt: '2026-07-14T10:00:00.000Z' })).toBe(true)
  })

  it('treats null and absent archive timestamps as normal chats', () => {
    expect(isArchivedSession({ archivedAt: null })).toBe(false)
    expect(isArchivedSession({})).toBe(false)
  })
})

describe('chat sidebar background activity', () => {
  it('ignores stale cached background activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:10:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(false)
  })

  it('keeps fresh idle background activity visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:01:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(true)
  })

  it('keeps an idle parent visible while a descendant employee is active', () => {
    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: null,
        delegatedActivity: { activeSessions: 2, employees: ['researcher', 'writer'] },
      }),
    ).toBe(true)
  })

  it('lets foreground running state take precedence over delegated activity', () => {
    expect(
      hasBackgroundActivity({
        status: 'running',
        backgroundActivity: null,
        delegatedActivity: { activeSessions: 1, employees: ['researcher'] },
      }),
    ).toBe(false)
  })
})

describe('chat sidebar recent-error dot gating', () => {
  // Fixed "now"; the helper takes nowMs so we never read Date.now() at module load.
  const now = new Date('2026-06-15T12:00:00Z').getTime()
  const HOUR = 60 * 60 * 1000

  it('flags an error whose last activity is within the 24h window (→ red)', () => {
    const oneHourAgo = new Date(now - HOUR).toISOString()
    expect(isRecentError('error', oneHourAgo, now)).toBe(true)
  })

  it('does NOT flag an error whose last activity is older than 24h (→ not red)', () => {
    const twoDaysAgo = new Date(now - 48 * HOUR).toISOString()
    expect(isRecentError('error', twoDaysAgo, now)).toBe(false)
  })

  it('never flags a non-error status, even when recent', () => {
    const oneHourAgo = new Date(now - HOUR).toISOString()
    expect(isRecentError('idle', oneHourAgo, now)).toBe(false)
    expect(isRecentError('running', oneHourAgo, now)).toBe(false)
    expect(isRecentError(undefined, oneHourAgo, now)).toBe(false)
  })

  it('treats a missing or unparseable timestamp as not-recent (→ not red)', () => {
    expect(isRecentError('error', '', now)).toBe(false)
    expect(isRecentError('error', 'not-a-date', now)).toBe(false)
  })

  it('treats the 24h boundary as stale (strictly inside the window is red)', () => {
    const exactly24h = new Date(now - 24 * HOUR).toISOString()
    expect(isRecentError('error', exactly24h, now)).toBe(false)
    const justInside = new Date(now - 24 * HOUR + 1000).toISOString()
    expect(isRecentError('error', justInside, now)).toBe(true)
  })
})

describe('chat sidebar search row identity', () => {
  const opts = {
    portalSlug: 'jimbo',
    portalName: 'Jimbo',
    employeeData: new Map([
      [
        'jinn',
        {
          name: 'jinn',
          displayName: 'Jinn Dev',
          department: 'platform',
          rank: 'employee' as const,
          engine: 'claude',
          model: 'opus',
          persona: '',
        },
      ],
    ]),
  }

  // The API types employee as `string | null`, but the local Session interface
  // narrows it to `string | undefined`; the server can still send null at
  // runtime. Cast to reproduce that real-world shape in the test.
  const cron = { source: 'cron', sourceRef: 'cron:nightly', employee: null } as unknown as Parameters<
    typeof resolveRowIdentity
  >[0]

  // Regression: search flattens cron rows (which the grouped view renders in a
  // separate cron section). isDirectSession returns false for cron sessions, so
  // the old `s.employee!` assertion fed `null` to titleCase → `null.split('-')`
  // → "Cannot read properties of null (reading 'split')". Must not throw.
  it('does not crash on a cron session with a null employee', () => {
    expect(() => resolveRowIdentity(cron, opts)).not.toThrow()
    expect(resolveRowIdentity(cron, opts)).toEqual({ avatarName: 'jimbo', displayName: 'Jimbo' })
  })

  it('does not crash on a session with an undefined employee', () => {
    expect(() => resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).not.toThrow()
    expect(resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).toEqual({
      avatarName: 'jimbo',
      displayName: 'Jimbo',
    })
  })

  it('resolves a real employee to its org display name', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:2', employee: 'jinn' }, opts),
    ).toEqual({ avatarName: 'jinn', displayName: 'Jinn Dev' })
  })

  it('title-cases an employee with no org profile rather than crashing', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:3', employee: 'magic-switch-lead' }, opts),
    ).toEqual({ avatarName: 'magic-switch-lead', displayName: 'Magic Switch Lead' })
  })
})

describe('chat sidebar pinned floating', () => {
  it('floats pinned non-cron sessions to the Pinned section', () => {
    const pinned = new Set(['s1'])
    expect(shouldFloatPinned({ id: 's1', source: 'web', sourceRef: 'web:1' }, pinned)).toBe(true)
  })

  it('leaves unpinned sessions in their recency buckets', () => {
    const pinned = new Set(['s1'])
    expect(shouldFloatPinned({ id: 's2', source: 'web', sourceRef: 'web:2' }, pinned)).toBe(false)
    expect(shouldFloatPinned({ id: 's3', source: 'web', sourceRef: 'web:3' }, new Set())).toBe(false)
  })

  it('never floats cron sessions — Scheduled paginates by loaded-count offsets', () => {
    const pinned = new Set(['c1', 'c2'])
    expect(shouldFloatPinned({ id: 'c1', source: 'cron', sourceRef: 'cron:daily' }, pinned)).toBe(false)
    expect(shouldFloatPinned({ id: 'c2', source: 'web', sourceRef: 'cron:daily' }, pinned)).toBe(false)
  })
})

describe('pickNeighborSessionId (post-delete fallback)', () => {
  it('prefers the next visible session, then the previous', () => {
    expect(pickNeighborSessionId(['a', 'b', 'c'], 'b')).toBe('c')
    expect(pickNeighborSessionId(['a', 'b', 'c'], 'c')).toBe('b')
    expect(pickNeighborSessionId(['a', 'b', 'c'], 'a')).toBe('b')
  })

  it('returns null when the list is a singleton or the id is not visible', () => {
    expect(pickNeighborSessionId(['only'], 'only')).toBeNull()
    expect(pickNeighborSessionId(['a', 'b'], 'zzz')).toBeNull()
    expect(pickNeighborSessionId([], 'a')).toBeNull()
  })
})

describe('pickDeleteFallbackId (the ONE post-delete fallback decision)', () => {
  it('prefers the visible-order neighbour', () => {
    expect(pickDeleteFallbackId(['a', 'b', 'c'], ['z', 'a', 'b', 'c'], 'b')).toBe('c')
    expect(pickDeleteFallbackId(['a', 'b', 'c'], ['z'], 'c')).toBe('b')
  })

  it('falls back to the most recent OTHER session when the deleted id is not in the visible order (collapsed Older group)', () => {
    expect(pickDeleteFallbackId(['a', 'b'], ['hidden-1', 'hidden-2'], 'hidden-1')).toBe('hidden-2')
    expect(pickDeleteFallbackId(['a', 'b'], ['hidden-1', 'a', 'b'], 'hidden-1')).toBe('a')
    // deleted first in recency: skip itself
    expect(pickDeleteFallbackId([], ['x', 'y'], 'x')).toBe('y')
  })

  it('returns null only when no other session exists (composer)', () => {
    expect(pickDeleteFallbackId(['only'], ['only'], 'only')).toBeNull()
    expect(pickDeleteFallbackId([], [], 'gone')).toBeNull()
    expect(pickDeleteFallbackId([], ['gone'], 'gone')).toBeNull()
  })
})

describe('formatStallAge', () => {
  it('reads coarsely — the operator needs "too long", not a stopwatch', () => {
    expect(formatStallAge(30_000)).toBe('under a minute')
    expect(formatStallAge(60_000)).toBe('1m')
    expect(formatStallAge(51 * 60_000)).toBe('51m')
    expect(formatStallAge(60 * 60_000)).toBe('1h')
    expect(formatStallAge(64 * 60_000)).toBe('1h 4m')
  })
})

describe('getTurnStall', () => {
  it('reads the gateway-derived stall state', () => {
    expect(getTurnStall({ id: 's', turnStall: { stalledForMs: 90_000, awaitingSubmit: false } })).toEqual({
      stalledForMs: 90_000,
      awaitingSubmit: false,
    })
    expect(getTurnStall({ id: 's', turnStall: { stalledForMs: 5_000, awaitingSubmit: true } })).toEqual({
      stalledForMs: 5_000,
      awaitingSubmit: true,
    })
  })

  it('tolerates gateways that predate the field, and rejects junk', () => {
    expect(getTurnStall({ id: 's' })).toBeNull()
    expect(getTurnStall({ id: 's', turnStall: null })).toBeNull()
    expect(getTurnStall({ id: 's', turnStall: { stalledForMs: 0, awaitingSubmit: false } })).toBeNull()
    expect(getTurnStall({ id: 's', turnStall: { stalledForMs: -1, awaitingSubmit: false } })).toBeNull()
    expect(getTurnStall({ id: 's', turnStall: { stalledForMs: NaN, awaitingSubmit: false } })).toBeNull()
    expect(getTurnStall({ id: 's', turnStall: { awaitingSubmit: true } as never })).toBeNull()
  })
})

describe('getStatusDot: a stalled turn must not look like a working one', () => {
  const read = new Set(['s1'])

  it('paints a working turn blue and pulsing', () => {
    expect(getStatusDot({ id: 's1', status: 'running' }, read)).toEqual({
      color: 'var(--system-blue)',
      label: 'running',
      pulse: true,
    })
  })

  it('paints a stalled turn amber and STILL, with the elapsed time in the label', () => {
    const dot = getStatusDot(
      { id: 's1', status: 'running', turnStall: { stalledForMs: 51 * 60_000, awaitingSubmit: false } },
      read,
    )
    expect(dot).toEqual({ color: 'var(--system-orange)', label: 'no output for 51m', pulse: false })
  })

  it('names the unaccepted-prompt case specifically — it has a different fix', () => {
    const dot = getStatusDot(
      { id: 's1', status: 'running', turnStall: { stalledForMs: 120_000, awaitingSubmit: true } },
      read,
    )
    expect(dot?.color).toBe('var(--system-orange)')
    expect(dot?.label).toMatch(/prompt not accepted by the engine/)
    expect(dot?.pulse).toBe(false)
  })

  it('ignores stall state on a session that is not running', () => {
    const dot = getStatusDot(
      { id: 's1', status: 'idle', turnStall: { stalledForMs: 999_000, awaitingSubmit: true } },
      read,
    )
    expect(dot).toBeNull()
  })
})
