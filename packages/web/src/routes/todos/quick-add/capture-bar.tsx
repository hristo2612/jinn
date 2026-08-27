import { useEffect, useState } from "react"
import { Check, LoaderCircle, Send, WandSparkles } from "lucide-react"
import type { TodoCaptureAction } from "@/lib/api"
import { TodoDialog } from "../todo-dialog"
import { CaptureMic } from "./capture-mic"
import { useTodoCapture } from "./use-todo-capture"

const ACKNOWLEDGEMENT_MS = 520
const SHELL = "inset-x-3 bottom-3 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-4 py-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] motion-safe:data-[state=closed]:animate-sheet-out motion-safe:data-[state=open]:animate-sheet-in sm:left-1/2 sm:top-[18%] sm:bottom-auto sm:w-[min(560px,calc(100vw-32px))] sm:-translate-x-1/2 sm:px-5 sm:py-[18px] sm:motion-safe:data-[state=closed]:animate-pop-out sm:motion-safe:data-[state=open]:animate-pop-in"

type SubmitCapture = (action: TodoCaptureAction) => void

function CaptureAction({
  action,
  label,
  ariaLabel,
  title,
  icon: Icon,
  primary = false,
  disabled,
  pending,
  onSubmit,
}: {
  action: TodoCaptureAction
  label: string
  ariaLabel: string
  title: string
  icon: typeof WandSparkles
  primary?: boolean
  disabled: boolean
  pending: boolean
  onSubmit: SubmitCapture
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-busy={pending}
      title={title}
      disabled={disabled}
      data-testid={`quick-capture-action-${action}`}
      onClick={() => onSubmit(action)}
      className={primary
        ? "focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] py-2 pl-3.5 pr-4 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] shadow-[var(--shadow-ambient),var(--inset-shine)] outline-none transition-[scale,opacity] duration-150 active:scale-[0.96] disabled:opacity-40 motion-reduce:transition-none" // jinn-shell: ok quick-capture dialog submit, not page chrome
        : "focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-secondary)] py-2 pl-3.5 pr-4 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)] shadow-[var(--inset-shine)] outline-none transition-[scale,background-color,opacity] duration-150 hover:bg-[var(--bg-tertiary)] active:scale-[0.96] disabled:opacity-40 motion-reduce:transition-none"}
    >
      {pending ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden /> : <Icon className="size-4" aria-hidden />}
      <span>{label}</span>
    </button>
  )
}

function CaptureTextarea({
  text,
  pending,
  onChange,
  onTranscript,
  onSubmit,
}: {
  text: string
  pending: boolean
  onChange: (value: string) => void
  onTranscript: (value: string) => void
  onSubmit: SubmitCapture
}) {
  return (
    <div className="flex items-end gap-2.5">
      <textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return
          event.preventDefault()
          onSubmit("shape-and-dispatch")
        }}
        disabled={pending}
        aria-label="Capture"
        data-testid="quick-capture-input"
        placeholder="What's on your mind?"
        className="min-h-[76px] min-w-0 flex-1 resize-none rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] px-3 py-2.5 text-[length:var(--text-body)] leading-relaxed text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--separator)] outline-none transition-[box-shadow,opacity] duration-150 placeholder:text-[var(--text-tertiary)] focus:shadow-[inset_0_0_0_1.5px_var(--accent)] disabled:opacity-60 motion-reduce:transition-none"
      />
      {!pending && <CaptureMic onTranscript={onTranscript} />}
    </div>
  )
}

function CaptureActions({ text, pendingAction, onSubmit }: {
  text: string
  pendingAction: TodoCaptureAction | null
  onSubmit: SubmitCapture
}) {
  const disabled = !text.trim() || pendingAction !== null
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      <CaptureAction
        action="shape"
        label="Shape"
        ariaLabel="Shape only"
        title="Shape — create the Todo without dispatching it"
        icon={WandSparkles}
        disabled={disabled}
        pending={pendingAction === "shape"}
        onSubmit={onSubmit}
      />
      <CaptureAction
        action="shape-and-dispatch"
        label="Shape & Dispatch"
        ariaLabel="Shape and dispatch"
        title="Shape & Dispatch — create the Todo, then start its work"
        icon={Send}
        primary
        disabled={disabled}
        pending={pendingAction === "shape-and-dispatch"}
        onSubmit={onSubmit}
      />
    </div>
  )
}

