import type { AppRouteDescriptor, AppRouteId } from "@/lib/app-routes"

interface SupportedCoverage {
  status: "supported"
  context: string
  reads: readonly string[]
  controls: readonly string[]
  uiEffect: string
}

interface ExplicitGapCoverage {
  status: "explicit-gap"
  reason: string
  plannedAdapter: string
}

export type TalkSurfaceCoverage = SupportedCoverage | ExplicitGapCoverage

const supported = (
  context: string,
  reads: readonly string[],
  controls: readonly string[],
  uiEffect: string,
): SupportedCoverage => ({ status: "supported", context, reads, controls, uiEffect })

/**
 * Route-level coverage is deliberately explicit. Slice 2 replaces the control
 * names with the gateway manifest; this slice establishes that no rendered
 * surface can silently disappear from Talk's semantic context.
 */
export const TALK_SURFACE_COVERAGE: Record<AppRouteId, TalkSurfaceCoverage> = {
  chat: supported("selected session and transcript", ["search", "inspect"], ["open", "message", "continue", "stop"], "open and focus chat"),
  "chat-redirect": supported("redirect destination", ["inspect"], ["navigate"], "redirect to chat"),
  "cron-list": supported("jobs, filters, and run summaries", ["list", "inspect"], ["filter", "open", "trigger"], "focus job or run"),
  "cron-detail": supported("selected job and run history", ["inspect", "runs"], ["edit", "enable", "disable", "trigger"], "refresh selected job"),
  "todos-index": supported("board redirect", ["inspect"], ["navigate"], "open default board"),
  "todo-board": supported("board, filters, and visible Todos", ["search", "inspect"], ["filter", "open", "create"], "update board and focus Todo"),
  "todo-detail": supported("selected Todo, status, relations, comments, and runs", ["inspect", "comments", "runs"], ["edit", "comment", "assign", "delegate", "state"], "refresh and focus changed evidence"),
  "notes-list": supported("note list and search", ["list", "search"], ["open", "create"], "open note"),
  notes: supported("selected note and folder", ["read", "search"], ["open", "create", "update"], "focus note content"),
  "experiments-list": supported("experiment filters and summaries", ["list", "search"], ["open", "create"], "open experiment"),
  "experiment-detail": supported("selected hypothesis, metrics, readings, and verdict", ["inspect", "readings"], ["record", "conclude", "reopen"], "refresh experiment"),
  "kanban-redirect": supported("redirect destination", ["inspect"], ["navigate"], "redirect to Todos"),
  logs: supported("bounded redacted activity summary", ["read", "filter"], ["refresh"], "focus filtered activity"),
  limits: supported("engine limit windows and freshness", ["read"], ["refresh"], "focus engine limits"),
  org: supported("employee, reporting line, and activity", ["list", "inspect"], ["open", "delegate"], "focus employee or resulting chat"),
  constellation: supported("visible company graph, active lens, and selected entity", ["list", "inspect"], ["filter", "open"], "focus a graph layer or open the selected Jinn object"),
  settings: supported("active settings and safe configuration summary", ["read"], ["update"], "focus setting"),
  "settings-plugins": supported("plugin inventory and state", ["list", "inspect"], ["enable", "disable", "rescan"], "focus plugin state"),
  "skills-list": supported("installed skill summaries", ["list", "search"], ["open"], "open skill"),
  "skill-detail": supported("selected skill metadata and content", ["read"], ["update"], "focus skill editor"),
  file: supported("published file metadata and preview", ["read"], ["open", "attach"], "focus preview"),
  more: supported("available destinations", ["list"], ["navigate"], "open destination"),
  "workflow-list": supported("workflow definitions and status", ["list", "search"], ["open", "start"], "open workflow or run"),
  "workflow-detail": supported("definition, revision, graph, and runs", ["inspect", "runs"], ["edit", "start", "enable", "disable"], "focus definition or run"),
  "workflow-run": supported("selected run, node, attempts, gates, and output", ["inspect", "attempts"], ["cancel", "input", "decide"], "refresh and focus run node"),
  "talk-orb": supported("development orb bench state", ["inspect"], [], "no company mutation"),
  redesign: supported("development-only design bench", ["inspect"], [], "no company mutation"),
  "plugin-contributed": {
    status: "explicit-gap",
    reason: "plugin-context-unavailable",
    plannedAdapter: "plugin host SDK publishes route, selected object, controls, and freshness",
  },
}

function coverageProblem(id: string, entry: TalkSurfaceCoverage | undefined): string | null {
  if (!entry) return `missing Talk coverage: ${id}`
  if (entry.status === "explicit-gap") {
    return entry.reason && entry.plannedAdapter ? null : `incomplete explicit gap: ${id}`
  }
  return entry.context && entry.reads.length > 0 && entry.uiEffect ? null : `incomplete supported coverage: ${id}`
}

export function validateTalkCoverage(
  routes: readonly AppRouteDescriptor[],
  coverage: Readonly<Record<string, TalkSurfaceCoverage>>,
): string[] {
  const ids = routes.map((route) => route.id)
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index).map((id) => `duplicate route id: ${id}`)
  const routeProblems = ids.map((id) => coverageProblem(id, coverage[id])).filter((error): error is string => error !== null)
  const extras = Object.keys(coverage).filter((id) => !ids.includes(id)).map((id) => `coverage has no route: ${id}`)
  return [...new Set([...duplicates, ...routeProblems, ...extras])]
}

/** Canonical route inventory rendered for humans. The freshness test keeps the
 * checked-in document from drifting from the router and Talk contract. */
export function renderTalkCoverageMarkdown(
  routes: readonly AppRouteDescriptor[] = [],
  coverage: Readonly<Record<string, TalkSurfaceCoverage>> = TALK_SURFACE_COVERAGE,
): string {
  const rows = routes.map((route) => {
    const entry = coverage[route.id]
    if (!entry) return `| ${route.id} | \`${route.path}\` | missing | — |`
    if (entry.status === "explicit-gap") {
      return `| ${route.id} | \`${route.path}\` | explicit gap | ${entry.reason}; ${entry.plannedAdapter} |`
    }
    return `| ${route.id} | \`${route.path}\` | semantic | ${entry.context}; controls: ${entry.controls.join(", ") || "none"} |`
  })
  return [
    "# Talk control coverage",
    "",
    "> Generated from `APP_ROUTES` and `TALK_SURFACE_COVERAGE`. Edit the typed inventory, not this table.",
    "",
    "| Route | Path | Context | Evidence and controls |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "A normal question uses semantic context. One bounded image is permitted only when the current surface declares a named visual gap; the Talk orb, hidden content, secrets, and password inputs are excluded.",
    "",
  ].join("\n")
}
