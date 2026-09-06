import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { apiMocks, liveSessionDefaults, pane, renderPane } from './chat-pane-fixture'
import { ChatPane } from '../chat-pane'
import type { GatewayEvent } from '@jinn/gateway-events'
import { CHAT_SESSION_DND_MIME } from '@/routes/chat/chat-session-dnd'

describe('ChatPane', () => {
  it('makes focus state real at the pane and composer boundaries', () => {
    const onFocus = vi.fn()
    const { container } = renderPane({ isActive: false, onFocus })

    expect(container.querySelector('[data-chat-pane-active="false"]')).toBeTruthy()
    expect(pane.composerActive).toBe(false)
    fireEvent.focusIn(screen.getByTestId('chat-input'))
    expect(onFocus).toHaveBeenCalledOnce()
  })

  it('renders pane-owned chrome only in a multi-pane layout', () => {
    const onFocus = vi.fn()
    const onClose = vi.fn()
    pane.liveSessionState = {
      ...liveSessionDefaults,
      loading: true,
      session: { id: 's1', title: '#9 - Focus work', employee: 'platform-lead', status: 'running' },
    }
    const { rerender } = renderPane({
      multiPane: true,
      paneTitle: 'Warm title',
      paneEmployee: 'fallback-employee',
      onFocus,
      onClose,
    })

    expect(screen.getByTestId('chat-pane-title-bar')).toBeTruthy()
    expect(screen.getByText('Focus work')).toBeTruthy()
    expect(screen.getByTestId('chat-pane-status-dot').getAttribute('style')).toContain('var(--system-blue)')
    const close = screen.getByRole('button', { name: 'Close #9 - Focus work' })
    fireEvent.focusIn(close)
    fireEvent.click(close)
    expect(onFocus).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()

    rerender(
      <ChatPane
        sessionId="s1"
        isActive
        onFocus={() => {}}
        subscribe={() => () => {}}
        events={[]}
        multiPane={false}
        paneTitle="Warm title"
        paneEmployee="fallback-employee"
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('chat-pane-title-bar')).toBeNull()
  })

  it('lets session drags bubble to the grid while retaining file drops', () => {
    const outerDrop = vi.fn()
    const { container } = render(
      <div onDrop={outerDrop}>
        <ChatPane sessionId="s1" isActive onFocus={() => {}} subscribe={() => () => {}} events={[]} />
      </div>,
    )
    const pane = container.querySelector<HTMLElement>('[data-chat-pane-session="s1"]')!
    fireEvent.drop(pane, {
      dataTransfer: { types: [CHAT_SESSION_DND_MIME], files: [], getData: () => 's2' },
    })
    expect(outerDrop).toHaveBeenCalledOnce()
    outerDrop.mockClear()

    fireEvent.drop(pane, {
      dataTransfer: { types: ['Files'], files: [new File(['x'], 'x.txt')] },
    })
    expect(outerDrop).not.toHaveBeenCalled()
  })

  it('returns failed delivery while retaining the optimistic bubble and retry path', async () => {
    apiMocks.sendMessage.mockRejectedValueOnce(new Error('transport aborted')).mockResolvedValueOnce({})
    renderPane()
    const first = await pane.composerOnSend?.('Retry this message.')
    expect(first).toBe(false)
    expect(pane.liveSessionState.beginSend).toHaveBeenCalledTimes(1)
    expect(pane.liveSessionState.failSend).toHaveBeenCalledWith('transport aborted')

    pane.messagesOnRetry?.('Retry this message.')

    await vi.waitFor(() => expect(apiMocks.sendMessage).toHaveBeenCalledTimes(2))
    expect(pane.liveSessionState.beginSend).toHaveBeenCalledTimes(2)
    expect(pane.liveSessionState.failSend).toHaveBeenCalledTimes(1)
  })

  it('persists existing-chat engine switching on the same session', () => {
    const onNewChat = vi.fn()
    renderPane({ onNewChat })

    fireEvent.click(screen.getByRole('button', { name: /selector switch engine/i }))

    expect(apiMocks.updateSession).toHaveBeenCalledWith('s1', {
      engine: 'codex',
      model: 'gpt-5.5',
      effortLevel: 'medium',
    })
    expect(onNewChat).not.toHaveBeenCalled()
  })

  it('shows a lightweight loading status instead of an empty new-chat picker while a session hydrates', () => {
    vi.useFakeTimers()
    try {
      pane.liveSessionState = { ...liveSessionDefaults, hydrating: true, session: null }

      renderPane()

      // The spinner is a threshold, not a default — see chat-hydration.
      act(() => { vi.advanceTimersByTime(250) })
      expect(screen.getByRole('status', { name: /loading chat/i })).toBeTruthy()
      expect(screen.queryByTestId('employee-picker')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes parent delegated activity and employee display names to the composer status', () => {
    renderPane({
      delegatedActivity: { activeSessions: 1, employees: ['platform-lead'] },
    })

    expect(screen.getByTestId('background-status').textContent).toBe('1:Platform Lead')
  })

  it('releases destination readiness once per session, before paint', () => {
    const onContentReady = vi.fn()
    const props = {
      sessionId: 's1',
      isActive: true,
      onFocus: () => {},
      subscribe: () => () => {},
      events: [] as GatewayEvent[],
      onContentReady,
    }
    const { rerender } = render(<ChatPane {...props} />)

    // In the commit that paints the transcript, not a frame after it: what this
    // releases positions the scroller, and a frame later is a visible jump.
    expect(onContentReady).toHaveBeenCalledOnce()
    expect(onContentReady).toHaveBeenCalledWith('s1')

    pane.liveSessionState = {
      ...pane.liveSessionState,
      session: { ...pane.liveSessionState.session, title: 'Metadata landed before paint' },
    }
    rerender(<ChatPane {...props} />)
    expect(onContentReady).toHaveBeenCalledOnce()
  })
})
