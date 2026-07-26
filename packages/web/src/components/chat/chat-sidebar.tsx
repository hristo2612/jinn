
import React, { useEffect, useState, useRef, useCallback, useMemo, startTransition } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { ChevronDown, Clock3, Copy, EllipsisVertical, Focus, Layers, Pencil, Pin, Plus, Search, SquarePen, Trash2, X } from "lucide-react"
import { api, type BackgroundActivity, type DelegatedActivity, type Employee, type SessionsResponse } from "@/lib/api"
import { useOrg } from "@/hooks/use-employees"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { useSettings } from "@/routes/settings-provider"
import { cleanPreview } from "@/lib/clean-preview"
import { queryKeys } from "@/lib/query-keys"
import { useSessions, useSessionCounts, useSessionSearch, useUpdateSession, useDeleteSession, useBulkDeleteSessions, useDuplicateSession, useArchiveSession, useUnarchiveSession } from "@/hooks/use-sessions"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { mergeSidebarEmployees, bucketByDay, summarizeOlder, isFocusedSession } from "@/components/chat/chat-route-helpers"

interface Session {
  id: string
  connector?: string | null
  employee?: string
  title?: string
  status?: string
  source?: string
  sourceRef?: string
  sessionKey?: string
  /** Set on delegated/spawned child sessions; null/empty for top-level chats. */
  parentSessionId?: string | null
  transportState?: string
  queueDepth?: number
  lastActivity?: string
  createdAt?: string
  archivedAt?: string | null
  /** Background work (subagents/background tasks) still running while the
   *  session is officially idle. null/absent = none. Kept live via the
   *  session:background WS event (cache patch in useQueryInvalidation). */
  backgroundActivity?: BackgroundActivity | null
  /** Active descendant employee sessions; derived by the gateway. */
  delegatedActivity?: DelegatedActivity | null
  /** The in-flight turn has produced nothing for a while; derived by the gateway.
   *  A running session and a wedged one are otherwise indistinguishable. */
  turnStall?: { lastProgressAt: number; awaitingSubmit: boolean } | null
  [key: string]: unknown
}

export interface SidebarOrder {
  sessionIds: string[]
  employeeNames: string[]
  employeeSessionMap: Record<string, string[]>
}

interface ChatSidebarProps {
  selectedId: string | null
  /** Select a session. System-initiated selections (e.g. the post-delete
   *  neighbour fallback) pass `replace` so they collapse into the current
   *  history entry instead of pushing a new one. */
  onSelect: (id: string, opts?: { replace?: boolean; navigateMobile?: boolean }) => void
  onNewChat: () => void
  onDelete?: (id: string) => void
  onArchive?: (id: string) => void
  onUnarchive?: (id: string) => void
  onDuplicate?: (newSessionId: string) => void
  onSessionsLoaded?: (sessions: Session[]) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  onOrderComputed?: (order: SidebarOrder) => void
  /** Start a new chat with a session-less roster employee (contactable list). */
  onContactEmployee?: (name: string) => void
}

interface FlatItem {
  type: "employee" | "direct"
  employeeName?: string
  employeeData?: Employee
  sessions?: Session[]
  session?: Session
  sortKey: string
  pinKey: string
  /** Server group key for "load more" (employee slug, or a sentinel). */
  groupKey?: string
  /** True total in this group (may exceed loaded `sessions.length`). */
  total?: number
}

// One flat session row (Today / Yesterday / search results), carrying the
// resolved employee identity so the row can render without re-deriving it.
interface FlatRow {
  session: Session
  avatarName: string
  displayName: string
}

// Server-side group sentinels — must match CRON_GROUP/DIRECT_GROUP in the
// backend registry (sessions are bounded per group; "load more" fetches the rest).
const DIRECT_GROUP = "__direct__"
const CRON_GROUP = "__cron__"
const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000
// A red error dot is only worth surfacing while the failure is fresh; older
// errored sessions fall back to the normal idle/unread treatment so the list
// isn't littered with stale red dots.
const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000

const COLLAPSE_STORAGE_KEY = "jinn-sidebar-collapsed"
const EXPANDED_STORAGE_KEY = "jinn-sidebar-expanded"
const PINNED_STORAGE_KEY = "jinn-pinned-sessions"
const OLDER_EXPANDED_STORAGE_KEY = "jinn-sidebar-older-expanded"
const FOCUS_MODE_STORAGE_KEY = "jinn-sidebar-focus-mode"

type FocusMode = "focused" | "all"

/** An archived search result is intentionally selectable so its transcript can
 * be reviewed and restored, despite being absent from default browse lists. */
export function isArchivedSession(session: Pick<Session, "archivedAt"> | { archivedAt?: unknown }): boolean {
  return typeof session.archivedAt === "string" && session.archivedAt.length > 0
}

const formatTimeCache = new Map<string, string>()
const FORMAT_TIME_CACHE_MAX = 200

function formatTime(dateStr?: string): string {
  if (!dateStr) return ""
  const cached = formatTimeCache.get(dateStr)
  if (cached !== undefined) return cached
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  let result: string
  if (diff < 60_000) result = "now"
  else if (diff < 3_600_000) result = `${Math.floor(diff / 60_000)}m`
  else if (diff < 86_400_000) {
    result = new Date(dateStr).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  } else if (diff < 172_800_000) result = "yesterday"
  else result = new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  if (formatTimeCache.size >= FORMAT_TIME_CACHE_MAX) {
    const oldest = formatTimeCache.keys().next().value
    if (oldest !== undefined) formatTimeCache.delete(oldest)
  }
  formatTimeCache.set(dateStr, result)
  return result
}

function getReadSessions(): Set<string> {
  try {
    const raw = localStorage.getItem("jinn-read-sessions")
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function markSessionRead(id: string) {
  const read = getReadSessions()
  read.add(id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem("jinn-read-sessions", JSON.stringify(arr))
}

function markAllReadForEmployee(sessions: Session[]) {
  const read = getReadSessions()
  for (const s of sessions) read.add(s.id)
  const arr = Array.from(read)
  if (arr.length > 500) arr.splice(0, arr.length - 500)
  localStorage.setItem("jinn-read-sessions", JSON.stringify(arr))
}

function getPinnedSessions(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function savePinnedSessions(pinned: Set<string>) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(pinned)))
  } catch {}
}

function loadCollapsedState(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsedState(collapsed: Set<string>) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(collapsed)))
  } catch {}
}

function loadExpandedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveExpandedState(expanded: Record<string, boolean>) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expanded))
  } catch {}
}

function titleCase(slug: string | null | undefined): string {
  if (!slug) return ""
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

/** Resolve the avatar slug + human label for a flat session row. Direct/COO
 *  sessions borrow the portal identity; cron/employee-less sessions fall back to
 *  it too — they have no org employee, so search (which flattens cron rows that
 *  the grouped view renders separately) must not `.split()` a null employee.
 *  The rest use their employee's org profile. */
export function resolveRowIdentity(
  s: Pick<Session, "source" | "sourceRef" | "employee">,
  opts: { portalSlug: string; portalName: string; employeeData: Map<string, Employee> },
): { avatarName: string; displayName: string } {
  const { portalSlug, portalName, employeeData } = opts
  if (isDirectSession(s, portalSlug) || !s.employee) {
    return { avatarName: portalSlug, displayName: portalName }
  }
  const emp = s.employee
  return { avatarName: emp, displayName: employeeData.get(emp)?.displayName || titleCase(emp) }
}

function isCronSession(session: Pick<Session, "source" | "sourceRef">): boolean {
  return session.source === "cron" || (session.sourceRef || "").startsWith("cron:")
}

/** Pinned chats float to a dedicated Pinned section at the top of the list,
 *  regardless of recency bucket or focus mode (a pin is explicit intent).
 *  Cron sessions are exempt: Scheduled paginates by loaded-count offsets, so
 *  pulling a row out of that group would corrupt its "+N more" math — a pinned
 *  cron session keeps its in-place pin glyph instead. */
export function shouldFloatPinned(
  s: Pick<Session, "id" | "source" | "sourceRef">,
  pinned: Set<string>,
): boolean {
  return !isCronSession(s) && pinned.has(s.id)
}

export function isDirectSession(
  session: Pick<Session, "source" | "sourceRef" | "employee">,
  portalSlug?: string,
): boolean {
  if (isCronSession(session)) return false
  if (!session.employee) return true
  // A session tagged with the portal slug is a direct/COO session, not a
  // pseudo-employee — fold it into the direct group rather than a phantom one
  // that renders with the portal's own title.
  return !!portalSlug && session.employee.toLowerCase() === portalSlug
}

// Sources the sidebar renders (others, e.g. slack/telegram, are shown elsewhere).
export function isVisibleSource(s: Pick<Session, "source">): boolean {
  return s.source === "web" || s.source === "cron" || s.source === "workflow" || s.source === "whatsapp" || s.source === "discord" || !s.source
}

export function workflowRunPath(sourceRef: string | undefined): string | null {
  if (!sourceRef) return null
  const parts = sourceRef.split(":")
  if (
    parts.length !== 5 ||
    parts[0] !== "workflow" ||
    parts.slice(1).some((part) => part.length === 0) ||
    !/^\d+$/.test(parts[4]!)
  ) return null
  return `/workflow/${encodeURIComponent(parts[1]!)}/runs/${encodeURIComponent(parts[2]!)}`
}

export function WorkflowSessionChip({
  session,
}: {
  session: Pick<Session, "source" | "sourceRef">
}) {
  if (session.source !== "workflow") return null
  const path = workflowRunPath(session.sourceRef)
  const className = "shrink-0 rounded-full bg-[color-mix(in_srgb,var(--system-indigo)_12%,transparent)] px-1.5 py-0.5 text-[9px] font-[var(--weight-semibold)] text-[var(--system-indigo)]"
  if (!path) return <span className={className}>Workflow</span>
  return (
    <Link
      to={path}
      onClick={(event) => event.stopPropagation()}
      className={`${className} hover:bg-[color-mix(in_srgb,var(--system-indigo)_20%,transparent)]`}
      title="Open workflow run"
    >
      Workflow
    </Link>
  )
}

function getSessionActivity(session: Session): string {
  return session.lastActivity || session.createdAt || ""
}

function sortSessionsByActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => getSessionActivity(b).localeCompare(getSessionActivity(a)))
}

