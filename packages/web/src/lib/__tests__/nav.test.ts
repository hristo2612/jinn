import { describe, it, expect } from 'vitest'
import { NAV_ITEMS, MOBILE_TAB_ITEMS, OVERFLOW_ITEMS, MORE_NAV_ITEM } from '../nav'

// Notes are feature-gated, so the default tab bar contains the remaining primary
// surfaces and More, with everything else under the More
// overflow screen.
describe('MOBILE_TAB_ITEMS', () => {
  it('has exactly 4 entries while Notes is disabled', () => {
    expect(MOBILE_TAB_ITEMS).toHaveLength(4)
  })

  it('lists the primary hrefs in order, ending with More', () => {
    expect(MOBILE_TAB_ITEMS.map((item) => item.href)).toEqual([
      '/',
      '/todos',
      '/workflow',
      '/more',
    ])
  })

  it('includes Todos as a primary tab', () => {
    expect(MOBILE_TAB_ITEMS.some((i) => i.href === '/todos' && i.label === 'Todos')).toBe(true)
  })

  it('derives the 4 primary destinations from NAV_ITEMS (icons/labels stay in sync)', () => {
    for (const item of MOBILE_TAB_ITEMS) {
      if (item.href === MORE_NAV_ITEM.href) continue // More is the synthetic overflow entry
      expect(NAV_ITEMS).toContain(item)
    }
  })
})

describe('OVERFLOW_ITEMS (the More screen)', () => {
  it('holds every non-Chat destination that is not a primary tab', () => {
    expect(OVERFLOW_ITEMS.map((i) => i.href)).toEqual([
      '/experiments',
      '/org',
      '/constellation',
      '/cron',
      '/limits',
      '/logs',
      '/skills',
      '/settings',
    ])
  })

  it('mirrors the shared NAV_ITEMS order (derived, not a second hardcoded list)', () => {
    const sharedOrder = NAV_ITEMS.filter((i) => OVERFLOW_ITEMS.includes(i))
    expect(OVERFLOW_ITEMS).toEqual(sharedOrder)
  })

  it('partitions NAV_ITEMS with no gaps and no overlap (Chat + primary tabs + overflow)', () => {
    const primary = MOBILE_TAB_ITEMS.filter((i) => i.href !== MORE_NAV_ITEM.href).map((i) => i.href)
    const overflow = OVERFLOW_ITEMS.map((i) => i.href)
    const covered = new Set([...primary, ...overflow])
    // '/' (Chat) is a primary tab; every NAV_ITEMS href is either a primary tab
    // or lives in the overflow — nothing is orphaned, nothing is double-listed.
    for (const item of NAV_ITEMS) expect(covered.has(item.href)).toBe(true)
    expect(primary.filter((h) => overflow.includes(h))).toEqual([])
  })
})
