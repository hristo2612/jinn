import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useNavigationType, useParams, useSearchParams } from "react-router-dom"
import { ListFilter, Plus } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { PrimaryAction } from "@/components/shell/primary-action"
import { ApiError, type WorkItemCompactWire, type WorkItemStatusWire } from "@/lib/api"
import {
  activeFilterCount,
  compareRank,
  deriveNeedsYou,
  filtersFromSearchParams,
  filtersToSearchParams,
  matchesDueFilter,
  operatorSafeTodoError,
  rankBetween,
  isPositiveTodoVersion,
  type TodoFilters,
} from "@/lib/todos"
import { todoPath } from "@/lib/todo-id"
import { useDepartments } from "@/hooks/use-departments"
import {
  useDecideApproval,
  useEmployeesByName,
  useNeedsAttentionItems,
  useOpenDetails,
  useOrg,
} from "../use-todos"
import { FilterBar } from "../filter-bar"
import { TodoFilterSheet } from "../todo-filter-sheet"
import { NeedsYouView } from "../needs-you-view"
import { NewTodoDialog } from "../new-todo-dialog"
import { QuickCaptureBar } from "../quick-add/capture-bar"
import { BoardHeader } from "./board-header"
import { TodoList } from "../list/todo-list"
import { BoardCard, cardLayoutKey, rollupOf, type CardEnrichment } from "./card"
import { FilteredEmptyCard, HomeEmptyCard } from "./board-empty"
import { BoardColumn, DragSlot } from "./column"
import { ClosedColumnGroup, ClosedColumnHeader, ClosedRail } from "./closed-rail"
import { departmentTitle } from "./board-switcher"
import { boardDetailIds, useBoardData, useBoardRank, useBoardTransition, useBoardTrees, useCreateSubTask, useKeepWorkItem } from "./use-board"
import {
  BOARD_STATUS_ORDER, CLOSED_STATUSES, EXCEPTION_STATUSES, isColumnInStatusFilter, PIPELINE_STATUSES, visibleItemCount,
} from "./status-scope"
import { useBoardDrag } from "./use-board-drag"
import { boardKey, parseBoardParam } from "./board-route"
import { useBoardScroll } from "./use-board-scroll"

/* Todos v2 slice 6 — the board surface (design contract:
 * docs/superpowers/design/todos-v2-board — board.html is the visual truth).
 * Stage A: switcher-in-title, 4 pipeline columns + materializing exception
 * columns + folded Closed rail, card anatomy per mock, in-place tree trays,
 * drag (rank within a column, legal status moves across), board-scoped data.
 * The task-page takeover is stage B; mobile polish + cutover are stage C. */

const NOOP = () => {}

/** The one breakpoint the Todos dash reads: the phone gets the grouped list,
 *  the desktop the columns. No `window` — SSR, jsdom — reads as desktop. */
