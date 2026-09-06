import type { ComponentType } from "react"
import { Moon, Palette, Sun } from "lucide-react"
import { useTheme } from "@/routes/providers"
import { THEMES, type ThemeId } from "@/lib/themes"
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-menu"
import { contributions } from "@/contrib/registry"
import { Slot } from "@/contrib/slot"
import { AREAS } from "@/contrib/types"
import { cn } from "@/lib/utils"

// Keep compact desktop chrome while giving phone controls room to tap.
const CONTROL_CLASS =
  "flex size-[40px] md:size-[34px] shrink-0 items-center justify-center rounded-[var(--radius-md)] " +
  "text-[var(--text-tertiary)] transition-colors duration-150 " +
  "[transition-timing-function:var(--ease-smooth)] " +
  "hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"

function themeGlyph(theme: ThemeId): ComponentType<{ size?: number | string; className?: string }> {
  if (theme === "light") return Sun
  if (theme === "dark") return Moon
  return Palette
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const Glyph = themeGlyph(theme)

  function cycleTheme() {
    const ids = THEMES.map((t) => t.id)
    setTheme(ids[(ids.indexOf(theme) + 1) % ids.length])
  }

  return (
    <button
      type="button"
      onClick={cycleTheme}
      aria-label={`Theme: ${theme}`}
      title={`Theme: ${theme}`}
      className={CONTROL_CLASS}
    >
      <Glyph size={17} />
    </button>
  )
}

// The two persistent status affordances the app has, registered as core
// contributions so the area ships with a real consumer instead of an empty
// host. The rail's piano-reveal label has nowhere to escape to in a bottom bar
// — it would slide over the next control or straight off the right edge — so it
// is suppressed here and the button's `title` carries the name instead.
contributions.registerMany([
  {
    id: "workspace",
    area: AREAS.statusbarRight,
    order: 0,
    render: () => <WorkspaceSwitcher className={cn(CONTROL_CLASS, "[&_[data-rail-label]]:hidden")} />,
  },
  {
    id: "theme",
    area: AREAS.statusbarRight,
    order: 10,
    render: () => <ThemeToggle />,
  },
])

/**
 * The app's status bar: a quiet strip along the bottom of the content column
 * that hosts the `statusbar.right` area.
 *
 * It clears the mobile tab bar itself. That bar is `fixed`, so a flow sibling
 * placed before it would sit underneath it rather than above it, and the
 * clearance the content column used to carry lives here now that the bar is
 * the lowest thing in the column.
 *
 * The margin mirrors what `chat/mobile-tab-bar.tsx` adds up to — a 49px row,
 * `py-1.5`, a 0.5px top edge, and `pb-[max(var(--safe-bottom),6px)]`. The 49px
 * the content column used to reserve was the row alone, which is 13px short:
 * invisible under scrolling content, but it would have parked a third of these
 * tap targets behind the tab bar.
 */
export function StatusBar() {
  return (
    <div className="mb-[calc(var(--tab-bar-height)+max(var(--safe-bottom),6px))] flex shrink-0 items-center justify-end gap-1 px-2 py-1 lg:mb-0">
      <Slot area={AREAS.statusbarRight} variant="chip" />
    </div>
  )
}
