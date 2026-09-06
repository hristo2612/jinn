/** Hold threshold (ms) that separates a quick tap from a tap-and-hold. */
export const MIC_HOLD_THRESHOLD_MS = 250

export type MicGesture = 'hold' | 'tap'

/**
 * Pure classifier for the mic button gesture. A press held for at least
 * `threshold` ms is a push-to-talk hold; anything shorter is a quick tap.
 * Exported for unit testing.
 */
export function classifyMicGesture(
  downAt: number,
  upAt: number,
  threshold: number = MIC_HOLD_THRESHOLD_MS,
): MicGesture {
  return upAt - downAt >= threshold ? 'hold' : 'tap'
}

export interface SendTapContext {
  isStop: boolean
  armed: boolean
  sttPending: boolean
  hasContent: boolean
}

export type SendTapAction = "stop" | "disarm" | "arm" | "send" | "noop"

/** Stop wins; otherwise a second tap disarms, pending STT arms, and visible
 * content sends. This is the pure core of the dictation send button. */
export function resolveSendTap(context: SendTapContext): SendTapAction {
  if (context.isStop) return "stop"
  if (context.armed) return "disarm"
  if (context.sttPending) return "arm"
  if (context.hasContent) return "send"
  return "noop"
}

export type TranscriptLandAction = "send" | "disarm" | "fill"

export function resolveTranscriptLanding(armed: boolean, transcript: string): TranscriptLandAction {
  if (!armed) return "fill"
  return transcript.trim().length > 0 ? "send" : "disarm"
}
