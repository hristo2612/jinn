import { test, expect, type Page } from '@playwright/test'

// Integration coverage for the stick-to-bottom rebuild against the REAL wired
// /chat thread (the unit + DOM tests in packages/web cover the hook in isolation).
//
// Never point this at the live gateway: it owns port 7777, and the Vite dev
// server proxies its API and HMR socket straight back to whatever gateway port
// it is given. Stand up a throwaway instance instead and drive that — the full
// recipe, runnable from a bare checkout, is in docs/qa/ICI-1422-chat-scroll-qa.md.
// In short: JINN_HOME=<tmp> jinn setup, rewrite gateway.port away from its 7777
// default, seed with scripts/device-scroll-fixture.mjs, then start on that port.
// Run:  SCROLL_E2E_URL=http://localhost:<sandbox-port> SCROLL_E2E_SESSION=<id> pnpm test:e2e scroll
// and stop the gateway and delete the home afterwards, pass or fail.
// Falls back to the e2e baseURL (:7779) and skips gracefully if no thread is loaded.

const BASE = process.env.SCROLL_E2E_URL || 'http://localhost:7779'
const SESSION = process.env.SCROLL_E2E_SESSION || ''

const scroller = '.chat-messages-scroll'
const jumpBtn = 'button[aria-label="Jump to latest"]'

async function openThread(page: Page) {
  const url = SESSION ? `${BASE}/chat?session=${SESSION}` : `${BASE}/chat`
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForSelector(scroller, { timeout: 15_000 })
  await page.waitForTimeout(1500) // let messages render + mount-snap settle
}

async function distance(page: Page) {
  return page.$eval(scroller, (el) => Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight))
}

// Guarantee the thread is taller than the viewport (independent of how much content
// the target session happens to hold) by appending a spacer inside the scroll area.
// Use an IDLE session so React never re-renders the spacer away mid-test.
async function ensureScrollable(page: Page) {
  await page.$eval(scroller, (el) => {
    if (el.scrollHeight - el.clientHeight > 400) return
    const content = el.firstElementChild ?? el
    const spacer = document.createElement('div')
    spacer.style.height = '1600px'
    spacer.setAttribute('data-test-spacer', '1')
    content.appendChild(spacer)
  })
}

async function pinToBottom(page: Page) {
  await page.$eval(scroller, (el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(150)
}

test.describe('chat stick-to-bottom', () => {
  test('mount-snap: loads pinned to the bottom', async ({ page }) => {
    await openThread(page)
    expect(await distance(page)).toBeLessThan(60) // within STICK_THRESHOLD_PX
  })

  test('read-up: scrolling up reveals "Jump to latest", click returns to bottom', async ({ page }) => {
    await openThread(page)
    await ensureScrollable(page)
    await pinToBottom(page)

    await page.$eval(scroller, (el) => { el.scrollTop = 0 })
    await page.waitForTimeout(300)
    await expect(page.locator(jumpBtn)).toBeVisible()
    expect(await distance(page)).toBeGreaterThan(60) // genuinely detached

    await page.locator(jumpBtn).click()
    await expect(page.locator(jumpBtn)).toBeHidden() // hides immediately on click
    // Poll until the smooth scroll lands at the bottom (distance independent of speed).
    await expect.poll(() => distance(page), { timeout: 4000 }).toBeLessThan(60)
  })

  test('resize: a viewport shrink while pinned stays pinned (no composer overlap)', async ({ page }) => {
    await openThread(page)
    await ensureScrollable(page)
    await pinToBottom(page)
    expect(await distance(page)).toBeLessThan(60)
    await page.setViewportSize({ width: 1440, height: 520 }) // simulate keyboard / shrink
    await page.waitForTimeout(400)
    expect(await distance(page)).toBeLessThan(60)
  })
})
