import { matchPath } from "react-router-dom"

export type AppRouteAvailability = "always" | "notes-enabled" | "development"

export interface AppRouteDescriptor {
  id: string
  path: string
  availability: AppRouteAvailability
  /** The semantic surface an operator names. Redirects name their destination. */
  surface: string
}

/**
 * The paths the shipped router can render. Route elements stay in `main.tsx`,
 * but their identities live here so Talk coverage and the router consume the
 * same list instead of maintaining two uncheckable copies.
 */
export const APP_ROUTES = [
  { id: "chat", path: "/", availability: "always", surface: "chat" },
  { id: "chat-redirect", path: "/chat/:sessionId?", availability: "always", surface: "chat" },
  { id: "cron-list", path: "/cron", availability: "always", surface: "cron" },
  { id: "cron-detail", path: "/cron/:id", availability: "always", surface: "cron" },
  { id: "todos-index", path: "/todos", availability: "always", surface: "todos" },
  { id: "todo-board", path: "/todos/b/:board", availability: "always", surface: "todos" },
  { id: "todo-detail", path: "/todos/:todoId", availability: "always", surface: "todo" },
  { id: "notes-list", path: "/notes", availability: "notes-enabled", surface: "notes" },
  { id: "notes", path: "/notes/*", availability: "notes-enabled", surface: "notes" },
  { id: "experiments-list", path: "/experiments", availability: "always", surface: "experiments" },
  { id: "experiment-detail", path: "/experiments/:id", availability: "always", surface: "experiment" },
  { id: "kanban-redirect", path: "/kanban", availability: "always", surface: "todos" },
  { id: "logs", path: "/logs", availability: "always", surface: "logs" },
  { id: "limits", path: "/limits", availability: "always", surface: "limits" },
  { id: "org", path: "/org", availability: "always", surface: "org" },
  { id: "constellation", path: "/constellation", availability: "always", surface: "constellation" },
  { id: "settings-plugins", path: "/settings/plugins", availability: "always", surface: "settings-plugins" },
  { id: "settings", path: "/settings", availability: "always", surface: "settings" },
  { id: "skills-list", path: "/skills", availability: "always", surface: "skills" },
  { id: "skill-detail", path: "/skills/:name", availability: "always", surface: "skill" },
  { id: "file", path: "/file", availability: "always", surface: "file" },
  { id: "more", path: "/more", availability: "always", surface: "more" },
  { id: "workflow-list", path: "/workflow", availability: "always", surface: "workflows" },
  { id: "workflow-detail", path: "/workflow/:id", availability: "always", surface: "workflow" },
  { id: "workflow-run", path: "/workflow/:id/runs/:runId", availability: "always", surface: "workflow-run" },
  { id: "talk-orb", path: "/talk-orb", availability: "always", surface: "talk-orb" },
  { id: "redesign", path: "/redesign", availability: "development", surface: "redesign" },
  { id: "plugin-contributed", path: "/*", availability: "always", surface: "plugin" },
] as const satisfies readonly AppRouteDescriptor[]

export type AppRouteId = (typeof APP_ROUTES)[number]["id"]

/** First concrete match wins; the plugin splat is intentionally last. */
export function matchAppRoute(pathname: string): (typeof APP_ROUTES)[number] | undefined {
  return APP_ROUTES.find((route) => matchPath({ path: route.path, end: true }, pathname) !== null)
}
