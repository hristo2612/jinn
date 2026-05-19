
import React, { useEffect, useState, useRef, useCallback, useMemo, startTransition } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Clock3, Copy, EllipsisVertical, Pencil, Pin, Plus, Search, Trash2, X } from "lucide-react"
import { api, type Employee, type SessionsResponse } from "@/lib/api"
import { useOrg } from "@/hooks/use-employees"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { useSettings } from "@/routes/settings-provider"
import { cleanPreview } from "@/lib/clean-preview"
import { queryKeys } from "@/lib/query-keys"
import { useSessions, useSessionCounts, useSessionSearch, useUpdateSession, useDeleteSession, useBulkDeleteSessions, useDuplicateSession } from "@/hooks/use-sessions"
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

interface Session {
  id: string
  connector?: string | null
  employee?: string
  title?: string
  status?: string
  source?: string
  sourceRef?: string
  sessionKey?: string
  transportState?: string
  queueDepth?: number
  lastActivity?: string
  createdAt?: string
  [key: string]: unknown
}

export interface SidebarOrder {
  sessionIds: string[]
  employeeNames: string[]
  employeeSessionMap: Record<string, string[]>
}

interface ChatSidebarProps {
  selectedId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete?: (id: string) => void
  onDuplicate?: (newSessionId: string) => void
  onSessionsLoaded?: (sessions: Session[]) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  onOrderComputed?: (order: SidebarOrder) => void
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

// Server-side group sentinels — must match CRON_GROUP/DIRECT_GROUP in the
// backend registry (sessions are bounded per group; "load more" fetches the rest).
const DIRECT_GROUP = "__direct__"
const CRON_GROUP = "__cron__"

const COLLAPSE_STORAGE_KEY = "jinn-sidebar-collapsed"
const EXPANDED_STORAGE_KEY = "jinn-sidebar-expanded"
const PINNED_STORAGE_KEY = "jinn-pinned-sessions"

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

function titleCase(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

function isCronSession(session: Session): boolean {
  return session.source === "cron" || (session.sourceRef || "").startsWith("cron:")
}

function isDirectSession(session: Session, portalSlug: string): boolean {
  return !isCronSession(session) && (!session.employee || session.employee === portalSlug)
}

// Sources the sidebar renders (others, e.g. slack/telegram, are shown elsewhere).
function isVisibleSource(s: Session): boolean {
  return s.source === "web" || s.source === "cron" || s.source === "whatsapp" || s.source === "discord" || !s.source
}

function getSessionActivity(session: Session): string {
  return session.lastActivity || session.createdAt || ""
}

function sortSessionsByActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => getSessionActivity(b).localeCompare(getSessionActivity(a)))
}

function getStatusDotColor(session: Session, readSet: Set<string>): string {
  if (session.status === "running") return "var(--system-blue)"
  if (session.status === "error") return "var(--system-red)"
  if (readSet.has(session.id)) return "var(--text-quaternary)"
  return "var(--system-green)"
}

function StatusDot({
  color,
  pulse = false,
  className,
}: {
  color: string
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      className={cn("shrink-0 rounded-full", className)}
      style={{
        background: color,
        animation: pulse ? "sidebar-pulse 2s ease-in-out infinite" : "none",
        boxShadow: pulse ? `0 0 8px ${color}` : "none",
      }}
    />
  )
}