/** Idle-but-busy: the session's turn ended but subagents/background tasks are
 *  still making API calls. Running/error status always wins over this. */
export function hasBackgroundActivity(session: Pick<Session, "status" | "backgroundActivity" | "delegatedActivity">): boolean {
  const activity = session.backgroundActivity
  const lastActivityAt = activity?.lastActivityAt ? new Date(activity.lastActivityAt).getTime() : 0
  const stale = lastActivityAt > 0 && Date.now() - lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS
  const runtimeActive = (
    session.status !== "running" &&
    session.status !== "error" &&
    !stale &&
    (activity?.activeStreams ?? 0) > 0
  )
  const delegatedActive =
    session.status !== "running" &&
    session.status !== "error" &&
    (session.delegatedActivity?.activeSessions ?? 0) > 0
  return runtimeActive || delegatedActive
}

interface StatusDotState {
  color: string
  label: string
  pulse: boolean
}

/** A red error dot fires only for a *recently* errored session — `status` is
 *  "error" AND its last activity is inside the recency window. `nowMs` is passed
 *  in (rather than read at module load) so the window is evaluated at call time
 *  and the helper stays pure/testable. A missing or unparseable timestamp is
 *  treated as not-recent so the row falls through to the quiet treatment. */
/**
 * The session to fall back to after deleting the ACTIVE session: its
 * neighbour in the visible order — the next row, else the previous, else
 * null (list empty / deleted row not visible). Pure so the post-delete
 * replace semantics are unit-testable.
 */
export function pickNeighborSessionId(visibleIds: string[], deletedId: string): string | null {
  const idx = visibleIds.indexOf(deletedId)
  if (idx === -1) return null
  if (idx + 1 < visibleIds.length) return visibleIds[idx + 1]
  if (idx - 1 >= 0) return visibleIds[idx - 1]
  return null
}

/**
 * The single post-delete fallback decision: the visible-order neighbour when
 * the deleted session is in the flat visible order, else the most recent
 * OTHER session (a session inside a collapsed Older group is not in the
 * visible order — real installs hit this constantly), else null (composer —
 * nothing left to select).
 */
export function pickDeleteFallbackId(
  visibleIds: string[],
  allIdsByRecency: string[],
  deletedId: string,
): string | null {
  const neighbor = pickNeighborSessionId(visibleIds, deletedId)
  if (neighbor) return neighbor
  return allIdsByRecency.find((id) => id !== deletedId) ?? null
}

export function isRecentError(
  status: string | undefined,
  lastActivityISO: string,
  nowMs: number,
): boolean {
  if (status !== "error") return false
  if (!lastActivityISO) return false
  const ts = new Date(lastActivityISO).getTime()
  if (Number.isNaN(ts)) return false
  return nowMs - ts < RECENT_ERROR_WINDOW_MS
}

/** Read the gateway-derived stall state off a session, tolerating older payloads
 *  (a gateway that predates the field simply never reports a stall).
 *
 *  The server sends `lastProgressAt` — an instant — and the age is derived here
 *  at render time. A server-computed duration would freeze at the last refetch,
 *  so the label would sit at "no output for 2m" while an hour passed. */
