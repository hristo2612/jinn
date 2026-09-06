import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import type { MediaAttachment, Message } from '@/lib/conversations'
import { reconcileMessages } from '@/lib/conversations'
import { ChatPane } from '../chat-pane'
import type { GatewayEvent } from '@jinn/gateway-events'
import { CHAT_SESSION_DND_MIME } from '@/routes/chat/chat-session-dnd'

let featuresState = {
  notesEnabled: false,
  staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 },
}

const apiMocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(() => Promise.resolve({})),
  sendMessage: vi.fn<(id: string, body: unknown) => Promise<Record<string, unknown>>>(() => Promise.resolve({})),
}))

vi.mock('@/lib/api', () => ({ api: apiMocks }))

vi.mock('@/hooks/use-employees', () => {
  const result = { data: { employees: [{ name: 'platform-lead', displayName: 'Platform Lead' }] } }
  return { useOrg: () => result }
})

vi.mock('@/hooks/use-features', () => ({
  useFeatures: () => ({ data: featuresState, isPending: false }),
}))

interface LiveSessionMockState {
  messages: unknown[]
  streamingText: string
  loading: boolean
  hydrating: boolean
  session: Record<string, unknown> | null
  error: Error | null
  liveContextTokens: number | null
  backgroundActivity: unknown
  reload: ReturnType<typeof vi.fn>
  beginSend: ReturnType<typeof vi.fn>
  updateSendMedia: ReturnType<typeof vi.fn>
  failSend: ReturnType<typeof vi.fn>
  appendLocal: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const liveSessionDefaults: LiveSessionMockState = {
  messages: [],
  streamingText: '',
  loading: false,
  hydrating: false,
  session: { id: 's1', status: 'idle', engine: 'claude', model: 'opus' },
  error: null,
  liveContextTokens: null,
  backgroundActivity: null,
  reload: vi.fn(),
  beginSend: vi.fn(),
  updateSendMedia: vi.fn(),
  failSend: vi.fn(),
  appendLocal: vi.fn(),
  reset: vi.fn(),
}

let liveSessionState: LiveSessionMockState
let composerOnSend: ((message: string, media?: MediaAttachment[]) => Promise<boolean>) | null
let messagesOnRetry: ((message: string) => void) | null
let composerActive: boolean | undefined

vi.mock('@/hooks/use-live-session', () => ({
  useLiveSession: () => liveSessionState,
}))

vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ selectorSlot, statusSlot, onSend, isActive }: {
    selectorSlot?: React.ReactNode
    statusSlot?: React.ReactNode
    onSend: (message: string, media?: MediaAttachment[]) => Promise<boolean>
    isActive?: boolean
  }) => {
    composerOnSend = onSend
    composerActive = isActive
    return <div data-testid="chat-input" data-active={String(isActive)}>{selectorSlot}{statusSlot}</div>
  },
}))

vi.mock('@/components/chat/model-selector-row', () => ({
  ModelSelectorRow: ({ onChange }: { onChange: (next: { engine?: string; model?: string; effortLevel?: string }) => void }) => (
    <button
      type="button"
      onClick={() => onChange({ engine: 'codex', model: 'gpt-5.5', effortLevel: 'medium' })}
    >
      selector switch engine
    </button>
  ),
}))

vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: ({ footer, onRetry }: { footer?: React.ReactNode; onRetry?: (message: string) => void }) => {
    messagesOnRetry = onRetry ?? null
    return <div data-testid="messages">{footer}</div>
  },
}))

vi.mock('@/components/chat/chat-employee-picker', () => ({
  ChatEmployeePicker: () => <div data-testid="employee-picker" />,
}))


vi.mock('@/components/chat/background-activity-status', () => ({
  BackgroundActivityStatus: ({ delegatedActivity, employeeDisplayNames }: {
    delegatedActivity?: { activeSessions: number; employees: string[] } | null
    employeeDisplayNames?: Record<string, string>
  }) => (
    <div data-testid="background-status">
      {delegatedActivity?.activeSessions ?? 0}:{employeeDisplayNames?.['platform-lead'] ?? ''}
    </div>
  ),
}))

vi.mock('@/components/chat/cli-keybar', () => ({
  CliKeybar: () => null,
}))

