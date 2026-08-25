import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { distanceFromBottom } from '@/hooks/stick-geometry'
import { ChatMessages } from '../chat-messages'
import { VIRTUALIZE_THRESHOLD } from '../transcript-virtualizer'

const measureColumn = (root: HTMLElement) => root.querySelector('.chat-messages-scroll > div') as HTMLElement

/** A windowed transcript renders one total-size spacer in place of the group list. */
const windowingSpacer = (root: HTMLElement) => {
  const first = measureColumn(root).firstElementChild as HTMLElement | null
  return first?.style.position === 'relative' ? first : null
}

const longTranscript = Array.from({ length: VIRTUALIZE_THRESHOLD }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
  content: `message ${i}`,
  timestamp: i + 1,
}))

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

  it('leaves a long transcript windowed, in the same box, when it comes and goes', () => {
    // The footer IS the stale-chat notice, and sending a message answers it. While
    // the footer decided the windowing mode, that one send swapped the whole
    // content block for a total-size spacer and re-flowed the column underneath a
    // reader sitting at the bottom — the jump on submit.
    const view = render(
      <ChatMessages
        messages={longTranscript}
        loading={false}
        footer={<div data-testid="transcript-footer">Footer</div>}
      />,
    )
    expect(windowingSpacer(view.container)).toBeTruthy()
    const boxWithFooter = measureColumn(view.container).className
    const scroller = view.container.querySelector('.chat-messages-scroll') as HTMLElement
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 8000 })
    scroller.scrollTop = 7600
    const fromBottom = distanceFromBottom(scroller)

    view.rerender(<ChatMessages messages={longTranscript} loading={false} />)

    expect(windowingSpacer(view.container)).toBeTruthy()
    expect(measureColumn(view.container).className).toBe(boxWithFooter)
    expect(scroller.scrollTop).toBe(7600)
    expect(distanceFromBottom(scroller)).toBe(fromBottom)
  })
})
