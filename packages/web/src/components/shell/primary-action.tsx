import { createContext, useContext, useMemo, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export const PRIMARY_ACTION_SLOT = "primary-action"

/**
 * The FAB is absolutely placed inside the scaffold, whose column already ends
 * above the status row — and `StatusBar` carries the fixed tab bar's clearance
 * for the whole column. So with the tab bar up, the offset is the gutter alone;
 * re-adding --tab-bar-height here counted that clearance a second time and
 * parked the button ~180px above the bar, mid-list.
 *
 * With the tab bar hidden the status row stands down with it and the column does
 * reach the viewport edge, so that offset still clears the safe area itself.
 */
export const FAB_BOTTOM_WITH_TAB = "var(--space-4)"
export const FAB_BOTTOM_WITHOUT_TAB = "calc(max(var(--safe-bottom),6px)+var(--space-4))"

type Placement = "fab" | "trailing"

const PlacementContext = createContext<{ placement: Placement; hideMobileTabBar: boolean }>({
  placement: "fab",
  hideMobileTabBar: false,
})

export function PrimaryActionPlacementProvider({
  placement,
  hideMobileTabBar = false,
  children,
}: {
  placement: Placement
  hideMobileTabBar?: boolean
  children: ReactNode
}) {
  const value = useMemo(
    () => ({ placement, hideMobileTabBar }),
    [placement, hideMobileTabBar],
  )
  return <PlacementContext.Provider value={value}>{children}</PlacementContext.Provider>
}

type ActionProps = {
  "aria-label": string
  label: string
  icon?: ReactNode
  onClick: () => void
  disabled?: boolean
  testId?: string
}

function TrailingAction({ "aria-label": ariaLabel, label, icon, onClick, disabled, testId }: ActionProps) {
  return (
    <button
      type="button"
      data-slot={PRIMARY_ACTION_SLOT}
      data-primary-action="trailing"
      data-testid={testId}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "hidden h-9 shrink-0 items-center gap-1.5 rounded-full bg-[var(--fill-secondary)] px-3.5",
        "text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]",
        "lg:inline-flex",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        "disabled:text-[var(--text-quaternary)]",
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function FabAction({ "aria-label": ariaLabel, icon, onClick, disabled, testId, hideMobileTabBar }: ActionProps & { hideMobileTabBar: boolean }) {
  return (
    <button
      type="button"
      data-slot={PRIMARY_ACTION_SLOT}
      data-primary-action="fab"
      data-testid={testId ? `${testId}-fab` : undefined}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // --space-3 is the mobile page gutter (`.jinn-scrollport`'s --jinn-gutter
        // floor, and what the external-scroll routes pad by), so the disc's
        // right edge lands on the card edge instead of 4px inside it.
        "absolute right-[var(--space-3)] z-30 inline-flex size-[var(--fab-size)] items-center justify-center rounded-full lg:hidden",
        hideMobileTabBar
          ? "bottom-[calc(max(var(--safe-bottom),6px)+var(--space-4))]"
          : "bottom-[var(--space-4)]",
        "shadow-[var(--shadow-key),var(--inset-shine)]",
        "transition-transform duration-[var(--duration-fast)] ease-[var(--ease-snappy)]",
        "active:scale-[0.94]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
        "[&_svg]:size-6",
        disabled
          ? "bg-[var(--fill-tertiary)] text-[var(--text-quaternary)] shadow-none"
          : "bg-[var(--accent)] text-[var(--accent-contrast)]",
      )}
    >
      {icon}
    </button>
  )
}

export function PrimaryAction(props: ActionProps) {
  const { placement, hideMobileTabBar } = useContext(PlacementContext)
  if (placement === "trailing") return <TrailingAction {...props} />
  return <FabAction {...props} hideMobileTabBar={hideMobileTabBar} />
}
