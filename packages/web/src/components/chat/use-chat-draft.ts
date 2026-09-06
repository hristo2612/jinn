import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { gatewayTransport } from '@/lib/gateway-transport'

function readDraft(key: string): string | null {
  try { return sessionStorage.getItem(key) ?? '' } catch { return null }
}
function writeDraft(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value)
    else sessionStorage.removeItem(key)
  } catch { /* A disabled/full store must not prevent composing or sending. */ }
}

/** Text survives pane/route remounts and reload in this tab, scoped to its gateway. */
export function useChatDraft(sessionId: string | null) {
  const scope = `jinn-chat-draft:${gatewayTransport().profile.origin}:`
  const key = scope + (sessionId ?? 'new')
  const [value, updateValue] = useState(() => readDraft(key) ?? '')
  const owner = useRef({ key, value })
  if (owner.current.key !== key) {
    const previous = owner.current
    if (previous.key === scope + 'new' && sessionId) {
      // First-send adoption keeps the composer mounted while assigning its id.
      writeDraft(previous.key, '')
      previous.key = key
      writeDraft(key, previous.value)
    } else {
      owner.current = { key, value: readDraft(key) ?? '' }
      updateValue(owner.current.value)
    }
  }
  const setValue: Dispatch<SetStateAction<string>> = useCallback((next) => {
    const current = owner.current
    current.value = typeof next === 'function' ? next(current.value) : next
    writeDraft(current.key, current.value)
    updateValue(current.value)
  }, [])
  function pendingSend() {
    const current = owner.current
    const sentValue = current.value
    return () => {
      // A late acknowledgment may belong to an unmounted or newly adopted pane.
      // Preserve any edits made while the request was in flight.
      const stored = readDraft(current.key)
      if (current.value !== sentValue || (stored !== null && stored !== sentValue)) return
      current.value = ''
      writeDraft(current.key, '')
      if (owner.current === current) updateValue('')
    }
  }
  return { value, setValue, pendingSend }
}
