import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ChatMessages, finalAnswerIndices, turnSpacerClass } from '../chat-messages'
import { BURST_WINDOW_MS, formatBurstRange } from '../callback-burst'
import { anchorScrollDuring, canAnchorFold, formatWorkDuration, foldSummaryWords } from '../fold-region'
import type { Message } from '@/lib/conversations'

vi.mock('@/lib/api', () => ({
  api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) },
}))

const T0 = 1_780_000_000_000

afterEach(() => {
  vi.useRealTimers()
})

function callback(id: string, employee: string, ts: number, preview = `Report from ${employee}.`): Message {
  return {
    id,
    role: 'notification',
    content: `📩 ${employee} replied\n${preview}`,
    timestamp: ts,
    meta: {
      kind: 'child-reply',
      employee,
      employeeDisplay: employee,
      childSessionId: `child-${employee}`,
    },
  }
}

describe('T3 burst grouping', () => {
  it('groups 2+ consecutive callbacks within the window into one burst entry', () => {
    const messages = [
      callback('c1', 'dev', T0),
      callback('c2', 'analyst', T0 + 60_000),
      callback('c3', 'designer', T0 + 120_000),
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} onPeek={vi.fn()} />)

    const burst = container.querySelector('[data-comms-burst="3"]')
    expect(burst).toBeTruthy()
    expect(burst!.textContent).toContain('3 reports')
    // The individual ledger lines stay individually openable inside the rail.
    expect(screen.getAllByRole('button', { name: /Open report/ })).toHaveLength(3)
  })

  it('does not group callbacks separated by more than the burst window', () => {
    const messages = [
      callback('c1', 'dev', T0),
      callback('c2', 'analyst', T0 + BURST_WINDOW_MS + 60_000),
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} onPeek={vi.fn()} />)
    expect(container.querySelector('[data-comms-burst]')).toBeNull()
    expect(screen.getAllByRole('button', { name: /Open report/ })).toHaveLength(2)
  })

  it('breaks the burst run at a non-callback message', () => {
    const messages: Message[] = [
      callback('c1', 'dev', T0),
      { id: 'n1', role: 'notification', content: '📨 From scout: fresh threads.', timestamp: T0 + 10_000 },
      callback('c2', 'analyst', T0 + 20_000),
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} />)
    expect(container.querySelector('[data-comms-burst]')).toBeNull()
  })

  it('routes a burst row click through the peek payload', () => {
    const onPeek = vi.fn()
    const messages = [callback('c1', 'dev', T0), callback('c2', 'analyst', T0 + 5_000)]
    render(<ChatMessages messages={messages} loading={false} onPeek={onPeek} />)

    fireEvent.click(screen.getByRole('button', { name: /analyst replied.*Open report/ }))
    expect(onPeek).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'reply',
      employee: 'analyst',
      sessionId: 'child-analyst',
    }))
  })

  it('formats the burst time range with a shared meridiem and collapses equal times', () => {
    const at = (h: number, m: number) => new Date(2026, 6, 11, h, m).getTime()
    expect(formatBurstRange(at(15, 42), at(15, 45))).toBe('3:42-3:45 PM')
    expect(formatBurstRange(at(15, 42), at(15, 42))).toBe('3:42 PM')
    expect(formatBurstRange(at(11, 58), at(12, 2))).toBe('11:58 AM-12:02 PM')
  })
})

