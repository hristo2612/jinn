import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatMessages, finalAnswerIndices, groupMessages, partitionForFold } from '../chat-messages'
import type { Message } from '@/lib/conversations'
vi.mock('@/lib/api', () => ({ api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) } }))
const T0 = 1_780_000_000_000

describe('completed answers with a callback queued during work', () => {
  const messages: Message[] = [
    { id: 'ask', role: 'user', content: 'Research the design.', timestamp: T0 },
    { id: 'progress', role: 'assistant', content: 'Checking the implementation.', timestamp: T0 + 1_000, meta: { assistantPhase: 'commentary' } },
    { id: 'relay', role: 'notification', content: '📨 From coordinator: acknowledged.', timestamp: T0 + 2_000 },
    { id: 'more-work', role: 'assistant', content: 'Comparing the results.', timestamp: T0 + 3_000, meta: { assistantPhase: 'commentary' } },
    { id: 'attachment', role: 'assistant', content: 'Detailed evidence.', timestamp: T0 + 4_000, media: [{ type: 'file', url: '/api/files/report', name: 'report.md' }] },
    { id: 'answer', role: 'assistant', content: 'The complete research conclusion.', timestamp: T0 + 5_000, meta: { assistantPhase: 'final' } },
    { id: 'ack', role: 'assistant', content: 'The coordinator update is acknowledged.', timestamp: T0 + 6_000, meta: { assistantPhase: 'final' } },
  ]

  it.each([0, 3, 5])('keeps both final answers outside collapsed work after history page offset %s', (offset) => {
    const history = messages.slice(offset)
    const groups = partitionForFold(groupMessages(history), history, new Set(), null, new Set())
    const visible = groups.flatMap((group) => group.kind === 'plain' && group.item.kind === 'message' ? [group.item.msg.id] : [])
    expect(visible).toContain('answer')
    expect(visible).toContain('ack')
    if (offset === 0) expect(finalAnswerIndices(history)[1]).toBe(5)
  })

  it('keeps the completed answer identified while a later callback turn streams', () => {
    const history = messages.slice(0, -1)
    const { rerender } = render(<ChatMessages messages={history} loading={false} />)
    expect(screen.getByText('The complete research conclusion.').closest('[data-fold-region]')).toBeNull()
    rerender(<ChatMessages messages={history} loading streamingText="Checking the coordinator update." />)
    expect(screen.getByText('The complete research conclusion.').closest('[data-message-id]')?.getAttribute('data-final-answer')).toBe('true')
    rerender(<ChatMessages messages={messages} loading={false} />)
    expect(screen.getByText('The complete research conclusion.').closest('[data-fold-region]')).toBeNull()
    expect(screen.getByText('The coordinator update is acknowledged.').closest('[data-fold-region]')).toBeNull()
  })

  it('identifies an illustrated final answer while preserving progress as work', () => {
    const history: Message[] = [messages[0], messages[1], {
      ...messages[5], content: 'Research conclusion with ![evidence](https://example.test/chart.png)',
    }]
    render(<ChatMessages messages={history} loading={false} />)
    expect(screen.getByText('Final answer')).toBeTruthy()
    expect(finalAnswerIndices(history)).toEqual([-1, 2, 2])
  })

  it('counts native agents separately from Jinn teammates in completed work', () => {
    const native: Message = { id: 'native', role: 'assistant', content: 'Native Codex agents', timestamp: T0 + 4_500, blocks: [{
      id: 'native-block', type: 'task-list', version: 2, status: 'completed', payload: {
        kind: 'native-agents', items: [{ id: 'research', text: 'research: Completed', status: 'completed' }],
      },
    }] }
    const history = [messages[0], messages[2], native, messages[5]]
    render(<ChatMessages messages={history} loading={false} />)
    expect(screen.getByRole('button', { name: /1 teammate, 1 native agent/ })).toBeTruthy()
  })
})
