import { beforeEach, describe, expect, it } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import { gateway, renderRoute } from './multi-pane-page-harness'

function resize(width: number) {
  act(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    window.dispatchEvent(new Event('resize'))
  })
}

describe('chat sidebar viewport ownership', () => {
  beforeEach(() => {
    localStorage.clear()
    gateway.listeners.clear()
  })

  it.each([390, 1440])('mounts only the active sidebar at %i px and after resizing', async (width) => {
    resize(width)
    renderRoute()
    await waitFor(() => expect(screen.getAllByTestId('chat-sidebar')).toHaveLength(1))
    resize(width === 390 ? 1440 : 390)
    await waitFor(() => expect(screen.getAllByTestId('chat-sidebar')).toHaveLength(1))
  })
})
