import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { type CapturedObserver, dist, Harness, setMetrics, stubScrollEnvironment } from './stick-harness'

// Involuntary re-pins (both ResizeObservers, visibility/pageshow) must not
// write over a reader who already owns the scroller — by having moved it, or
// by still having a finger/glide on it. The jump button is the one write that
// still goes through immediately.

let roInstances: CapturedObserver[] = []

beforeEach(() => { roInstances = stubScrollEnvironment() })
afterEach(() => { vi.unstubAllGlobals() })

describe('useStickToBottom — involuntary re-pin', () => {
  it('content-growth: a resize landing after the reader has already moved writes nothing', () => {
    const view = render(<Harness messageCount={0} />)
    const el = view.getByTestId('scroller')
    const content = view.getByTestId('content')
    setMetrics(el, 1000, 200, 0)
    const scrollToEnd = vi.fn((_behavior: ScrollBehavior) => { el.scrollTop = el.scrollHeight })
    act(() => { view.rerender(<Harness messageCount={5} scrollToEnd={scrollToEnd} />) })
    expect(dist(el)).toBe(0) // following, pinned
    scrollToEnd.mockClear()

    // The first drag up from pure bottom mounts previously-unmeasured rows, and
    // they resize the content in the SAME frame — before the scroll event that
    // would detach follow has been processed. `followRef` still says true about a
    // position that is no longer ours, so the observer must believe the position.
    el.scrollTop = 400
    const contentObservers = roInstances.filter((r) => r.observed.includes(content))
    act(() => { contentObservers.forEach((r) => r.cb([], {} as ResizeObserver)) })

    expect(el.scrollTop).toBe(400)
    expect(scrollToEnd).not.toHaveBeenCalled()
  })

  it('touch phase: no involuntary re-pin writes mid-glide, but the jump button still does', () => {
    const view = render(<Harness messageCount={0} />)
    const el = view.getByTestId('scroller')
    const content = view.getByTestId('content')
    setMetrics(el, 1000, 200, 0)
    act(() => { view.rerender(<Harness messageCount={5} />) }) // following, pinned
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })

    // A finger takes the scroller. Assigning `scrollTop` from here ends WebKit's
    // fling on the spot, which is the list going sticky instead of sliding — so
    // every write nobody asked for waits for the glide to finish.
    act(() => { fireEvent.touchStart(el) })
    const held = el.scrollTop
    setMetrics(el, 1400, 200, held) // content grew under an untouched position

    const contentObservers = roInstances.filter((r) => r.observed.includes(content))
    const viewportObservers = roInstances.filter((r) => r.observed.includes(el))
    act(() => { contentObservers.forEach((r) => r.cb([], {} as ResizeObserver)) })
    expect(el.scrollTop).toBe(held)
    act(() => { viewportObservers.forEach((r) => r.cb([], {} as ResizeObserver)) })
    expect(el.scrollTop).toBe(held)
    act(() => { fireEvent(document, new Event('visibilitychange')) })
    expect(el.scrollTop).toBe(held)

    // A scroll the reader asked for supersedes the glide and lands immediately.
    act(() => { fireEvent.click(view.getByTestId('btn')) })
    expect(dist(el)).toBe(0)
  })
})
