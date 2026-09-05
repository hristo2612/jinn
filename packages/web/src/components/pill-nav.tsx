import { type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { PanelLeft } from "lucide-react"
import { useSettings } from "@/routes/settings-provider"
import { useNavigation } from "@/lib/use-navigation"
import { cn } from "@/lib/utils"
import { useFeatures } from "@/hooks/use-features"
import { prefetchRoute } from "@/lib/route-prefetch"

// ---------------------------------------------------------------------------
// Frosted pill primitives (mockup _shared.css `.pill` recipe)
// ---------------------------------------------------------------------------
// A theme-aware material, 0.5px theme-aware border (the shadow's built-in ring,
// NOT a hairline at rest), overlay shadow, full radius — flipping with the theme
// via --pill-bg / --pill-border (globals.css). blur(20px) saturate(1.3) rides on
// top for pointer:fine only: these float over a scrolling region, where a
// backdrop filter re-rasterises every frame. Coarse pointers get the same
// material composited to alpha 1 (--pill-bg-opaque), not a dropped effect.
const PILL_MATERIAL =
  "border-[0.5px] border-[var(--pill-border)] bg-[var(--pill-bg-opaque)] shadow-[var(--shadow-overlay)] " +
  "[@media(pointer:fine)]:bg-[var(--pill-bg)] [@media(pointer:fine)]:[backdrop-filter:blur(20px)_saturate(1.3)] " +
  "[@media(pointer:fine)]:[-webkit-backdrop-filter:blur(20px)_saturate(1.3)]"

// The cross-page pill system and the chat header pills share this primitive; the
// nav popover reuses the EXACT same material, only the radius differs.
export const PILL_CLASS = `pointer-events-auto inline-flex items-center gap-0.5 rounded-full p-1 ${PILL_MATERIAL}`

export function PillButton({
  onClick,
  title,
  ariaLabel,
  ariaExpanded,
  className,
  children,
}: {
  onClick?: () => void
  title?: string
  ariaLabel?: string
  ariaExpanded?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      className={cn(
        // Mobile controls keep a 44px target; desktop retains its compact chrome.
        "inline-flex size-11 lg:size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        "text-[var(--text-secondary)]",
        "hover:bg-[var(--fill-secondary)] hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Nav primitives — shared by the popover (non-chat pages) AND the chat route's
// in-surface list⇄nav swap, so the nav links read identically everywhere.
// ---------------------------------------------------------------------------

/** The single active-route rule used across the nav rail and the mobile tab bar. */
export function isNavItemActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href)
}

// ---------------------------------------------------------------------------
// NavRibbon — the chat route's permanent slim icon rail (~56px). Always mounted
// (desktop only). Icons-only at rest; the rail NEVER widens, so the chat list is
// never covered. Hovering/focusing a single icon springs ONLY that icon's label
// out as a small frosted pill to its right — a per-key "piano" reveal — while the
// icon itself lifts a touch (Dock-style). The top slot shows the Jinn logo at
// rest and cross-fades to the sidebar toggle on hover (ChatGPT-style). Active
// item = soft --fill-secondary, NEVER --accent.
// ---------------------------------------------------------------------------

// The floating label that springs out beside a hovered/focused icon. Calm and
// crisp: a flat opaque --bg-tertiary surface with a 0.5px --separator hairline
// and a subtle drop shadow — NO backdrop saturate (no colored halo) and NOT the
// heavy overlay shadow (no glow). Theme-aware, quiet, readable over the list.
// The icon carries the real aria-label, so the pill is decorative (aria-hidden).
// Under reduced motion it fades only (no slide).
const RIBBON_LABEL_PILL =
  "whitespace-nowrap rounded-full border-[0.5px] border-[var(--separator)] bg-[var(--bg-tertiary)] " +
  "px-2.5 py-1 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] " +
  "shadow-[var(--shadow-subtle)] " +
  "opacity-0 transition-[opacity,transform] duration-150 [transition-timing-function:var(--ease-snappy)] " +
  "motion-safe:-translate-x-1.5 group-hover/row:opacity-100 group-hover/row:translate-x-0 " +
  "group-focus-within/row:opacity-100 group-focus-within/row:translate-x-0 motion-reduce:transition-opacity"

/** One ribbon entry — a fixed 44px icon square. It never resizes; the label is a
 *  floating pill that escapes to the right on hover/focus (the piano reveal), and
 *  the icon lifts/scales a touch like a pressed Dock key. */
function RibbonRow({
  Icon,
  label,
  isActive,
  href,
  onClick,
}: {
  Icon: ComponentType<{ size?: number | string; className?: string }>
  label: string
  isActive?: boolean
  href?: string
  // Receives the click event so a link row can preventDefault a no-op
  // same-route navigation (used by the Chat icon to reveal the list instead).
  onClick?: (e: ReactMouseEvent) => void
}) {
  const cls = cn(
    "group/row relative flex size-11 shrink-0 items-center justify-center rounded-[12px] transition-colors duration-150 [transition-timing-function:var(--ease-smooth)]",
    isActive
      ? "bg-[var(--fill-secondary)] text-[var(--text-primary)]"
      : "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
  )
  const inner = (
    <>
      <span className="flex items-center justify-center transition-transform duration-150 [transition-timing-function:var(--ease-snappy)] motion-safe:group-hover/row:-translate-y-px motion-safe:group-hover/row:scale-110 motion-safe:group-active/row:scale-95 motion-reduce:transform-none">
        <Icon size={20} className="shrink-0" />
      </span>
      {/* Piano reveal — floats past the rail edge; flex-centers vertically so the
          inner pill is free to animate on the X axis. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-full z-50 ml-2 flex items-center">
        <span className={RIBBON_LABEL_PILL}>{label}</span>
      </span>
    </>
  )
  if (href) {
    return (
      <Link
        to={href} viewTransition
        onClick={onClick}
        onPointerEnter={() => prefetchRoute(href)}
        onFocus={() => prefetchRoute(href)}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        className={cls}
      >
        {inner}
      </Link>
    )
  }
  return (
    <button type="button" onClick={onClick} aria-label={label} className={cls}>
      {inner}
    </button>
  )
}

/** The slim icon nav rail. On the chat route `listOpen` + `onToggleList` drive
 *  the chat-list fold (top slot = logo↔toggle morph). Mounted globally elsewhere
 *  with NEITHER prop — then the top slot is a brand mark linking home, with no
 *  fold/toggle (there is no list to fold). */
export function NavRibbon({
  listOpen = false,
  onToggleList,
}: {
  listOpen?: boolean
  onToggleList?: () => void
}) {
  const { data: features } = useFeatures()
  const navItems = useNavigation(features?.notesEnabled === true).items
  const pathname = useLocation().pathname
  const { settings } = useSettings()
  const portalName = settings.portalName ?? "Jinn"
  // Default brand mark carries U+FE0F so the genie always renders as a COLOR
  // emoji (never a text-presentation glyph that would inherit the slot's text
  // color and look faded — see the brand-mark color note below).
  const emoji = settings.portalEmoji ?? "\u{1F9DE}\u{FE0F}"
  // The Chat icon is OPEN-ONLY. While already on the chat route ("/") with the
  // list collapsed, a plain click reveals the list instead of firing a dead
  // same-route navigation. Not on "/" → the Link navigates as before; list
  // already open → harmless no-op. Modified clicks (new tab/window) fall through
  // to the Link untouched. Closing the list stays the top toggle's job, so one
  // control never means both open and close.
  const onChatIconClick = (e: ReactMouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (onToggleList && pathname === "/" && !listOpen) {
      e.preventDefault()
      onToggleList()
    }
  }
  return (
    // The placeholder reserves the rail width (w-14 = 56px) in the flex row; the
    // real rail floats above it so the per-icon label pills can escape to the
    // right (over the list / thread) without widening the rail or reflowing it.
    <div className="relative hidden h-full w-14 shrink-0 lg:block">
      {/* Named so a route change snapshots the rail apart from the page — globals.css. */}
      <nav aria-label="Primary"
        className="absolute inset-y-0 left-0 z-30 flex w-14 flex-col items-center gap-0.5 bg-[var(--ribbon-bg)] px-1.5 pb-2.5 pt-3.5 [view-transition-name:jinn-nav-rail]"
      >
        {/* Top slot — a plain, button-sized Jinn brand mark that fills the rail
            top (no frosted-pill chrome). It morphs to the sidebar.left toggle
            while the pointer is anywhere over the LEFT region — the rail AND the
            chat-list column (ChatGPT-style, via group/sidebar on the region
            wrapper in chat/page.tsx) — or while the button is focused after a
            click; it reverts to the logo on mouse-leave. The thread/main content
            sits outside that group, so hovering it never triggers the morph.
            pt-3.5 centers the 44px button on the same y (~36px) as the thread's
            right actions pill, so rail-top and header read as one row. */}
        <div className="group/logo mb-1">
          {onToggleList ? (
            <button
              type="button"
              onClick={onToggleList}
              title={listOpen ? "Hide chats" : "Show chats"}
              aria-label={listOpen ? "Hide chats" : "Show chats"}
              aria-expanded={listOpen}
              className="relative flex size-11 items-center justify-center rounded-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
            >
              {/* Full-strength brand color (NOT the button's --text-secondary) +
                  forced color-emoji presentation, so the genie — or a custom
                  monochrome/letter portalEmoji — reads crisp at rest in BOTH
                  themes instead of inheriting the muted secondary text token. */}
              <span
                aria-hidden
                className="absolute inset-0 flex items-center justify-center text-[26px] leading-none text-[var(--text-primary)] [font-variant-emoji:emoji] transition-opacity duration-150 group-hover/sidebar:opacity-0 group-focus-within/logo:opacity-0"
              >
                {emoji}
              </span>
              <PanelLeft
                size={22}
                className="opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100 group-focus-within/logo:opacity-100"
              />
            </button>
          ) : (
            // Global (non-chat) rail: no list to fold, so the top slot is a plain
            // brand mark that links home. Same full-strength color + forced
            // color-emoji presentation as the chat variant — no toggle/morph.
            <Link
              to="/" viewTransition
              onPointerEnter={() => prefetchRoute("/")}
              onFocus={() => prefetchRoute("/")}
              aria-label={portalName}
              title={portalName}
              className="relative flex size-11 items-center justify-center rounded-[12px] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              <span
                aria-hidden
                className="flex items-center justify-center text-[26px] leading-none text-[var(--text-primary)] [font-variant-emoji:emoji]"
              >
                {emoji}
              </span>
            </Link>
          )}
        </div>

        {/* Nav icons — per-icon piano reveal. */}
        {navItems.map((item) => (
          <RibbonRow
            key={item.href}
            Icon={item.icon}
            label={item.label}
            href={item.href}
            isActive={isNavItemActive(item.href, pathname)}
            onClick={item.href === "/" ? onChatIconClick : undefined}
          />
        ))}
      </nav>
    </div>
  )
}
