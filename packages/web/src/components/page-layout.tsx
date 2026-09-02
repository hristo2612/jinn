import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { NavRibbon } from "./pill-nav"
import { MobileTabBar } from "./chat/mobile-tab-bar"
import { StatusBar } from "./status-bar"
import { EdgeBackLayer } from "./edge-back/edge-back-layer"
import { useCoarsePointer } from "./edge-back/use-edge-back-gesture"
import { cn } from "@/lib/utils"
import { useOnboarding } from "@/hooks/use-onboarding"
import { runAfterLoad, useLoadDeferredMount } from "@/hooks/use-idle-mount"
import { SearchOverlayProvider, useSearchOverlay } from "./search-overlay-context"

const loadGlobalSearch = () => import("./global-search")
const loadLiveStreamWidget = () => import("./live-stream-widget")
const loadOnboardingWizard = () => import("./onboarding-wizard")

const GlobalSearch = lazy(() => loadGlobalSearch().then(m => ({ default: m.GlobalSearch })))
const LiveStreamWidget = lazy(() => loadLiveStreamWidget().then(m => ({ default: m.LiveStreamWidget })))
const OnboardingWizard = lazy(() => loadOnboardingWizard().then(m => ({ default: m.OnboardingWizard })))

function isCommandPaletteShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"
}

function DeferredGlobalSearch() {
  const { request } = useSearchOverlay()
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const mounted = shortcutOpen || request !== null

  // Warm the Cmd-K chunk, but only well after load so the fetch stays out of
  // the first-paint / pre-interaction waterfall. A key press before this fires
  // still opens instantly — the keydown handler mounts (and imports) on demand.
  useEffect(() => runAfterLoad(() => {
    void loadGlobalSearch()
  }), [])

  useEffect(() => {
    if (mounted) return
    function handleKeyDown(e: KeyboardEvent) {
      if (!isCommandPaletteShortcut(e)) return
      e.preventDefault()
      setShortcutOpen(true)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [mounted])

  if (!mounted) return null

  // Every openSearch call remounts the palette so it re-enters with the scope
  // and seed it asked for. Once open the palette owns its own state — Cmd-K
  // included — so there is nothing to carry across requests.
  return (
    <Suspense fallback={null}>
      <GlobalSearch
        key={request?.id ?? "shortcut"}
        initialOpen
        initialScope={request?.scope}
        initialQuery={request?.query}
      />
    </Suspense>
  )
}

function DeferredLiveStreamWidget() {
  // Non-critical shell widget — mount after load so its chunk never lands in
  // the measured first-paint / pre-interaction waterfall.
  const mounted = useLoadDeferredMount()
  if (!mounted) return null
  return (
    <Suspense fallback={null}>
      <LiveStreamWidget />
    </Suspense>
  )
}

function DeferredOnboardingWizard() {
  // Consumes the SAME shared onboarding query as SettingsProvider, so a clean
  // load only fetches /api/onboarding once. The localStorage short-circuit keeps
  // the query disabled for already-onboarded users (no request at all).
  const forceFreshWorkspaceOnboarding = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("onboarding") === "1"
  const onboardedLocally = typeof window !== "undefined"
    && !!localStorage.getItem("jinn-onboarded")
    && !forceFreshWorkspaceOnboarding
  const { data, isError } = useOnboarding({ enabled: !onboardedLocally })

  useEffect(() => {
    if (data?.onboarded && typeof window !== "undefined") {
      localStorage.setItem("jinn-onboarded", "true")
    }
  }, [data?.onboarded])

  if (onboardedLocally) return null
  // Fall back to "needed" on error so a failed fetch still surfaces onboarding
  // (matches the previous best-effort behavior).
  const needed = data ? data.needed : isError
  if (!needed) return null

  return (
    <Suspense fallback={null}>
      <OnboardingWizard initialVisible />
    </Suspense>
  )
}

export function ToolbarActions({ children }: { children?: React.ReactNode }) {
  return (
    <div className="hidden items-center gap-2 lg:flex">
      {children}
    </div>
  )
}

/**
 * App shell. Desktop nav is the global NavRibbon (the same polished icon rail
 * the chat route uses) mounted as a left column — no list to fold, so its top
 * slot is the brand mark. The active rail icon is the "you are here" cue, so
 * there is no persistent title pill; pages that want a heading render
 * `PageScaffold` + `LargeTitleHeader` inside this shell.
 *
 * Mobile nav is the MobileTabBar ALONE (GRS-022). The old top-left
 * hamburger+title pill was removed: the bottom tab bar carries all cross-route
 * navigation (with a "More" tab for the overflow), and each headed page renders
 * `PageScaffold` + `LargeTitleHeader` in content — no global mobile chrome bar.
 * `chromeless` routes (chat) draw their own rail + pills.
 *
 * The StatusBar closes the column at every breakpoint — it hosts the app's
 * persistent status affordances, which used to be pinned to the bottom of the
 * desktop nav rail where mobile never saw them. `chromeless` routes draw their
 * own bottom edge, so they get no bar.
 *
 * `hideMobileTabBar` is the full-screen-push escape (Todos v2 §8): a pushed
 * detail page (the opened task) owns the bottom edge — its fixed comment bar
 * replaces the tab bar, and back is the page's own affordance. The status bar
 * stands down with it for the same reason: two surfaces cannot own one edge.
 * Only mobile pushes, so desktop chrome is untouched.
 *
 * The left-edge back drag (ICI-801) is mounted here rather than per route, so
 * `chromeless` chat gets it too. It arms on a coarse pointer only: a mouse keeps
 * the browser's own back, and the existing chevrons are untouched either way.
 */
export function PageLayout({ children, chromeless, hideMobileTabBar }: { children: React.ReactNode; chromeless?: boolean; hideMobileTabBar?: boolean }) {
  const content = useRef<HTMLDivElement>(null)
  const coarsePointer = useCoarsePointer()
  return (
    <SearchOverlayProvider>
      <div className="jinn-cosmic-shell flex h-dvh overflow-hidden bg-background">
        <DeferredGlobalSearch />
        {/* Global desktop nav rail (hidden < lg from inside NavRibbon). Sibling of
            <main> so its per-icon label pills can escape rightward over content. */}
        {!chromeless && <NavRibbon />}
        <main className="relative flex flex-1 flex-col overflow-hidden">
          {/* Before the live view in DOM order, which is what puts the previous
              view underneath it while the drag is running. */}
          {coarsePointer && <EdgeBackLayer contentRef={content} />}
          <div
            ref={content}
            className={cn(
              "flex-1 overflow-hidden",
              // Notch clearance only (mobile) — no global top chrome to clear now
              // that the hamburger pill is gone; pages own their inline headers.
              !chromeless && "pt-[var(--safe-top)] lg:pt-0",
            )}
          >
            {children}
          </div>
          {/* The persistent status affordances (workspace, theme), hosted as the
              statusbar.right contribution area. Lowest thing in the column, so it
              carries the mobile tab bar's clearance — the bar below is `fixed`,
              and a flow sibling without it would render underneath. */}
          {!chromeless && !hideMobileTabBar && <StatusBar />}
          {/* Persistent mobile nav — same curated tab bar across every standard
              page so nav never disappears (Chat draws its own on the list screen). */}
          {!chromeless && !hideMobileTabBar && <MobileTabBar />}
        </main>
        <DeferredLiveStreamWidget />
        <DeferredOnboardingWizard />
      </div>
    </SearchOverlayProvider>
  )
}