function SectionLabel({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode
  label: string
  count?: number
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className="text-xs">{icon}</span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {typeof count === "number" && (
        <span className="ml-auto rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
          {count}
        </span>
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
  setDeleteTarget,
  setRenamingSessionId,
  updateSessionTitle,
}: SessionRowProps) {
  const sessionIsActive = session.id === selectedId
  const sessionDotColor = getStatusDotColor(session, readSessions)
  const sessionIsRunning = session.status === "running"
  const sessionTitle = fixTitle(session.title, session.employee)
  const displayTitle = cleanPreview(sessionTitle) || sessionTitle
  const sessionTime = formatTime(getSessionActivity(session))
  const isPinned = pinnedSessions.has(session.id)
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
              ? "border-l-[var(--accent)] bg-[var(--fill-secondary)]"
              : "border-l-transparent hover:bg-accent"
          )}
        >
          <StatusDot color={sessionDotColor} pulse={sessionIsRunning} className="size-1.5" />
          {isRenaming ? (
            <input
              autoFocus
              maxLength={200}
              defaultValue={displayTitle}
              className={cn(
                "min-w-0 flex-1 truncate border-none bg-transparent text-xs outline-none ring-1 ring-[var(--accent)] rounded px-0.5",
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
          {isPinned ? (
            <Pin className="size-3 shrink-0 text-[var(--accent)] group-hover/session:lg:hidden group-has-[[data-state=open]]/session:lg:hidden" />
          ) : null}
          <span className="shrink-0 text-[10px] text-[var(--text-quaternary)] group-hover/session:lg:hidden group-has-[[data-state=open]]/session:lg:hidden">{sessionTime}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                className="hidden shrink-0 text-muted-foreground transition-colors hover:text-foreground group-hover/session:lg:block group-has-[[data-state=open]]/session:lg:block"
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
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => setDeleteTarget({ type: "session", id: session.id, label: cleanPreview(sessionTitle) || "Untitled" })}>
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
}: EmployeeRowProps) {
  const empName = item.employeeName!
  const empSessions = item.sessions!
  const latestSession = empSessions[0]
  const empInfo = item.employeeData
  const displayName = empInfo?.displayName || titleCase(empName)
  const department = empInfo?.department || ""
  const timeLabel = formatTime(getSessionActivity(latestSession))
  const dotColor = getStatusDotColor(latestSession, readSessions)
  const pulse = latestSession.status === "running"
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
                ? "border-l-[var(--accent)] bg-[var(--fill-secondary)]"
                : "border-l-transparent hover:bg-accent"
            )}
          >
            <div className="relative flex size-9 shrink-0 items-center justify-center">
              <EmployeeAvatar name={empName} size={36} />
              <StatusDot
                color={dotColor}
                pulse={pulse}
                className="absolute -bottom-0.5 -right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-baseline gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13px] tracking-[-0.2px] text-foreground",
                    hasUnread || isActive ? "font-semibold" : "font-medium"
                  )}
                >
                  {displayName}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--text-tertiary)] group-hover/emp:lg:hidden group-has-[[data-state=open]]/emp:lg:hidden">{timeLabel}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className="hidden shrink-0 text-muted-foreground transition-colors hover:text-foreground group-hover/emp:lg:block group-has-[[data-state=open]]/emp:lg:block"
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
                {sessionCount > 1 ? (
                  <span className="shrink-0 rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px]">
                    {sessionCount} chats
                  </span>
                ) : null}
                {isPinned ? (
                  <Pin className="size-3 shrink-0 text-[var(--accent)]" />
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
  onDuplicate,
  onSessionsLoaded,
  onEmployeeSessionsAvailable,
  onOrderComputed,
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
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const renameCancelledRef = useRef(false)
  const [readSessions, setReadSessions] = useState<Set<string>>(new Set())
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
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
    // Compute next session to select before removing
    let nextSelectId: string | null = null
    if (selectedId === sessionId) {
      // Build a flat ordered list of all visible session IDs
      const allVisible: string[] = []
      const addGroup = (items: FlatItem[]) => {
        for (const item of items) {
          const empName = item.employeeName!
          const empSessions = item.sessions || []
          // Always add the latest session (employee row click selects it)
          if (empSessions.length === 1) {
            allVisible.push(empSessions[0].id)
          } else if (expanded[empName]) {
            for (const s of empSessions) allVisible.push(s.id)
          } else {
            // Collapsed — only the latest session is reachable
            if (empSessions.length > 0) allVisible.push(empSessions[0].id)
          }
        }
      }
      addGroup(pinnedFlat)
      addGroup(unpinnedFlat)
      for (const s of sortedCron) allVisible.push(s.id)

      const idx = allVisible.indexOf(sessionId)
      if (idx !== -1) {
        // Prefer next item, then previous
        if (idx + 1 < allVisible.length) nextSelectId = allVisible[idx + 1]
        else if (idx - 1 >= 0) nextSelectId = allVisible[idx - 1]
      }
    }

    try {
      await deleteSessionMutation.mutateAsync(sessionId)
      setPinnedSessions((prev) => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        savePinnedSessions(next)
        return next
      })
      startTransition(() => {
        if (nextSelectId) {
          onSelect(nextSelectId)
        } else if (onDelete) {
          onDelete(sessionId)
        } else if (selectedId === sessionId) {
          onNewChat()
        }
      })
    } catch {}
  }

  const { pinnedFlat, unpinnedFlat, sortedCron, cronSessions, cronTotal } = useMemo(() => {
    // When searching, use server results (spans all sessions); "load more" is
    // disabled in this mode since totals reflect the search, not each group.
    const searching = search.trim().length > 0
    const displayed = searching
      ? ((searchResults as Session[] | undefined) ?? []).filter(isVisibleSource)
      : sessions

    const cronSessions: Session[] = []
    const directSessions: Session[] = []
    const employeeSessionMap = new Map<string, Session[]>()

    for (const s of displayed) {
      if (isCronSession(s)) cronSessions.push(s)
      else if (isDirectSession(s, portalSlug)) directSessions.push(s)
      else {
        const emp = s.employee!
        if (!employeeSessionMap.has(emp)) employeeSessionMap.set(emp, [])
        employeeSessionMap.get(emp)!.push(s)
      }
    }

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
        total: searching ? sorted.length : (counts[empName] ?? sorted.length),
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
        total: searching ? sorted.length : (counts[DIRECT_GROUP] ?? sorted.length),
      })
    }

    const pinnedFlat = flatItems
      .filter((item) => pinnedSessions.has(item.pinKey))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    const unpinnedFlat = flatItems
      .filter((item) => !pinnedSessions.has(item.pinKey))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))

    const sortedCron = sortSessionsByActivity(cronSessions)
    const cronTotal = searching ? cronSessions.length : (counts[CRON_GROUP] ?? cronSessions.length)

    return { pinnedFlat, unpinnedFlat, sortedCron, cronSessions, cronTotal }
  }, [sessions, search, searchResults, employeeData, portalSlug, portalName, pinnedSessions, counts])

  const cronCollapsed = collapsed.has("cron")

  // Emit flat session order for keyboard navigation (J/K/E shortcuts)
  const orderRef = useRef<string>('')
  const allFlatIds = useMemo(() => {
    const ids: string[] = []
    const empNames: string[] = []
    const empMap: Record<string, string[]> = {}
    for (const item of [...pinnedFlat, ...unpinnedFlat]) {
      const name = item.employeeName!
      empNames.push(name)
      const sessionIds = item.sessions!.map(s => s.id)
      empMap[name] = sessionIds
      ids.push(...sessionIds)
    }
    for (const s of sortedCron) ids.push(s.id)
    return { sessionIds: ids, employeeNames: empNames, employeeSessionMap: empMap }
  }, [pinnedFlat, unpinnedFlat, sortedCron])

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
    setDeleteTarget,
    setRenamingSessionId,
    updateSessionTitle,
  }), [selectedId, readSessions, pinnedSessions, renamingSessionId, fixTitleCb, onSelect, onEmployeeSessionsAvailable, togglePin, handleDuplicateCb, updateSessionTitle])

  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Build flat list of items for virtualization: employee rows + cron header + cron sessions
  // Each element carries enough info to render either an EmployeeRow or a SessionRow (for cron)
  type VirtualItem =
    | { kind: "employee"; item: FlatItem }
    | { kind: "cron-header" }
    | { kind: "cron-session"; session: Session }
    | { kind: "cron-more" }

  const virtualItems = useMemo<VirtualItem[]>(() => {
    const list: VirtualItem[] = []
    for (const item of pinnedFlat) list.push({ kind: "employee", item })
    for (const item of unpinnedFlat) list.push({ kind: "employee", item })
    if (cronSessions.length > 0) {
      list.push({ kind: "cron-header" })
      if (!cronCollapsed) {
        for (const s of sortedCron) list.push({ kind: "cron-session", session: s })
        if (cronSessions.length < cronTotal) list.push({ kind: "cron-more" })
      }
    }
    return list
  }, [pinnedFlat, unpinnedFlat, cronSessions.length, cronCollapsed, sortedCron, cronTotal])

  const VIRTUALIZE_THRESHOLD = 50
  const shouldVirtualize = virtualItems.length >= VIRTUALIZE_THRESHOLD

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? virtualItems.length : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      if (!shouldVirtualize) return 36
      const vi = virtualItems[index]
      if (vi.kind === "cron-header") return 36
      if (vi.kind === "cron-session") return 36
      // employee row
      return 64
    },
    overscan: 5,
    enabled: shouldVirtualize,
  })

  return (
    <div className="flex h-full flex-col border-r border-border bg-[var(--sidebar-bg)]">
      <div className="shrink-0 border-b border-border bg-[var(--material-thick)] px-4 pb-3 pt-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold tracking-[-0.03em] text-foreground">Chats</h2>
            <p className="text-xs text-muted-foreground">All conversations</p>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" className="gap-1.5" onClick={onNewChat} title="New chat (N)">
              <Plus className="size-3.5" />
              New
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-2">
          <Search className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
          <input
            id="chat-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            aria-label="Search chats"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-[var(--text-tertiary)]"
          />
          {search.trim() ? (
            <button
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="rounded-full p-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
            Loading sessions...
          </div>
        ) : pinnedFlat.length === 0 && unpinnedFlat.length === 0 && cronSessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
            {search.trim() ? "No matching chats" : "No conversations yet"}
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
                  {vi.kind === "employee" ? (
                    <EmployeeRow
                      key={vi.item.pinKey}
                      item={vi.item}
                      expanded={expanded}
                      handleEmployeeClick={handleEmployeeClick}
                      handleMarkAllRead={handleMarkAllRead}
                      onLoadMore={handleLoadMore}
                      loadingMore={loadingMore}
                      {...sharedRowProps}
                    />
                  ) : vi.kind === "cron-header" ? (
                    <div className={cn("mt-2", pinnedFlat.length === 0 && unpinnedFlat.length === 0 && "mt-0")}>
                      <button
                        onClick={toggleCronCollapsed}
                        className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-accent"
                      >
                        <Clock3 className="size-3.5 text-muted-foreground" />
                        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                          Scheduled
                        </span>
                        <span className="ml-auto rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                          {cronTotal}
                        </span>
                        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", cronCollapsed && "-rotate-90")} />
                      </button>
                    </div>
                  ) : vi.kind === "cron-session" ? (
                    <SessionRow key={vi.session.id} session={vi.session} {...sharedRowProps} />
                  ) : vi.kind === "cron-more" ? (
                    <button
                      onClick={() => handleLoadMore(CRON_GROUP, cronSessions.length)}
                      disabled={loadingMore.has(CRON_GROUP)}
                      className="w-full cursor-pointer px-4 pb-2 pl-11 text-left text-[10px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50"
                    >
                      {loadingMore.has(CRON_GROUP) ? "Loading…" : `+${cronTotal - cronSessions.length} more`}
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <>
            {pinnedFlat.map((item) => (
              <EmployeeRow
                key={item.pinKey}
                item={item}
                expanded={expanded}
                handleEmployeeClick={handleEmployeeClick}
                handleMarkAllRead={handleMarkAllRead}
                onLoadMore={handleLoadMore}
                loadingMore={loadingMore}
                {...sharedRowProps}
              />
            ))}
            {unpinnedFlat.map((item) => (
              <EmployeeRow
                key={item.pinKey}
                item={item}
                expanded={expanded}
                handleEmployeeClick={handleEmployeeClick}
                handleMarkAllRead={handleMarkAllRead}
                onLoadMore={handleLoadMore}
                loadingMore={loadingMore}
                {...sharedRowProps}
              />
            ))}

            {cronSessions.length > 0 ? (
              <div className={cn("mt-2", pinnedFlat.length === 0 && unpinnedFlat.length === 0 && "mt-0")}>
                <button
                  onClick={toggleCronCollapsed}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-accent"
                >
                  <Clock3 className="size-3.5 text-muted-foreground" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Scheduled
                  </span>
                  <span className="ml-auto rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                    {cronTotal}
                  </span>
                  <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", cronCollapsed && "-rotate-90")} />
                </button>
                {!cronCollapsed ? sortedCron.map((session) => (
                  <SessionRow key={session.id} session={session} {...sharedRowProps} />
                )) : null}
                {!cronCollapsed && cronSessions.length < cronTotal ? (
                  <button
                    onClick={() => handleLoadMore(CRON_GROUP, cronSessions.length)}
                    disabled={loadingMore.has(CRON_GROUP)}
                    className="w-full cursor-pointer px-4 pb-2 pl-11 text-left text-[10px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50"
                  >
                    {loadingMore.has(CRON_GROUP) ? "Loading…" : `+${cronTotal - cronSessions.length} more`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
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
