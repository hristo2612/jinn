import { useCallback, useRef, useState } from "react"
import { api, ApiError, type TodoCaptureAction } from "@/lib/api"

export interface TodoCaptureRun {
  pendingAction: TodoCaptureAction | null
  accepted: boolean
  /** The gateway's own refusal, kept beside the composer so it can be retried. */
  error: string | null
}

const EMPTY: TodoCaptureRun = { pendingAction: null, accepted: false, error: null }

/** Quick capture ends, from this surface's point of view, when the gateway has
 * accepted the first session message. Downstream shaping remains visible on
 * the Todo/session surfaces and must never hold this compact composer open. */
export function useTodoCapture() {
  const [run, setRun] = useState<TodoCaptureRun>(EMPTY)
  const posting = useRef(false)

  const start = useCallback(async (
    text: string,
    speechDerived: boolean,
    action: TodoCaptureAction,
  ): Promise<boolean> => {
    if (posting.current || run.accepted) return false
    posting.current = true
    setRun({ pendingAction: action, accepted: false, error: null })
    try {
      await api.startTodoCapture({ text, speechDerived, action })
      setRun({ pendingAction: null, accepted: true, error: null })
      return true
    } catch (error) {
      const reason = error instanceof ApiError || error instanceof Error ? error.message : String(error)
      setRun({ pendingAction: null, accepted: false, error: reason })
      return false
    } finally {
      posting.current = false
    }
  }, [run.accepted])

  return { run, start }
}
