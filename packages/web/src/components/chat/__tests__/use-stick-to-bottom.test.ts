import { describe, it, expect } from 'vitest'
import {
  distanceFromBottom,
  rememberScrollTop,
  scrollTopToRemember,
  shouldFollow,
  unreadDelta,
  STICK_THRESHOLD_PX,
} from '@/hooks/stick-geometry'

// Pins the pure scroll math the stick-to-bottom hook builds on. The hook's
// DOM/observer wiring is exercised by the Playwright behaviour tests (jsdom has
// no layout, so scrollHeight/clientHeight are meaningless there); these lock the
// arithmetic that decides "am I at the bottom" and "how many unread".

describe('distanceFromBottom', () => {
  it('is 0 when pinned to the bottom', () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(0)
  })

  it('is the gap between the viewport bottom and content bottom', () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 200 })).toBe(500)
  })

  it('clamps negative overscroll (rubber-banding) to 0', () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 200 })).toBe(0)
  })

  it('is 0 when content is shorter than the viewport', () => {
    expect(distanceFromBottom({ scrollHeight: 150, scrollTop: 0, clientHeight: 400 })).toBe(0)
  })
})

describe('shouldFollow', () => {
  it('follows when exactly at the bottom', () => {
    expect(shouldFollow(0)).toBe(true)
  })

  it('follows at the threshold boundary (inclusive)', () => {
    expect(shouldFollow(STICK_THRESHOLD_PX)).toBe(true)
  })

  it('detaches one px past the threshold', () => {
    expect(shouldFollow(STICK_THRESHOLD_PX + 1)).toBe(false)
  })

  it('detaches when far from the bottom', () => {
    expect(shouldFollow(2000)).toBe(false)
  })

  it('respects a custom threshold', () => {
    expect(shouldFollow(100, 120)).toBe(true)
    expect(shouldFollow(140, 120)).toBe(false)
  })
})

describe('unreadDelta', () => {
  it('is 0 when caught up', () => {
    expect(unreadDelta(12, 12)).toBe(0)
  })

  it('counts messages added since the last catch-up', () => {
    expect(unreadDelta(15, 12)).toBe(3)
  })

  it('never goes negative if the count somehow shrinks', () => {
    expect(unreadDelta(10, 12)).toBe(0)
  })
})

describe('scrollTopToRemember', () => {
  it('remembers nothing for a reader who left at the bottom', () => {
    expect(scrollTopToRemember({ scrollHeight: 4000, scrollTop: 3800, clientHeight: 200 })).toBeUndefined()
  })

  it('remembers nothing inside the threshold band either', () => {
    const scrollTop = 4000 - 200 - STICK_THRESHOLD_PX
    expect(scrollTopToRemember({ scrollHeight: 4000, scrollTop, clientHeight: 200 })).toBeUndefined()
  })

  it('remembers a genuine scrolled-up position', () => {
    const justPast = 4000 - 200 - (STICK_THRESHOLD_PX + 1)
    expect(scrollTopToRemember({ scrollHeight: 4000, scrollTop: justPast, clientHeight: 200 })).toBe(justPast)
    expect(scrollTopToRemember({ scrollHeight: 4000, scrollTop: 900, clientHeight: 200 })).toBe(900)
  })
})

describe('rememberScrollTop', () => {
  it('forgets a stored position when the reader left at the bottom', () => {
    const store = new Map<string, number>([['s1', 900]])
    rememberScrollTop(store, 's1', { scrollHeight: 4000, scrollTop: 3800, clientHeight: 200 })
    expect(store.has('s1')).toBe(false)
  })

  it('records a genuine scrolled-up position', () => {
    const store = new Map<string, number>()
    rememberScrollTop(store, 's1', { scrollHeight: 4000, scrollTop: 900, clientHeight: 200 })
    expect(store.get('s1')).toBe(900)
  })
})
