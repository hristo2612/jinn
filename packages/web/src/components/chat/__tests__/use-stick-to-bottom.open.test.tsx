import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import { STICK_THRESHOLD_PX } from '@/hooks/stick-geometry'
import { Harness, setClampedMetrics, setMetrics, stubScrollEnvironment } from './stick-harness'

// The two rules ICI-821 changed: where a transcript opens, and when the arrow
// offering to take the reader back to the bottom is worth showing at all.

beforeEach(() => { stubScrollEnvironment() })
afterEach(() => { vi.unstubAllGlobals() })

describe('useStickToBottom — the jump arrow is a second decision', () => {
  const open = () => {
    const view = render(<Harness messageCount={0} />)
    const el = view.getByTestId('scroller')
    setMetrics(el, 1000, 200, 0)
    act(() => { view.rerender(<Harness messageCount={5} />) })
    return { ...view, el }
  }

  it('stays hidden when a scroll away ends within the threshold', () => {
    const { getByTestId, el } = open()
    act(() => { el.scrollTop = 1000 - 200 - STICK_THRESHOLD_PX; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('hide')
  })

  it('appears when the same scroll ends past the threshold', () => {
    const { getByTestId, el } = open()
    act(() => { el.scrollTop = 1000 - 200 - (STICK_THRESHOLD_PX + 1); fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
  })

  it('detaches follow-intent even where the arrow stays hidden', () => {
    const { getByTestId, el, rerender } = open()
    act(() => { el.scrollTop = 1000 - 200 - 4; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('hide')
    const readingPos = el.scrollTop
    setMetrics(el, 1600, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} latestMessageKey="m6" />) })
    expect(el.scrollTop).toBe(readingPos)
  })

  it('is not re-engaged by a compensating scroll that leaves the gap alone', () => {
    const { getByTestId, el, rerender } = open()
    // Detached inside the band, arrow hidden — the case a fold's anchor loop runs in.
    act(() => { el.scrollTop = 1000 - 200 - 4; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('hide')

    // A fold shrinks and the compensation scrolls up by the same amount: the
    // position moved, the reader's distance from the bottom did not.
    setMetrics(el, 1300, 200, el.scrollTop + 300)
    act(() => { fireEvent.scroll(el) })

    // Still theirs: the next message does not pin them.
    const readingPos = el.scrollTop
    setMetrics(el, 1700, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} latestMessageKey="m6" />) })
    expect(el.scrollTop).toBe(readingPos)
  })

  it('is not toggled by a programmatic scroll', () => {
    const { getByTestId, el, rerender } = open()
    // Growth pins the reader from far above the bottom: our write, not theirs.
    act(() => { el.scrollTop = 100; fireEvent.scroll(el) })
    expect(getByTestId('jump').textContent).toBe('show')
    act(() => { fireEvent.click(getByTestId('btn')) })
    expect(getByTestId('jump').textContent).toBe('hide')
    setMetrics(el, 2400, 200, el.scrollTop)
    act(() => { rerender(<Harness messageCount={6} latestMessageKey="m6" />) })
    act(() => { fireEvent.scroll(el) }) // the pin's own scroll event
    expect(getByTestId('jump').textContent).toBe('hide')
  })
})

describe('useStickToBottom — opening a virtualised transcript', () => {
  it('reaches the true bottom through the virtualizer, not a scrollHeight write', () => {
    // Rows enter at estimates and re-measure larger, so `scrollHeight` at open time
    // is short of the real end. `scrollToEnd` re-targets; one raw write cannot.
    let scrollHeight = 4000
    const view = render(<Harness messageCount={0} />)
    const el = view.getByTestId('scroller')
    setClampedMetrics(el, () => scrollHeight, 200)
    const scrollToEnd = vi.fn((_behavior: ScrollBehavior) => { el.scrollTop = scrollHeight })
    act(() => { view.rerender(<Harness messageCount={80} scrollToEnd={scrollToEnd} />) })

    expect(scrollToEnd).toHaveBeenCalledWith('auto')
    expect(el.scrollTop).toBe(4000 - 200)

    // A late measurement moves the true bottom down; the settle window follows it.
    scrollHeight = 5200
    act(() => { view.rerender(<Harness messageCount={80} scrollToEnd={scrollToEnd} />) })
    expect(el.scrollTop).toBe(5200 - 200)
  })

  it('makes no raw scrollHeight write of its own on the way there', () => {
    // The open and the growth commit both want the bottom, and both land on the
    // same commit. A raw `scrollTop = scrollHeight` from either aims at the
    // estimate the window is painting, and lands after the virtualizer's answer.
    const scrollHeight = 4000
    let insideVirtualizer = false
    const sources: string[] = []
    const view = render(<Harness messageCount={0} />)
    const el = view.getByTestId('scroller')
    setClampedMetrics(el, () => scrollHeight, 200)
    const raw = Object.getOwnPropertyDescriptor(el, 'scrollTop')!
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: raw.get,
      set: (v: number) => { sources.push(insideVirtualizer ? 'virtualizer' : 'raw'); raw.set!.call(el, v) },
    })
    const scrollToEnd = (_behavior: ScrollBehavior) => {
      insideVirtualizer = true
      el.scrollTop = scrollHeight
      insideVirtualizer = false
    }
    act(() => { view.rerender(<Harness messageCount={80} scrollToEnd={scrollToEnd} />) })

    expect(sources).not.toContain('raw')
    expect(el.scrollTop).toBe(4000 - 200)
  })

  it('is not detached by the transcript holding a row still while it measures', () => {
    // A windowed transcript measures itself for a beat after opening: a row that
    // resolves taller ABOVE the reader is held still by moving the position, and
    // one below moves the bottom down. Both arrive as scroll events, and reading
    // them as the reader scrolling up is what leaves an open above the bottom.
    let scrollHeight = 4000
    let written: number | undefined
    const view = render(<Harness messageCount={0} />)
    const el = view.getByTestId('scroller')
    setClampedMetrics(el, () => scrollHeight, 200)
    const scrollToEnd = () => { el.scrollTop = scrollHeight; written = el.scrollTop }
    const takeLastWriteTop = () => { const top = written; written = undefined; return top }
    const props = { scrollToEnd, takeLastWriteTop }
    act(() => { view.rerender(<Harness messageCount={80} {...props} />) })
    expect(el.scrollTop).toBe(4000 - 200)

    scrollHeight = 4600
    act(() => { el.scrollTop = 3920; written = el.scrollTop; fireEvent.scroll(el) })

    // Still theirs to follow: the next message pins to the bottom that moved.
    act(() => { view.rerender(<Harness messageCount={81} latestMessageKey="m81" {...props} />) })
    expect(el.scrollTop).toBe(4600 - 200)
  })

  it('opens on a remembered offset without snapping to the bottom first', () => {
    const view = render(<Harness messageCount={0} />)
    const el = view.getByTestId('scroller')
    setClampedMetrics(el, () => 4000, 200)
    const scrollToEnd = vi.fn()
    act(() => { view.rerender(<Harness messageCount={80} initialScrollTop={900} scrollToEnd={scrollToEnd} />) })

    expect(el.scrollTop).toBe(900)
    expect(scrollToEnd).not.toHaveBeenCalled()
    // And the reader is left detached, so the next message does not yank them down.
    setMetrics(el, 4600, 200, el.scrollTop)
    act(() => { view.rerender(<Harness messageCount={81} latestMessageKey="m81" initialScrollTop={900} />) })
    expect(el.scrollTop).toBe(900)
  })
})
