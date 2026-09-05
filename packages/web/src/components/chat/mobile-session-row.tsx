import React from "react"
import { Pin } from "lucide-react"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { cleanPreview } from "@/lib/clean-preview"
import { cn } from "@/lib/utils"
import { ACTION_WIDTH, MobileRowMenu, SwipeActionRails, type RowActions } from "@/components/chat/mobile-row-actions"
import {
  formatTime,
  getSessionActivity,
  getStatusDot,
  isArchivedSession,
  SessionAttentionChips,
  StatusDot,
  useStallClock,
  type Session,
} from "@/components/chat/session-signals"
import { useSwipeActions } from "@/components/chat/use-swipe-actions"

export interface MobileSessionRowProps {
  session: Session
  /** Avatar slug — employee name, or the portal slug for direct chats. */
  avatarName: string
  /** Strong first line: employee display name, or the portal name. */
  displayName: string
  /** Rows inside the Pinned section drop the per-row pin glyph. */
  hidePin?: boolean
  selectedId: string | null
  readSessions: Set<string>
  pinnedSessions: Set<string>
  renamingSessionId: string | null
  renameCancelledRef: React.MutableRefObject<boolean>
  fixTitle: (title: string | undefined, employee: string | undefined) => string
  onSelect: (id: string) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  togglePin: (pinKey: string) => void
  handleDuplicate: (sessionId: string) => void
  handleStop: (sessionId: string) => void
  handleArchive: (session: Session) => void
  setDeleteTarget: (target: { type: "session" | "employee"; id: string; label: string; sessions?: Session[] } | null) => void
  setRenamingSessionId: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
}

interface SummaryProps {
  session: Session
  avatarName: string
  displayName: string
  title: string
  strong: boolean
  showPin: boolean
  isArchived: boolean
  readSessions: Set<string>
}

/** Avatar, then the two lines a phone list cell reads by — the chat TITLE is
 *  the strong line (it's what the operator scans to switch), the employee name
 *  the quiet one. Identity is already ambient in the emoji avatar. */
function RowSummary({ session, avatarName, displayName, title, strong, showPin, isArchived, readSessions }: SummaryProps) {
  const stallNow = useStallClock(session.status === "running")
  const dot = getStatusDot(session, readSessions, false, stallNow)
  return (
    <>
      <span className="relative flex size-[30px] shrink-0 items-center justify-center">
        <EmployeeAvatar name={avatarName} size={30} />
        {dot ? (
          <StatusDot
            color={dot.color}
            pulse={dot.pulse}
            title={dot.label}
            className="absolute -bottom-0.5 right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-subheadline text-foreground",
              strong ? "font-[var(--weight-semibold)]" : "font-[var(--weight-regular)]",
            )}
          >
            {title}
          </span>
          {isArchived ? (
            <span className="shrink-0 text-caption2 font-[var(--weight-medium)] text-[var(--text-tertiary)]">
              Archived
            </span>
          ) : null}
          {showPin ? <Pin className="size-3 shrink-0 text-[var(--text-tertiary)]" /> : null}
          <span className="shrink-0 text-caption1 tabular-nums text-[var(--text-quaternary)]">
            {formatTime(getSessionActivity(session))}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-caption1 text-[var(--text-tertiary)]">{displayName}</span>
          <SessionAttentionChips session={session} />
        </span>
      </span>
    </>
  )
}

/** Overlaid on the quiet line rather than replacing it: an input cannot live
 *  inside the row's own button. */
function RowRenameInput({
  title,
  cancelledRef,
  onCommit,
  onDone,
}: {
  title: string
  cancelledRef: React.MutableRefObject<boolean>
  onCommit: (next: string) => void
  onDone: () => void
}) {
  return (
    <input
      autoFocus
      maxLength={200}
      defaultValue={title}
      aria-label="Rename chat"
      className="absolute bottom-2.5 left-4 right-16 h-9 rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] px-2 text-footnote text-[var(--text-primary)] outline-none"
      onFocus={(e) => e.target.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        else if (e.key === "Escape") {
          cancelledRef.current = true
          onDone()
        }
      }}
      onBlur={(e) => {
        if (cancelledRef.current) {
          cancelledRef.current = false
          return
        }
        const next = e.target.value.trim()
        if (next && next !== title) onCommit(next)
        onDone()
      }}
    />
  )
}

