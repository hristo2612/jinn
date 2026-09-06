import { afterEach, expect, it, vi } from 'vitest'
import { reloadRoute } from '../reload-route'

const origin = window.location.origin
const links: HTMLLinkElement[] = []
function preload(href: string) {
  const link = document.createElement('link')
  link.rel = 'modulepreload'
  link.href = href
  document.head.append(link)
  links.push(link)
}
afterEach(() => { links.splice(0).forEach(link => link.remove()); vi.unstubAllGlobals() })

it('refetches only unique same-origin JS assets before reloading', async () => {
  const reload = vi.fn()
  const body = vi.fn().mockResolvedValue(new ArrayBuffer(0))
  const fetcher = vi.fn().mockResolvedValue({ arrayBuffer: body })
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('window', { location: { origin, reload } })
  for (const href of ['/assets/page.js', '/assets/page.js', '/api/private.js', '/assets/style.css', 'https://example.test/assets/page.js']) preload(href)
  await reloadRoute()
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(origin + '/assets/page.js', { cache: 'reload', signal: expect.any(AbortSignal) })
  expect(body).toHaveBeenCalledTimes(1)
  expect(reload).toHaveBeenCalledTimes(1)
})

it('waits for the replacement body, but still reloads if assets are unavailable', async () => {
  const reload = vi.fn()
  let finish!: () => void
  const body = new Promise<void>(resolve => { finish = resolve })
  vi.stubGlobal('window', { location: { origin, reload } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ arrayBuffer: () => body }).mockRejectedValueOnce(new Error('offline')))
  preload('/assets/one.js'); preload('/assets/two.js')
  const recovery = reloadRoute()
  await Promise.resolve()
  expect(reload).not.toHaveBeenCalled()
  finish()
  await recovery
  expect(reload).toHaveBeenCalledTimes(1)
})
