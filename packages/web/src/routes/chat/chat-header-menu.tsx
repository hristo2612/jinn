import { Archive, ArchiveRestore, Copy, ExternalLink, MoreHorizontal, PanelRightOpen, Pin, PinOff, Search, Share2, Trash2 } from 'lucide-react'
import { sessionUrl } from '@/components/chat/chat-route-helpers'
import { usePins, useTogglePin } from '@/hooks/use-pins'
import { openExternal } from '@/platform'
import { cn } from '@/lib/utils'
import type { ViewMode } from '@/lib/view-mode'

const EMPTY_PINS = new Set<string>()

interface ChatHeaderMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedId: string | null
  sessionMeta: { engine?: string; engineSessionId?: string; archivedAt?: string | null } | null
  openGlobalSearch: () => void
  effectiveViewMode: ViewMode
  cliModeAvailable: boolean
  viewSwitchLocked: boolean
  cliTitle: string | undefined
  setAndPersistViewMode: (mode: ViewMode) => void
  onDuplicate: (id: string) => void
  duplicatePending: boolean
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
  onCopyToClipboard: (text: string, field: string) => void
  onShareDebugLog: () => void
  onClearDebugLog: () => void
  onDeleteSession: (id: string) => void
  onOpenChatBeside: () => void
}

/** The items below the view toggle, where a session is guaranteed to exist. */
type SelectedChatProps = Omit<ChatHeaderMenuProps, 'selectedId'> & { selectedId: string }

// More (…) menu — rendered as the last control inside the right header pill.
// D7: ALWAYS rendered (even on a new chat, where it carries Search, the view
// toggle, and Open beside) so the right pill is consistent. When a session is
// selected the items are grouped: primary (Search · view toggle · Open beside · Open in new
// tab · Pin · Duplicate) → Developer
// cluster → destructive Delete, each separated.
//
// Open state lives in the route, not here: the outside-click handler there
// matches on the `data-more-menu` attribute below, because this node is
// rendered twice (desktop tab bar + mobile header, one hidden via CSS).
export function ChatHeaderMenu(props: ChatHeaderMenuProps) {
  const { open, onOpenChange, selectedId } = props

  return (
    <div data-more-menu className="relative">
      <button
        onClick={() => onOpenChange(!open)}
        aria-label="More options"
        className="inline-flex size-11 lg:size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
      >
        <MoreHorizontal className="size-[18px]" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-[200] mt-2 min-w-[220px] overflow-hidden rounded-[var(--radius-md)] border border-border bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] backdrop-blur-xl">
          {/* PRIMARY group — Search (⌘K), the Chat/CLI view toggle, Open beside, then Open in
              new tab, Pin and Duplicate (only when a session is selected). */}
          {/* D4: Search lives at the very top — the only visible ⌘K entry point on desktop. */}
          <button
            onClick={props.openGlobalSearch}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent"
          >
            <Search className="size-3.5" />
            <span className="flex-1">Search…</span>
            <kbd className="font-mono text-caption2 text-[var(--text-quaternary)]">⌘K</kbd>
          </button>
          <ViewModeToggle {...props} />
          <button
            onClick={() => { props.onOpenChatBeside(); onOpenChange(false) }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent"
          >
            <PanelRightOpen className="size-3.5" />
            <span className="flex-1">Open beside</span>
          </button>
          {selectedId && <SelectedChatItems {...props} selectedId={selectedId} />}
        </div>
      )}
    </div>
  )
}

// Chat/CLI view toggle (moved here from the old tab bar so it stays reachable
// now that the header is a pill).
function ViewModeToggle(props: ChatHeaderMenuProps) {
  const { effectiveViewMode, cliModeAvailable, viewSwitchLocked, cliTitle, setAndPersistViewMode, onOpenChange } = props

  return (
    <div className="flex items-center gap-1 px-3 py-2">
      <button
        onClick={() => { if (!viewSwitchLocked) { setAndPersistViewMode('chat'); onOpenChange(false) } }}
        disabled={viewSwitchLocked}
        title={viewSwitchLocked ? cliTitle : undefined}
        className={cn(
          "flex-1 rounded-md px-2 py-1 text-caption1 font-medium transition-colors",
          effectiveViewMode === 'chat' ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "text-muted-foreground hover:bg-accent",
          viewSwitchLocked && "opacity-60 cursor-not-allowed"
        )}
      >
        Chat
      </button>
      <button
        onClick={() => { if (cliModeAvailable && !viewSwitchLocked) { setAndPersistViewMode('cli'); onOpenChange(false) } }}
        disabled={!cliModeAvailable || viewSwitchLocked}
        title={cliTitle}
        className={cn(
          "flex-1 rounded-md px-2 py-1 font-mono text-caption1 font-medium transition-colors",
          effectiveViewMode === 'cli' ? "bg-[var(--accent-fill)] text-[var(--accent)]" : "text-muted-foreground hover:bg-accent",
          (!cliModeAvailable || viewSwitchLocked) && "opacity-45 cursor-not-allowed"
        )}
      >
        CLI
      </button>
    </div>
  )
}

