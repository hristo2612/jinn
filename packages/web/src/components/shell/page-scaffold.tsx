import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { cn } from "@/lib/utils"
import { PrimaryActionPlacementProvider } from "./primary-action"

type ShellChrome = {
  collapse: boolean
  hideMobileTabBar: boolean
  trailingAction: ReactNode
}

const ShellChromeContext = createContext<ShellChrome>({
  collapse: true,
  hideMobileTabBar: false,
  trailingAction: null,
})

export function useShellChrome() {
  return useContext(ShellChromeContext)
}

const ScaffoldScrollContext = createContext<HTMLElement | null>(null)

export function useScaffoldScrollElement() {
  return useContext(ScaffoldScrollContext)
}

/**
 * What overlaps the bottom of a scrollport: the FAB that floats over it, the
 * keyboard, and — only on the pushed pages that hide the tab bar — the safe
 * area. With the tab bar up, `StatusBar` already holds the whole column clear of
 * it, so reserving --tab-bar-height here covered the bar twice and left ~150px
 * of dead scroll under the last row.
 *
 * Joined rather than concatenated because `calc()` reads `+` as an operator only
 * when it is whitespace-delimited: unspaced, the declaration is dropped without
 * complaint and the padding resolves to 0.
 */
export function scaffoldBottomPadding({
  hasPrimaryAction,
  hideMobileTabBar,
}: {
  hasPrimaryAction: boolean
  hideMobileTabBar: boolean
}): string {
  const terms = [
    ...(hideMobileTabBar ? ["max(var(--safe-bottom), 6px)"] : []),
    "var(--space-4)",
    ...(hasPrimaryAction ? ["var(--fab-size)", "var(--space-4)"] : []),
    "var(--keyboard-inset)",
  ]
  return `calc(${terms.join(" + ")})`
}

function OwnedScroll({
  header,
  children,
  padStyle,
  scrollEl,
  attachScroll,
}: {
  header?: ReactNode
  children: ReactNode
  padStyle: CSSProperties
  scrollEl: HTMLElement | null
  attachScroll: (node: HTMLDivElement | null) => void
}) {
  return (
    <ScaffoldScrollContext.Provider value={scrollEl}>
      <div
        ref={attachScroll}
        data-scrollable
        style={padStyle}
        className={cn(
          "jinn-scrollport min-h-0 flex-1 overflow-y-auto",
          "pb-[var(--jinn-scaffold-bottom)] lg:pb-10",
        )}
      >
        {header}
        {children}
      </div>
    </ScaffoldScrollContext.Provider>
  )
}

function ExternalColumn({
  header,
  children,
  padStyle,
}: {
  header?: ReactNode
  children: ReactNode
  padStyle: CSSProperties
}) {
  return (
    <>
      {header ? (
        <div className="flex-none px-[var(--space-3)] pt-[var(--space-5)] md:px-[var(--space-10)]">
          {header}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col" style={padStyle}>
        {children}
      </div>
    </>
  )
}

function useChrome(collapse: boolean, hideMobileTabBar: boolean, primaryAction?: ReactNode) {
  return useMemo<ShellChrome>(
    () => ({
      collapse,
      hideMobileTabBar,
      trailingAction: primaryAction ? (
        <PrimaryActionPlacementProvider placement="trailing" hideMobileTabBar={hideMobileTabBar}>
          {primaryAction}
        </PrimaryActionPlacementProvider>
      ) : null,
    }),
    [collapse, hideMobileTabBar, primaryAction],
  )
}

export function PageScaffold({
  header,
  primaryAction,
  children,
  scroll = "owned",
  hideMobileTabBar = false,
  contentWidth,
  className,
}: {
  header?: ReactNode
  primaryAction?: ReactNode
  children: ReactNode
  scroll?: "owned" | "external"
  hideMobileTabBar?: boolean
  /** The route's measure, e.g. `"640px"`. The scrollport centres its content on
   *  it through its own gutter, so the header shares the body's left edge. */
  contentWidth?: string
  className?: string
}) {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const attachScroll = useCallback((node: HTMLDivElement | null) => setScrollEl(node), [])
  const chrome = useChrome(scroll !== "external", hideMobileTabBar, primaryAction)
  const padStyle = {
    "--jinn-scaffold-bottom": scaffoldBottomPadding({
      hasPrimaryAction: Boolean(primaryAction),
      hideMobileTabBar,
    }),
    ...(contentWidth ? { "--jinn-content-width": contentWidth } : {}),
  } as CSSProperties
  useLayoutEffect(() => {
    if (!scrollEl) return
    const title = scrollEl.querySelector<HTMLElement>(".jinn-large-title")
    if (title) scrollEl.style.setProperty("--jinn-collapse-distance", `${title.offsetHeight}px`)
  }, [scrollEl, header])

  return (
    <ShellChromeContext.Provider value={chrome}>
      <div className={cn("relative flex h-full min-h-0 flex-col", className)}>
        {scroll === "external"
          ? <ExternalColumn header={header} padStyle={padStyle}>{children}</ExternalColumn>
          : <OwnedScroll header={header} padStyle={padStyle} scrollEl={scrollEl} attachScroll={attachScroll}>{children}</OwnedScroll>}
        {primaryAction ? (
          <PrimaryActionPlacementProvider placement="fab" hideMobileTabBar={hideMobileTabBar}>
            {primaryAction}
          </PrimaryActionPlacementProvider>
        ) : null}
      </div>
    </ShellChromeContext.Provider>
  )
}
