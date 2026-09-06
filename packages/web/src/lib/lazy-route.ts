import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { reloadRoute } from './gateway-transport'

const RECOVERABLE_IMPORT_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /chunkloaderror/i,
  /loading chunk \d+ failed/i,
  /mime type of text\/html/i,
]

export function isRecoverableDynamicImportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = `${error.name}: ${error.message}`
  return RECOVERABLE_IMPORT_PATTERNS.some((pattern) => pattern.test(message))
}

export function consumeChunkReloadRetry(storage: Storage, key: string): boolean {
  try {
    if (storage.getItem(key) === '1') return false
    storage.setItem(key, '1')
    return true
  } catch {
    return false
  }
}

function retryKey(routeName: string): string {
  const path = typeof window === 'undefined' ? routeName : window.location.pathname
  return `jinn:chunk-retry:${routeName}:${path}`
}

export function lazyRoute<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  routeName: string,
) {
  let importPromise: Promise<{ default: T }> | undefined
  const importOnce = () => {
    importPromise ??= load().catch((error) => {
      importPromise = undefined
      throw error
    })
    return importPromise
  }

  const Route = lazy(async () => {
    try {
      const mod = await importOnce()
      if (typeof window !== 'undefined') {
        try { window.sessionStorage.removeItem(retryKey(routeName)) } catch { /* ignore */ }
      }
      return mod
    } catch (error) {
      if (
        typeof window !== 'undefined' &&
        navigator.onLine !== false &&
        isRecoverableDynamicImportError(error) &&
        consumeChunkReloadRetry(window.sessionStorage, retryKey(routeName))
      ) {
        await reloadRoute()
        return new Promise<{ default: T }>(() => {})
      }
      throw error
    }
  }) as LazyExoticComponent<T> & { prefetch: () => Promise<void> }

  Route.prefetch = async () => {
    try {
      await importOnce()
    } catch {
      // Prefetch is speculative. A real render retries after a rejected import.
    }
  }

  return Route
}