function SelectedChatItems(props: SelectedChatProps) {
  const { selectedId, sessionMeta, onOpenChange } = props

  return (
    <>
      <button
        onClick={() => { void openExternal(sessionUrl(selectedId)); onOpenChange(false) }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent"
      >
        <ExternalLink className="size-3.5" />
        <span className="flex-1">Open in new tab</span>
      </button>
      <PinItem selectedId={selectedId} onOpenChange={onOpenChange} />
      <button
        onClick={() => props.onDuplicate(selectedId)}
        disabled={props.duplicatePending}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent disabled:opacity-50"
      >
        <Copy className="size-3.5" />
        <span className="flex-1">{props.duplicatePending ? 'Duplicating...' : 'Duplicate...'}</span>
      </button>

      <div className="my-0.5 border-t border-border" />
      <button
        onClick={() => { if (sessionMeta?.archivedAt) props.onUnarchive(selectedId); else props.onArchive(selectedId) }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent"
      >
        {sessionMeta?.archivedAt ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        <span className="flex-1">{sessionMeta?.archivedAt ? 'Unarchive chat' : 'Archive chat'}</span>
      </button>

      <DeveloperItems {...props} />

      {/* DESTRUCTIVE */}
      <div className="my-0.5 border-t border-border" />
      <button
        onClick={() => { onOpenChange(false); if (window.confirm('Delete this session?')) props.onDeleteSession(selectedId) }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-subheadline text-[var(--system-red)] transition-colors hover:bg-accent"
      >
        <Trash2 className="size-3.5" />
        <span className="flex-1">Delete Session</span>
        <kbd className="font-mono text-caption2 text-[var(--text-quaternary)]">⌫</kbd>
      </button>
    </>
  )
}

// The chat pin is keyed by session id, exactly as the sidebar row menu keys it.
// Not to be confused with the route's tab `pinned` flag, a different concept.
function PinItem({ selectedId, onOpenChange }: Pick<SelectedChatProps, 'selectedId' | 'onOpenChange'>) {
  const { data: pinnedKeys = EMPTY_PINS } = usePins()
  const { mutate: togglePin } = useTogglePin()
  const isPinned = pinnedKeys.has(selectedId)

  return (
    <button
      onClick={() => { togglePin({ key: selectedId, pinned: !isPinned }); onOpenChange(false) }}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent"
    >
      {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      <span className="flex-1">{isPinned ? 'Unpin' : 'Pin'}</span>
    </button>
  )
}

function DeveloperItems(props: SelectedChatProps) {
  const { selectedId, sessionMeta, onOpenChange, onCopyToClipboard } = props

  return (
    <>
      <div className="my-0.5 border-t border-border" />
      <div className="px-3 pb-1 pt-2 text-caption2 font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
        Developer
      </div>
      <button
        onClick={() => onCopyToClipboard(selectedId, 'id')}
        className="block w-full px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent"
      >
        Copy Session ID
      </button>
      {sessionMeta?.engineSessionId && (
        <button
          onClick={() => {
            const cli = sessionMeta.engine === 'codex' ? 'codex' : 'claude'
            onCopyToClipboard(`${cli} --resume ${sessionMeta.engineSessionId}`, 'cli')
          }}
          className="block w-full px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent"
        >
          Copy CLI Resume Command
        </button>
      )}
      <button
        onClick={() => { onOpenChange(false); props.onShareDebugLog() }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-subheadline text-foreground transition-colors hover:bg-accent"
      >
        <Share2 className="size-3.5" />
        <span className="flex-1">Share debug log</span>
      </button>
      <button
        onClick={() => { onOpenChange(false); props.onClearDebugLog() }}
        className="block w-full px-3 py-2 text-left text-caption1 text-muted-foreground transition-colors hover:bg-accent"
      >
        Clear debug log
      </button>
    </>
  )
}
