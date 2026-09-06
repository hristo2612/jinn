import { beforeEach, vi, type Mock } from 'vitest'
import { render, type RenderResult } from '@testing-library/react'
import type React from 'react'
import type { MediaAttachment } from '@/lib/conversations'
import { ChatPane } from '../chat-pane'

let featuresState = {
  notesEnabled: false,
  staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 },
}

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(() => Promise.resolve({})),
  sendMessage: vi.fn<(id: string, body: unknown) => Promise<Record<string, unknown>>>(() => Promise.resolve({})),
}))

vi.mock('@/lib/api', () => ({ api: mocks }))

export const apiMocks: Record<'uploadFile' | 'createSession' | 'updateSession' | 'sendMessage', Mock> = mocks

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

export const liveSessionDefaults: LiveSessionMockState = {
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

export const pane = {
  liveSessionState: { ...liveSessionDefaults },
  composerOnSend: null as ((message: string, media?: MediaAttachment[]) => Promise<boolean>) | null,
  messagesOnRetry: null as ((message: string) => void) | null,
  composerActive: undefined as boolean | undefined,
}

vi.mock('@/hooks/use-live-session', () => ({
  useLiveSession: () => pane.liveSessionState,
}))

vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ selectorSlot, statusSlot, onSend, isActive }: {
    selectorSlot?: React.ReactNode
    statusSlot?: React.ReactNode
    onSend: (message: string, media?: MediaAttachment[]) => Promise<boolean>
    isActive?: boolean
  }) => {
    pane.composerOnSend = onSend
    pane.composerActive = isActive
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
    pane.messagesOnRetry = onRetry ?? null
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

export function renderPane(props: Partial<React.ComponentProps<typeof ChatPane>> = {}): RenderResult {
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

beforeEach(() => {
  pane.liveSessionState = { ...liveSessionDefaults, beginSend: vi.fn(), updateSendMedia: vi.fn() }
  featuresState = {
    notesEnabled: false,
    staleChat: { enabled: true, tokenThreshold: 300_000, staleAfterMinutes: 60 },
  }
  apiMocks.updateSession.mockClear()
  apiMocks.sendMessage.mockReset()
  apiMocks.sendMessage.mockResolvedValue({})
  pane.composerOnSend = null
  pane.messagesOnRetry = null
  pane.composerActive = undefined
  localStorage.clear()
})
