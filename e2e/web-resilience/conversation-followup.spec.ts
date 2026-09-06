import { test, expect } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const session = process.env.JINN_QA_SESSION
const other = process.env.JINN_QA_OTHER_SESSION

test.beforeEach(() => test.skip(!session || !other, 'Requires two synthetic conversations in an isolated gateway'))

test('unsent text survives chat switches, reload and offline recovery without sending', async ({ page, context }) => {
  let sends = 0
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/sessions/.test(request.url())) sends++ })
  await page.goto(`/?session=${session}`)
  const input = page.locator('#chat-textarea')
  await input.fill('Unsent alpha draft')
  await page.locator(`[data-mobile-working-set-chip="${other}"]:not([inert] *)`).click()
  await expect(input).toHaveValue('')
  await input.fill('Unsent beta draft')
  await page.locator(`[data-mobile-working-set-chip="${session}"]:not([inert] *)`).click()
  await expect(input).toHaveValue('Unsent alpha draft')
  await page.reload()
  await expect(input).toHaveValue('Unsent alpha draft')
  await context.setOffline(true)
  await input.fill('Offline edited draft')
  await context.setOffline(false)
  const background = await context.newPage()
  await background.goto('about:blank')
  await background.bringToFront()
  await page.bringToFront()
  await background.close()
  await expect(input).toHaveValue('Offline edited draft')
  await page.reload()
  await expect(input).toHaveValue('Offline edited draft')
  expect(sends).toBe(0)
})

test('mobile targets stay reachable without overlap at narrow and enlarged text sizes', async ({ page }) => {
  for (const width of [320, 390]) {
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`/?session=${session}`)
      await expect(page.locator('#chat-textarea')).toBeEditable()
      await page.evaluate(({ theme }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = '160%' }, { theme })
      const targets = page.locator('[data-mobile-working-set-chip], button[aria-label="Attach file"], button[aria-label="Voice input"], button[aria-label="Send message"], button[aria-label^="Model and effort"]')
      for (const target of await targets.all()) {
        const box = await target.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.width).toBeGreaterThanOrEqual(40)
        expect(box!.height).toBeGreaterThanOrEqual(40)
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
        const reachable = await target.evaluate(el => {
          const r = el.getBoundingClientRect()
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        })
        expect(reachable).toBe(true)
      }
      const boxes = await page.locator('[data-mobile-working-set-chip]').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right } }))
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].right)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    }
  }
})

test('a controlled progressive response stops and keeps the next unsent draft', async ({ page }) => {
  let deliver: (event: string, payload: Record<string, unknown>) => void = () => { throw new Error('Socket not connected') }
  await page.routeWebSocket('**/ws', socket => {
    socket.connectToServer()
    deliver = (event, payload) => socket.send(JSON.stringify({ event, payload }))
  })
  let sends = 0
  await page.route(`**/api/sessions/${other}/message`, async route => {
    sends++
    await route.fulfill({ json: { status: 'started', sessionId: other } })
  })
  await page.route(`**/api/sessions/${other}/stop`, async route => {
    await route.fulfill({ json: { status: 'stopped', sessionId: other } })
    deliver('session:stopped', { sessionId: other })
  })
  await page.goto(`/?session=${other}`)
  await page.locator('#chat-textarea').fill('Synthetic progressive response')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(() => sends).toBe(1)
  await expect(page.locator('#chat-textarea')).toHaveValue('')
  deliver('session:started', { sessionId: other })
  deliver('session:delta', { sessionId: other, type: 'text', content: 'First streamed sentence. ' })
  await expect(page.locator('[data-streaming]')).toContainText('First streamed sentence.')
  deliver('session:delta', { sessionId: other, type: 'text', content: 'Second streamed sentence.' })
  await expect(page.locator('[data-streaming]')).toContainText('First streamed sentence. Second streamed sentence.')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.locator('[data-streaming]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await page.locator('#chat-textarea').fill('Do not send this recovery draft')
  await page.locator(`[data-mobile-working-set-chip="${session}"]:not([inert] *)`).click()
  await page.locator(`[data-mobile-working-set-chip="${other}"]:not([inert] *)`).click()
  await expect(page.locator('#chat-textarea')).toHaveValue('Do not send this recovery draft')
  expect(sends).toBe(1)
})

test('secondary phone controls fit and remain reachable with enlarged text', async ({ page }) => {
  const routes = [
    { path: '/todos', labels: ['Filters', 'Switch workspace'] },
    { path: '/workflow', labels: ['Active', 'Archived'] },
    { path: '/more', labels: ['Dark', 'Light', 'System'] },
    { path: '/settings', labels: ['Red', 'Blue', 'Custom accent hex color'] },
  ]
  for (const [width, theme] of [[320, 'dark'], [320, 'light'], [390, 'dark'], [390, 'light']] as const) {
      await page.setViewportSize({ width, height: 844 })
      for (const route of routes) {
        await page.goto(route.path)
        for (const label of route.labels) await expect(page.getByRole(label === 'Custom accent hex color' ? 'textbox' : 'button', { name: label, exact: true })).toBeVisible()
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = '160%' }, theme)
        for (const label of route.labels) {
          const target = page.getByRole(label === 'Custom accent hex color' ? 'textbox' : 'button', { name: label, exact: true })
          await target.scrollIntoViewIfNeeded()
          const box = await target.boundingBox()
          expect(box!.height).toBeGreaterThanOrEqual(40)
          expect(box!.width).toBeGreaterThanOrEqual(40)
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width).toBeLessThanOrEqual(width)
          expect(await target.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
      }
  }
})
