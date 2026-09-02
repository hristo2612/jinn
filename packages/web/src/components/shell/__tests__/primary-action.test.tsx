import { render, screen } from "@testing-library/react"
import { Plus } from "lucide-react"
import { describe, expect, it } from "vitest"
import { LargeTitleHeader } from "../large-title-header"
import { PageScaffold } from "../page-scaffold"
import { FAB_BOTTOM_WITH_TAB, FAB_BOTTOM_WITHOUT_TAB, PRIMARY_ACTION_SLOT, PrimaryAction } from "../primary-action"

describe("PrimaryAction", () => {
  it("renders a mobile FAB and a labelled desktop trailing control from one call site", () => {
    render(
      <PageScaffold
        header={<LargeTitleHeader title="Workflows" />}
        primaryAction={
          <PrimaryAction
            aria-label="New workflow"
            label="New workflow"
            icon={<Plus />}
            onClick={() => {}}
          />
        }
      >
        <p>list</p>
      </PageScaffold>,
    )

    const slots = document.querySelectorAll(`[data-slot="${PRIMARY_ACTION_SLOT}"]`)
    expect(slots.length).toBe(2)
    const fab = document.querySelector("[data-primary-action='fab']")
    const trailing = document.querySelector("[data-primary-action='trailing']")
    expect(fab).toBeTruthy()
    expect(trailing).toBeTruthy()
    expect(fab?.className).toContain("lg:hidden")
    expect(trailing?.className).toContain("hidden")
    expect(trailing?.className).toContain("lg:inline-flex")
    expect(fab?.getAttribute("aria-label")).toBe("New workflow")
    expect(trailing?.textContent).toContain("New workflow")
  })

  // `StatusBar` holds the whole column clear of the fixed tab bar, so the FAB's
  // containing block already stops above it. Re-adding that clearance to the
  // offset counted it twice and floated the button ~180px up, mid-list.
  it("clears the column's bottom edge by one gutter, not the tab bar a second time", () => {
    expect(FAB_BOTTOM_WITH_TAB).toBe("var(--space-4)")
    expect(FAB_BOTTOM_WITH_TAB).not.toContain("--tab-bar-height")
    expect(FAB_BOTTOM_WITH_TAB).not.toMatch(/\b5[56]px\b/)
    expect(FAB_BOTTOM_WITHOUT_TAB).not.toMatch(/\b5[56]px\b/)
    expect(FAB_BOTTOM_WITHOUT_TAB).not.toContain("--tab-bar-height")

    render(
      <PageScaffold
        header={<LargeTitleHeader title="Todos" />}
        primaryAction={<PrimaryAction aria-label="New todo" label="New Todo" onClick={() => {}} />}
      >
        <p>board</p>
      </PageScaffold>,
    )
    const fab = document.querySelector("[data-primary-action='fab']") as HTMLElement
    expect(fab.className).toContain(`bottom-[${FAB_BOTTOM_WITH_TAB}]`)
    expect(fab.className).not.toContain("--tab-bar-height")
    expect(fab.className).not.toMatch(/\b5[56]px\b/)
    expect(fab.className).toContain("size-[var(--fab-size)]")
    // The disc lines up with the mobile page gutter, so its right edge is the
    // card's right edge, and the glyph is centred in the disc on both axes.
    expect(fab.className).toContain("right-[var(--space-3)]")
    expect(fab.className).toContain("items-center")
    expect(fab.className).toContain("justify-center")
  })

  // A pushed page unmounts the tab bar AND the status row, so its column really
  // does reach the viewport edge and its offset must keep clearing the safe area.
  it("leaves the pushed page's offset byte-identical", () => {
    expect(FAB_BOTTOM_WITHOUT_TAB).toBe("calc(max(var(--safe-bottom),6px)+var(--space-4))")

    render(
      <PageScaffold
        hideMobileTabBar
        header={<LargeTitleHeader title="Task" />}
        primaryAction={<PrimaryAction aria-label="Save" label="Save" onClick={() => {}} />}
      >
        <p>body</p>
      </PageScaffold>,
    )
    const fab = document.querySelector("[data-primary-action='fab']") as HTMLElement
    expect(fab.className).toContain("bottom-[calc(max(var(--safe-bottom),6px)+var(--space-4))]")
    expect(fab.className).not.toContain(`bottom-[${FAB_BOTTOM_WITH_TAB}]`)
  })

  // An `outline` paints outside the border box. The disc's right edge is the
  // page gutter, so an outlined FAB is a wider button sitting off that rail —
  // which is exactly how the focused FAB read next to an unfocused one.
  it("draws the focus ring inside the disc, so focus never resizes the button", () => {
    render(<PrimaryAction aria-label="New" label="New" icon={<Plus />} onClick={() => {}} />)
    const fab = document.querySelector("[data-primary-action='fab']") as HTMLElement

    expect(fab.className).not.toContain("outline-offset")
    expect(fab.className).not.toMatch(/focus-visible:outline-\d/)
    expect(fab.className).toContain("outline-none")

    const focusRing = fab.className
      .split(/\s+/)
      .find((cls) => cls.startsWith("focus-visible:shadow-["))
    expect(focusRing).toBeDefined()
    expect(focusRing).toContain("inset_0_0_0_4px_var(--accent-contrast)")
    // Every layer of the focused shadow is inset or the disc's own resting
    // shadow, so no focus layer reaches past the disc's edge.
    expect(focusRing).not.toMatch(/,(?!inset_|var\(--shadow-key\)|var\(--inset-shine\))/)

    // The box itself is untouched by focus: one size, one right edge.
    expect(fab.className).toContain("size-[var(--fab-size)]")
    expect(fab.className).toContain("right-[var(--space-3)]")
    expect(fab.className).not.toMatch(/focus-visible:(size|right|p|m)-/)
  })

  it("disabled FAB drops the accent fill", () => {
    render(<PrimaryAction aria-label="New" label="New" disabled onClick={() => {}} />)
    const fab = screen.getByRole("button", { name: "New" })
    expect((fab as HTMLButtonElement).disabled).toBe(true)
    expect(fab.className).toContain("--fill-tertiary")
  })
})