describe('the post-turn fold', () => {
  const foldedTurn: Message[] = [
    { id: 'u1', role: 'user', content: 'Ship it.', timestamp: T0 },
    { id: 't1', role: 'assistant', content: 'Used file_read', timestamp: T0 + 10_000, toolCall: 'file_read' },
    { id: 't2', role: 'assistant', content: 'Used file_edit', timestamp: T0 + 20_000, toolCall: 'file_edit' },
    callback('c1', 'dev', T0 + 400_000),
    { id: 'a1', role: 'assistant', content: 'Done, shipped.', timestamp: T0 + 430_000 },
  ]

  it('rests answered turns folded behind a work-summary ledger line', () => {
    const { container } = render(<ChatMessages messages={foldedTurn} loading={false} />)

    const summary = screen.getByRole('button', { name: /Worked for 7m, 2 tools, 1 teammate\. Show the work\./ })
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    // Rendered dot separators, never glyph middots.
    expect(summary.textContent).not.toContain('·')
    // The evidence is folded away from the accessibility tree; the answer stays.
    const region = container.querySelector('[data-fold-region]')
    expect(region?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('Done, shipped.')).toBeTruthy()
  })

  it('re-expands and re-collapses from the summary line, animating BOTH directions', () => {
    vi.useFakeTimers()
    const { container } = render(<ChatMessages messages={foldedTurn} loading={false} />)
    const summary = screen.getByRole('button', { name: /Show the work/ })
    const region = () => container.querySelector('[data-fold-region]')

    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(region()?.getAttribute('aria-hidden')).toBeNull()
    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByRole('button', { name: /^2 tools$/ })).toBeTruthy()

    // Collapse: the control reads closed at once, but the folded state (and
    // the inert/aria-hidden bookkeeping) commits only after the 420ms
    // choreography — committing synchronously would snap the height to 0.
    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(region()?.getAttribute('aria-hidden')).toBeNull()
    act(() => vi.advanceTimersByTime(600))
    expect(region()?.getAttribute('aria-hidden')).toBe('true')
  })

  it('recovers from a collapse interrupted by a re-expand click', () => {
    vi.useFakeTimers()
    const { container } = render(<ChatMessages messages={foldedTurn} loading={false} />)
    const summary = screen.getByRole('button', { name: /Show the work/ })

    fireEvent.click(summary) // expand
    act(() => vi.advanceTimersByTime(600))
    fireEvent.click(summary) // collapse begins…
    act(() => vi.advanceTimersByTime(50))
    fireEvent.click(summary) // …interrupted: expand again
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    act(() => vi.advanceTimersByTime(600))
    // The stale collapse timer must not fire and snap-fold the region.
    expect(container.querySelector('[data-fold-region]')?.getAttribute('aria-hidden')).toBeNull()
  })

  it('keeps unanswered live work open with no summary line', () => {
    const live = foldedTurn.slice(0, 4)
    const { container } = render(<ChatMessages messages={live} loading />)
    expect(container.querySelector('[data-fold]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Show the work/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^2 tools$/ })).toBeTruthy()
  })

  it('partitions answered work around active delegations and folds only terminal evidence', () => {
    const delegation = (id: string, status: 'running' | 'waiting' | 'done'): Message => ({
      id: `m-${id}`,
      role: 'assistant',
      content: `Delegation ${id}`,
      timestamp: T0 + (id === 'active' ? 2_000 : 3_000),
      blocks: [{
        id,
        type: 'delegation',
        version: 1,
        status,
        payload: { employee: id, employeeDisplay: id, childSessionId: `child-${id}`, title: `${id} work` },
      }],
    })
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Delegate both.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used search', timestamp: T0 + 1_000, toolCall: 'search' },
      delegation('active', 'running'),
      delegation('terminal', 'done'),
      { id: 'a1', role: 'assistant', content: 'Parent final.', timestamp: T0 + 4_000 },
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} onPeek={vi.fn()} />)

    const active = container.querySelector('[data-handoff-state="working"]')!
    expect(active.closest('[data-fold-region]')).toBeNull()
    const terminal = container.querySelector('[data-handoff-state="replied"]')!
    expect(terminal.closest('[data-fold-region]')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('Parent final.')).toBeTruthy()
  })

  it('renders active middle evidence normally without a Worked-for wrapper', () => {
    const active: Message[] = [
      { id: 'u1', role: 'user', content: 'Audit it.', timestamp: T0 },
      { id: 'p1', role: 'assistant', content: 'I found the first issue.', timestamp: T0 + 1_000 },
      { id: 't1', role: 'assistant', content: 'Used file_read', timestamp: T0 + 2_000, toolCall: 'file_read' },
      callback('c1', 'dev', T0 + 3_000),
    ]
    const { container } = render(<ChatMessages messages={active} loading onPeek={vi.fn()} />)

    expect(container.querySelector('[data-fold]')).toBeNull()
    expect(container.querySelector('[data-fold-summary]')).toBeNull()
    expect(screen.getByText('I found the first issue.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^1 tool$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /dev replied.*Open report/ })).toBeTruthy()
  })

  it('never folds a region with a still-running tool', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Go.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Using file_edit', timestamp: T0 + 1_000, toolCall: 'file_edit' },
      { id: 'a1', role: 'assistant', content: 'Interim note.', timestamp: T0 + 2_000 },
    ]
    render(<ChatMessages messages={messages} loading />)
    expect(screen.queryByRole('button', { name: /Show the work/ })).toBeNull()
    expect(screen.getByRole('button', { name: /1 tool running/i })).toBeTruthy()
  })

  it('formats work durations and omits zero-count summary segments', () => {
    expect(formatWorkDuration(0)).toBe('<1s')
    expect(formatWorkDuration(999)).toBe('<1s')
    expect(formatWorkDuration(5_000)).toBe('5s')
    expect(formatWorkDuration(90_000)).toBe('1m')
    expect(formatWorkDuration(3_720_000)).toBe('1h 2m')
    expect(foldSummaryWords({ durationMs: 90_000, tools: 0, teammates: 2, updates: 0 })).toEqual(['Worked for 1m', '2 teammates'])
    expect(foldSummaryWords({ durationMs: 1_000, tools: 1, teammates: 0, updates: 0 })).toEqual(['Worked for 1s', '1 tool'])
    expect(foldSummaryWords({ durationMs: 1_000, tools: 2, teammates: 1, updates: 2 }))
      .toEqual(['Worked for 1s', '2 tools', '1 teammate', '2 updates'])
  })

  it.each([
    {
      case: 'tool-only',
      messages: [
        { id: 'u1', role: 'user', content: 'Run it.', timestamp: T0 },
        { id: 't1', role: 'assistant', content: 'Used Bash', timestamp: T0 + 1_000, toolCall: 'Bash' },
        { id: 'a1', role: 'assistant', content: 'Done.', timestamp: T0 + 2_400 },
      ] satisfies Message[],
      copy: /Worked for 2s, 1 tool\. Show the work\./,
    },
    {
      case: 'interim-prose-only',
      messages: [
        { id: 'u1', role: 'user', content: 'Investigate.', timestamp: T0 },
        { id: 'p1', role: 'assistant', content: 'Checking the logs.', timestamp: T0 + 1_000 },
        { id: 'a1', role: 'assistant', content: 'Found it.', timestamp: T0 + 3_000 },
      ] satisfies Message[],
      copy: /Worked for 3s, 1 update\. Show the work\./,
    },
    {
      case: 'mixed evidence',
      messages: [
        { id: 'u1', role: 'user', content: 'Fix it.', timestamp: T0 },
        { id: 't1', role: 'assistant', content: 'Used Read', timestamp: T0 + 1_000, toolCall: 'Read' },
        { id: 'p1', role: 'assistant', content: 'Applying the focused fix.', timestamp: T0 + 2_000 },
        {
          id: 'd1',
          role: 'assistant',
          content: 'Delegated review',
          timestamp: T0 + 3_000,
          blocks: [{
            id: 'review',
            type: 'delegation',
            version: 1,
            status: 'done',
            payload: { employee: 'reviewer', employeeDisplay: 'Reviewer' },
          }],
        },
        { id: 'a1', role: 'assistant', content: 'Fixed.', timestamp: T0 + 5_000 },
      ] satisfies Message[],
      copy: /Worked for 5s, 1 tool, 1 teammate, 1 update\. Show the work\./,
    },
    {
      case: 'terminal error',
      messages: [
        { id: 'u1', role: 'user', content: 'Deploy it.', timestamp: T0 },
        { id: 't1', role: 'assistant', content: 'Used deploy', timestamp: T0 + 1_000, toolCall: 'deploy' },
        { id: 'a1', role: 'assistant', content: 'Error: deployment failed', timestamp: T0 + 4_000 },
      ] satisfies Message[],
      copy: /Worked for 4s, 1 tool\. Show the work\./,
    },
    {
      case: 'rapid completion',
      messages: [
        { id: 'u1', role: 'user', content: 'Check.', timestamp: T0 },
        { id: 't1', role: 'assistant', content: 'Used check', timestamp: T0 + 100, toolCall: 'check' },
        { id: 'a1', role: 'assistant', content: 'Clear.', timestamp: T0 + 400 },
      ] satisfies Message[],
      copy: /Worked for <1s, 1 tool\. Show the work\./,
    },
  ])('measures $case work from the initiating user row through the terminal response', ({ messages, copy }) => {
    render(<ChatMessages messages={messages} loading={false} />)
    expect(screen.getByRole('button', { name: copy })).toBeTruthy()
  })

  it('freezes settled duration across rerenders and remounts instead of using the render clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0 + 10_000)
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Run it.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used Bash', timestamp: T0 + 500, toolCall: 'Bash' },
      { id: 'a1', role: 'assistant', content: 'Done.', timestamp: T0 + 2_000 },
    ]
    const view = render(<ChatMessages messages={messages} loading={false} />)
    expect(screen.getByRole('button', { name: /Worked for 2s, 1 tool\. Show the work\./ })).toBeTruthy()

    vi.setSystemTime(T0 + 3_600_000)
    view.rerender(<ChatMessages messages={messages} loading={false} />)
    expect(screen.getByRole('button', { name: /Worked for 2s, 1 tool\. Show the work\./ })).toBeTruthy()

    view.unmount()
    render(<ChatMessages messages={messages.map((message) => ({ ...message }))} loading={false} />)
    expect(screen.getByRole('button', { name: /Worked for 2s, 1 tool\. Show the work\./ })).toBeTruthy()
  })

  it('recovers one missing boundary from durable evidence without using the current clock', () => {
    const missingStart: Message[] = [
      { id: 'u1', role: 'user', content: 'Run it.', timestamp: Number.NaN },
      { id: 't1', role: 'assistant', content: 'Used Bash', timestamp: T0 + 1_000, toolCall: 'Bash' },
      { id: 'a1', role: 'assistant', content: 'Done.', timestamp: T0 + 3_000 },
    ]
    const first = render(<ChatMessages messages={missingStart} loading={false} />)
    expect(screen.getByRole('button', { name: /Worked for 2s, 1 tool\. Show the work\./ })).toBeTruthy()
    first.unmount()

    const missingEnd: Message[] = [
      { id: 'u1', role: 'user', content: 'Run it.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used Bash', timestamp: T0 + 1_500, toolCall: 'Bash' },
      { id: 'a1', role: 'assistant', content: 'Done.', timestamp: Number.NaN },
    ]
    render(<ChatMessages messages={missingEnd} loading={false} />)
    expect(screen.getByRole('button', { name: /Worked for 2s, 1 tool\. Show the work\./ })).toBeTruthy()
  })

  it('omits elapsed copy when legacy timestamps cannot establish a real interval', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Run it.', timestamp: Number.NaN },
      { id: 't1', role: 'assistant', content: 'Used Bash', timestamp: Number.NaN, toolCall: 'Bash' },
      { id: 'a1', role: 'assistant', content: 'Done.', timestamp: Number.NaN },
    ]
    render(<ChatMessages messages={messages} loading={false} />)
    expect(screen.getByRole('button', { name: /^1 tool\. Show the work\./ })).toBeTruthy()
    expect(screen.queryByText(/Worked for/)).toBeNull()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
  })

  it('anchorScrollDuring compensates scrollTop by the anchor bottom delta each frame', () => {
    const scroller = { scrollTop: 100 } as unknown as Element
    let bottom = 500
    const anchor = { getBoundingClientRect: () => ({ bottom }) } as unknown as Element
    const frames: FrameRequestCallback[] = []
    let now = 0
    anchorScrollDuring(scroller, anchor, 100, (cb) => { frames.push(cb); return 1 }, () => now)

    bottom = 480
    now = 16
    frames.shift()!(now)
    expect(scroller.scrollTop).toBe(80)

    bottom = 470
    now = 200
    frames.shift()!(now)
    expect(scroller.scrollTop).toBe(50)
    // Past the window: no further frames scheduled.
    expect(frames).toHaveLength(0)
  })
})

