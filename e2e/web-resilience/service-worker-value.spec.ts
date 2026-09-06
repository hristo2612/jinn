import { test, expect } from '@playwright/test'

test('without a worker an uncached offline document cannot show app recovery', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ...testInfo.project.use, serviceWorkers: 'block' })
  const page = await context.newPage()
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await context.setOffline(true)
  await expect(page.goto('/experiments?offline-probe')).rejects.toThrow()
  await context.setOffline(false)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await context.close()
})

test('a stale route asset reloads once and opens the fresh route', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ...testInfo.project.use, serviceWorkers: 'block' })
  const page = await context.newPage()
  let failed = false
  let armed = false
  await page.route('**/assets/page-*.js', async route => {
    if (!armed || failed) await route.continue()
    else { failed = true; await route.fulfill({ status: 404, headers: { 'Cache-Control': 'no-store' }, contentType: 'text/plain', body: 'Asset no longer available' }) }
  })
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  armed = true
  await page.getByRole('link', { name: 'More', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible()
  expect(failed).toBe(true)
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('jinn:chunk-retry:')))).toEqual([])
  await context.close()
})