export function getTurnStall(
  session: Session,
  now: number = Date.now(),
): { stalledForMs: number; awaitingSubmit: boolean } | null {
  const stall = session.turnStall
  const at = stall?.lastProgressAt
  if (!stall || typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null
  const stalledForMs = now - at
  if (stalledForMs <= 0) return null
  return { stalledForMs, awaitingSubmit: !!stall.awaitingSubmit }
}

/** Coarse elapsed label — "2m", "51m", "1h 4m". Deliberately low-precision: the
 *  operator needs to know it has been too long, not the exact second. */
export function formatStallAge(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return "under a minute"
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

// Resolve the attention-state dot for a session. Returns null for the resting
// "read" state so no dot is painted (quiet at rest). Optionally treat the row
// as unread even when this session is read (e.g. a grouped employee row whose
// other chats are unread).
export function getStatusDot(
  session: Session,
  readSet: Set<string>,
  forceUnread = false,
): StatusDotState | null {
  if (session.status === "running") {
    // A stalled turn must not look like a working one. Same blue-dot spinner for
    // both is exactly why a 51-minute hang can sit unnoticed: amber + an elapsed
    // count is the difference between "thinking" and "go look at this".
    const stall = getTurnStall(session)
    if (stall) {
      return {
        color: "var(--system-orange)",
        label: stall.awaitingSubmit
          ? `prompt not accepted by the engine (stuck ${formatStallAge(stall.stalledForMs)})`
          : `no output for ${formatStallAge(stall.stalledForMs)}`,
        pulse: false, // a still dot reads as stuck; pulsing reads as working
      }
    }
    return { color: "var(--system-blue)", label: "running", pulse: true }
  }
  if (isRecentError(session.status, getSessionActivity(session), Date.now())) {
    return { color: "var(--system-red)", label: "error", pulse: false }
  }
  if (hasBackgroundActivity(session)) return { color: "var(--system-orange)", label: "background work running", pulse: true }
  // Unread uses a NEUTRAL dot (not --accent): accent is user-set and may be red,
  // which would read like an error. Calm grey stays visible without alarming.
  if (forceUnread || !readSet.has(session.id)) return { color: "var(--text-secondary)", label: "unread", pulse: false }
  return null
}

/** Row-level "this needs a look" chips.
 *
 *  Both facts here were previously unobservable: a wedged session rendered exactly
 *  like a working one indefinitely, and the queue piling up behind it was not shown
 *  at all — so the only way to find a stuck employee was to go looking for one. */
function SessionAttentionChips({ session }: { session: Session }) {
  const stall = session.status === "running" ? getTurnStall(session) : null
  const queued = typeof session.queueDepth === "number" ? session.queueDepth : 0
  if (!stall && queued <= 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {stall ? (
        <span
          title={
            stall.awaitingSubmit
              ? "The engine never accepted this prompt. Open the CLI view to resend it, or interrupt the session."
              : `The turn is still in flight but has produced no output for ${formatStallAge(stall.stalledForMs)}.`
          }
          style={{ background: "color-mix(in srgb, var(--system-orange) 14%, transparent)" }}
          className="shrink-0 rounded-sm px-1 text-[10px] font-medium tabular-nums text-[var(--system-orange)]"
        >
          {stall.awaitingSubmit ? "not accepted" : `stalled ${formatStallAge(stall.stalledForMs)}`}
        </span>
      ) : null}
      {queued > 0 ? (
        <span
          title={`${queued} queued message${queued === 1 ? "" : "s"} waiting on this session`}
          className="shrink-0 rounded-sm bg-[var(--fill-secondary)] px-1 text-[10px] font-medium tabular-nums text-[var(--text-secondary)]"
        >
          {queued} queued
        </span>
      ) : null}
    </span>
  )
}

function StatusDot({
  color,
  pulse = false,
  className,
  title,
}: {
  color: string
  pulse?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      className={cn("shrink-0 rounded-full", className)}
      title={title}
      role={title ? "img" : undefined}
      aria-label={title}
      style={{
        background: color,
        animation: pulse ? "sidebar-pulse 2s ease-in-out infinite" : "none",
        boxShadow: pulse ? `0 0 8px ${color}` : "none",
      }}
    />
  )
}

// One quiet, unified treatment for every sidebar section header
// (Today/Yesterday, Older, Scheduled, Team): muted medium label with light
// tracking and the count as a plain trailing number — no shouty uppercase, no
// filled chip. Keep these constants the single source so the headers can't drift.
const SECTION_LABEL_CLASS =
  "text-[11px] font-[var(--weight-medium)] tracking-[0.06em] text-[var(--text-tertiary)]"
const SECTION_COUNT_CLASS = "text-[10px] tabular-nums text-[var(--text-quaternary)]"

function SectionLabel({
  label,
  count,
}: {
  label: string
  count?: number
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className={SECTION_LABEL_CLASS}>{label}</span>
      {typeof count === "number" && (
        <span className={cn("ml-auto", SECTION_COUNT_CLASS)}>{count}</span>
      )}
    </div>
  )
}

interface SessionRowProps {
  session: Session
  parentSessions?: Session[]
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
  handleArchive: (session: Session) => void
  setDeleteTarget: (target: { type: "session" | "employee"; id: string; label: string; sessions?: Session[] } | null) => void
  setRenamingSessionId: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
}

const SessionRow = React.memo(function SessionRow({
  session,
  parentSessions,
  selectedId,
  readSessions,
  pinnedSessions,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleDuplicate,
  handleArchive,
  setDeleteTarget,
  setRenamingSessionId,
  updateSessionTitle,
}: SessionRowProps) {
  const sessionIsActive = session.id === selectedId
  const sessionDot = getStatusDot(session, readSessions)
  const sessionTitle = fixTitle(session.title, session.employee)
  const displayTitle = cleanPreview(sessionTitle) || sessionTitle
  const sessionTime = formatTime(getSessionActivity(session))
  const isPinned = pinnedSessions.has(session.id)
  const isArchived = isArchivedSession(session)
  const isRenaming = renamingSessionId === session.id
  const RowTag = isRenaming ? "div" : "button"

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <RowTag
          {...(!isRenaming && { onClick: () => {
            onSelect(session.id)
            onEmployeeSessionsAvailable?.(parentSessions ?? [session])
          }})}
          className={cn(
            "group/session relative flex w-full items-center gap-2.5 border-l-2 px-4 py-2 text-left transition-colors",
            parentSessions
              ? "pl-11"
              : "pl-6",
            sessionIsActive
              ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
              : "border-l-transparent hover:bg-[var(--fill-tertiary)]"
          )}
        >
          {sessionDot ? (
            <StatusDot
              color={sessionDot.color}
              pulse={sessionDot.pulse}
              title={sessionDot.label}
              className="size-1.5"
            />
          ) : null}
          {isRenaming ? (
            <input
              autoFocus
              maxLength={200}
              defaultValue={displayTitle}
              className={cn(
                "min-w-0 flex-1 truncate border-none bg-transparent text-xs outline-none ring-1 ring-[var(--text-quaternary)] rounded px-0.5",
                sessionIsActive ? "font-semibold text-foreground" : "text-[var(--text-secondary)]"
              )}
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur()
                } else if (e.key === "Escape") {
                  renameCancelledRef.current = true
                  setRenamingSessionId(null)
                }
              }}
              onBlur={(e) => {
                if (renameCancelledRef.current) {
                  renameCancelledRef.current = false
                  return
                }
                const val = e.target.value.trim()
                if (val && val !== displayTitle) {
                  updateSessionTitle(session.id, val)
                }
                setRenamingSessionId(null)
              }}
            />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                sessionIsActive ? "font-semibold text-foreground" : "text-[var(--text-secondary)]"
              )}
            >
              {cleanPreview(sessionTitle) || "Untitled"}
            </span>
          )}
          <WorkflowSessionChip session={session} />
          {isPinned ? (
            <Pin className="size-3 shrink-0 text-[var(--text-tertiary)] group-hover/session:lg:hidden group-has-[[data-state=open]]/session:lg:hidden" />
          ) : null}
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-quaternary)] group-hover/session:lg:hidden group-has-[[data-state=open]]/session:lg:hidden">{sessionTime}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                aria-label="Session actions"
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:size-7 lg:hidden group-hover/session:lg:flex group-has-[[data-state=open]]/session:lg:flex"
              >
                <EllipsisVertical className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => togglePin(session.id)}>
                {isPinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleDuplicate(session.id)}>
                Duplicate...
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleArchive(session)}>
                {isArchived ? "Unarchive chat" : "Archive chat"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "session", id: session.id, label: cleanPreview(sessionTitle) || "Untitled" })}>
                Delete session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </RowTag>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}>
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={() => togglePin(session.id)}>
          {isPinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleDuplicate(session.id)}>
          Duplicate...
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleArchive(session)}>
          {isArchived ? "Unarchive chat" : "Archive chat"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "session", id: session.id, label: cleanPreview(sessionTitle) || "Untitled" })}>
          <span className="flex-1">Delete session</span>
          <kbd className="ml-auto pl-3 font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

interface FlatSessionRowProps {
  session: Session
  /** Avatar/identity slug — employee name, or the portal slug for direct chats. */
  avatarName: string
  /** Human label shown on line 1 (employee display name or portal name). */
  displayName: string
  /** Rows inside the Pinned section drop the per-row pin glyph — the section
   *  header already carries that signal. */
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
  handleArchive: (session: Session) => void
  setDeleteTarget: (target: { type: "session" | "employee"; id: string; label: string; sessions?: Session[] } | null) => void
  setRenamingSessionId: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
}

// One CHAT per row (focused Today/Yesterday view): employee avatar + name + time
// on the first line, the chat title on the second. Distinct from SessionRow
// (single-line, used for cron + the Older drawer's per-employee children).
const FlatSessionRow = React.memo(function FlatSessionRow({
  session,
  avatarName,
  displayName,
  hidePin,
  selectedId,
  readSessions,
  pinnedSessions,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleDuplicate,
  handleArchive,
  setDeleteTarget,
  setRenamingSessionId,
  updateSessionTitle,
}: FlatSessionRowProps) {
  const isActive = session.id === selectedId
  const dot = getStatusDot(session, readSessions)
  const rawTitle = fixTitle(session.title, session.employee)
  const displayTitle = cleanPreview(rawTitle) || "Untitled"
  const time = formatTime(getSessionActivity(session))
  const isPinned = pinnedSessions.has(session.id)
  const isArchived = isArchivedSession(session)
  const isRenaming = renamingSessionId === session.id
  const isUnread =
    !readSessions.has(session.id) && session.status !== "running" && session.status !== "error"

  const menuItems = (
    <>
      <DropdownMenuItem onClick={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}>
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => togglePin(session.id)}>
        {isPinned ? "Unpin" : "Pin"}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handleDuplicate(session.id)}>
        Duplicate...
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => handleArchive(session)}>
        {isArchived ? "Unarchive chat" : "Archive chat"}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "session", id: session.id, label: displayTitle })}>
        Delete session
      </DropdownMenuItem>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group/flat relative flex w-full items-center gap-3 border-l-2 px-4 py-2 text-left transition-colors",
            isActive
              ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
              : "border-l-transparent hover:bg-[var(--fill-tertiary)]"
          )}
        >
          <button
            onClick={() => {
              onSelect(session.id)
              onEmployeeSessionsAvailable?.([session])
            }}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <div className="relative flex size-9 shrink-0 items-center justify-center">
              <EmployeeAvatar name={avatarName} size={36} />
              {dot ? (
                <StatusDot
                  color={dot.color}
                  pulse={dot.pulse}
                  title={dot.label}
                  className="absolute -bottom-0.5 -right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
                />
              ) : null}
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-baseline gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13px] tracking-[-0.2px] text-foreground",
                    isUnread || isActive ? "font-semibold" : "font-medium"
                  )}
                >
                  {displayName}
                </span>
                {isArchived ? (
                  <span className="shrink-0 text-[10px] font-medium text-[var(--text-tertiary)]">Archived</span>
                ) : null}
                <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-quaternary)] group-hover/flat:lg:hidden group-has-[[data-state=open]]/flat:lg:hidden">{time}</span>
              </div>
              {isRenaming ? (
                <input
                  autoFocus
                  maxLength={200}
                  defaultValue={displayTitle}
                  className="min-w-0 w-full truncate rounded border-none bg-transparent px-0.5 text-[11px] text-[var(--text-secondary)] outline-none ring-1 ring-[var(--text-quaternary)]"
                  onFocus={(e) => e.target.select()}
                  onClick={(e) => { e.stopPropagation(); e.preventDefault() }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur()
                    else if (e.key === "Escape") { renameCancelledRef.current = true; setRenamingSessionId(null) }
                  }}
                  onBlur={(e) => {
                    if (renameCancelledRef.current) { renameCancelledRef.current = false; return }
                    const val = e.target.value.trim()
                    if (val && val !== displayTitle) updateSessionTitle(session.id, val)
                    setRenamingSessionId(null)
                  }}
                />
              ) : (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-[11px] text-[var(--text-tertiary)]">{displayTitle}</span>
                  <SessionAttentionChips session={session} />
                </div>
              )}
            </div>
          </button>

          <WorkflowSessionChip session={session} />
          {isPinned && !hidePin ? (
            <Pin className="size-3 shrink-0 text-[var(--text-tertiary)] group-hover/flat:lg:hidden group-has-[[data-state=open]]/flat:lg:hidden" />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                aria-label="Chat actions"
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:size-7 lg:hidden group-hover/flat:lg:flex group-has-[[data-state=open]]/flat:lg:flex"
              >
                <EllipsisVertical className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}>
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={() => togglePin(session.id)}>
          {isPinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleDuplicate(session.id)}>
          Duplicate...
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleArchive(session)}>
          {isArchived ? "Unarchive chat" : "Archive chat"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "session", id: session.id, label: displayTitle })}>
          <span className="flex-1">Delete session</span>
          <kbd className="ml-auto pl-3 font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

