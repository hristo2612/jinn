import { test, expect } from '@playwright/test'

// Run against a built, paired fixture gateway. A dev server has no worker.
test('an offline cold launch recovers without re-pairing or cached API data', async ({ page, context }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
    }
  })
  await context.setOffline(true)
  await page.goto('/experiments')
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('jinn:chunk-retry:')))).toEqual([])
  const cachedApiUrls = await page.evaluate(async () => {
    const urls = await Promise.all((await caches.keys()).map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)))
    return urls.flat().filter((url) => new URL(url).pathname.startsWith('/api/'))
  })
  expect(cachedApiUrls).toEqual([])
  await context.setOffline(false)
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('heading', { name: 'Experiments', exact: true })).toBeVisible()
})

test('an uncached tab shows offline recovery inside an already paired app', async ({ page, context }) => {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await context.setOffline(true)
  await page.getByRole('link', { name: 'More', exact: true }).click()
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('jinn:chunk-retry:')))).toEqual([])
  await context.setOffline(false)
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('heading', { name: 'More', exact: true })).toBeVisible()
})