describe('fold region boundary (turn structure)', () => {
  it('derives the final answer per turn: last assistant prose before the next user message', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Go.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used grep', timestamp: T0 + 1_000, toolCall: 'grep' },
      { id: 'p1', role: 'assistant', content: 'Interim finding.', timestamp: T0 + 2_000 },
      { id: 'a1', role: 'assistant', content: 'Final answer one.', timestamp: T0 + 3_000 },
      { id: 'u2', role: 'user', content: 'Next.', timestamp: T0 + 10_000 },
      { id: 't2', role: 'assistant', content: 'Used bash', timestamp: T0 + 11_000, toolCall: 'bash' },
    ]
    // Turn 1: the LAST prose (a1) is the answer — interim prose p1 is not.
    // User rows never fold, so their own entry stays -1. Turn 2 has no
    // answer yet: -1 throughout.
    expect(finalAnswerIndices(messages)).toEqual([-1, 3, 3, 3, -1, -1])
  })

  it('folds a callback burst (and the tools-only segment before it) into the turn they trigger, not split', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Go.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used grep', timestamp: T0 + 1_000, toolCall: 'grep' },
      callback('c1', 'dev', T0 + 2_000),
      callback('c2', 'qa', T0 + 3_000),
      { id: 't2', role: 'assistant', content: 'Used bash', timestamp: T0 + 4_000, toolCall: 'bash' },
      { id: 'a1', role: 'assistant', content: 'All done.', timestamp: T0 + 5_000 },
    ]
    // Both callbacks share the single downstream reply (index 5), and the
    // tools-only pre-callback segment folds toward it instead of orphaning.
    expect(finalAnswerIndices(messages)).toEqual([-1, 5, 5, 5, 5, 5])
  })

  it('treats persisted partial prose as evidence, never as the final answer', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Go.', timestamp: T0 },
      { id: 'p1', role: 'assistant', content: 'Interim finding.', timestamp: T0 + 1_000, partial: true },
      { id: 't1', role: 'assistant', content: 'Used grep', timestamp: T0 + 2_000, partial: true, toolCall: 'grep' },
      { id: 'a1', role: 'assistant', content: 'Final answer.', timestamp: T0 + 3_000 },
    ]

    expect(finalAnswerIndices(messages)).toEqual([-1, 3, 3, 3])
  })

  it('keeps historical turns folded while the latest turn remains an ordinary pending stream', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'First task.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used grep', timestamp: T0 + 1_000, toolCall: 'grep' },
      { id: 'a1', role: 'assistant', content: 'First final.', timestamp: T0 + 2_000 },
      { id: 'u2', role: 'user', content: 'Second task.', timestamp: T0 + 3_000 },
      { id: 'p2', role: 'assistant', content: 'Second interim.', timestamp: T0 + 4_000, partial: true },
      { id: 't2', role: 'assistant', content: 'Using bash', timestamp: T0 + 5_000, partial: true, toolCall: 'bash' },
    ]
    const { container } = render(
      <ChatMessages messages={messages} loading={false} turnPending />,
    )

    expect(container.querySelectorAll('[data-fold]')).toHaveLength(1)
    expect(container.querySelector('[data-fold-region]')?.textContent).toContain('1 tool')
    expect(container.querySelector('[data-fold-region]')?.textContent).not.toContain('Second interim.')
    expect(screen.getByText('First final.')).toBeTruthy()
    expect(screen.getByText('Second interim.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^1 tool$/ })).toBeTruthy()
  })

  it('folds interim prose within one engine turn, keeping only that turn\'s reply visible', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Redesign the panel.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used file_read', timestamp: T0 + 5_000, toolCall: 'file_read' },
      { id: 'p1', role: 'assistant', content: 'Reading the current layout first.', timestamp: T0 + 10_000 },
      { id: 'a1', role: 'assistant', content: 'Panel redesigned end to end.', timestamp: T0 + 20_000 },
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} onPeek={vi.fn()} />)

    // One engine turn → one fold. Its tool call and interim prose collapse…
    const regions = container.querySelectorAll('[data-fold-region]')
    expect(regions).toHaveLength(1)
    const region = regions[0]
    expect(region.getAttribute('aria-hidden')).toBe('true')
    expect(region.textContent).toContain('1 tool')
    expect(region.textContent).toContain('Reading the current layout first.')
    // …only the turn's final reply stays out.
    expect(region.textContent).not.toContain('Panel redesigned end to end.')
    expect(screen.getByText('Panel redesigned end to end.')).toBeTruthy()
  })

  it('preserves each reply and opens a fresh fold when a child re-invokes the same turn', () => {
    // One logical (user) turn, two engine turns: the model replies and stops,
    // a child callback re-invokes it, it replies again. Each reply must stay
    // visible; each engine turn's work folds separately, and the triggering
    // callback folds into the turn it started — not the earlier reply's fold.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Coordinate the redesign.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used file_read', timestamp: T0 + 5_000, toolCall: 'file_read' },
      { id: 'a1', role: 'assistant', content: 'Dispatched dev; will report back.', timestamp: T0 + 10_000 },
      callback('c1', 'dev', T0 + 200_000),
      { id: 't2', role: 'assistant', content: 'Used bash', timestamp: T0 + 205_000, toolCall: 'bash' },
      { id: 'a2', role: 'assistant', content: 'Panel redesigned end to end.', timestamp: T0 + 210_000 },
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} onPeek={vi.fn()} />)

    const regions = container.querySelectorAll('[data-fold-region]')
    expect(regions).toHaveLength(2)
    // Both replies stay visible; neither is swallowed by the other's fold.
    expect(screen.getByText('Dispatched dev; will report back.')).toBeTruthy()
    expect(screen.getByText('Panel redesigned end to end.')).toBeTruthy()
    // The first fold is just the first turn's work; the child callback belongs
    // to the SECOND fold (the engine turn it re-invoked).
    expect(regions[0].textContent).toContain('1 tool')
    expect(regions[0].textContent).not.toContain('dev')
    expect(regions[1].textContent).toContain('1 tool')
    expect(regions[1].textContent).toContain('dev')
    // Each engine segment owns its own persisted interval. The child callback,
    // not the original user row, starts the second 10-second segment.
    expect(screen.getAllByRole('button', { name: /Worked for 10s/ })).toHaveLength(2)
    expect(screen.getByRole('button', { name: /Worked for 10s, 1 tool, 1 teammate\. Show the work\./ })).toBeTruthy()
  })

  it('keeps system banners outside the fold and splits the region around them', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Go.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used grep', timestamp: T0 + 1_000, toolCall: 'grep' },
      { id: 'n1', role: 'notification', content: 'Session context was compacted.', timestamp: T0 + 2_000 },
      { id: 't2', role: 'assistant', content: 'Used bash', timestamp: T0 + 3_000, toolCall: 'bash' },
      { id: 'a1', role: 'assistant', content: 'All done.', timestamp: T0 + 4_000 },
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} />)
    // The banner stays visible between two folded regions.
    expect(screen.getByText('Session context was compacted.')).toBeTruthy()
    expect(container.querySelectorAll('[data-fold-region]')).toHaveLength(2)
    const summaries = screen.getAllByRole('button', { name: /Show the work/ })
    expect(summaries).toHaveLength(2)
    expect(summaries.filter((summary) => summary.getAttribute('aria-label')?.includes('Worked for 4s'))).toHaveLength(1)
    for (const region of container.querySelectorAll('[data-fold-region]')) {
      expect(region.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('counts delegated wait as worked time: a lone callback spans from the turn start', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Ask dev to audit.', timestamp: T0 },
      callback('c1', 'dev', T0 + 300_000),
      { id: 'a1', role: 'assistant', content: 'Audit relayed.', timestamp: T0 + 370_000 },
    ]
    render(<ChatMessages messages={messages} loading={false} />)
    // The callback is middle evidence, not the settlement boundary.
    expect(screen.getByRole('button', { name: /Worked for 6m, 1 teammate\. Show the work\./ })).toBeTruthy()
  })

  it('gives the summary row its own after-user inset outside the folding region', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Ship it.', timestamp: T0 },
      { id: 't1', role: 'assistant', content: 'Used file_edit', timestamp: T0 + 1_000, toolCall: 'file_edit' },
      { id: 'a1', role: 'assistant', content: 'Shipped.', timestamp: T0 + 2_000 },
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} />)
    const wrap = container.querySelector('[data-fold]')!
    const region = wrap.querySelector('[data-fold-region]')!
    const inset = wrap.querySelector('[data-fold-summary-inset]')!
    // The 24px inset survives the fold: it lives OUTSIDE the folded region,
    // directly above the summary row (the items' own spacers fold away).
    expect(inset.className).toContain('h-[var(--space-6)]')
    expect(region.contains(inset)).toBe(false)
    expect(region.compareDocumentPosition(inset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const summaryRow = screen.getByRole('button', { name: /Show the work/ }).closest('.assistant-msg-row')!
    expect(inset.compareDocumentPosition(summaryRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('creates and auto-collapses the region only when the final response arrives', () => {
    const running: Message[] = [
      { id: 'u1', role: 'user', content: 'Go.', timestamp: T0 },
      { id: 'p1', role: 'assistant', content: 'On it, delegating now.', timestamp: T0 + 1_000 },
      { id: 't1', role: 'assistant', content: 'Using read_flags', timestamp: T0 + 2_000, toolCall: 'read_flags' },
    ]
    vi.useFakeTimers()
    const onPeek = vi.fn()
    const { container, rerender } = render(<ChatMessages messages={running} loading onPeek={onPeek} />)
    expect(container.querySelector('[data-fold]')).toBeNull()

    // Tool completion and teammate completion are middle evidence, not turn
    // completion. They stay in the ordinary, fully visible stream.
    const middle: Message[] = [
      running[0],
      running[1],
      { ...running[2], content: 'Used read_flags' },
      callback('c1', 'dev', T0 + 4_000),
    ]
    rerender(<ChatMessages messages={middle} loading onPeek={onPeek} />)
    expect(container.querySelector('[data-fold]')).toBeNull()
    expect(screen.getByText('On it, delegating now.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /dev replied.*Open report/ })).toBeTruthy()

    // A waiting/idle status rerender is not a final-response event either.
    rerender(<ChatMessages messages={middle} loading={false} turnPending onPeek={onPeek} />)
    expect(container.querySelector('[data-fold]')).toBeNull()

    // The true final response is a new assistant prose row. Its arrival alone
    // derives the completed middle region. The final answer stays outside it —
    // and so does the engine turn's earlier reply ("On it, delegating now."),
    // which the child callback re-invocation preserves.
    const done: Message[] = [
      ...middle,
      { id: 'a1', role: 'assistant', content: 'All wired up.', timestamp: T0 + 9_000 },
    ]
    rerender(
      <ChatMessages
        messages={done}
        loading={false}
        turnPending={false}
        liveFinalResponseId="a1"
        onPeek={onPeek}
      />,
    )
    const region = container.querySelector('[data-fold-region]')!
    expect(region).toBeTruthy()
    // The folded region holds the tool work and the dev callback…
    expect(region.textContent).toContain('dev')
    // …not the two visible replies.
    expect(region.textContent).not.toContain('On it, delegating now.')
    expect(region.textContent).not.toContain('All wired up.')
    expect(screen.getByText('On it, delegating now.')).toBeTruthy()
    expect(screen.getByText('All wired up.')).toBeTruthy()
    expect(region.getAttribute('aria-hidden')).toBeNull()
    expect(container.querySelector('[data-fold-summary]')).toBeNull()

    // The existing beat + 420ms choreography performs the first collapse.
    act(() => vi.advanceTimersByTime(1200))
    expect(container.querySelector('[data-fold-region]')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: /Worked for 5s, 1 tool, 1 teammate\. Show the work\./ })).toBeTruthy()
  })
})

describe('streaming → final structural parity', () => {
  it('shares one spacer function between the streaming container and the final row', () => {
    expect(turnSpacerClass('user', 'assistant')).toBe('h-[var(--space-6)]')
    expect(turnSpacerClass('notification', 'assistant')).toBe('h-[var(--space-4)]')
    expect(turnSpacerClass('assistant', 'assistant')).toBe('h-[var(--space-1)]')
    expect(turnSpacerClass('user', 'user')).toBe('h-[var(--space-1)]')
  })

  it('renders the streaming container with the after-user spacer the final row will use', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Summarize the sweep.', timestamp: Date.now() - 5_000 },
    ]
    const { container } = render(
      <ChatMessages messages={messages} loading streamingText="Sweep done, three threads flagged" />,
    )
    const streaming = container.querySelector('[data-streaming]')
    expect(streaming).toBeTruthy()
    expect(streaming!.querySelector('.h-\\[var\\(--space-6\\)\\]')).toBeTruthy()
    expect(streaming!.querySelector('.assistant-transcript')).toBeTruthy()
  })

  it('renders a timestamp divider while streaming when the final row will show one', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Old message.', timestamp: Date.now() - 10 * 60 * 1000 },
    ]
    const { container } = render(
      <ChatMessages messages={messages} loading streamingText="Fresh reply" />,
    )
    const streaming = container.querySelector('[data-streaming]')
    expect(streaming!.textContent).toMatch(/Today/)
    expect(streaming!.querySelector('.h-\\[var\\(--space-6\\)\\]')).toBeNull()
  })

  it('renders the streaming shell and the final shell byte-identically (one component)', () => {
    const prev: Message = { id: 'u1', role: 'user', content: 'Go.', timestamp: Date.now() - 5_000 }
    const shellSignature = (root: Element) => {
      const row = root.querySelector('.assistant-msg-row')!
      const bubble = root.querySelector('.assistant-msg-bubble')!
      const transcript = root.querySelector('.assistant-transcript')!
      return [row.className, bubble.className, transcript.className].join('\n')
    }

    const streaming = render(
      <ChatMessages messages={[prev]} loading streamingText="The answer." />,
    )
    const streamingSig = shellSignature(streaming.container.querySelector('[data-streaming]')!)
    streaming.unmount()

    const final = render(
      <ChatMessages
        messages={[prev, { id: 'a1', role: 'assistant', content: 'The answer.', timestamp: Date.now() }]}
        loading={false}
      />,
    )
    const finalSig = shellSignature(final.container.querySelector('[data-message-id="a1"]')!)

    expect(streamingSig).toBe(finalSig)
  })
})

