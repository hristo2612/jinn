import { render, screen, waitFor } from "@testing-library/react"
import { useLayoutEffect, useRef, type RefObject } from "react"
import { describe, expect, it } from "vitest"
import { useScrollAnchor } from "@/hooks/use-scroll-anchor"
import { LargeTitleHeader } from "../large-title-header"
import {
  PageScaffold,
  scaffoldBottomPadding,
  useScaffoldScrollElement,
} from "../page-scaffold"
import { PrimaryAction } from "../primary-action"

function ScrollProbe() {
  const el = useScaffoldScrollElement()
  return <div data-testid="scroll-probe" data-wired={el ? "yes" : "no"} data-scrollable={el?.hasAttribute("data-scrollable") ? "yes" : "no"} />
}

describe("PageScaffold", () => {
  it("owns a scrollport that carries data-scrollable and holds the header", () => {
    const { container } = render(
      <PageScaffold header={<LargeTitleHeader title="Settings" />}>
        <p>Body</p>
      </PageScaffold>,
    )

    const scroll = container.querySelector("[data-scrollable]")
    expect(scroll).toBeTruthy()
    expect(scroll?.querySelector(".jinn-large-title")).toBeTruthy()
    expect(scroll?.textContent).toContain("Body")
  })

  // The route owns its scrollports, so the scaffold builds none — and with no
  // scrollport of its own there is nothing for the collapse timeline to read.
  // A permanent large title is the contract for `scroll="external"`, not a
  // degradation: `/todos` is not expected to collapse.
  it("scroll=external builds no scroll box, and so no collapsed title bar", () => {
    const { container } = render(
      <PageScaffold scroll="external" header={<LargeTitleHeader title="Todos" />}>
        <div data-testid="page-scroller" data-scrollable />
      </PageScaffold>,
    )

    const scrollables = container.querySelectorAll("[data-scrollable]")
    expect(scrollables).toHaveLength(1)
    expect(scrollables[0].getAttribute("data-testid")).toBe("page-scroller")
    expect(container.querySelector(".jinn-large-title")).toBeTruthy()
    expect(container.querySelector(".jinn-inline-title")).toBeNull()
  })

  it("publishes the scroll node through state so a descendant sees it after commit", async () => {
    render(
      <PageScaffold header={<LargeTitleHeader title="Skills" />}>
        <ScrollProbe />
      </PageScaffold>,
    )

    await waitFor(() => {
      expect(screen.getByTestId("scroll-probe").dataset.wired).toBe("yes")
    })
    expect(screen.getByTestId("scroll-probe").dataset.scrollable).toBe("yes")
  })

  it("never writes the scroll position", () => {
    const { container } = render(
      <PageScaffold header={<LargeTitleHeader title="Cron" />}>
        <p>rows</p>
      </PageScaffold>,
    )
    const scroll = container.querySelector("[data-scrollable]") as HTMLElement
    scroll.scrollTop = 40
    scroll.dispatchEvent(new Event("scroll"))
    expect(scroll.scrollTop).toBe(40)
  })

  // `calc()` reads `+` as an operator only when it is whitespace-delimited on
  // both sides. Unspaced there is no error to see: the declaration is dropped
  // and the scrollport's padding-bottom resolves to 0, FAB and tab bar covering
  // the last rows of every list.
  it("emits a calc whose operators are whitespace-delimited, so the declaration parses", () => {
    const combinations = [
      { hasPrimaryAction: false, hideMobileTabBar: false },
      { hasPrimaryAction: true, hideMobileTabBar: false },
      { hasPrimaryAction: true, hideMobileTabBar: true },
    ]
    for (const combination of combinations) {
      expect(scaffoldBottomPadding(combination)).not.toMatch(/\S\+|\+\S/)
    }
  })

  // With the tab bar up the column already clears it, so the pad reserves only
  // what actually floats over the scrollport: the disc and its gutter. The
  // safe area comes back only on a pushed page, where the column owns the edge.
  it("below-lg bottom padding reserves the FAB, not the tab bar, with no 55/56px literal", () => {
    const pad = scaffoldBottomPadding({ hasPrimaryAction: true, hideMobileTabBar: false })
    expect(pad).not.toContain("--tab-bar-height")
    expect(pad).toContain("var(--fab-size)")
    expect(pad).not.toMatch(/\b5[56]px\b/)
    expect(pad).not.toContain("--safe-bottom")
    expect(scaffoldBottomPadding({ hasPrimaryAction: false, hideMobileTabBar: false })).not.toContain("var(--fab-size)")
    expect(scaffoldBottomPadding({ hasPrimaryAction: true, hideMobileTabBar: true })).toContain("--safe-bottom")
    expect(scaffoldBottomPadding({ hasPrimaryAction: false, hideMobileTabBar: true })).not.toContain("--tab-bar-height")

    const { container } = render(
      <PageScaffold
        header={<LargeTitleHeader title="Workflows" />}
        primaryAction={<PrimaryAction aria-label="New workflow" label="New workflow" onClick={() => {}} />}
      >
        <p>list</p>
      </PageScaffold>,
    )
    const scroll = container.querySelector("[data-scrollable]") as HTMLElement
    expect(scroll.style.getPropertyValue("--jinn-scaffold-bottom")).toBe(pad)
    expect(scroll.className).toContain("pb-[var(--jinn-scaffold-bottom)]")
    expect(scroll.className).toContain("lg:pb-10")
  })
})

describe("Todos windowing and scroll anchoring", () => {
  it("gives the virtualizer and useScrollAnchor the same non-null scaffold node", async () => {
    let virtualizerEl: HTMLElement | null = null
    let anchorEl: HTMLElement | null = null

    function Consumer() {
      const el = useScaffoldScrollElement()
      virtualizerEl = el
      const ref = useRef<HTMLElement | null>(null)
      ;(ref as RefObject<HTMLElement | null>).current = el
      useScrollAnchor(ref)
      useLayoutEffect(() => {
        anchorEl = ref.current
      })
      return <div data-testid="list-body">rows</div>
    }

    render(
      <PageScaffold header={<LargeTitleHeader title="Todos" />}>
        <Consumer />
      </PageScaffold>,
    )

    await waitFor(() => {
      expect(virtualizerEl).not.toBeNull()
      expect(anchorEl).toBe(virtualizerEl)
      expect(virtualizerEl?.hasAttribute("data-scrollable")).toBe(true)
    })
  })
})
