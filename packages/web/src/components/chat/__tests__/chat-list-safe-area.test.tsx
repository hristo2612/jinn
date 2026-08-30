import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ChatSidebar } from '@/components/chat/chat-sidebar'

/* The chat list's control band owns its own top safe-area inset: the chat route
 * is `chromeless`, the branch that skips PageLayout's `pt-[var(--safe-top)]`,
 * and the mobile thread header is hidden over the list. jsdom does no layout, so
 * a reachability test passes with the bug in place; assert the inset instead,
 * plus that the affected controls sit inside the band that carries it. */

vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({ data: [], isLoading: false }),
  usePinnedSessions: () => ({ data: [] }),
  useSessionCounts: () => ({ data: { counts: {}, perGroup: 8 } }),
  useSessionSearch: () => ({ data: undefined }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useStopSession: () => ({ mutate: vi.fn() }),
  useArchiveSession: () => ({ mutateAsync: vi.fn() }),
  useUnarchiveSession: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteSessions: () => ({ mutateAsync: vi.fn() }),
  useDuplicateSession: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: new Set<string>() }),
  useTogglePin: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: { getOrg: () => Promise.resolve({ employees: [] }), getEmployee: () => Promise.resolve({}) },
}))

vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: { portalName: 'Jinn', employeeOverrides: {} } }),
}))

function renderSidebar(variant: 'desktop' | 'mobile') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChatSidebar selectedId={null} onSelect={vi.fn()} onNewChat={vi.fn()} variant={variant} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const band = document.querySelector('[data-chat-list-controls]')
  if (!band) throw new Error('chat list control band not found')
  return band
}

// Class or inline style — either spelling is a real fix, so don't pin one.
function topPadding(band: Element): string {
  const inline = (band as HTMLElement).style.paddingTop
  if (inline) return inline
  return band.className.match(/(?:^|\s)pt-\[([^\]]*)\]/)?.[1] ?? ''
}

it.each(['mobile', 'desktop'] as const)(
  'reserves the top safe-area inset on the control band (%s)',
  (variant) => {
    const padding = topPadding(renderSidebar(variant))

    expect(padding).toContain('var(--safe-top)')
    // A bare inset collapses the band flush to the top edge wherever it reports
    // 0 — every desktop browser, where this band already looked right.
    expect(padding).toMatch(/max\(/)
  },
)

it('keeps the controls that were unreachable inside the padded band', () => {
  const band = renderSidebar('mobile')

  for (const label of ['New chat', 'Focused', 'All', 'Search chats']) {
    expect(band.contains(screen.getByLabelText(label, { selector: 'button' }))).toBe(true)
  }
})