interface EmployeeRowProps {
  item: FlatItem
  selectedId: string | null
  readSessions: Set<string>
  pinnedSessions: Set<string>
  expanded: Record<string, boolean>
  renamingSessionId: string | null
  renameCancelledRef: React.MutableRefObject<boolean>
  fixTitle: (title: string | undefined, employee: string | undefined) => string
  onSelect: (id: string) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  togglePin: (pinKey: string) => void
  handleMarkAllRead: (sessions: Session[]) => void
  handleEmployeeClick: (item: FlatItem) => void
  setDeleteTarget: (target: { type: "session" | "employee"; id: string; label: string; sessions?: Session[] } | null) => void
  onLoadMore: (groupKey: string, offset: number) => void
  loadingMore: Set<string>
  setRenamingSessionId: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
  handleDuplicate: (sessionId: string) => void
  handleArchive: (session: Session) => void
}

const EmployeeRow = React.memo(function EmployeeRow({
  item,
  selectedId,
  readSessions,
  pinnedSessions,
  expanded,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleMarkAllRead,
  handleEmployeeClick,
  setDeleteTarget,
  onLoadMore,
  loadingMore,
  setRenamingSessionId,
  updateSessionTitle,
  handleDuplicate,
  handleArchive,
}: EmployeeRowProps) {
  const empName = item.employeeName!
  const empSessions = item.sessions!
  const latestSession = empSessions[0]
  const empInfo = item.employeeData
  const displayName = empInfo?.displayName || titleCase(empName)
  const department = empInfo?.department || ""
  const timeLabel = formatTime(getSessionActivity(latestSession))
  const isActive = empSessions.some((s) => s.id === selectedId)
  const isPinned = pinnedSessions.has(item.pinKey)
  const loadedCount = empSessions.length
  // True total from the server; may exceed what's loaded so far.
  const sessionCount = item.total ?? loadedCount
  const groupKey = item.groupKey ?? empName
  const isLoadingMore = loadingMore.has(groupKey)
  const isExpanded = expanded[empName] || false
  const hasUnread = empSessions.some(
    (s) => !readSessions.has(s.id) && s.status !== "running" && s.status !== "error"
  )
  // The group dot reflects the latest session's live state, but escalates to an
  // "unread" accent dot when any chat in the group is unread.
  const empDot = getStatusDot(latestSession, readSessions, hasUnread)

  const sessionRowProps = {
    selectedId,
    readSessions,
    pinnedSessions,
    renamingSessionId,
    renameCancelledRef,
    fixTitle,
    onSelect,
    onEmployeeSessionsAvailable,
    togglePin,
    handleDuplicate,
    handleArchive,
    setDeleteTarget,
    setRenamingSessionId,
    updateSessionTitle,
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={() => handleEmployeeClick(item)}
            className={cn(
              "group/emp relative flex w-full items-center gap-3 border-l-2 px-4 py-3 text-left transition-colors",
              isActive
                ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
                : "border-l-transparent hover:bg-[var(--fill-tertiary)]"
            )}
          >
            <div className="relative flex size-9 shrink-0 items-center justify-center">
              <EmployeeAvatar name={empName} size={36} />
              {empDot ? (
                <StatusDot
                  color={empDot.color}
                  pulse={empDot.pulse}
                  title={empDot.label}
                  className="absolute -bottom-0.5 -right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
                />
              ) : null}
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-baseline gap-2 pr-9 lg:pr-0">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13px] tracking-[-0.2px] text-foreground",
                    hasUnread || isActive ? "font-semibold" : "font-medium"
                  )}
                >
                  {displayName}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-quaternary)] group-hover/emp:lg:hidden group-has-[[data-state=open]]/emp:lg:hidden">{timeLabel}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Employee chat actions"
                      className="absolute right-1 top-1/2 flex size-9 shrink-0 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:static lg:size-7 lg:translate-y-0 lg:hidden group-hover/emp:lg:flex group-has-[[data-state=open]]/emp:lg:flex"
                    >
                      <EllipsisVertical className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => togglePin(item.pinKey)}>
                      {isPinned ? "Unpin" : "Pin"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleMarkAllRead(empSessions)}>
                      Mark all as read
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "employee", id: empName, label: displayName, sessions: empSessions })}>
                      Delete all chats
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex items-center gap-1.5 overflow-hidden text-[11px] text-[var(--text-tertiary)]">
                {department ? <span className="truncate">{department}</span> : null}
                {department && sessionCount > 1 ? (
                  <span aria-hidden className="shrink-0 text-[var(--text-quaternary)]">·</span>
                ) : null}
                {sessionCount > 1 ? (
                  <span className="shrink-0 tabular-nums text-[var(--text-quaternary)]">
                    {sessionCount} chats
                  </span>
                ) : null}
                <WorkflowSessionChip session={latestSession} />
                {isPinned ? (
                  <Pin className="size-3 shrink-0 text-[var(--text-tertiary)]" />
                ) : null}
              </div>
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => togglePin(item.pinKey)}>
            {isPinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleMarkAllRead(empSessions)}>
            Mark all as read
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "employee", id: empName, label: displayName, sessions: empSessions })}>
            Delete all chats
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isExpanded && loadedCount > 1 ? (
        empSessions.map((session) => (
          <SessionRow key={session.id} session={session} parentSessions={empSessions} {...sessionRowProps} />
        ))
      ) : null}
      {isExpanded && loadedCount < sessionCount ? (
        <button
          onClick={() => onLoadMore(groupKey, loadedCount)}
          disabled={isLoadingMore}
          className="w-full cursor-pointer px-4 pb-2 pl-11 text-left text-[10px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50"
        >
          {isLoadingMore ? "Loading…" : `+${sessionCount - loadedCount} more`}
        </button>
      ) : null}
    </div>
  )
})

