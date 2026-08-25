import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { WORKING_SET_STORAGE_KEY } from '../working-set'

import { apiMocks, gateway, pane, renderRoute, sessionIds } from './multi-pane-page-harness'

// Leaving a thread for the composer is leaving the thread. Selecting another session
// records where the reader was, so back returns them to it; "New chat" navigates the same
// way and has to record the same thing, or back lands on whatever offset was stored the
// last time the reader happened to switch sessions.

const SCROLLER = '.chat-messages-scroll'
const READER_POSITION = 900

function transcript() {
  return document.querySelector<HTMLElement>(SCROLLER)
}

/** jsdom lays nothing out, and page.tsx only records a scroller that has a height. */
function stubGeometry() {
  const descriptors = {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => 4000 },
  }
  Object.defineProperties(HTMLElement.prototype, descriptors)
  return () => {
    for (const key of Object.keys(descriptors)) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
    }
  }
}

describe('leaving a thread for the composer', () => {
  let release: (() => void) | undefined

  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    localStorage.setItem(
      WORKING_SET_STORAGE_KEY,
      JSON.stringify({ version: 1, sessionIds: ['a'], focusedId: 'a', focusHistory: ['a'] }),
    )
    gateway.listeners.clear()
    apiMocks.sendMessage.mockClear()
    apiMocks.createSession.mockClear()
    release = stubGeometry()
  })

  afterEach(() => {
    release?.()
    release = undefined
  })

  it('remembers where the reader was before New chat navigates away', async () => {
    renderRoute('/?session=a')
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))

    const scroller = transcript()
    expect(scroller).not.toBeNull()
    scroller!.scrollTop = READER_POSITION

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0])
    await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/'))

    fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))

    await waitFor(() => expect(transcript()?.scrollTop).toBe(READER_POSITION))
  })
})
