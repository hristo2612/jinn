import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatMessages } from '../chat-messages'

describe('ChatMessages footer', () => {
  it('is the last transcript element and removes the transcript bottom padding', () => {
    const { container } = render(
      <ChatMessages
        messages={[{ id: 'm1', role: 'assistant', content: 'Done', timestamp: 1 }]}
        loading={false}
        footer={<div data-testid="transcript-footer">Footer</div>}
      />,
    )

    const transcript = container.querySelector('.chat-messages-scroll > div')
    expect(transcript?.lastElementChild?.querySelector('[data-testid="transcript-footer"]')).toBeTruthy()
    expect(transcript?.className).toContain('min-h-full')
    expect(transcript?.className).toContain('justify-end')
    expect(transcript?.className).toContain('pb-0')
    expect(transcript?.className).not.toContain('pb-[var(--space-6)]')
  })
})
