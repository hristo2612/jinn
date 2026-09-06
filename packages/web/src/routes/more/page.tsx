import { Link } from "react-router-dom"
import { ChevronRight, Sun, Moon, Palette, type LucideIcon } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { useTheme } from "@/routes/providers"
import { THEMES, type ThemeId } from "@/lib/themes"
import type { NavItem } from "@/lib/nav"
import { useNavigation } from "@/lib/use-navigation"
import { cn } from "@/lib/utils"
import { useFeatures } from "@/hooks/use-features"
import { WorkspacesGroup } from "./workspaces-group"
// GRS-022 — the mobile "More" overflow. The 4th bottom-tab slot opens this
// grouped iOS-Settings-style screen holding every destination that isn't a
// primary tab. Reachable at /more (deep-linkable); the mobile tab bar keeps its
// More icon lit while any of these children is open. Desktop still reaches all
// of these from the NavRibbon rail — this screen is the phone's overflow home.

// Per-row icon tint — a filled rounded square (iOS Settings vibe). Theme-aware
// via the shared system tokens; the accent square uses the on-accent contrast
// token for its glyph, the colored squares use white.
const TINT: Record<string, { bg: string; fg: string }> = {
  "/org": { bg: "var(--system-blue)", fg: "#fff" },
  "/cron": { bg: "var(--system-orange)", fg: "#fff" },
  "/skills": { bg: "var(--accent)", fg: "var(--accent-contrast)" },
  "/logs": { bg: "var(--system-green)", fg: "#fff" },
  "/limits": { bg: "var(--system-blue)", fg: "#fff" },
  "/settings": { bg: "var(--text-tertiary)", fg: "var(--bg-secondary)" },
}

function RowIcon({ Icon, href }: { Icon: LucideIcon; href: string }) {
  const tint = TINT[href] ?? { bg: "var(--text-tertiary)", fg: "#fff" }
  return (
    <span
      className="flex size-[29px] shrink-0 items-center justify-center rounded-[8px]"
      style={{ background: tint.bg, color: tint.fg }}
    >
      <Icon size={17} className="shrink-0" aria-hidden />
    </span>
  )
}

function LinkRow({ item, first }: { item: NavItem; first: boolean }) {
  const Icon = item.icon
  return (
    <Link
      to={item.href}
      className={cn(
        "flex min-h-[52px] flex-wrap items-center gap-3 py-1.5 px-3.5 text-[var(--text-primary)] transition-colors active:bg-[var(--fill-secondary)]",
        !first && "border-t-[0.5px] border-[var(--separator)]",
      )}
    >
      <RowIcon Icon={Icon} href={item.href} />
      <span className="flex-1 text-[length:var(--text-body)] font-[var(--weight-medium)] tracking-[-0.01em]">
        {item.label}
      </span>
      <ChevronRight size={18} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden />
    </Link>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] shadow-[var(--shadow-card)]">
      {children}
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-[7px] pt-4 text-[length:var(--text-caption1)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
      {children}
    </div>
  )
}

function ThemeIcon({ theme }: { theme: ThemeId }) {
  if (theme === "light") return <Sun size={17} aria-hidden />
  if (theme === "dark") return <Moon size={17} aria-hidden />
  return <Palette size={17} aria-hidden />
}

/** Appearance row — an inline Light/Dark/System segmented control wired to the
 *  live theme. Re-homes the theme cycle that used to live in the nav footer. */
function AppearanceRow() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="flex min-h-[52px] flex-wrap items-center gap-3 py-1.5 border-t-[0.5px] border-[var(--separator)] px-3.5">
      <span
        className="flex size-[29px] shrink-0 items-center justify-center rounded-[8px]"
        style={{ background: "var(--text-tertiary)", color: "var(--bg-secondary)" }}
      >
        <ThemeIcon theme={theme} />
      </span>
      <span className="flex-1 text-[length:var(--text-body)] font-[var(--weight-medium)] tracking-[-0.01em] text-[var(--text-primary)]">
        Appearance
      </span>
      <div className="flex items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5" role="group" aria-label="Appearance">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTheme(t.id)}
            aria-pressed={theme === t.id}
            className={cn(
              "min-h-[40px] md:min-h-0 rounded-full px-3 py-1 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] transition-[background-color,color,box-shadow]",
              theme === t.id
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)] shadow-[var(--shadow-subtle)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function MorePage() {
  const { data: features } = useFeatures()
  // Subscribed, not a module-time snapshot: this list is the phone's only route
  // to an overflow destination, so a sidebar.nav row from a plugin enabled after
  // boot has to reach it. Settings is held out for the App group below.
  const navigation = useNavigation(features?.notesEnabled === true)
  const overflowLinks = navigation.overflowItems.filter((item) => item.href !== "/settings")
  const settings = navigation.items.find((item) => item.href === "/settings")!

  return (
    <PageLayout>
      <PageScaffold contentWidth="560px" header={<LargeTitleHeader title="More" />}>
        <div>
          <div className="mt-5">
            <Card>
              {overflowLinks.map((item, i) => (
                <LinkRow key={item.href} item={item} first={i === 0} />
              ))}
            </Card>
          </div>

          <GroupLabel>App</GroupLabel>
          <Card>
            <LinkRow item={settings} first />
            <AppearanceRow />
          </Card>

          <WorkspacesGroup />
        </div>
      </PageScaffold>
    </PageLayout>
  )
}
