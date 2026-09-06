import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { gatewayTransport } from '@/lib/gateway-transport'

const acknowledgments = new Map<string, Set<(sentValue: string) => void>>()

function readDraft(key: string): string | null {
  try { return sessionStorage.getItem(key) ?? '' } catch { return null }
}
function writeDraft(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value)
    else sessionStorage.removeItem(key)
  } catch { /* A disabled/full store must not prevent composing or sending. */ }
}

type DraftOwner = { key: string; value: string }

function useDraftAcknowledgment(owner: RefObject<DraftOwner>, updateValue: Dispatch<SetStateAction<string>>) {
  const { key } = owner.current
  const storedAtRender = readDraft(key)
  useEffect(() => {
    const listeners = acknowledgments.get(key) ?? new Set<(sentValue: string) => void>()
    const clearAcknowledged = (sentValue: string) => {
      if (owner.current.key !== key || owner.current.value !== sentValue) return
      owner.current.value = ''
      updateValue('')
    }
    listeners.add(clearAcknowledged)
    acknowledgments.set(key, listeners)
    // Reconcile an acknowledgment that arrived between render and subscription.
    const stored = readDraft(key)
    if (storedAtRender !== null && stored !== null && stored !== storedAtRender) {
      owner.current.value = stored
      updateValue(stored)
    }
    return () => {
      listeners.delete(clearAcknowledged)
      if (!listeners.size) acknowledgments.delete(key)
    }
  }, [key, storedAtRender, owner, updateValue])
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
  useDraftAcknowledgment(owner, updateValue)
  const setValue: Dispatch<SetStateAction<string>> = useCallback((next) => {
    const current = owner.current
    current.value = typeof next === 'function' ? next(current.value) : next
    writeDraft(current.key, current.value)
    updateValue(current.value)
  }, [])
  function pendingSend() {
    const current = owner.current
    const sentValue = current.value
    const storedAtSend = readDraft(current.key)
    return () => {
      // A late acknowledgment may belong to an unmounted or newly adopted pane.
      // Preserve any edits made while the request was in flight.
      const stored = readDraft(current.key)
      if (current.value !== sentValue || (stored !== null && stored !== storedAtSend)) return
      current.value = ''
      writeDraft(current.key, '')
      acknowledgments.get(current.key)?.forEach(notify => notify(sentValue))
      if (owner.current === current) updateValue('')
    }
  }
  return { value, setValue, pendingSend }
}
