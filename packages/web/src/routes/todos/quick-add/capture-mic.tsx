import { useEffect, useRef } from "react"
import { LoaderCircle, Mic } from "lucide-react"
import { useGateway } from "@/hooks/use-gateway"
import { useStt, type UseSttReturn } from "@/hooks/use-stt"
import { MicWaveform } from "@/components/chat/mic-waveform"
import { WhisperDownloadModal } from "@/components/stt/whisper-download-modal"
import { classifyMicGesture, MIC_HOLD_THRESHOLD_MS } from "@/components/chat/chat-input"
import { cn } from "@/lib/utils"

/**
 * Hold to talk, tap to toggle — the same gesture the notes mic uses, sized for
 * a capture bar rather than a page.
 *
 * A landed transcript is handed up and nothing else happens here: the bar owns
 * what a transcript means, and what it means is "show this to the operator and
 * wait", never "send it".
 */

function useMicGesture(stt: UseSttReturn, onTranscript: (text: string) => void) {
  const downAtRef = useRef<number | null>(null)
  const toggleActiveRef = useRef(false)

  useEffect(() => {
    if (stt.state === "idle" || stt.state === "no-model" || stt.state === "error") toggleActiveRef.current = false
  }, [stt.state])

  async function transcribe() {
    const text = await stt.stopRecording()
    if (text) onTranscript(text)
  }

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation()
    if (stt.state === "transcribing") return
    if (stt.state === "starting") { downAtRef.current = null; stt.cancelRecording(); return }
    if (toggleActiveRef.current || stt.state === "recording") {
      toggleActiveRef.current = false
      downAtRef.current = null
      void transcribe()
      return
    }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* unavailable */ }
    downAtRef.current = Date.now()
    void stt.handleMicClick()
  }

  function onPointerUp() {
    const downAt = downAtRef.current
    if (downAt === null) return
    downAtRef.current = null
    if (stt.state === "no-model" || stt.state === "transcribing") return
    if (classifyMicGesture(downAt, Date.now(), MIC_HOLD_THRESHOLD_MS) === "hold") void transcribe()
    else toggleActiveRef.current = true
  }

  function onPointerCancel(event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation()
    downAtRef.current = null
    toggleActiveRef.current = false
    stt.cancelRecording()
  }

  return { onPointerDown, onPointerUp, onPointerCancel }
}

function MicGlyph({ stt, recording, busy }: { stt: UseSttReturn; recording: boolean; busy: boolean }) {
  if (busy) return <LoaderCircle size={16} className="motion-safe:animate-spin" aria-hidden />
  if (!recording) return <Mic size={17} aria-hidden />
  if (stt.analyser) return <MicWaveform analyser={stt.analyser} cssWidth={34} cssHeight={16} barCount={6} />
  return (
    <span aria-hidden className="flex h-4 items-center gap-[3px]">
      {[6, 11, 15, 8, 13, 9].map((height, index) => (
        <span key={index} className="w-0.5 rounded-full bg-current" style={{ height }} />
      ))}
    </span>
  )
}

export function CaptureMic({ onTranscript }: { onTranscript: (text: string) => void }) {
  const { events } = useGateway()
  const stt = useStt(events, onTranscript)
  const gesture = useMicGesture(stt, onTranscript)

  const recording = stt.state === "recording"
  const busy = stt.state === "starting" || stt.state === "transcribing"

  return (
    <>
      <button
        type="button"
        aria-label={recording ? "Stop recording" : busy ? "Transcribing…" : "Voice capture"}
        aria-busy={busy}
        data-state={stt.state}
        data-testid="quick-capture-mic"
        title={recording ? "Stop recording" : "Hold to talk · tap to toggle"}
        disabled={stt.state === "transcribing"}
        {...gesture}
        className={cn(
          "focus-ring flex h-10 shrink-0 select-none items-center justify-center rounded-full outline-none transition-[width,scale,background-color,color] duration-150 touch-none [transition-timing-function:var(--ease-snappy)] active:scale-[0.96] motion-reduce:transition-none",
          recording
            ? "w-[104px] gap-2 bg-[var(--system-red)] px-3 text-[var(--bg-secondary)]"
            : "size-10 bg-[var(--fill-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]",
          stt.state === "transcribing" && "cursor-wait",
        )}
      >
        <MicGlyph stt={stt} recording={recording} busy={busy} />
      </button>

      {stt.error && (
        <p className="mt-2 text-[length:var(--text-footnote)] text-[var(--system-red)]" data-testid="quick-capture-mic-error">
          {stt.error}
          <button type="button" onClick={stt.dismissError} className="ml-2 font-[var(--weight-semibold)] text-[var(--text-primary)]">Dismiss</button>
        </p>
      )}

      <WhisperDownloadModal
        open={stt.state === "no-model"}
        progress={stt.downloadProgress}
        onDownload={stt.startDownload}
        onCancel={stt.dismissDownload}
      />
    </>
  )
}