export function ChatSidebar({
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
  onArchive,
  onUnarchive,
  onDuplicate,
  onSessionsLoaded,
  onEmployeeSessionsAvailable,
  onOrderComputed,
  onContactEmployee,
}: ChatSidebarProps) {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? "Jinn"
  const portalSlug = portalName.toLowerCase()

  const qc = useQueryClient()
  const { data: rawSessions, isLoading: loading } = useSessions()
  const { data: meta } = useSessionCounts()
  const counts = meta?.counts ?? {}
  const updateSessionMutation = useUpdateSession()
  const deleteSessionMutation = useDeleteSession()
  const archiveSessionMutation = useArchiveSession()
  const unarchiveSessionMutation = useUnarchiveSession()
  const bulkDeleteMutation = useBulkDeleteSessions()
  const duplicateSessionMutation = useDuplicateSession()

  const sessions = useMemo(() => {
    if (!rawSessions) return []
    const filtered = (rawSessions as Session[]).filter(isVisibleSource)
    filtered.sort((a, b) => {
      const ta = a.lastActivity || a.createdAt || ""
      const tb = b.lastActivity || b.createdAt || ""
      return tb.localeCompare(ta)
    })
    return filtered
  }, [rawSessions])

  const [search, setSearch] = useState("")
  // Search spans ALL sessions server-side (the loaded page is only a subset).
  const { data: searchResults } = useSessionSearch(search)
  // The slim control row morphs between the Focused/All segmented control and an
  // inline search field; `searchOpen` drives that reveal. Collapsing always
  // clears the query so a hidden field can never leave the list silently filtered.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearch("")
  }, [])
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const renameCancelledRef = useRef(false)
  const [readSessions, setReadSessions] = useState<Set<string>>(new Set())
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [olderExpanded, setOlderExpanded] = useState(false)
  const [focusMode, setFocusMode] = useState<FocusMode>("all")
  const [loadingMore, setLoadingMore] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "session" | "employee"
    id: string
    label: string
    sessions?: Session[]
  } | null>(null)
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const { data: orgData } = useOrg()
  const employeeData = useMemo(() => {
    const map = new Map<string, Employee>()
    for (const emp of orgData?.employees ?? []) {
      map.set(emp.name, emp)
    }
    return map
  }, [orgData])
  const onSessionsLoadedRef = useRef(onSessionsLoaded)

  useEffect(() => {
    onSessionsLoadedRef.current = onSessionsLoaded
  }, [onSessionsLoaded])

  useEffect(() => {
    if (sessions.length > 0) {
      startTransition(() => {
        onSessionsLoadedRef.current?.(sessions)
      })
    }
  }, [sessions])

  useEffect(() => {
    setReadSessions(getReadSessions())
    setPinnedSessions(getPinnedSessions())
    setCollapsed(loadCollapsedState())
    setExpanded(loadExpandedState())
    try {
      setOlderExpanded(localStorage.getItem(OLDER_EXPANDED_STORAGE_KEY) === "true")
      const stored = localStorage.getItem(FOCUS_MODE_STORAGE_KEY)
      if (stored === "focused" || stored === "all") setFocusMode(stored)
    } catch {}
  }, [])

  useEffect(() => {
    if (selectedId) {
      markSessionRead(selectedId)
      setReadSessions((prev) => {
        const next = new Set(prev)
        next.add(selectedId)
        return next
      })
    }
  }, [selectedId])


  // Focus the inline search field once it has morphed open.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const selectFocusMode = useCallback((mode: FocusMode) => {
    setFocusMode(mode)
    try { localStorage.setItem(FOCUS_MODE_STORAGE_KEY, mode) } catch {}
  }, [])

  const toggleOlderExpanded = useCallback(() => {
    setOlderExpanded((prev) => {
      const next = !prev
      try { localStorage.setItem(OLDER_EXPANDED_STORAGE_KEY, String(next)) } catch {}
      return next
    })
  }, [])

  const toggleCronCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has("cron")) next.delete("cron")
      else next.add("cron")
      saveCollapsedState(next)
      return next
    })
  }, [])

  // Fetch the next page for one group and merge it into the cached session list.
  const handleLoadMore = useCallback(async (groupKey: string, offset: number) => {
    if (loadingMore.has(groupKey)) return
    setLoadingMore((prev) => new Set(prev).add(groupKey))
    try {
      const more = await api.getSessionsForGroup(groupKey, offset, 50)
      qc.setQueryData<SessionsResponse>(queryKeys.sessions.all, (old) => {
        if (!old) return old
        const seen = new Set(old.sessions.map((s) => s.id as string))
        const merged = [...old.sessions, ...more.filter((s) => !seen.has(s.id as string))]
        return { ...old, sessions: merged }
      })
    } catch {
      /* surfaced by the disabled state resetting; non-fatal */
    } finally {
      setLoadingMore((prev) => {
        const next = new Set(prev)
        next.delete(groupKey)
        return next
      })
    }
  }, [qc, loadingMore])

  const toggleEmployeeExpanded = useCallback((empName: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [empName]: !prev[empName] }
      saveExpandedState(next)
      return next
    })
  }, [])

  const togglePin = useCallback((pinKey: string) => {
    setPinnedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(pinKey)) next.delete(pinKey)
      else next.add(pinKey)
      savePinnedSessions(next)
      return next
    })
  }, [])

  const handleMarkAllRead = useCallback((empSessions: Session[]) => {
    markAllReadForEmployee(empSessions)
    setReadSessions((prev) => {
      const next = new Set(prev)
      for (const s of empSessions) next.add(s.id)
      return next
    })
  }, [])

  async function handleDeleteEmployee(empName: string, empSessions: Session[]) {
    const ids = empSessions.map((s) => s.id)
    try {
      await bulkDeleteMutation.mutateAsync(ids)
      setPinnedSessions((prev) => {
        const next = new Set(prev)
        next.delete(`emp:${empName}`)
        for (const id of ids) next.delete(id)
        savePinnedSessions(next)
        return next
      })
      startTransition(() => {
        if (selectedId && ids.includes(selectedId)) onNewChat()
      })
    } catch {}
  }

  async function handleDelete(sessionId: string) {
    setPinnedSessions((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      savePinnedSessions(next)
      return next
    })
    // The page-level routine owns delete resolution end-to-end (mutation,
    // tab close, ONE atomic history REPLACE to the fallback session) so all
    // entry points — this row menu, the page ⋯ menu, Backspace — navigate
    // identically. No selection writes from here.
    if (onDelete) {
      onDelete(sessionId)
      return
    }
    // Embedders without onDelete: previous minimal behavior.
    try {
      await deleteSessionMutation.mutateAsync(sessionId)
      startTransition(() => {
        if (selectedId === sessionId) onNewChat()
      })
    } catch {}
  }

  async function handleArchive(session: Session) {
    try {
      if (isArchivedSession(session)) {
        if (onUnarchive) {
          onUnarchive(session.id)
          return
        }
        await unarchiveSessionMutation.mutateAsync(session.id)
        return
      }
      if (onArchive) {
        onArchive(session.id)
        return
      }
      await archiveSessionMutation.mutateAsync(session.id)
      setPinnedSessions((prev) => {
        if (!prev.has(session.id)) return prev
        const next = new Set(prev)
        next.delete(session.id)
        savePinnedSessions(next)
        return next
      })
      if (selectedId === session.id) onNewChat()
    } catch {}
  }

  const {
    searching,
    searchRows,
    pinnedRows,
    todayRows,
    yesterdayRows,
    olderSummary,
    olderFocusedRows,
    hiddenAutomated,
    olderPinned,
    olderUnpinned,
    pinnedFlat,
    unpinnedFlat,
    sortedCron,
    cronSessions,
    cronTotal,
  } = useMemo(() => {
    // When searching, use server results (spans all sessions); "load more" is
    // disabled in this mode since totals reflect the search, not each group.
    const searching = search.trim().length > 0
    const displayed = searching
      ? ((searchResults as Session[] | undefined) ?? []).filter(isVisibleSource)
      : sessions

    // Resolve the avatar slug + human label for a flat row (see resolveRowIdentity).
    const toRow = (s: Session): FlatRow => ({
      session: s,
      ...resolveRowIdentity(s, { portalSlug, portalName, employeeData }),
    })

    // ---- Search mode: one flat list spanning everything matched. ----
    if (searching) {
      const searchRows = sortSessionsByActivity(displayed).map(toRow)
      return {
        searching,
        searchRows,
        pinnedRows: [] as FlatRow[],
        todayRows: [] as FlatRow[],
        yesterdayRows: [] as FlatRow[],
        olderSummary: { chats: 0, employees: 0 },
        olderFocusedRows: [] as FlatRow[],
        hiddenAutomated: 0,
        olderPinned: [] as FlatItem[],
        olderUnpinned: [] as FlatItem[],
        pinnedFlat: [] as FlatItem[],
        unpinnedFlat: [] as FlatItem[],
        sortedCron: [] as Session[],
        cronSessions: [] as Session[],
        cronTotal: 0,
      }
    }

    // ---- Default mode: recency buckets + per-employee Older drawer. ----
    // In "focused" mode the Today/Yesterday/Older buckets only contain the
    // operator's own top-level chats (isFocusedSession); delegated children and
    // other automated sessions are hidden until "All" is selected. The
    // per-employee groups (drawer in All mode + keyboard cycling + contactable
    // roster) are always built from every non-cron session so they stay stable.
    const focused = focusMode === "focused"
    const now = new Date()
    const cronSessions: Session[] = []
    const directSessions: Session[] = []
    const employeeSessionMap = new Map<string, Session[]>()
    const pinnedRows: FlatRow[] = []
    const todayRows: FlatRow[] = []
    const yesterdayRows: FlatRow[] = []
    // Focused-mode Older = older user-initiated chats, as flat rows (computed
    // from loaded sessions; the deep tail beyond the per-group window is reachable
    // via search). All-mode Older uses the authoritative `counts` instead.
    const olderFocusedRows: FlatRow[] = []
    let hiddenAutomated = 0
    // today+yesterday sessions surfaced per group — drives the All-mode Older math.
    const recentByGroup: Record<string, number> = {}

    for (const s of displayed) {
      if (isCronSession(s)) {
        cronSessions.push(s)
        continue
      }
      const isDirect = isDirectSession(s, portalSlug)
      const groupKey = isDirect ? DIRECT_GROUP : s.employee!
      if (isDirect) directSessions.push(s)
      else {
        if (!employeeSessionMap.has(groupKey)) employeeSessionMap.set(groupKey, [])
        employeeSessionMap.get(groupKey)!.push(s)
      }
      // Pinned chats float to the Pinned section at the top, regardless of
      // bucket or focus mode. They still feed the employee groups above (the
      // Older drawer keeps full history; overlap is de-duped in allFlatIds) and
      // count as "surfaced" so the Older summary doesn't re-count them.
      if (shouldFloatPinned(s, pinnedSessions)) {
        pinnedRows.push(toRow(s))
        recentByGroup[groupKey] = (recentByGroup[groupKey] ?? 0) + 1
        continue
      }
      // Focused filter gates only the recency buckets, not the employee groups.
      if (focused && !isFocusedSession(s)) {
        hiddenAutomated += 1
        continue
      }
      const bucket = bucketByDay(getSessionActivity(s), now)
      if (bucket === "today") {
        todayRows.push(toRow(s))
        recentByGroup[groupKey] = (recentByGroup[groupKey] ?? 0) + 1
      } else if (bucket === "yesterday") {
        yesterdayRows.push(toRow(s))
        recentByGroup[groupKey] = (recentByGroup[groupKey] ?? 0) + 1
      } else if (focused) {
        olderFocusedRows.push(toRow(s))
      }
    }

    pinnedRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))
    todayRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))
    yesterdayRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))
    olderFocusedRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))

    // Per-employee groups (full history) — used by the Older drawer + keyboard nav.
    const flatItems: FlatItem[] = []
    for (const [empName, empSessions] of employeeSessionMap) {
      const sorted = sortSessionsByActivity(empSessions)
      flatItems.push({
        type: "employee",
        employeeName: empName,
        employeeData: employeeData.get(empName),
        sessions: sorted,
        sortKey: getSessionActivity(sorted[0]),
        pinKey: `emp:${empName}`,
        groupKey: empName,
        total: counts[empName] ?? sorted.length,
      })
    }
    if (directSessions.length > 0) {
      const sorted = sortSessionsByActivity(directSessions)
      flatItems.push({
        type: "employee",
        employeeName: portalSlug,
        employeeData: {
          name: portalSlug,
          displayName: portalName,
          emoji: "\u{1F4AC}",
          department: "direct",
          role: "",
          rank: "manager",
          engine: "",
          model: "",
          persona: "",
        } as Employee,
        sessions: sorted,
        sortKey: getSessionActivity(sorted[0]),
        pinKey: `emp:${portalSlug}`,
        groupKey: DIRECT_GROUP,
        total: counts[DIRECT_GROUP] ?? sorted.length,
      })
    }

    const pinnedFlat = flatItems
      .filter((item) => pinnedSessions.has(item.pinKey))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    const unpinnedFlat = flatItems
      .filter((item) => !pinnedSessions.has(item.pinKey))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))

    // Older drawer = only groups that actually have sessions beyond yesterday.
    const hasOlder = (item: FlatItem) =>
      (item.total ?? item.sessions!.length) - (recentByGroup[item.groupKey ?? item.employeeName!] ?? 0) > 0
    const olderPinned = pinnedFlat.filter(hasOlder)
    const olderUnpinned = unpinnedFlat.filter(hasOlder)

    // Older summary. Focused: count the loaded older user-initiated chats +
    // their distinct employees (direct/COO excluded from the employee tally).
    // All: authoritative — every non-cron group total minus what's already shown
    // in Today/Yesterday.
    let olderSummary: { chats: number; employees: number }
    if (focused) {
      const emps = new Set<string>()
      for (const r of olderFocusedRows) {
        if (!isDirectSession(r.session, portalSlug) && r.session.employee) emps.add(r.session.employee)
      }
      olderSummary = { chats: olderFocusedRows.length, employees: emps.size }
    } else {
      const nonCronTotals: Record<string, number> = {}
      for (const [k, v] of Object.entries(counts)) {
        if (k !== CRON_GROUP) nonCronTotals[k] = v
      }
      olderSummary = summarizeOlder(nonCronTotals, recentByGroup, new Set([DIRECT_GROUP]))
    }

    const sortedCron = sortSessionsByActivity(cronSessions)
    const cronTotal = counts[CRON_GROUP] ?? cronSessions.length

    return {
      searching,
      searchRows: [] as FlatRow[],
      pinnedRows,
      todayRows,
      yesterdayRows,
      olderSummary,
      olderFocusedRows,
      hiddenAutomated,
      olderPinned,
      olderUnpinned,
      pinnedFlat,
      unpinnedFlat,
      sortedCron,
      cronSessions,
      cronTotal,
    }
  }, [sessions, search, searchResults, employeeData, portalSlug, portalName, pinnedSessions, counts, focusMode])

  const cronCollapsed = collapsed.has("cron")

  // Contactable employees: the full org roster MERGED with the employees that
  // already have sessions, then sliced down to the roster-only tail (employees
  // with ZERO sessions). These are listed so they can be contacted directly.
  // Hidden while searching (search spans real sessions, not the roster) and the
  // COO/portal row is excluded (reachable via "New chat").
  const contactableEmployees = useMemo(() => {
    if (search.trim()) return []
    const sessionful = [...pinnedFlat, ...unpinnedFlat]
      .map((item) => item.employeeName)
      .filter((n): n is string => !!n)
    const sessionfulSet = new Set(sessionful)
    const rosterNames = (orgData?.employees ?? []).map((e) => e.name)
    const merged = mergeSidebarEmployees(sessionful, rosterNames)
    return merged
      .filter((name) => !sessionfulSet.has(name) && name !== portalSlug)
      .map((name) => employeeData.get(name))
      .filter((e): e is Employee => !!e)
  }, [search, pinnedFlat, unpinnedFlat, orgData, employeeData, portalSlug])

  // Emit flat session order for keyboard navigation (J/K/E shortcuts).
  // Visual order: Today → Yesterday → (Older drawer, if open) → Scheduled.
  // De-duped — an employee's older sessions can overlap their Today/Yesterday rows.
  const orderRef = useRef<string>('')
  const allFlatIds = useMemo(() => {
    const ids: string[] = []
    const seen = new Set<string>()
    const push = (id: string) => { if (!seen.has(id)) { seen.add(id); ids.push(id) } }

    if (searching) {
      for (const r of searchRows) push(r.session.id)
      return { sessionIds: ids, employeeNames: [] as string[], employeeSessionMap: {} as Record<string, string[]> }
    }

    for (const r of pinnedRows) push(r.session.id)
    for (const r of todayRows) push(r.session.id)
    for (const r of yesterdayRows) push(r.session.id)
    if (olderExpanded) {
      if (focusMode === "focused") {
        for (const r of olderFocusedRows) push(r.session.id)
      } else {
        for (const item of [...olderPinned, ...olderUnpinned]) {
          const sessionIds = item.sessions!.map((s) => s.id)
          // Collapsed employee row reaches only its latest session; expanded reaches all.
          if (expanded[item.employeeName!]) sessionIds.forEach(push)
          else if (sessionIds.length) push(sessionIds[0])
        }
      }
    }
    for (const s of sortedCron) push(s.id)

    // E-shortcut cycles every employee with sessions, regardless of Older state.
    const empNames: string[] = []
    const empMap: Record<string, string[]> = {}
    for (const item of [...pinnedFlat, ...unpinnedFlat]) {
      const name = item.employeeName!
      empNames.push(name)
      empMap[name] = item.sessions!.map((s) => s.id)
    }
    return { sessionIds: ids, employeeNames: empNames, employeeSessionMap: empMap }
  }, [searching, searchRows, pinnedRows, todayRows, yesterdayRows, olderExpanded, focusMode, olderFocusedRows, olderPinned, olderUnpinned, expanded, sortedCron, pinnedFlat, unpinnedFlat])

  useEffect(() => {
    const key = allFlatIds.sessionIds.join(',')
    if (key !== orderRef.current) {
      orderRef.current = key
      onOrderComputed?.(allFlatIds)
    }
  }, [allFlatIds, onOrderComputed])

  const handleEmployeeClick = useCallback((item: FlatItem) => {
    const empName = item.employeeName!
    const empSessions = item.sessions!
    if (empSessions.length > 1) {
      // Toggle expand/collapse — selecting latest session when expanding
      const wasExpanded = expanded[empName] || false
      toggleEmployeeExpanded(empName)
      if (!wasExpanded) {
        onSelect(empSessions[0].id)
        onEmployeeSessionsAvailable?.(empSessions)
      }
    } else {
      onSelect(empSessions[0].id)
      onEmployeeSessionsAvailable?.(empSessions)
    }
  }, [expanded, toggleEmployeeExpanded, onSelect, onEmployeeSessionsAvailable])

  const fixTitleCb = useCallback((title: string | undefined, employee: string | undefined) => {
    if (!title) return employee || portalName
    if (portalName !== "Jinn" && title.startsWith("Jinn - ")) {
      return portalName + title.slice(4)
    }
    return title
  }, [portalName])

  const updateSessionTitle = useCallback((id: string, title: string) => {
    updateSessionMutation.mutate({ id, data: { title } })
  }, [updateSessionMutation])

  const handleDuplicateCb = useCallback(async (sessionId: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(sessionId) as { id?: string }
      if (result?.id) {
        onDuplicate?.(result.id)
        onSelect(result.id)
        setRenamingSessionId(result.id)
        renameCancelledRef.current = false
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || "Unknown error"}`)
    }
  }, [duplicateSessionMutation, onDuplicate, onSelect])

  // Shared props passed to all SessionRow and EmployeeRow instances
  const sharedRowProps = useMemo(() => ({
    selectedId,
    readSessions,
    pinnedSessions,
    renamingSessionId,
    renameCancelledRef,
    fixTitle: fixTitleCb,
    onSelect,
    onEmployeeSessionsAvailable,
    togglePin,
    handleDuplicate: handleDuplicateCb,
    handleArchive,
    setDeleteTarget,
    setRenamingSessionId,
    updateSessionTitle,
  }), [selectedId, readSessions, pinnedSessions, renamingSessionId, fixTitleCb, onSelect, onEmployeeSessionsAvailable, togglePin, handleDuplicateCb, updateSessionTitle])

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Apple nav-bar pattern: the control band carries NO line at rest, and a
  // single --separator hairline appears under it only once rows scroll beneath.
  const [listScrolled, setListScrolled] = useState(false)
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const next = e.currentTarget.scrollTop > 2
    setListScrolled((prev) => (prev === next ? prev : next))
  }, [])

  // Build one flat list for the (optional) virtualizer. The focused layout is a
  // sequence of section labels, flat session rows (Today/Yesterday/search), the
  // collapsible Older summary + its per-employee drawer, and the cron section.
  type VirtualItem =
    | { kind: "section"; id: string; label: string; count?: number }
    | { kind: "flat"; row: FlatRow; hidePin?: boolean }
    | { kind: "older-line" }
    | { kind: "older-header" }
    | { kind: "employee"; item: FlatItem }
    | { kind: "cron-header" }
    | { kind: "cron-session"; session: Session }
    | { kind: "cron-more" }

  const virtualItems = useMemo<VirtualItem[]>(() => {
    const list: VirtualItem[] = []
    if (searching) {
      for (const row of searchRows) list.push({ kind: "flat", row })
      return list
    }
    if (pinnedRows.length > 0) {
      // The section header carries the "pinned" signal, so rows inside it
      // drop their per-row pin glyph (hidePin) — one signal, not two.
      list.push({ kind: "section", id: "pinned", label: "Pinned", count: pinnedRows.length })
      for (const row of pinnedRows) list.push({ kind: "flat", row, hidePin: true })
    }
    if (todayRows.length > 0) {
      list.push({ kind: "section", id: "today", label: "Today", count: todayRows.length })
      for (const row of todayRows) list.push({ kind: "flat", row })
    }
    if (yesterdayRows.length > 0) {
      list.push({ kind: "section", id: "yesterday", label: "Yesterday", count: yesterdayRows.length })
      for (const row of yesterdayRows) list.push({ kind: "flat", row })
    }
    if (olderSummary.chats > 0) {
      if (!olderExpanded) {
        list.push({ kind: "older-line" })
      } else if (focusMode === "focused") {
        // Focused Older = flat older user-initiated chats (no per-employee drawer).
        list.push({ kind: "older-header" })
        for (const row of olderFocusedRows) list.push({ kind: "flat", row })
      } else {
        list.push({ kind: "older-header" })
        for (const item of olderPinned) list.push({ kind: "employee", item })
        for (const item of olderUnpinned) list.push({ kind: "employee", item })
      }
    }
    if (cronSessions.length > 0) {
      list.push({ kind: "cron-header" })
      if (!cronCollapsed) {
        for (const s of sortedCron) list.push({ kind: "cron-session", session: s })
        if (cronSessions.length < cronTotal) list.push({ kind: "cron-more" })
      }
    }
    return list
  }, [searching, searchRows, pinnedRows, todayRows, yesterdayRows, olderSummary.chats, olderExpanded, focusMode, olderFocusedRows, olderPinned, olderUnpinned, cronSessions.length, cronCollapsed, sortedCron, cronTotal])

  const VIRTUALIZE_THRESHOLD = 50
  const shouldVirtualize = virtualItems.length >= VIRTUALIZE_THRESHOLD

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? virtualItems.length : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      if (!shouldVirtualize) return 52
      const vi = virtualItems[index]
      switch (vi.kind) {
        case "section": return 32
        case "older-header": return 36
        case "older-line": return 40
        case "cron-header": return 36
        case "cron-session": return 36
        case "cron-more": return 28
        case "flat": return 52
        default: return 64 // employee row (dynamic — measured)
      }
    },
    overscan: 5,
    enabled: shouldVirtualize,
  })

  const olderLineLabel = useMemo(() => {
    const { chats, employees } = olderSummary
    const chatWord = chats === 1 ? "chat" : "chats"
    if (employees <= 0) return `Older · ${chats} ${chatWord}`
    const empWord = employees === 1 ? "employee" : "employees"
    return `Older · ${chats} ${chatWord} across ${employees} ${empWord}`
  }, [olderSummary])

  const cronHeader = (
    <button
      onClick={toggleCronCollapsed}
      className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-[var(--fill-tertiary)]"
    >
      <span className={SECTION_LABEL_CLASS}>Scheduled</span>
      <span className={cn("ml-auto", SECTION_COUNT_CLASS)}>{cronTotal}</span>
      <ChevronDown className={cn("size-3.5 shrink-0 text-[var(--text-quaternary)] transition-transform", cronCollapsed && "-rotate-90")} />
    </button>
  )

  // Single source of truth for rendering a VirtualItem — shared by the
  // virtualized and plain render paths so they can never drift apart.
  const renderItem = (vi: VirtualItem): React.ReactNode => {
    switch (vi.kind) {
      case "section":
        return (
          <div className="flex items-center gap-2 px-4 pb-1 pt-3">
            <span className={SECTION_LABEL_CLASS}>{vi.label}</span>
            {typeof vi.count === "number" && (
              <span className={SECTION_COUNT_CLASS}>{vi.count}</span>
            )}
          </div>
        )
      case "flat":
        return (
          <FlatSessionRow
            session={vi.row.session}
            avatarName={vi.row.avatarName}
            displayName={vi.row.displayName}
            hidePin={vi.hidePin}
            {...sharedRowProps}
          />
        )
      case "older-line":
        return (
          <button
            onClick={toggleOlderExpanded}
            className="mt-1 flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
          >
            <Clock3 className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{olderLineLabel}</span>
            <ChevronDown className="size-3.5 shrink-0 -rotate-90" />
          </button>
        )
      case "older-header":
        return (
          <button
            onClick={toggleOlderExpanded}
            className="mt-1 flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-[var(--fill-tertiary)]"
          >
            <span className={SECTION_LABEL_CLASS}>Older</span>
            <span className={cn("ml-auto", SECTION_COUNT_CLASS)}>{olderSummary.chats}</span>
            <ChevronDown className="size-3.5 shrink-0 text-[var(--text-quaternary)]" />
          </button>
        )
      case "employee":
        return (
          <EmployeeRow
            item={vi.item}
            expanded={expanded}
            handleEmployeeClick={handleEmployeeClick}
            handleMarkAllRead={handleMarkAllRead}
            onLoadMore={handleLoadMore}
            loadingMore={loadingMore}
            {...sharedRowProps}
          />
        )
      case "cron-header":
        return <div className={cn(virtualItems[0]?.kind === "cron-header" && "mt-0")}>{cronHeader}</div>
      case "cron-session":
        return <SessionRow session={vi.session} {...sharedRowProps} />
      case "cron-more":
        return (
          <button
            onClick={() => handleLoadMore(CRON_GROUP, cronSessions.length)}
            disabled={loadingMore.has(CRON_GROUP)}
            className="w-full cursor-pointer px-4 pb-2 pl-11 text-left text-[10px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50"
          >
            {loadingMore.has(CRON_GROUP) ? "Loading…" : `+${cronTotal - cronSessions.length} more`}
          </button>
        )
      default:
        return null
    }
  }

  return (
    <div className="relative z-10 flex h-full flex-col bg-[var(--sidebar-bg)] shadow-[var(--shadow-card)]">
      {/* One slim control row. At rest it shows the Focused/All segmented
          control (left) + a borderless search icon (right); tapping search
          morphs the whole row into an inline search field. The page title and
          "+ New" affordance now live in the header pill, so neither lives here.
          Separation is fills only — no hairlines at rest. */}
      {/* Control band — part of the List surface (--sidebar-bg), not the
          Thread. A scroll-activated separator (below) is the only line; at rest
          it's borderless. */}
      <div
        className={cn(
          "shrink-0 bg-[var(--sidebar-bg)] px-3 py-2 transition-shadow duration-150",
          listScrolled && "shadow-[0_1px_0_0_var(--separator)]",
        )}
      >
        <div className="relative flex h-9 items-center">
          {/* Resting controls — fade/disable while the search field is open. */}
          <div
            className={cn(
              "flex w-full items-center gap-2 transition-opacity duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
              searchOpen ? "pointer-events-none opacity-0" : "opacity-100",
            )}
            aria-hidden={searchOpen}
          >
            {/* Focused (default) shows only the operator's own top-level chats;
                All reveals delegated/automated sessions too. Persisted; search
                spans everything regardless. */}
            <div className="flex items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5">
              {([
                { mode: "focused", Icon: Focus, aria: "Focused", tip: "Only chats you started" },
                { mode: "all", Icon: Layers, aria: "All", tip: "Include automated & delegated sessions" },
              ] as const).map(({ mode, Icon, aria, tip }) => (
                <button
                  key={mode}
                  onClick={() => selectFocusMode(mode)}
                  aria-pressed={focusMode === mode}
                  aria-label={aria}
                  title={tip}
                  className={cn(
                    "flex items-center justify-center rounded-full px-2.5 py-1.5 transition-all",
                    focusMode === mode
                      ? "bg-[var(--bg-secondary)] text-foreground shadow-[var(--shadow-subtle)]"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="size-[15px]" strokeWidth={2} />
                </button>
              ))}
            </div>

            <div className="flex-1" />

            {/* GRS-022 — new-chat (compose) on the mobile chat LIST. Desktop
                reaches compose from the thread header pill / ribbon, but on
                mobile the list view has no header pill, so surface the SAME
                compose action here (top-right, HIG). Mobile only.
                GRS-023b — sits BEFORE search (order swapped per operator). */}
            <button
              onClick={onNewChat}
              title="New chat"
              aria-label="New chat"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground lg:hidden"
            >
              <SquarePen className="size-[18px]" />
            </button>

            <button
              onClick={() => setSearchOpen(true)}
              title="Search chats"
              aria-label="Search chats"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <Search className="size-[18px]" />
            </button>
          </div>

          {/* Inline search field — morphs in from the right (width + opacity). */}
          <div
            className={cn(
              "absolute inset-y-0 right-0 flex items-center gap-2 overflow-hidden rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] transition-[width,opacity] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
              searchOpen ? "w-full px-3 opacity-100" : "w-0 px-0 opacity-0",
            )}
          >
            <Search className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
            <input
              id="chat-search"
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  closeSearch()
                }
              }}
              placeholder="Search chats"
              aria-label="Search chats"
              tabIndex={searchOpen ? 0 : -1}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-[var(--text-tertiary)]"
            />
            <button
              onClick={closeSearch}
              tabIndex={searchOpen ? 0 : -1}
              aria-label="Close search"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* C10: short top scrim so rows dissolve under the header instead of
            clipping at a hard seam (the header border is gone). Theme-aware. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-3"
          style={{ background: "linear-gradient(to bottom, var(--sidebar-bg), transparent)" }}
        />
        <div ref={scrollContainerRef} data-chat-list-scroll onScroll={handleListScroll} className="h-full overflow-y-auto pb-[calc(49px+var(--safe-bottom))] lg:pb-0">
        {loading ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
            Loading chats…
          </div>
        ) : virtualItems.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
            {search.trim() ? (
              "No matching chats"
            ) : focusMode === "focused" && hiddenAutomated > 0 ? (
              <>
                No personal chats here.{" "}
                <button onClick={() => selectFocusMode("all")} className="text-[var(--accent)] hover:underline">
                  View all ({hiddenAutomated} automated)
                </button>
              </>
            ) : (
              "No chats yet"
            )}
          </div>
        ) : shouldVirtualize ? (
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const vi = virtualItems[vr.index]
              return (
                <div
                  key={vr.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={vr.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vr.start}px)` }}
                >
                  {renderItem(vi)}
                </div>
              )
            })}
          </div>
        ) : (
          <>
            {virtualItems.map((vi, i) => (
              <React.Fragment key={
                vi.kind === "flat" ? vi.row.session.id
                : vi.kind === "employee" ? vi.item.pinKey
                : vi.kind === "cron-session" ? vi.session.id
                : vi.kind === "section" ? `section:${vi.id}`
                : `${vi.kind}:${i}`
              }>
                {renderItem(vi)}
              </React.Fragment>
            ))}
          </>
        )}

        {!loading && onContactEmployee && contactableEmployees.length > 0 ? (
          <div className="mt-3 pt-1">
            <SectionLabel label="Team" count={contactableEmployees.length} />
            {contactableEmployees.map((emp) => (
              <button
                key={emp.name}
                onClick={() => onContactEmployee(emp.name)}
                title={`Start a chat with ${emp.displayName || titleCase(emp.name)}`}
                className="group/contact relative flex w-full items-center gap-3 border-l-2 border-l-transparent px-4 py-2.5 text-left transition-colors hover:bg-[var(--fill-tertiary)]"
              >
                <div className="relative flex size-9 shrink-0 items-center justify-center">
                  <EmployeeAvatar name={emp.name} size={36} />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block min-w-0 truncate text-[13px] font-medium tracking-[-0.2px] text-foreground">
                    {emp.displayName || titleCase(emp.name)}
                  </span>
                  {emp.department ? (
                    <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{emp.department}</span>
                  ) : null}
                </div>
                <Plus className="size-3.5 shrink-0 text-[var(--text-quaternary)] transition-colors group-hover/contact:text-[var(--accent)]" />
              </button>
            ))}
          </div>
        ) : null}
        </div>
      </div>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent showCloseButton={false} className="max-w-sm" onOpenAutoFocus={(e) => { e.preventDefault(); deleteButtonRef.current?.focus() }}>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.type === "employee"
                ? `Delete all chats with "${deleteTarget.label}"?`
                : `Delete "${deleteTarget?.label}"?`}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.type === "employee"
                ? `This will permanently delete ${deleteTarget.sessions?.length ?? 0} session(s) and all their messages. This cannot be undone.`
                : "This will permanently delete the session and all its messages. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              ref={deleteButtonRef}
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return
                if (deleteTarget.type === "employee" && deleteTarget.sessions) {
                  handleDeleteEmployee(deleteTarget.id, deleteTarget.sessions)
                } else {
                  handleDelete(deleteTarget.id)
                }
                setDeleteTarget(null)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <style>{`
        @keyframes sidebar-pulse {
          0%,
          100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.55;
            transform: scale(0.85);
          }
        }
      `}</style>
    </div>
  )
}
