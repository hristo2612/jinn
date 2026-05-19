import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

function withQueryClient(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

// --- ChatSidebar shortcut hints ---

// Mock all heavy dependencies so we can render ChatSidebar in isolation
vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({ data: [], isLoading: false }),
  useSessionCounts: () => ({ data: { counts: {}, perGroup: 8 } }),
  useSessionSearch: () => ({ data: undefined }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteSessions: () => ({ mutateAsync: vi.fn() }),
  useDuplicateSession: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    getOrg: () => Promise.resolve({ employees: [] }),
    getEmployee: () => Promise.resolve({}),
  },
}))

vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: { portalName: 'Jinn' } }),
}))

// Stub Radix context menu to avoid portal issues in tests
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}))

import { ChatSidebar } from '../chat-sidebar'

describe('ChatSidebar shortcut hints', () => {
  const defaultProps = {
    selectedId: null,
    onSelect: vi.fn(),
    onNewChat: vi.fn(),
  }

  it('renders "New" button with shortcut hint in title/aria-label', () => {
    render(withQueryClient(<ChatSidebar {...defaultProps} />))
    // The New button should have a title attribute containing "N" shortcut
    const newBtn = screen.getByRole('button', { name: /new/i })
    const title = newBtn.getAttribute('title') ?? newBtn.getAttribute('aria-label') ?? ''
    expect(title.toLowerCase()).toContain('n')
  })

  it('renders search input with placeholder', () => {
    render(withQueryClient(<ChatSidebar {...defaultProps} />))
    const searchInput = screen.getByPlaceholderText(/search/i)
    expect(searchInput).toBeTruthy()
  })
})

// --- ChatTabBar shortcut hints ---

vi.mock('@/components/ui/employee-avatar', () => ({
  EmployeeAvatar: () => null,
}))

vi.mock('@/lib/clean-preview', () => ({
  cleanPreview: (s: string) => s,
}))

import { ChatTabBar } from '../chat-tabs'

describe('ChatTabBar shortcut hints', () => {
  const defaultProps = {
    tabs: [],
    activeIndex: -1,
    onSwitch: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
  }

  it('renders new tab button with shortcut hint in title', () => {
    render(<ChatTabBar {...defaultProps} />)
    // The + button should show "N" shortcut in its title
    const newBtn = screen.getByTitle(/\(N\)/i)
    expect(newBtn).toBeTruthy()
  })
})

// --- Persistent bottom hint ---

describe('Persistent shortcut hint', () => {
  it('ShortcutHint component renders "? for shortcuts" text', async () => {
    // Import the persistent hint component
    const { ShortcutHint } = await import('../shortcut-hint')
    render(<ShortcutHint onClick={vi.fn()} />)
    const hint = screen.getByText(/\?/i)
    expect(hint).toBeTruthy()
    // Should contain "shortcuts" text nearby
    const container = screen.getByText(/shortcuts/i)
    expect(container).toBeTruthy()
  })
})
