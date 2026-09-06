import { useState, useSyncExternalStore } from 'react'
import { reloadRoute } from '@/lib/reload-route'

function subscribe(listener: () => void) {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

/** Route failures are caught by the router before the outer React boundary. */
export function RouteFailure() {
  const [refreshing, setRefreshing] = useState(false)
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true)
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <h1 className="text-subheadline font-medium text-foreground">
        {online ? 'This page could not load' : "You're offline"}
      </h1>
      <p role="status" className="text-footnote text-[var(--text-secondary)]">
        {online ? 'Refresh to try again.' : 'Connect to the network, then refresh to continue.'}
      </p>
      <button
        className="min-h-11 rounded-md bg-[var(--accent)] px-4 py-2 text-subheadline font-medium text-[var(--accent-contrast)] disabled:opacity-50 motion-safe:active:scale-[0.96] transition-transform"
        disabled={!online || refreshing}
        onClick={() => { setRefreshing(true); void reloadRoute() }}
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </main>
  )
}
