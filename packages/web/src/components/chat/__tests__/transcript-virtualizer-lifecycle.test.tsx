import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTranscriptVirtualizer } from '../transcript-virtualizer'
import { fakeScroller } from './fake-scroller'
import type { RenderGroup } from '../chat-messages'

const groups = Array.from({ length: 60 }, () => ({
  kind: 'plain', item: { kind: 'message' },
})) as RenderGroup[]
const keys = groups.map((_, index) => `g${index}`)

describe('virtual transcript scroll observer lifetime', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('reports scrolling immediately and settles after the latest scroll', () => {
    const { el } = fakeScroller(() => 4000)
    const { result, unmount } = renderHook(() => useTranscriptVirtualizer(groups, keys, true, () => el, 0))
    const delay = result.current.options.isScrollingResetDelay

    act(() => { el.dispatchEvent(new Event('scroll')) })
    expect(result.current.isScrolling).toBe(true)
    act(() => { vi.advanceTimersByTime(delay - 1) })
    act(() => { el.dispatchEvent(new Event('scroll')) })
    act(() => { vi.advanceTimersByTime(delay - 1) })
    expect(result.current.isScrolling).toBe(true)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.isScrolling).toBe(false)
    unmount()
  })

  it.each(['unmount', 'disable', 'replace'] as const)('cancels a pending scroll-end callback on %s', (transition) => {
    const { el } = fakeScroller(() => 4000)
    const { el: replacement } = fakeScroller(() => 4000)
    const { result, rerender, unmount } = renderHook(
      ({ enabled, node }) => useTranscriptVirtualizer(groups, keys, enabled, () => node, 0),
      { initialProps: { enabled: true, node: el } },
    )
    act(() => { el.dispatchEvent(new Event('scroll')) })
    expect(result.current.isScrolling).toBe(true)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    if (transition === 'unmount') unmount()
    else rerender({ enabled: transition !== 'disable', node: transition === 'replace' ? replacement : el })

    expect(vi.getTimerCount()).toBe(0)
    // Detached observers must neither schedule new work nor report a late stop
    // into the next transcript (or a jsdom environment already torn down).
    act(() => { el.dispatchEvent(new Event('scroll')); vi.runAllTimers() })
    expect(result.current.isScrolling).toBe(true)
    unmount()
  })

  it('has no callback left to update React after the window is torn down', () => {
    const { el } = fakeScroller(() => 4000)
    const { unmount } = renderHook(() => useTranscriptVirtualizer(groups, keys, true, () => el, 0))
    act(() => { el.dispatchEvent(new Event('scroll')) })
    unmount()

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')!
    Reflect.deleteProperty(globalThis, 'window')
    try {
      expect(() => { vi.runAllTimers() }).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'window', descriptor)
    }
  })
})