const MOBILE_QUERY = "(max-width: 700px)"
function useIsBoardMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && (window.matchMedia?.(MOBILE_QUERY).matches ?? false),
  )
  useEffect(() => {
    const query = window.matchMedia?.(MOBILE_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return mobile
}

const TREE_OPEN_KEY = "jinn-board-tree-open"

function loadExpandedTrees(): Set<string> {
  try {
    const raw = sessionStorage.getItem(TREE_OPEN_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function saveExpandedTrees(ids: Set<string>): void {
  try {
    sessionStorage.setItem(TREE_OPEN_KEY, JSON.stringify([...ids]))
  } catch {
    /* session-only convenience */
  }
}

export default function TodoBoardPage() {
  const { board: boardParam } = useParams()
  const board = parseBoardParam(boardParam)
  const key = boardKey(board)
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // Columns are the status dimension, so `status` narrows WHICH columns exist
  // rather than filtering within one (useBoardData gates the queries).
  const filters = useMemo(() => filtersFromSearchParams(searchParams), [searchParams])
  const now = useMemo(() => Date.now(), [filters.date, filters.due])

  const isAttention = board.kind === "attention"
  // The viewport picks the view — grouped list on the phone, columns on the
  // desktop — so there is nothing for the operator to toggle or to remember.
  const mobile = useIsBoardMobile()
  const data = useBoardData(board, filters, now, !isAttention)
  const departments = useDepartments()
  const org = useOrg()
  const byName = useEmployeesByName(org.data?.employees)
  const needs = useNeedsAttentionItems()
  const needsYou = useMemo(() => deriveNeedsYou(needs.data ?? []), [needs.data])

  // ── Optimistic overlays ───────────────────────────────────────────────────
  const [moves, setMoves] = useState<Map<string, { status: WorkItemStatusWire; index: number }>>(new Map())
  const [rankOverrides, setRankOverrides] = useState<Map<string, number>>(new Map())
  const [callout, setCallout] = useState<string | null>(null)
  const calloutTimer = useRef<number | null>(null)
  const announce = useCallback((message: string) => {
    setCallout(message)
    if (calloutTimer.current !== null) window.clearTimeout(calloutTimer.current)
    calloutTimer.current = window.setTimeout(() => setCallout(null), 6000)
  }, [])
  useEffect(() => () => {
    if (calloutTimer.current !== null) window.clearTimeout(calloutTimer.current)
  }, [])

  /** Effective per-status card lists: server data + optimistic moves/ranks. */
  const { itemsByStatus, countByStatus } = useMemo(() => {
    const out: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}
    const counts: Partial<Record<WorkItemStatusWire, number>> = {}
    const allStatuses = [...PIPELINE_STATUSES, ...EXCEPTION_STATUSES, ...CLOSED_STATUSES]
    const withRank = (item: WorkItemCompactWire): WorkItemCompactWire => {
      const rank = rankOverrides.get(item.id)
      return rank === undefined ? item : { ...item, rank }
    }
    for (const status of allStatuses) {
      const seen = new Set<string>()
      const sourceStatuses = [status, ...allStatuses.filter((candidate) => candidate !== status)]
      const base = sourceStatuses
        .flatMap((sourceStatus) => data.columns[sourceStatus]?.items ?? [])
        .filter((item) => {
          if (item.status !== status || seen.has(item.id)) return false
          seen.add(item.id)
          return true
        })
        .filter((item) => {
          const move = moves.get(item.id)
          return !move || move.status === status
        })
        // The due window is the ONE client-side dimension (review F1: no
        // server param) — it filters the loaded columns.
        .filter((item) => matchesDueFilter(item.dueAt, filters.due, now))
        .map(withRank)
      base.sort(compareRank)
      out[status] = base
    }
    // Insert moved cards into their optimistic column at the drop index.
    for (const [id, move] of moves) {
      const source = allStatuses.flatMap((s) => data.columns[s]?.items ?? []).find((item) => item.id === id)
      if (!source || source.status === move.status) continue
      const list = out[move.status] ?? []
      if (list.some((item) => item.id === id)) continue
      const index = Math.min(Math.max(move.index, 0), list.length)
      list.splice(index, 0, { ...withRank(source), status: move.status })
      out[move.status] = list
    }
    for (const status of allStatuses) {
      const column = data.columns[status]
      counts[status] = Math.max(0, (column?.total ?? 0) + (out[status]?.length ?? 0) - (column?.items.length ?? 0))
    }
    return { itemsByStatus: out, countByStatus: counts }
  }, [data.columns, moves, rankOverrides, filters.due, now])

  // Drop an optimistic move once the server agrees (poll/refetch landed).
  useEffect(() => {
    if (moves.size === 0) return
    const next = new Map(moves)
    let changed = false
    for (const [id, move] of moves) {
      const serverItem = (data.columns[move.status]?.items ?? []).find((item) => item.id === id)
      if (serverItem) {
        next.delete(id)
        changed = true
      }
    }
    if (changed) setMoves(next)
  }, [data.columns, moves])

  // ── Enrichment (trees carry priority/roll-up/spend; details carry reasons) ─
  const detailIds = useMemo(
    () => data.isLoading ? [] : boardDetailIds(data.columns),
    [data.columns, data.isLoading],
  )
  const trees = useBoardTrees(detailIds)
  const reasonIds = useMemo(
    () =>
      (data.isLoading ? [] : (["executing", "blocked", "escalated"] as const).flatMap((status) =>
        (data.columns[status]?.items ?? []).map((item) => item.id),
      )).slice(0, 60),
    [data.columns, data.isLoading],
  )
  const details = useOpenDetails(reasonIds)
  const detailById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof details.data>[number]>()
    for (const d of details.data ?? []) map.set(d.workItem.id, d)
    return map
  }, [details.data])
  const enrichmentCache = useRef<Map<string, CardEnrichment>>(new Map())
  const enrichmentById = useMemo(() => {
    const next = new Map<string, CardEnrichment>()
    for (const id of new Set([...detailIds, ...reasonIds])) {
      const tree = trees.data?.get(id)
      const detail = detailById.get(id)
      const previous = enrichmentCache.current.get(id)
      next.set(
        id,
        previous && previous.tree === tree && previous.detail === detail
          ? previous
          : { tree, detail },
      )
    }
    enrichmentCache.current = next
    return next
  }, [detailIds, reasonIds, trees.data, detailById])

  // ── Tree expansion (session-persisted, per item) ────────────────────────────
  const [expandedTrees, setExpandedTrees] = useState<Set<string>>(loadExpandedTrees)
  const toggleTree = useCallback((id: string) => {
    setExpandedTrees((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveExpandedTrees(next)
      return next
    })
  }, [])

  // ── Mutations ───────────────────────────────────────────────────────────────
  const transition = useBoardTransition()
  const rankEdit = useBoardRank()
  const createSubTask = useCreateSubTask()
  const createSubTaskMutate = createSubTask.mutate
  const addSubTask = useCallback(
    (parentId: string, title: string) => {
      createSubTaskMutate(
        { parentId, title },
        { onError: (error) => announce(operatorSafeTodoError(error, "Failed to add the sub-task")) },
      )
    },
    [createSubTaskMutate, announce],
  )

  const commitTransition = useCallback(
    (item: WorkItemCompactWire, to: WorkItemStatusWire, index: number) => {
      // The drop position is a promise: once the status PUT lands, write the
      // rank at the landing slot too (Stage-A review F3) so the next refetch
      // never reorders a drop the gateway accepted.
      const siblings = (itemsByStatus[to] ?? []).filter((it) => it.id !== item.id)
      const before = index > 0 ? siblings[Math.min(index, siblings.length) - 1] : null
      const after = index < siblings.length ? siblings[index] : null
      const rank = rankBetween(before?.rank ?? null, after?.rank ?? null)
      setMoves((prev) => new Map(prev).set(item.id, { status: to, index }))
      setRankOverrides((prev) => new Map(prev).set(item.id, rank))
      const clearRankOverride = () =>
        setRankOverrides((prev) => {
          const next = new Map(prev)
          next.delete(item.id)
          return next
        })
      transition.mutate(
        { id: item.id, status: to },
        {
          onSuccess: (result) => {
            // A drop into Blocked/Escalated commits immediately, then opens the
            // task page with the banner's reason field focused (design-doc §5 —
            // the reason is asked for, never demanded by a modal). Review F6:
            // an exception item must never silently sit reason-less.
            if (to === "blocked" || to === "escalated") {
              navigate(todoPath(item.id), { state: { fromBoard: key, focusBannerReason: true } })
            }
            const version = result.workItem?.version
            if (!isPositiveTodoVersion(version)) {
              clearRankOverride()
              return
            }
            rankEdit.mutate(
              { id: item.id, rank, expectedVersion: version },
              {
                onSettled: clearRankOverride,
                // A rank refusal only costs the position, never the accepted
                // transition — stay quiet unless the operator would notice.
              },
            )
          },
          onError: (error) => {
            clearRankOverride()
            setMoves((prev) => {
              const next = new Map(prev)
              next.delete(item.id)
              return next
            })
            announce(operatorSafeTodoError(error, error instanceof ApiError ? error.message : "The gateway refused the move"))
          },
        },
      )
    },
    [transition, rankEdit, announce, itemsByStatus, navigate, key],
  )

  const commitRank = useCallback(
    (item: WorkItemCompactWire, beforeRank: number | null, afterRank: number | null) => {
      if (!isPositiveTodoVersion(item.version)) return
      const rank = rankBetween(beforeRank, afterRank)
      setRankOverrides((prev) => new Map(prev).set(item.id, rank))
      rankEdit.mutate(
        { id: item.id, rank, expectedVersion: item.version },
        {
          onSettled: () => {
            setRankOverrides((prev) => {
              const next = new Map(prev)
              next.delete(item.id)
              return next
            })
          },
          onError: (error) => announce(operatorSafeTodoError(error, "Reorder failed")),
        },
      )
    },
    [rankEdit, announce],
  )

  const openChildrenOf = useCallback(
    (id: string): number => {
      const tree = trees.data?.get(id)
      if (!tree) return 0
      const roll = rollupOf(tree, tree.root.status)
      return roll ? roll.total - roll.closed : 0
    },
    [trees.data],
  )

  const { drag, registerColumn, liftPointerDown, reducedMotion } = useBoardDrag(itemsByStatus, openChildrenOf, {
    onRank: commitRank,
    onTransition: (item, to, index) => commitTransition(item, to, index),
  })

  // ── Keyboard rank (⌘/Ctrl + arrows) with SR announcements ──────────────────
  const liveRef = useRef<HTMLSpanElement>(null)
  const onCardKeyDown = useCallback(
    (event: React.KeyboardEvent, item: WorkItemCompactWire) => {
      if (!(event.metaKey || event.ctrlKey) || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
      event.preventDefault()
      const list = itemsByStatus[item.status] ?? []
      const index = list.findIndex((it) => it.id === item.id)
      if (index < 0) return
      const target = event.key === "ArrowUp" ? index - 1 : index + 1
      if (target < 0 || target >= list.length) return
      const without = list.filter((it) => it.id !== item.id)
      const before = target > 0 ? without[target - 1] : null
      const after = target < without.length ? without[target] : null
      commitRank(item, before?.rank ?? null, after?.rank ?? null)
      if (liveRef.current) {
        liveRef.current.textContent = `${item.id} moved to position ${target + 1} of ${list.length}`
      }
    },
    [itemsByStatus, commitRank],
  )

  // ── Scroll position (per board on POP, anchored across every reflow) ────────
  const { boardScrollRef, listScrollRef, onBoardScroll, onListScroll } =
    useBoardScroll(key, navigationType, { dragging: drag !== null, attention: isAttention })

  // ── Page chrome state ───────────────────────────────────────────────────────
  const [creating, setCreating] = useState<null | { department?: string; askAssignee?: boolean }>(null)
  const [capturing, setCapturing] = useState(false)
  // A URL naming a closed status asked for closed work — never one tap short.
  const closedFilter = CLOSED_STATUSES.some((status) => status === filters.status)
  const [closedOpen, setClosedOpen] = useState(closedFilter)
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false)
  useEffect(() => {
    setClosedOpen(closedFilter)
    setMobileFilterOpen(false)
  }, [key, closedFilter])

  const setFilters = useCallback(
    (next: TodoFilters) => {
      setSearchParams(filtersToSearchParams(next), { replace: false })
    },
    [setSearchParams],
  )
  // Opening a card carries the board context so the task page's crumb knows
  // its way back (the board name is the back affordance).
  const onOpen = useCallback(
    (id: string, item?: WorkItemCompactWire) =>
      navigate(todoPath(id), {
        state: {
          fromBoard: key,
          bannerExpected: item
            ? item.status === "blocked" || item.status === "escalated" || item.approvalState === "pending"
            : undefined,
        },
      }),
    [navigate, key],
  )

  // ── Attention board actions (reuses the shipped decision surface). The
  // approval cluster is Approve · Reject…, and a rejection carries its own
  // note — that note is what decides between another round and a stop, so it
  // cannot be a separate action. Approval escalation stays an agent/MCP
  // affordance, not an inbox button. ────────────────────────────────────────
  const decide = useDecideApproval()
  const [resolving, setResolving] = useState<Set<string>>(new Set())
  const runDecision = useCallback(
    (id: string, decision: "approve" | "reject", note?: string) => {
      setResolving((prev) => new Set(prev).add(id))
      decide.mutate(
        { id, decision, note },
        {
          onSettled: () =>
            setResolving((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            }),
        },
      )
    },
    [decide],
  )

  // ── Derived chrome ──────────────────────────────────────────────────────────
  const deptSummary = board.kind === "department" ? departments.data?.find((d) => d.slug === board.slug) : undefined
  const title = board.kind === "department" ? departmentTitle(board.slug)
    : board.kind === "attention" ? "Attention"
    : board.kind === "everything" ? "Everything" : "Home"
  const blockedTotal = countByStatus.blocked ?? 0
  const escalatedTotal = countByStatus.escalated ?? 0
  const closedTotal = CLOSED_STATUSES.reduce((sum, status) => sum + (countByStatus[status] ?? 0), 0)
  const visibleStatuses: WorkItemStatusWire[] = useMemo(() => {
    const exceptions = EXCEPTION_STATUSES.filter(
      (status) =>
        (countByStatus[status] ?? 0) > 0
        || (itemsByStatus[status]?.length ?? 0) > 0
        // States mock §6: an empty column doesn't render — EXCEPT the column
        // a drag could legally land in, which materializes for the drop.
        || (drag !== null && drag.legal.has(status)),
    )
    return [...PIPELINE_STATUSES, ...exceptions].filter((s) => isColumnInStatusFilter(filters.status, s))
  }, [countByStatus, itemsByStatus, drag, filters.status])

  // Filtered-empty (states mock §6): zero visible items with filters/search
  // set always offers the way back. An unfiltered empty board celebrates
  // quietly — the columns and their quick-adds ARE the empty state — except
  // Home, which is empty until the operator creates or pins something and so
  // has to name those gestures rather than look broken (PLA-230).
  const filterCount = activeFilterCount(filters) + (filters.q ? 1 : 0)
  const boardEmpty = !data.isLoading && visibleItemCount(filters.status, itemsByStatus) === 0
  const filteredEmpty = boardEmpty && filterCount > 0
  const homeEmpty = boardEmpty && filterCount === 0 && board.kind === "home"
  const listStatusInScope = useCallback((s: WorkItemStatusWire) => isColumnInStatusFilter(filters.status, s), [filters.status])
  const listColumns = useMemo(() => {
    const columns = {} as typeof data.columns
    for (const status of BOARD_STATUS_ORDER) {
      const items = itemsByStatus[status] ?? []
      columns[status] = {
        ...data.columns[status],
        items,
        total: filters.due ? items.length : data.columns[status].total,
      }
    }
    return columns
  }, [data.columns, itemsByStatus, filters.due])
  const keep = useKeepWorkItem(announce)
  const clearAllFilters = useCallback(() => {
    const params = new URLSearchParams()
    setSearchParams(params, { replace: false })
  }, [setSearchParams])

  const renderCards = (status: WorkItemStatusWire) => {
    const items = (itemsByStatus[status] ?? []).filter((item) => item.id !== drag?.id)
    const slotIndex = drag && drag.overStatus === status ? Math.min(drag.overIndex, items.length) : null
    const nodes: React.ReactNode[] = []
    items.forEach((item, index) => {
      if (slotIndex === index) nodes.push(<DragSlot key="slot" height={drag!.height} />)
      nodes.push(
        <div key={item.id} onKeyDown={(e) => onCardKeyDown(e, item)}>
          <BoardCard
            item={item}
            enrichment={enrichmentById.get(item.id)}
            byName={byName}
            expanded={expandedTrees.has(item.id)}
            onToggleTree={toggleTree}
            onOpen={onOpen}
            onOpenChild={onOpen}
            onAddSubTask={addSubTask}
            onKeep={keep.mutate}
            onLiftPointerDown={liftPointerDown}
          />
        </div>,
      )
    })
    if (slotIndex !== null && slotIndex >= items.length) nodes.push(<DragSlot key="slot" height={drag!.height} />)
    return nodes
  }

  const columnFor = (status: WorkItemStatusWire) => {
    const column = data.columns[status]
    const items = itemsByStatus[status] ?? []
    // Under the client-side due window the server total no longer describes
    // what's visible — the header count follows the filtered list.
    const count = filters.due ? items.length : countByStatus[status] ?? 0
    const quickAdd =
      status === "backlog"
        ? () => setCreating({ department: board.kind === "department" ? board.slug : undefined })
        : status === "assigned"
          ? () => setCreating({ department: board.kind === "department" ? board.slug : undefined, askAssignee: true })
          : undefined
    return (
      <BoardColumn
        key={status}
        status={status}
        count={count}
        orderKey={items.map((item) => `${item.id}:${cardLayoutKey(item, enrichmentById.get(item.id))}`).join(",")}
        onQuickAdd={quickAdd}
        hasMore={column?.hasMore ?? false}
        remaining={Math.max(0, count - items.length)}
        loadMore={column?.loadMore ?? (() => {})}
        loadingMore={column?.loadingMore ?? false}
        drag={drag}
        registerColumn={registerColumn}
      >
        {renderCards(status)}
      </BoardColumn>
    )
  }

  return (
    <PageLayout>
      <PageScaffold
        scroll="external"
        header={
          <BoardHeader
            board={board}
            title={title}
            departments={departments.data}
            attentionCount={needsYou.length}
            deptPrefix={deptSummary?.prefix}
            isAttention={isAttention}
            openCount={
              filters.due
                ? PIPELINE_STATUSES.reduce((sum, s) => sum + (itemsByStatus[s]?.length ?? 0), 0)
                : data.openTotal
            }
            blockedTotal={blockedTotal}
            escalatedTotal={escalatedTotal}
            onQuickCapture={() => setCapturing(true)}
          />
        }
        primaryAction={
          <PrimaryAction
            aria-label="New todo"
            label="New Todo"
            icon={<Plus className="size-4" aria-hidden />}
            testId="todo-new"
            onClick={() => setCreating({ department: board.kind === "department" ? board.slug : undefined })}
          />
        }
      >
        {!isAttention && !mobile && (
          <div className="flex-none px-[var(--space-3)] md:px-[var(--space-10)]">
            <FilterBar
              filters={filters}
              onChange={setFilters}
              employees={org.data?.employees ?? []}
              departments={board.kind === "everything" || board.kind === "home" ? org.data?.departments ?? [] : []}
              byName={byName}
              hideStatus
              hideDepartment={board.kind === "department"}
              board
            />
          </div>
        )}

        {!isAttention && mobile && (
          <div className="flex-none px-[var(--space-3)] md:px-[var(--space-10)]">
            <button
              type="button"
              data-testid="todo-mobile-filters"
              onClick={() => setMobileFilterOpen(true)}
              className="focus-ring flex h-[40px] flex-none items-center gap-[7px] rounded-[17px] bg-[var(--bg-secondary)] px-3.5 text-[14px] font-semibold text-[var(--text-primary)] outline-none"
              style={{ boxShadow: "var(--shadow-ambient), var(--shadow-subtle), var(--inset-shine)" }}
            >
              <ListFilter
                size={13}
                strokeWidth={2.2}
                aria-hidden
                className={filterCount > 0 ? "text-[var(--accent)]" : undefined}
              />
              Filters
              {filterCount > 0 && (
                <span className="text-[12px] font-medium tabular-nums text-[var(--text-quaternary)]">{filterCount}</span>
              )}
            </button>
          </div>
        )}

        {isAttention ? (
          <div
            ref={boardScrollRef}
            onScroll={onBoardScroll}
            data-testid="todo-board-scroll"
            data-scrollable
            className="min-h-0 flex-1 overflow-y-auto px-5 pb-[var(--jinn-scaffold-bottom)] pt-5 md:px-10 lg:pb-10"
          >
            <div className="max-w-[680px]">
              {needs.isLoading ? (
                <GroupSkeleton />
              ) : needs.isError ? (
                <div className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]">
                  {operatorSafeTodoError(needs.error, "Failed to load your inbox")}
                </div>
              ) : (
                <NeedsYouView
                  items={needsYou}
                  byName={byName}
                  resolvingIds={resolving}
                  onApprove={(id) => runDecision(id, "approve")}
                  onReject={(id, note) => runDecision(id, "reject", note || undefined)}
                  onOpen={onOpen}
                />
              )}
            </div>
          </div>
        ) : (
          <>
          {/* Both containers stay mounted and one is hidden: the scroll
              position is put back per board, so unmounting the other half
              across a rotation would drop the reader where they were. */}
          <div
            ref={listScrollRef}
            onScroll={onListScroll}
            hidden={!mobile}
            data-testid="todo-list-scroll"
            data-scrollable
            className="min-h-0 flex-1 overflow-y-auto pb-[var(--jinn-scaffold-bottom)] lg:pb-10"
          >
            {data.isError ? (
              <BoardErrorCard error={data.error} testId="todo-list-error" />
            ) : data.isLoading ? (
              <div className="px-3 pt-5 md:px-10"><GroupSkeleton /></div>
            ) : filteredEmpty ? (
              <FilteredEmptyCard
                count={filterCount}
                onClear={clearAllFilters}
                testId="todo-list-filtered-empty"
                clearTestId="todo-list-clear-filters"
              />
            ) : homeEmpty ? (
              <HomeEmptyCard testId="todo-list-home-empty" />
            ) : (
              <TodoList
                columns={listColumns}
                scrollRef={listScrollRef}
                statusInScope={listStatusInScope}
                closedInitiallyOpen={closedFilter}
                needsAttention={needsYou}
                byName={byName}
                trees={trees.data}
                now={now}
                onOpen={onOpen}
                onKeep={keep.mutate}
                onQuickAdd={(askAssignee) => setCreating({ department: board.kind === "department" ? board.slug : undefined, askAssignee: askAssignee || undefined })}
              />
            )}
          </div>
          <div
            ref={boardScrollRef}
            onScroll={onBoardScroll}
            hidden={mobile}
            data-testid="todo-board-scroll"
            data-scrollable
            className="min-h-0 flex-1 overflow-auto pb-[var(--jinn-scaffold-bottom)] lg:pb-10"
          >
            {data.isError ? (
              <BoardErrorCard error={data.error} />
            ) : data.isLoading ? (
              <BoardSkeleton />
            ) : filteredEmpty ? (
              <FilteredEmptyCard count={filterCount} onClear={clearAllFilters} />
            ) : homeEmpty ? (
              <HomeEmptyCard />
            ) : (
            <div className="flex min-h-full items-start gap-3 px-10 pb-8 pt-5">
              {visibleStatuses.map((status) => columnFor(status))}
              {CLOSED_STATUSES.some(listStatusInScope) && (closedOpen ? (
                <section className="flex w-[262px] min-w-[238px] flex-none flex-col gap-3" data-testid="board-closed-column">
                  <ClosedColumnHeader count={closedTotal} onCollapse={() => setClosedOpen(false)} />
                  {CLOSED_STATUSES.filter(listStatusInScope).map((status) => (
                    <ClosedColumnGroup
                      key={status}
                      status={status as "done" | "cancelled"}
                      count={countByStatus[status] ?? 0}
                      hasMore={data.columns[status]?.hasMore ?? false}
                      loadMore={data.columns[status]?.loadMore ?? (() => {})}
                      loadingMore={data.columns[status]?.loadingMore ?? false}
                    >
                      <div ref={registerColumn(status)} className="flex flex-col gap-2">
                        {renderCards(status)}
                      </div>
                    </ClosedColumnGroup>
                  ))}
                </section>
              ) : (
                <ClosedRail count={closedTotal} onExpand={() => setClosedOpen(true)} />
              ))}
            </div>
            )}
          </div>
          </>
        )}
      </PageScaffold>

      {/* Drag ghost — lifted card follows the pointer (scale 1.02 + 1.2° tilt). */}
      {drag && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-50"
          style={{
            left: drag.x,
            top: drag.y,
            width: drag.width,
            transform: reducedMotion ? undefined : "scale(1.02) rotate(1.2deg)",
          }}
        >
          <BoardCard
            item={drag.item}
            enrichment={enrichmentById.get(drag.id)}
            byName={byName}
            expanded={false}
            onToggleTree={NOOP}
            onOpen={NOOP}
            onOpenChild={NOOP}
            onAddSubTask={NOOP}
            ghost
          />
        </div>
      )}

      {/* Transient refusal callout — the gateway's words. */}
      {callout && (
        <div
          role="status"
          data-testid="board-callout"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-[var(--radius-lg)] bg-[var(--material-thick)] px-4 py-2.5 text-[length:var(--text-footnote)] text-[var(--text-primary)] shadow-[var(--shadow-overlay)] backdrop-blur-xl"
        >
          {callout}
        </div>
      )}
      <span ref={liveRef} aria-live="polite" className="sr-only" />

      {capturing && <QuickCaptureBar onClose={() => setCapturing(false)} />}

      {creating && (
        <NewTodoDialog
          onClose={() => setCreating(null)}
          onCreated={() => setCreating(null)}
          defaults={{
            department: creating.department,
            askAssignee: creating.askAssignee,
            employees: org.data?.employees ?? [],
            departments: departments.data ?? [],
          }}
        />
      )}

      {/* Mobile filtering entry (F5): the Active pill's glyph opens the same
          filter grammar as the desktop chips, scoped like FilterBar. */}
      {mobile && mobileFilterOpen && (
        <TodoFilterSheet
          filters={filters}
          onChange={setFilters}
          employees={org.data?.employees ?? []}
          departments={board.kind === "everything" || board.kind === "home" ? org.data?.departments ?? [] : []}
          byName={byName}
          onClose={() => setMobileFilterOpen(false)}
          hideStatus
          hideDepartment={board.kind === "department"}
          showLabelDue
        />
      )}
    </PageLayout>
  )
}