/** The sliding half of the row: everything that rides on top of the action rails.
 *  Motion is transform-only and both ends of it come from the motion tokens, so a
 *  drag tracks the finger exactly and the release settles on the shared curve. */
function RowSurface({
  swipe,
  isActive,
  children,
}: {
  swipe: ReturnType<typeof useSwipeActions>
  isActive: boolean
  children: React.ReactNode
}) {
  return (
    <div
      data-pressed={swipe.pressing || undefined}
      onPointerDown={swipe.onPointerDown}
      onClickCapture={swipe.onClickCapture}
      style={{
        transform: `translate3d(${swipe.offset}px, 0, 0)`,
        transitionProperty: "transform",
        transitionDuration: swipe.dragging ? "var(--duration-instant)" : "var(--duration-base)",
        transitionTimingFunction: "var(--ease-snappy)",
        touchAction: "pan-y pinch-zoom",
      }}
      className={cn(
        "relative flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left data-[pressed]:bg-[var(--fill-primary)]",
        isActive ? "bg-[var(--fill-secondary)]" : "bg-[var(--sidebar-bg)]",
      )}
    >
      {children}
    </div>
  )
}

/** Every row action closes the rail first: leaving it open behind a dialog or a
 *  freshly pinned row is the state nobody expects. */
function rowActions(props: MobileSessionRowProps, swipe: ReturnType<typeof useSwipeActions>, title: string): RowActions {
  const { session, renameCancelledRef, setRenamingSessionId } = props
  return {
    onRename: () => { renameCancelledRef.current = false; setRenamingSessionId(session.id) },
    onTogglePin: () => { swipe.close(); props.togglePin(session.id) },
    onDuplicate: () => props.handleDuplicate(session.id),
    onArchive: () => { swipe.close(); props.handleArchive(session) },
    onStop: () => props.handleStop(session.id),
    onDelete: () => { swipe.close(); props.setDeleteTarget({ type: "session", id: session.id, label: title }) },
  }
}

/** The phone chat row: one comfortable list cell, avatar leading, name and time
 *  on the strong line, chat title on the quiet one. Swipe reveals the actions the
 *  desktop row already offers — Pin leading, Archive + Delete trailing — and the
 *  always-visible `⋯` keeps every one of them reachable without a gesture. */
export const MobileSessionRow = React.memo(function MobileSessionRow(props: MobileSessionRowProps) {
  const { session } = props
  const title = cleanPreview(props.fixTitle(session.title, session.employee)) || "Untitled"
  const isActive = session.id === props.selectedId
  const isPinned = props.pinnedSessions.has(session.id)
  const isArchived = isArchivedSession(session)
  const isUnread =
    !props.readSessions.has(session.id) && session.status !== "running" && session.status !== "error"
  const swipe = useSwipeActions({ leading: ACTION_WIDTH, trailing: ACTION_WIDTH * 2 })
  const actions = rowActions(props, swipe, title)

  const openChat = () => {
    props.onSelect(session.id)
    props.onEmployeeSessionsAvailable?.([session])
  }

  return (
    <div data-row="mobile" className="relative overflow-hidden">
      {swipe.offset !== 0 ? (
        <SwipeActionRails side={swipe.offset < 0 ? "trailing" : "leading"} isPinned={isPinned} isArchived={isArchived} {...actions} />
      ) : null}
      <RowSurface swipe={swipe} isActive={isActive}>
        {/* An open row spends its next tap dismissing itself, the way a native
            list cell does — otherwise the only way back is a second swipe. */}
        <button onClick={swipe.openSide ? swipe.close : openChat} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left">
          <RowSummary
            session={session}
            avatarName={props.avatarName}
            displayName={props.displayName}
            title={title}
            strong={isUnread || isActive}
            showPin={isPinned && !props.hidePin}
            isArchived={isArchived}
            readSessions={props.readSessions}
          />
        </button>
        {props.renamingSessionId === session.id ? (
          <RowRenameInput
            title={title}
            cancelledRef={props.renameCancelledRef}
            onCommit={(next) => props.updateSessionTitle(session.id, next)}
            onDone={() => props.setRenamingSessionId(null)}
          />
        ) : null}
        <MobileRowMenu session={session} isPinned={isPinned} isArchived={isArchived} {...actions} />
      </RowSurface>
    </div>
  )
})