function CaptureNotes({ confirming, pending, error }: {
  confirming: boolean
  pending: boolean
  error: string | null
}) {
  return (
    <>
      {confirming && !pending && (
        <p className="mt-2 text-pretty text-[length:var(--text-footnote)] text-[var(--text-tertiary)]" data-testid="quick-capture-confirm-hint">
          Edit if it misheard you, then choose how to continue.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-pretty text-[length:var(--text-footnote)] text-[var(--system-red)]" data-testid="capture-error">
          {error} Try again.
        </p>
      )}
      <p className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
        Return adds a line · ⌘/Ctrl Return shapes and dispatches
      </p>
    </>
  )
}

function CaptureComposer({
  text, confirming, pendingAction, error, onChange, onTranscript, onSubmit,
}: {
  text: string
  confirming: boolean
  pendingAction: TodoCaptureAction | null
  error: string | null
  onChange: (value: string) => void
  onTranscript: (value: string) => void
  onSubmit: SubmitCapture
}) {
  const pending = pendingAction !== null
  return (
    <>
      <CaptureTextarea text={text} pending={pending} onChange={onChange} onTranscript={onTranscript} onSubmit={onSubmit} />
      <CaptureActions text={text} pendingAction={pendingAction} onSubmit={onSubmit} />
      <CaptureNotes confirming={confirming} pending={pending} error={error} />
    </>
  )
}

function CaptureAccepted() {
  return (
    <div role="status" aria-live="polite" data-testid="capture-accepted" className="flex min-h-[148px] items-center justify-center gap-2.5 text-[var(--text-primary)]">
      <span className="flex size-8 items-center justify-center rounded-full bg-[var(--fill-secondary)] text-[var(--system-green)] motion-safe:animate-capture-ack-icon">
        <Check className="size-4" aria-hidden />
      </span>
      <span className="text-[length:var(--text-headline)] font-[var(--weight-semibold)] motion-safe:animate-capture-ack-label">Captured</span>
    </div>
  )
}

function useCaptureDraft() {
  const [text, setText] = useState("")
  const [confirming, setConfirming] = useState(false)
  const { run, start } = useTodoCapture()

  function submit(action: TodoCaptureAction) {
    const value = text.trim()
    if (!value || run.pendingAction || run.accepted) return
    const speechDerived = confirming
    void start(value, speechDerived, action).then((accepted) => {
      if (accepted) setConfirming(false)
    })
  }

  function change(value: string) {
    setText(value)
    if (!value.trim()) setConfirming(false)
  }

  function landTranscript(transcript: string) {
    setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript))
    setConfirming(true)
  }

  return { text, confirming, run, submit, change, landTranscript }
}

export function QuickCaptureBar({ onClose }: { onClose: () => void }) {
  const [leaving, setLeaving] = useState(false)
  const { text, confirming, run, submit, change, landTranscript } = useCaptureDraft()

  useEffect(() => {
    if (!run.accepted) return
    const timer = window.setTimeout(() => setLeaving(true), ACKNOWLEDGEMENT_MS)
    return () => window.clearTimeout(timer)
  }, [run.accepted])

  return (
    <TodoDialog
      open={!leaving}
      label="Quick capture"
      testId="quick-capture"
      onRequestClose={() => setLeaving(true)}
      onClosed={onClose}
      className={SHELL}
    >
      {run.accepted ? (
        <CaptureAccepted />
      ) : (
        <CaptureComposer
          text={text}
          confirming={confirming}
          pendingAction={run.pendingAction}
          error={run.error}
          onChange={change}
          onTranscript={landTranscript}
          onSubmit={submit}
        />
      )}
    </TodoDialog>
  )
}
