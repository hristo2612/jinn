/** Recovery-only: replace WebKit's failed modulepreload resource before reload (270357). */
export async function reloadRoute(): Promise<void> {
  const urls = new Set(Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'))
    .map(link => new URL(link.href))
    .filter(url => url.origin === window.location.origin && url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js'))
    .map(url => url.href))
  await Promise.allSettled(Array.from(urls, async url => {
    const response = await fetch(url, { cache: 'reload', signal: AbortSignal.timeout(5_000) })
    await response.arrayBuffer()
  }))
  window.location.reload()
}