function renderPane(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return render(
    <ChatPane
      sessionId="s1"
      isActive
      onFocus={() => {}}
      subscribe={() => () => {}}
      events={[]}
      {...props}
    />,
  )
}

describe('ChatPane', () => {
  beforeEach(() => {
    liveSessionState = { ...liveSessionDefaults, beginSend: vi.fn(), updateSendMedia: vi.fn() }
    featuresState = {
      notesEnabled: false,
      staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 },
    }
    apiMocks.updateSession.mockClear()
    apiMocks.sendMessage.mockReset()
    apiMocks.sendMessage.mockResolvedValue({})
    composerOnSend = null
    messagesOnRetry = null
    composerActive = undefined
    localStorage.clear()
  })

  it.each(['s1', null])('associates same-named uploads before dispatch and new-session handoff (%s)', async (sessionId) => {
    const media: MediaAttachment[] = ['a', 'b'].map((id) => ({
      type: 'video', url: `blob:${id}`, name: 'capture.mp4',
      file: new File([id], 'capture.mp4', { type: 'video/mp4' }),
    }))
    apiMocks.uploadFile.mockReset().mockResolvedValueOnce({ id: 'a' }).mockResolvedValueOnce({ id: 'b' })
    const onSessionCreated = vi.fn()
    let optimistic: Message | undefined
    liveSessionState.beginSend.mockImplementation((message: Message) => { optimistic = { ...message } })
    liveSessionState.updateSendMedia.mockImplementation((id: string, uploaded: MediaAttachment[]) => {
      expect(id).toBe(optimistic?.id)
      optimistic = { ...optimistic!, media: uploaded }
    })
    const persisted = (): Message => ({
      id: 'server', role: 'user', content: 'compare', timestamp: Date.now(),
      media: ['a', 'b'].map((id) => ({ type: 'video', name: 'capture.mp4', url: `/api/files/${id}` })),
    })
    const dispatch = async () => {
      const merged = reconcileMessages([optimistic!], [persisted()])
      expect(merged).toHaveLength(1)
      expect(merged[0].id).toBe(optimistic?.id)
      return { id: 'new-session' }
    }
    apiMocks.sendMessage.mockImplementation(dispatch)
    apiMocks.createSession.mockImplementation(dispatch)
    renderPane({ sessionId, onSessionCreated })

    await act(async () => { expect(await composerOnSend?.('compare', media)).toBe(true) })

    expect(optimistic?.media?.map((item) => item.fileId)).toEqual(['a', 'b'])
    const call = sessionId ? apiMocks.sendMessage.mock.calls[0]?.[1] : apiMocks.createSession.mock.calls[0]?.[0]
    expect(call).toMatchObject({ attachments: ['a', 'b'] })
    if (!sessionId) {
      expect(onSessionCreated).toHaveBeenCalledWith('new-session', expect.objectContaining({ media: optimistic?.media }))
    }
  })

  it('makes focus state real at the pane and composer boundaries', () => {
    const onFocus = vi.fn()
    const { container } = renderPane({ isActive: false, onFocus })

    expect(container.querySelector('[data-chat-pane-active="false"]')).toBeTruthy()
    expect(composerActive).toBe(false)
    fireEvent.focusIn(screen.getByTestId('chat-input'))
    expect(onFocus).toHaveBeenCalledOnce()
  })

  it('renders pane-owned chrome only in a multi-pane layout', () => {
    const onFocus = vi.fn()
    const onClose = vi.fn()
    liveSessionState = {
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
    const first = await composerOnSend?.('Retry this message.')
    expect(first).toBe(false)
    expect(liveSessionState.beginSend).toHaveBeenCalledTimes(1)
    expect(liveSessionState.failSend).toHaveBeenCalledWith('transport aborted')

    messagesOnRetry?.('Retry this message.')

    await vi.waitFor(() => expect(apiMocks.sendMessage).toHaveBeenCalledTimes(2))
    expect(liveSessionState.beginSend).toHaveBeenCalledTimes(2)
    expect(liveSessionState.failSend).toHaveBeenCalledTimes(1)
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
      liveSessionState = { ...liveSessionDefaults, hydrating: true, session: null }

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

    liveSessionState = {
      ...liveSessionState,
      session: { ...liveSessionState.session, title: 'Metadata landed before paint' },
    }
    rerender(<ChatPane {...props} />)
    expect(onContentReady).toHaveBeenCalledOnce()
  })
})
