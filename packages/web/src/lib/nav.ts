import {
  MessageSquare,
  Workflow,
  Users,
  Clock,
  ListChecks,
  Activity,
  Gauge,
  Zap,
  Settings,
  MoreHorizontal,
  NotebookPen,
  FlaskConical,
  Puzzle,
  Orbit,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { contributions } from "@/contrib/registry"
import { AREAS } from "@/contrib/types"
import { lookupIcon, type IconName } from "@/components/ui/icon"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

/**
 * What a `sidebar.nav` contribution declares.
 *
 * `icon` takes a component from the app's own code, or a name out of the SDK's
 * curated set — which is how a disk plugin supplies one, since the loader's
 * import allowlist is the SDK, React and the JSX runtime and no icon library.
 * A row with neither, or with a name the set does not carry, gets the fallback
 * glyph rather than a hole in the rail.
 */
export interface NavContributionData {
  href: string
  label: string
  icon?: LucideIcon | IconName
}

function contributedNavItems(): NavItem[] {
  return contributions.getArea(AREAS.sidebarNav).flatMap((contribution) => {
    const data = contribution.data as Partial<NavContributionData> | undefined
    if (typeof data?.href !== "string" || !data.href.startsWith("/")) return []
    if (typeof data.label !== "string" || !data.label) return []
    const icon = typeof data.icon === "string" ? lookupIcon(data.icon) : data.icon
    return [{ href: data.href, label: data.label, icon: icon ?? Puzzle }]
  })
}

const BASE_NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/todos", label: "Todos", icon: ListChecks },
  { href: "/workflow", label: "Workflows", icon: Workflow },
  { href: "/experiments", label: "Experiments", icon: FlaskConical },
  { href: "/org", label: "Organization", icon: Users },
  { href: "/constellation", label: "Constellation", icon: Orbit },
  { href: "/cron", label: "Cron", icon: Clock },
  { href: "/limits", label: "Limits", icon: Gauge },
  { href: "/logs", label: "Activity", icon: Activity },
  { href: "/skills", label: "Skills", icon: Zap },
  { href: "/settings", label: "Settings", icon: Settings },
]

const NOTES_NAV_ITEM: NavItem = { href: "/notes", label: "Notes", icon: NotebookPen }

// GRS-022 — the mobile bottom tab bar is the SOLE mobile nav (the top-left
// hamburger is gone). HIG caps a tab bar at ~4–5 self-explanatory items, so we
// carry the 4 primary destinations and hand everything else to a "More" tab that
// opens the grouped overflow screen (/more). Chat + Todos + Workflows are the
// day-to-day phone surfaces; Experiments/Organization/Cron/Skills/Activity/
// Limits/Settings live one tap deep under More. The bar is icon-only (see
// mobile-tab-bar.tsx).

// The "More" tab is not a NAV_ITEMS destination — it's the overflow entry point.
export const MORE_NAV_ITEM: NavItem = { href: "/more", label: "More", icon: MoreHorizontal }

export function navigationFor(notesEnabled: boolean): {
  items: NavItem[]
  mobileItems: NavItem[]
  overflowItems: NavItem[]
  overflowHrefs: string[]
} {
  const base = notesEnabled
    ? [...BASE_NAV_ITEMS.slice(0, 2), NOTES_NAV_ITEM, ...BASE_NAV_ITEMS.slice(2)]
    : BASE_NAV_ITEMS
  // Contributed rows go last, after the app's own destinations. The rail's order
  // is the operator's mental model of their company, and a plugin does not get
  // to insert itself into the middle of it.
  const items = [...base, ...contributedNavItems()]
  const primaryHrefs = notesEnabled ? ["/", "/todos", "/notes", "/workflow"] : ["/", "/todos", "/workflow"]
  const mobileItems = [
    ...primaryHrefs.map((href) => items.find((item) => item.href === href)!),
    MORE_NAV_ITEM,
  ]
  const overflowItems = items.filter((item) => !primaryHrefs.includes(item.href))
  return { items, mobileItems, overflowItems, overflowHrefs: overflowItems.map((item) => item.href) }
}

// Safe defaults keep a newly installed or temporarily disabled feature out of
// every static consumer before the runtime feature query completes.
export const NAV_ITEMS = navigationFor(false).items
export const MOBILE_TAB_ITEMS = navigationFor(false).mobileItems

// Destinations that live INSIDE the More overflow screen (everything not a
// primary tab). Derived from NAV_ITEMS so the overflow order always mirrors
// the shared nav order — no second hardcoded list. These are the core-only
// defaults; a surface that must also show contributed rows (the More screen,
// the mobile tab bar) reads the live list through `useNavigation` instead.
export const OVERFLOW_ITEMS = navigationFor(false).overflowItems
export const OVERFLOW_HREFS = navigationFor(false).overflowHrefs