/** The grouped-list skeleton (mobile/inbox loading) — moved here from the
 *  retired legacy list's group module at the stage-C cutover. */
function GroupSkeleton() {
  const widths = ["46%", "58%", "38%"]
  const metas = [64, 40, 52]
  return (
    <section className="mb-[22px]" data-testid="todos-skeleton" aria-hidden>
      <div className="flex items-center gap-2 px-1.5 pb-2">
        <span className="size-5 rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
        <span className="h-3 w-16 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
      </div>
      <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
        {widths.map((w, i) => (
          <div key={i} className="flex min-h-[46px] items-center gap-2.5 py-[7px] pl-2 pr-3">
            <span
              className="ml-[24px] size-6 flex-none rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite] max-[500px]:ml-0"
              style={{ animationDelay: `${i * 200}ms` }}
            />
            <span
              className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ width: w, animationDelay: `${i * 200}ms` }}
            />
            <span className="flex-1" />
            <span
              className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ width: metas[i], animationDelay: `${i * 200}ms` }}
            />
          </div>
        ))}
      </div>
    </section>
  )
}

function BoardErrorCard({ error, testId = "board-error" }: { error: unknown; testId?: string }) {
  return (
    <div className="px-10 pt-5 max-[700px]:px-0 max-[700px]:pt-2">
      <div
        data-testid={testId}
        className="max-w-[560px] rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
      >
        {operatorSafeTodoError(error, "Couldn't load this board")}
      </div>
    </div>
  )
}