describe('fold slack gate', () => {
  it('only anchors the live fold when scrollTop can absorb the shrink', () => {
    // QA-measured clamp case: slack 27, region ~331 (delta 299) → skip.
    expect(canAnchorFold(27, 331)).toBe(false)
    // Enough slack: 400 ≥ 331 - 32.
    expect(canAnchorFold(400, 331)).toBe(true)
    // Boundary: slack + 2 tolerance against delta.
    expect(canAnchorFold(297, 331)).toBe(true)
    expect(canAnchorFold(296, 331)).toBe(false)
    // A tiny region folds even at scrollTop 0 (delta ≤ summary height).
    expect(canAnchorFold(0, 32)).toBe(true)
  })
})

describe('rendered copy carries no em or en dashes', () => {
  const componentRoots = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../../ui'),
  ]

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
  }

  function strippedLines(file: string): Array<{ line: number; text: string }> {
    let source = fs.readFileSync(file, 'utf-8')
    source = source.replace(/\/\*[\s\S]*?\*\//g, '')
    // Split on CRLF too. A trailing \r survives a split on '\n', and `.` never
    // matches \r, so the comment-stripping `.*$` below cannot reach the end of
    // the line and strips nothing — on a CRLF checkout every commented dash in
    // the codebase reports as rendered copy.
    return source.split(/\r?\n/)
      .map((text, index) => ({ line: index + 1, text: text.replace(/(^|[^:])\/\/.*$/, '$1') }))
      // Regex literals legitimately MATCH dashes (e.g. tab-title parsing) —
      // they parse them, they don't render them.
      .filter(({ text }) => !text.includes('.match(') && !text.includes('RegExp'))
  }

  it('chat + ui component sources render no em/en dashes', () => {
    const offenders: string[] = []
    for (const dir of componentRoots) {
      for (const file of sourceFiles(dir)) {
        for (const { line, text } of strippedLines(file)) {
          if (/[—–]/.test(text)) offenders.push(`${path.basename(file)}:${line} ${text.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
