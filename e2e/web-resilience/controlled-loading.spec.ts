import { test, expect } from '@playwright/test'
import fs from 'node:fs'

test('controlled mobile loading and transcript interaction', async ({ browser, browserName }, testInfo) => {
  test.skip(!process.env.JINN_PERF_SESSION || browserName !== 'chromium', 'Opt-in measurement against a fixed synthetic transcript')
  test.setTimeout(180_000)
  const samples = []
  for (let sample = -1; sample < 3; sample++) {
    const context = await browser.newContext({ ...testInfo.project.use, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Performance.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 1_250_000, uploadThroughput: 625_000 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const responses: { url: string; encoding?: string; bytes?: number; initiator?: string }[] = []
    const initiators = new Map<string, string>()
    cdp.on('Network.requestWillBeSent', ({ requestId, initiator }) => {
      const source = initiator.url ?? initiator.stack?.callFrames[0]?.url
      initiators.set(requestId, source ? new URL(source).pathname : initiator.type)
    })
    const responseIds = new Map<string, number>()
    cdp.on('Network.responseReceived', ({ requestId, response }) => {
      responseIds.set(requestId, responses.length)
      responses.push({ url: new URL(response.url).pathname, initiator: initiators.get(requestId), encoding: response.headers['Content-Encoding'] ?? response.headers['content-encoding'] })
    })
    cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
      const index = responseIds.get(requestId)
      if (index !== undefined) responses[index].bytes = encodedDataLength
    })
    await page.goto(`/?session=${process.env.JINN_PERF_SESSION}`)
    const composer = page.locator('#chat-textarea')
    await expect(composer).toBeEditable()
    await composer.fill('Unsent performance probe')
    const composerMs = await page.evaluate(() => performance.now())
    const beforeInteraction = await cdp.send('Performance.getMetrics')
    const interactions = await page.evaluate(async () => {
      const scroller = Array.from(document.querySelectorAll<HTMLElement>('div')).find(e => e.scrollHeight > e.clientHeight + 100 && getComputedStyle(e).overflowY === 'auto' && e.querySelector('[data-message-id]'))
      const durations = []
      for (let i = 0; i < 8; i++) {
        const start = performance.now()
        if (scroller) scroller.scrollTop = i % 2 ? scroller.scrollHeight : 0
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))
        durations.push(performance.now() - start)
      }
      return { durations, foundScroller: !!scroller, scrollHeight: scroller?.scrollHeight }
    })
    const afterInteraction = await cdp.send('Performance.getMetrics')
    const costs = Object.fromEntries(['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].map(name => [name, 1000 * ((afterInteraction.metrics.find(m => m.name === name)?.value ?? 0) - (beforeInteraction.metrics.find(m => m.name === name)?.value ?? 0))]))
    await page.getByRole('button', { name: 'Back to chats', exact: true }).click()
    const tabs = []
    for (const name of ['Todos', 'Workflows', 'More']) {
      const start = await page.evaluate(() => performance.now())
      await page.getByRole('link', { name, exact: true }).click()
      await expect(page.getByRole('heading', { name: name === 'Todos' ? 'Home' : name, exact: true }).first()).toBeVisible()
      tabs.push({ name, ms: await page.evaluate(() => performance.now()) - start })
    }
    if (sample >= 0) samples.push({ composerMs, interactions, costs, tabs, responses })
    await context.close()
  }
  const output = { conditions: { samples: 3, cpuSlowdown: 4, latencyMs: 80, downloadBytesPerSecond: 1_250_000, uploadBytesPerSecond: 625_000, browserCache: 'disabled', serviceWorker: 'blocked', viewport: '390x844', server: 'built gateway with negotiated compression' }, samples }
  if (process.env.JINN_PERF_OUTPUT) fs.writeFileSync(process.env.JINN_PERF_OUTPUT, JSON.stringify(output, null, 2))
  await testInfo.attach('controlled-loading', { body: JSON.stringify(output), contentType: 'application/json' })
})