/** Loading keeps exact card geometry so nothing shifts when data lands
 *  (states mock §6 .skel-col: 56px overline bar, 85%/55% title bars). */
function BoardSkeleton() {
  const cardsPerColumn = [3, 2, 3, 2, 1]
  return (
    <div className="flex min-h-full items-start gap-3 px-10 pb-8 pt-5" data-testid="board-skeleton" aria-hidden>
      {cardsPerColumn.map((cards, column) => (
        <div key={column} className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-[11px] pb-2.5 pt-0.5">
            <span className="size-5 rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
            <span className="h-3 w-[74px] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
          </div>
          <div className="flex flex-col gap-2">
            {Array.from({ length: cards }, (_, i) => (
              <div
                key={i}
                className="rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] px-[13px] py-3 shadow-[var(--shadow-ambient),var(--shadow-subtle)]"
              >
                <div
                  className="h-2.5 w-14 rounded-[5px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
                  style={{ animationDelay: `${(column * 2 + i) * 120}ms` }}
                />
                <div
                  className="mt-[9px] h-[13px] w-[85%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
                  style={{ animationDelay: `${(column * 2 + i) * 120}ms` }}
                />
                {i % 3 !== 2 && (
                  <div
                    className="mt-[5px] h-[13px] w-[55%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
                    style={{ animationDelay: `${(column * 2 + i) * 120}ms` }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <div
        data-testid="board-skeleton-closed-rail"
        className="h-24 w-11 flex-none rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
      />
    </div>
  )
}
