import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { MediaAttachment } from '@/lib/conversations'
import { MediaPreview } from './media-preview'
import { useStt } from '@/hooks/use-stt'
import { useOrg } from '@/hooks/use-employees'
import { useSkills } from '@/hooks/use-skills'
import { WhisperDownloadModal } from '@/components/stt/whisper-download-modal'
import { MicWaveform } from './mic-waveform'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { useChatComposerControl } from './chat-composer-control'
import { composerCardPresentation } from './chat-composer-presentation'
import { useChatDraft } from './use-chat-draft'
import { classifyMicGesture, MIC_HOLD_THRESHOLD_MS, resolveSendTap, resolveTranscriptLanding } from './armed-send'

export { classifyMicGesture, MIC_HOLD_THRESHOLD_MS, resolveSendTap, resolveTranscriptLanding } from './armed-send'
export type { MicGesture } from './armed-send'

interface Employee {
  name: string
  displayName?: string
  department?: string
  rank?: string
  engine?: string
}

interface SlashCommand {
  name: string
  description: string
  /** Whether this command needs an @employee argument */
  needsEmployee?: boolean
}

/** Built-in commands handled client-side (not sent to engine) */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new chat session' },
  { name: 'status', description: 'Show current session info' },
]

export type ClientCommand = 'new' | 'status'

export function resolveClientCommand(text: string): ClientCommand | null {
  const trimmed = text.trim()
  if (trimmed === '/new') return 'new'
  if (trimmed === '/status') return 'status'
  return null
}

/* ── Speech-to-text provenance ─────────────────────────────────────────────
 * One bit per composed message: does its text contain any speech-to-text
 * content? Typing never sets it, any dictated fragment does, a full clear
 * resets it, and sending consumes it. A pure transition so the rule is testable
 * without driving the microphone. The bit rides `onSend` to the gateway, which
 * hands the engine a hidden context note — the operator's text is never changed.
 */
export type SpeechProvenanceEvent =
  | { type: 'transcript' }          // a dictated fragment landed in the field
  | { type: 'edit'; value: string } // a manual keystroke / clear changed the field
  | { type: 'send' }                // the message was dispatched

export function nextSpeechProvenance(current: boolean, event: SpeechProvenanceEvent): boolean {
  switch (event.type) {
    case 'transcript':
      return true
    case 'edit':
      // A full clear wipes provenance; any other edit (incl. typing alongside
      // dictated text) preserves it, so a mixed message stays speech-derived.
      return event.value.trim().length === 0 ? false : current
    case 'send':
      return false
  }
}

interface ChatInputProps {
  /** Existing chat owned by this composer. Null is the new-chat composer. */
  sessionId?: string | null
  /** Only the focused pane may receive global composer commands or autofocus. */
  isActive?: boolean
  disabled: boolean
  loading: boolean
  onSend: (message: string, media?: MediaAttachment[], interrupt?: boolean, speech?: boolean) => boolean | void | Promise<boolean | void>
  onInterrupt?: () => void
  onNewSession: () => void
  onStatusRequest: () => void
  /** Incremented when skills change on the gateway, triggers re-fetch */
  skillsVersion?: number
  /** WebSocket events from useGateway — needed for STT download progress */
  events?: Array<{ event: string; payload: unknown }>
  /** Files dropped onto the chat area (from parent drag & drop) */
  droppedFiles?: File[]
  /** Called after droppedFiles have been consumed as pending attachments */
  onDroppedFilesConsumed?: () => void
  /** Incrementing counter that triggers textarea focus when changed */
  focusTrigger?: number
  /** Optional Engine/Model/Effort selector row, rendered just above the input. */
  selectorSlot?: React.ReactNode
  /** Optional ambient status (e.g. background-activity StateLine), rendered in
   *  the toolbar's flexible middle so it never shifts layout. */
  statusSlot?: React.ReactNode
  /** Optional terminal-key control, rendered in the toolbar beside the mic. */
  terminalActionsSlot?: React.ReactNode
}

/* ── File to MediaAttachment ─────────────────────────────── */

function resizeImage(file: File, maxPx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > maxPx || height > maxPx) {
        const scale = maxPx / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no canvas context')); return }
      ctx.drawImage(img, 0, 0, width, height)
      const mimeType = file.size > 50000 ? 'image/jpeg' : 'image/png'
      const quality = mimeType === 'image/jpeg' ? 0.85 : undefined
      resolve(canvas.toDataURL(mimeType, quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

async function fileToAttachment(file: File): Promise<MediaAttachment> {
  const isImage = file.type.startsWith('image/')
  const isAudio = file.type.startsWith('audio/')
  const isVideo = file.type.startsWith('video/')

  let dataUrl: string
  if (isImage) {
    dataUrl = await resizeImage(file, 1200)
  } else {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  return {
    type: isImage ? 'image' : isAudio ? 'audio' : isVideo ? 'video' : 'file',
    url: dataUrl,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    file,
  }
}

/* ── Component ──────────────────────────────────────────── */

export function ChatInput({
  sessionId = null,
  isActive = true,
  disabled,
  loading,
  onSend,
  onInterrupt,
  onNewSession,
  onStatusRequest,
  skillsVersion,
  events,
  droppedFiles,
  onDroppedFilesConsumed,
  focusTrigger,
  selectorSlot,
  statusSlot,
  terminalActionsSlot,
}: ChatInputProps) {
  const { value, setValue, pendingSend } = useChatDraft(sessionId)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [showMentions, setShowMentions] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS)
  const [showCommands, setShowCommands] = useState(false)
  const [commandFilter, setCommandFilter] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<MediaAttachment[]>([])
  // Armed-send (STT): true once the operator has queued a send that will fire
  // automatically the instant the dictated transcript lands in the field.
  const [sendArmed, setSendArmed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const handledFocusTriggerRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef<number | null>(null)
  const previousSkillsVersionRef = useRef(skillsVersion)
  const { data: orgData } = useOrg()
  const { data: skillsData, refetch: refetchSkills } = useSkills()

  // Live mirrors so the async transcript-landing handler reads the latest value
  // without re-creating itself (and without stale-closure races on send).
  const valueRef = useRef('')
  const armedRef = useRef(false)
  // Speech-to-text provenance for the CURRENTLY composed message (see
  // nextSpeechProvenance). A ref, not state: it is read synchronously on send
  // and must never trigger a re-render.
  const speechRef = useRef(false)
  const pendingAttachmentsRef = useRef<MediaAttachment[]>([])
  const submittingRef = useRef(false)
  const disabledRef = useRef(disabled)
  const sendTextRef = useRef<(rawText: string, media: MediaAttachment[]) => Promise<boolean>>(async () => false)
  armedRef.current = sendArmed
  pendingAttachmentsRef.current = pendingAttachments
  valueRef.current = value
  disabledRef.current = disabled

  const resize = useCallback((el: HTMLTextAreaElement) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 180) + 'px'
    })
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Focus after session switches once the remounted textarea is ready.
  // Skip mobile so switching sessions does not pop the on-screen keyboard.
  // Each trigger is handled once so reactivating a pane leaves shortcuts available.
  useEffect(() => {
    if (!isActive || !focusTrigger || focusTrigger <= handledFocusTriggerRef.current) return
    handledFocusTriggerRef.current = focusTrigger
    if (window.innerWidth < 768) return
    const raf = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [focusTrigger, isActive])
  const mentionItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  // applyTranscript is defined below; the ref lets this stable callback reach it.
  const applyTranscriptRef = useRef<(text: string) => void>(() => {})
  const stt = useStt(events, (text) => {
    // Timeout auto-stop completed — route through the same landing handler so an
    // armed auto-send still fires on this path.
    applyTranscriptRef.current(text ?? '')
  })

  // Consume files dropped onto the chat area by the parent
  const consumedRef = useRef<File[] | undefined>(undefined)
  useEffect(() => {
    if (!droppedFiles || droppedFiles.length === 0) return
    // Guard against React Strict Mode double-firing the effect
    if (consumedRef.current === droppedFiles) return
    consumedRef.current = droppedFiles
    ;(async () => {
      const newAttachments: MediaAttachment[] = []
      for (const file of droppedFiles) {
        newAttachments.push(await fileToAttachment(file))
      }
      setPendingAttachments((prev) => [...prev, ...newAttachments])
      onDroppedFilesConsumed?.()
    })()
  }, [droppedFiles, onDroppedFilesConsumed])

  // Load employees for @mention (with full details)
  useEffect(() => {
    if (!Array.isArray(orgData?.employees)) return
    setEmployees(orgData.employees.map((emp) => ({
      name: emp.name,
      displayName: emp.displayName,
      department: emp.department,
      rank: emp.rank,
      engine: emp.engine,
    })))
  }, [orgData])

  // Load skills as slash commands.
  useEffect(() => {
    if (!Array.isArray(skillsData)) return
    const skillCommands: SlashCommand[] = skillsData
      .filter((s) => !BUILTIN_COMMANDS.some((b) => b.name === s.name))
      .map((s) => ({
        name: s.name as string,
        description: (s.description as string) || '',
        needsEmployee: s.name === 'sync',
      }))
    setSlashCommands([...BUILTIN_COMMANDS, ...skillCommands])
  }, [skillsData])

  useEffect(() => {
    if (previousSkillsVersionRef.current === skillsVersion) return
    previousSkillsVersionRef.current = skillsVersion
    void refetchSkills()
  }, [skillsVersion, refetchSkills])


  const handleMentionSelect = useCallback(
    (name: string) => {
      const atIdx = value.lastIndexOf('@')
      if (atIdx !== -1) {
        const before = value.slice(0, atIdx)
        setValue(before + '@' + name + ' ')
      }
      setShowMentions(false)
      textareaRef.current?.focus()
    },
    [value]
  )

  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.needsEmployee) {
        // Insert command + @ to trigger mention autocomplete
        setValue('/' + cmd.name + ' @')
        setShowCommands(false)
        // Trigger mention dropdown
        setMentionFilter('')
        setMentionIndex(0)
        setShowMentions(true)
      } else {
        setValue('/' + cmd.name)
        setShowCommands(false)
      }
      textareaRef.current?.focus()
    },
    []
  )

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setValue(val)

    // A manual edit updates provenance: a full clear resets it, any other edit
    // preserves it (so typing beside dictated text keeps the message speech-
    // derived). Programmatic transcript fills bypass onChange, so they never
    // reach here — they set provenance directly in applyTranscript.
    speechRef.current = nextSpeechProvenance(speechRef.current, { type: 'edit', value: val })

    // Any real keystroke (typing, clearing, editing) while a send is queued
    // means the operator took over — disarm cleanly so nothing auto-fires under
    // them. Programmatic transcript fills don't go through onChange, so they
    // never trip this.
    if (armedRef.current) setSendArmed(false)

    // Detect slash commands: text starts with / and has no space yet (still typing the command name)
    if (val.startsWith('/') && !val.includes(' ')) {
      const filter = val.slice(1).toLowerCase()
      setCommandFilter(filter)
      setCommandIndex(0)
      setShowCommands(true)
      setShowMentions(false)
      return
    }
    setShowCommands(false)

    // Detect @mentions
    const atIdx = val.lastIndexOf('@')
    if (atIdx !== -1) {
      const afterAt = val.slice(atIdx + 1)
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        setMentionFilter(afterAt.toLowerCase())
        setMentionIndex(0)
        setShowMentions(true)
        return
      }
    }
    setShowMentions(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Command autocomplete navigation
    if (showCommands && filteredCommands.length > 0) {
      const max = filteredCommands.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleCommandSelect(filteredCommands[commandIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowCommands(false)
        return
      }
    }

    // Mention autocomplete navigation
    if (showMentions && filteredEmployees.length > 0) {
      const max = Math.min(filteredEmployees.length, 8)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleMentionSelect(filteredEmployees[mentionIndex].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowMentions(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // Send core — resolves client-only commands, otherwise keeps the draft until
  // onSend acknowledges it. Shared by the Enter/tap path (handleSubmit) and
  // the STT auto-send path (applyTranscript), so both behave identically.
  async function sendText(rawText: string, media: MediaAttachment[]): Promise<boolean> {
    const trimmed = rawText.trim()
    const hasMedia = media.length > 0

    if ((!trimmed && !hasMedia) || disabledRef.current || submittingRef.current) return false
    submittingRef.current = true

    // Capture provenance before any reset, then consume it — this message's
    // speech-derived state must not bleed into the next one.
    const speech = speechRef.current
    speechRef.current = false

    const command = resolveClientCommand(trimmed)
    if (command === 'new') {
      valueRef.current = ''
      setValue('')
      setSendArmed(false)
      onNewSession()
      submittingRef.current = false
      return true
    }
    if (command === 'status') {
      valueRef.current = ''
      setValue('')
      setSendArmed(false)
      onStatusRequest()
      submittingRef.current = false
      return true
    }
    const mediaToSend = hasMedia ? [...media] : undefined
    const acknowledgeDraft = pendingSend()
    setSendArmed(false)
    setShowMentions(false)
    setShowCommands(false)
    try {
      const sending = onSend(trimmed, mediaToSend, false, speech)
      const accepted = typeof sending === 'boolean' ? sending : sending ? (await sending) !== false : true
      if (!accepted) {
        if (valueRef.current === rawText) speechRef.current = speech
        return false
      }
      acknowledgeDraft()
      if (valueRef.current === rawText) {
        valueRef.current = ''
        speechRef.current = nextSpeechProvenance(speechRef.current, { type: 'send' })
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      }
      pendingAttachmentsRef.current = pendingAttachmentsRef.current.filter(attachment => !media.includes(attachment))
      setPendingAttachments(current => current.filter(attachment => !media.includes(attachment)))
      return true
    } catch {
      if (valueRef.current === rawText) speechRef.current = speech
      return false
    } finally {
      submittingRef.current = false
    }
  }
  sendTextRef.current = sendText

  useChatComposerControl({
    sessionId, isActive, textareaRef, disabledRef, submittingRef, valueRef, speechRef,
    pendingAttachmentsRef, sendTextRef, setValue, setSendArmed, setShowMentions, setShowCommands,
  })

  function handleSubmit() {
    void sendText(value, pendingAttachments)
  }

  async function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    const newAttachments: MediaAttachment[] = []
    for (let i = 0; i < files.length; i++) {
      newAttachments.push(await fileToAttachment(files[i]))
    }
    setPendingAttachments((prev) => [...prev, ...newAttachments])
    e.target.value = ''
  }

  function removePendingAttachment(index: number) {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault()
        const file = items[i].getAsFile()
        if (file) {
          const att = await fileToAttachment(file)
          setPendingAttachments((prev) => [...prev, att])
        }
        return
      }
    }
  }

  /* ── Speech-to-text (offline whisper.cpp) ─────────────── */

  // Auto-resize textarea when value changes programmatically (e.g., from STT)
  useEffect(() => {
    if (textareaRef.current) {
      resize(textareaRef.current)
    }
  }, [value, resize])

  // The single choke point for a landed transcript — both the tap/hold stop path
  // and the timeout auto-stop path funnel through here so an armed auto-send is
  // honored identically. Recreated each render (closes over live state) and
  // published via a ref so the stable useStt callback can reach the latest copy.
  function applyTranscript(text: string) {
    const action = resolveTranscriptLanding(armedRef.current, text)
    const prev = valueRef.current
    const merged = prev ? prev + ' ' + text : text
    if (action === 'send') {
      // Keep the complete dictated draft available if delivery is refused.
      // Dictated words landed, so this send is speech-derived.
      speechRef.current = nextSpeechProvenance(speechRef.current, { type: 'transcript' })
      valueRef.current = merged
      setValue(merged)
      void sendText(merged, pendingAttachmentsRef.current)
      return
    }
    if (action === 'fill') {
      // Normal dictation (not armed) → drop the text in and keep editing.
      if (text.trim().length > 0) {
        speechRef.current = nextSpeechProvenance(speechRef.current, { type: 'transcript' })
        setValue(merged)
      }
      textareaRef.current?.focus()
      return
    }
    // action === 'disarm': armed but the transcript came back empty → never send
    // a blank message. Cancel the queue and leave the field focused as-is.
    setSendArmed(false)
    textareaRef.current?.focus()
  }
  applyTranscriptRef.current = applyTranscript

  // Stop the current recording, transcribe, and land the text (honoring an arm).
  const transcribeAndFill = useCallback(async () => {
    const text = await stt.stopRecording()
    applyTranscriptRef.current(text ?? '')
  }, [stt])

  // Disarm cleanly if STT ends without a transcript reaching applyTranscript —
  // an error, a declined model, or a timeout-stop that yielded no words. The
  // successful-landing paths read armedRef synchronously before this commits, so
  // this only ever tidies a genuinely-orphaned arm (never pre-empts a real send).
  useEffect(() => {
    if (!sendArmed) return
    if (stt.state === 'error' || stt.state === 'no-model' || stt.state === 'idle') {
      setSendArmed(false)
    }
  }, [sendArmed, stt.state])

  /* ── Mic gestures: tap-and-hold (push-to-talk) + quick-tap (toggle) ──── */
  // Refs avoid stale-closure races between pointerdown and pointerup.
  const micDownAtRef = useRef<number | null>(null)   // timestamp of an active press
  const micHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const micToggleActiveRef = useRef(false)           // recording left on by a quick tap

  function clearMicPress() {
    micDownAtRef.current = null
    if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current)
    micHoldTimerRef.current = null
  }

  useEffect(() => {
    return () => {
      if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (stt.state === 'idle' || stt.state === 'no-model' || stt.state === 'error') {
      micToggleActiveRef.current = false
    }
  }, [stt.state])

  function handleMicPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Keep the card click-to-focus handler from also firing.
    e.stopPropagation()
    if (stt.state === 'transcribing') return

    if (stt.state === 'starting') {
      clearMicPress()
      micToggleActiveRef.current = false
      stt.cancelRecording()
      return
    }

    // Already recording from a previous quick tap → this press toggles it off.
    if (micToggleActiveRef.current || stt.state === 'recording') {
      micToggleActiveRef.current = false
      clearMicPress()
      void transcribeAndFill()
      return
    }

    // Begin a fresh press: start recording and arm the hold detector.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
    micDownAtRef.current = Date.now()
    if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current)
    micHoldTimerRef.current = setTimeout(() => { micHoldTimerRef.current = null }, MIC_HOLD_THRESHOLD_MS)
    // handleMicClick() starts recording, or opens the download modal if no model.
    stt.handleMicClick()
  }

  function handleMicPointerUp() {
    const downAt = micDownAtRef.current
    if (downAt == null) return // no active press (e.g. toggle-off already handled)
    clearMicPress()

    // If the model wasn't ready, recording never started — leave the modal alone.
    if (stt.state === 'no-model' || stt.state === 'transcribing') return

    const gesture = classifyMicGesture(downAt, Date.now())
    if (gesture === 'hold') {
      // Push-to-talk release → stop + transcribe.
      void transcribeAndFill()
    } else {
      // Quick tap that started recording → leave it running; next tap stops it.
      micToggleActiveRef.current = true
    }
  }

  function handleMicPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    e.stopPropagation()
    clearMicPress()
    micToggleActiveRef.current = false
    stt.cancelRecording()
  }

  const filteredCommands = useMemo(
    () => slashCommands.filter((c) => c.name?.toLowerCase().startsWith(commandFilter)),
    [slashCommands, commandFilter]
  )

  const filteredEmployees = useMemo(
    () => employees.filter((e) => e.name?.toLowerCase().includes(mentionFilter)),
    [employees, mentionFilter]
  )

  const hasContent = value.trim().length > 0 || pendingAttachments.length > 0
  // STT "pending" window: words are being captured or transcribed but haven't
  // landed in the field yet. During this window the Send button is armable.
  const sttPending = stt.state === 'recording' || stt.state === 'transcribing'

  return (
    <div data-chat-composer className="pt-[var(--space-3)] pb-[max(var(--keyboard-inset),var(--safe-bottom),var(--space-3))] bg-[var(--bg)] shrink-0 relative">
      {/* Soft top scrim — fades scrolling content into the composer instead of a
          hard 1px divider. Borderless, readable over the thread in both themes.
          Stays full-bleed (spans the whole thread width). */}
      <div aria-hidden className="pointer-events-none absolute -top-5 left-0 right-0 h-5 bg-gradient-to-b from-transparent to-[var(--bg)]" />
      {/* Centered measure — caps the composer to the same column as the message
          text (--chat-measure + the message rows' space-3/space-8 side insets), so
          the card lines up edge-for-edge with the thread content instead of
          spanning the full pane. Mobile stays effectively full-width. */}
      <div className="relative mx-auto w-full max-w-[var(--chat-measure)] px-3 lg:px-8">
      {/* Slash command autocomplete */}
      {showCommands && filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 lg:left-8 lg:right-8 mb-1 border-0 bg-[var(--bg-tertiary)] rounded-[var(--radius-lg)] shadow-[var(--shadow-overlay)] max-h-60 overflow-y-auto z-10">
          {filteredCommands.map((cmd, idx) => {
            const isHighlighted = idx === commandIndex
            return (
              <button
                key={cmd.name}
                ref={(el) => {
                  if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
                }}
                onClick={() => handleCommandSelect(cmd)}
                className={`w-full text-left py-[var(--space-2)] px-[var(--space-3)] text-[length:var(--text-footnote)] ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'} border-none cursor-pointer flex items-center gap-[var(--space-2)] text-[var(--text-primary)]`}
              >
                <span className="font-[family-name:var(--font-mono)] font-[var(--weight-semibold)] text-[var(--accent)] text-[length:var(--text-footnote)]">/{cmd.name}</span>
                <span className="text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">{cmd.description}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Mention autocomplete */}
      {showMentions && filteredEmployees.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 lg:left-8 lg:right-8 mb-1 border-0 bg-[var(--bg-tertiary)] rounded-[var(--radius-lg)] shadow-[var(--shadow-overlay)] max-h-40 overflow-y-auto z-10">
          {filteredEmployees.slice(0, 8).map((emp, idx) => {
            const isHighlighted = idx === mentionIndex
            return (
              <button
                key={emp.name}
                ref={(el) => {
                  if (el) mentionItemRefs.current.set(idx, el)
                  else mentionItemRefs.current.delete(idx)
                  if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
                }}
                onClick={() => handleMentionSelect(emp.name)}
                className={`w-full text-left py-[var(--space-2)] px-[var(--space-3)] text-[length:var(--text-footnote)] ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'} border-none cursor-pointer flex items-center gap-[var(--space-2)] text-[var(--text-primary)]`}
              >
                <EmployeeAvatar name={emp.name} size={20} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[var(--space-2)]">
                    <span className="font-[var(--weight-semibold)]">{emp.displayName || emp.name}</span>
                    <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">@{emp.name}</span>
                  </div>
                  {emp.department && (
                    <div className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)] flex gap-[var(--space-2)] mt-px">
                      <span>{emp.department}</span>
                      {emp.engine && (
                        <span className="text-[var(--accent)] font-[var(--weight-medium)]">{emp.engine}</span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Pending attachments preview */}
      {pendingAttachments.length > 0 && (
        <div className="mb-[var(--space-2)]">
          <MediaPreview
            attachments={pendingAttachments}
            onRemove={removePendingAttachment}
          />
        </div>
      )}

      {/* Composer card — borderless: soft fill + shadow do the separating, no
          hairline at rest. A low-opacity accent ring (not a 1px border) marks
          the streaming state. */}
      <div
        {...composerCardPresentation(isActive, loading)}
        onPointerDown={(e) => {
          // Click-to-focus: tapping anywhere in the card (including the gaps
          // between toolbar buttons) lands the caret in the textarea. Real
          // controls stopPropagation so this never fires for them.
          if (disabled) return
          e.preventDefault() // don't steal/blur an existing selection
          textareaRef.current?.focus()
        }}
      >
        {/* Textarea */}
        <textarea
          id={isActive ? 'chat-textarea' : undefined}
          data-chat-textarea
          data-chat-session={sessionId ?? 'new'}
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={
            disabled ? 'Waiting for response...'
              : loading ? 'Queue another message...'
                : 'Type a message...'
          }
          rows={1}
          disabled={disabled}
          className={`block w-full bg-transparent border-none outline-none resize-none overflow-y-auto text-[var(--text-primary)] text-[length:var(--text-subheadline)] leading-6 min-h-6 px-1 pt-1 pb-2 m-0 ${disabled ? 'opacity-50' : 'opacity-100'}`}
          onInput={(e) => {
            resize(e.target as HTMLTextAreaElement)
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.csv,.json,.zip"
          multiple
          className="hidden"
          onChange={handleFileAttach}
        />

        {/* Toolbar: [+ attach] · [model chip] · spacer · [terminal keys] · [mic] · [send]. A container, so the chip degrades against THIS composer's width — a pane in a 3-column grid is narrow while the viewport is not. */}
        <div className="@container/composer flex items-center gap-[var(--space-2)]">
          {/* Attach */}
          <button
            aria-label="Attach file"
            title="Attach file"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => fileInputRef.current?.click()}
            className="w-[40px] h-[40px] md:w-[36px] md:h-[36px] shrink-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>

          {/* Model chip — wrapped so clicks on the trigger (and its inline popover)
              don't re-trigger card focus. The cap bounds a long model label instead
              of letting an unshrinkable chip push Send outside a narrow pane. */}
          {selectorSlot && (
            <div
              className="flex max-w-[55%] shrink-0 items-center overflow-hidden"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {selectorSlot}
            </div>
          )}

          {/* Ambient status sits left-anchored in the toolbar's flexible middle,
              reading as a continuation of the model chip's cluster rather than a
              floating center element. flex-1 (basis-0) claims only LEFTOVER
              space, so the slot can never push or truncate its siblings —
              appearing/disappearing moves nothing, and an overlong status clips
              inside this container. */}
          <div className="flex min-w-0 flex-1 items-center justify-start overflow-hidden pl-1">
            {statusSlot}
          </div>

          {/* Language picker — only shown when multiple STT languages configured */}
          {stt.languages.length > 1 && (
            <button
              aria-label={`STT language: ${stt.selectedLanguage.toUpperCase()}. Click to switch.`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={stt.cycleLanguage}
              className="h-7 px-2 shrink-0 rounded-full flex items-center justify-center bg-[var(--fill-tertiary)] border-none cursor-pointer text-[var(--text-secondary)] text-[11px] font-semibold font-[family-name:var(--font-mono)] tracking-[0.5px] uppercase hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 ease-in-out"
              title={`Transcription language: ${stt.selectedLanguage.toUpperCase()}. Click to cycle.`}
            >
              {stt.selectedLanguage}
            </button>
          )}

          {/* Terminal keys — only in the CLI view, where they have something to
              send. Sits with the mic so both read as one cluster of composer
              controls. */}
          {terminalActionsSlot && (
            <div className="shrink-0" onPointerDown={(e) => e.stopPropagation()}>
              {terminalActionsSlot}
            </div>
          )}

          {/* Voice input / STT button — tap-and-hold = push-to-talk, quick tap =
              toggle. While recording the button morphs into a compact waveform. */}
          <button
            aria-label={
              stt.state === 'recording' ? 'Stop recording'
              : stt.state === 'transcribing' ? 'Transcribing…'
              : stt.state === 'starting' ? 'Starting voice input…'
              : 'Voice input'
            }
            aria-busy={stt.state === 'starting' || stt.state === 'transcribing'}
            data-state={stt.state}
            onPointerDown={handleMicPointerDown}
            onPointerUp={handleMicPointerUp}
            onPointerCancel={handleMicPointerCancel}
            disabled={stt.state === 'transcribing'}
            className={`w-[40px] h-[40px] md:w-[36px] md:h-[36px] shrink-0 rounded-full flex items-center justify-center border-none transition-[scale,background-color,color] duration-150 ease-in-out active:scale-[0.96] touch-none select-none ${stt.state === 'recording' ? 'bg-[var(--system-red)] text-white cursor-pointer' : stt.state === 'starting' ? 'bg-[var(--accent-fill)] text-[var(--accent)] cursor-pointer' : `bg-transparent text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] ${stt.state === 'transcribing' ? 'cursor-wait' : 'cursor-pointer'}`}`}
            title={
              stt.state === 'recording' ? 'Stop recording'
              : stt.state === 'transcribing' ? 'Transcribing…'
              : stt.state === 'starting' ? 'Starting voice input… · press to cancel'
              : 'Hold to talk · tap to toggle'
            }
          >
            {stt.state === 'starting' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-[stt-spin_1s_linear_infinite]">
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
            ) : stt.state === 'recording' && stt.analyser ? (
              <MicWaveform analyser={stt.analyser} />
            ) : stt.state === 'transcribing' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-[stt-spin_1s_linear_infinite]">
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            )}
          </button>

          {/* Send ↔ Stop — one persistent circular button with five states:
                • stop     — a turn is streaming + interruptible (red square)
                • armed    — an STT auto-send is queued (solid accent + spinning
                             dashed ring: "locked, will fire when your words land")
                • armable  — STT is capturing/transcribing (tinted + static dashed
                             ring: "tap me to queue the send")
                • ready    — the field has content (solid accent arrow)
                • idle     — empty field (muted, inert)
              Background + arrow/stop crossfade keyed on the mode. */}
          {(() => {
            const showStop = loading && !!onInterrupt
            const mode: 'stop' | 'armed' | 'armable' | 'ready' | 'idle' =
              showStop ? 'stop'
              : sendArmed ? 'armed'
              : sttPending ? 'armable'
              : hasContent ? 'ready'
              : 'idle'
            // Disabled only when there's genuinely nothing to do: an empty idle
            // field, or the parent is blocking sends (waiting for a response) and
            // we're not in stop/arm/armable mode.
            const isDisabled =
              mode === 'idle' ? true
              : mode === 'stop' || mode === 'armed' ? false
              : disabled
            const showRing = mode === 'armable' || mode === 'armed'
            const label =
              mode === 'stop' ? 'Stop'
              : mode === 'armed' ? 'Send queued: fires when transcription lands. Tap to cancel.'
              : mode === 'armable' ? 'Send when transcription lands'
              : 'Send message'
            return (
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  const action = resolveSendTap({ isStop: showStop, armed: sendArmed, sttPending, hasContent })
                  if (action === 'stop') onInterrupt?.()
                  else if (action === 'arm') setSendArmed(true)
                  else if (action === 'disarm') setSendArmed(false)
                  else if (action === 'send') handleSubmit()
                  // 'noop' → nothing to do
                }}
                disabled={isDisabled}
                aria-label={label}
                title={label}
                className={`relative w-[40px] h-[40px] md:w-[38px] md:h-[38px] rounded-full border-none flex items-center justify-center shrink-0 transition-[background-color,color,opacity] duration-200 ease-in-out ${
                  mode === 'stop'
                    ? 'bg-[var(--system-red)] text-white cursor-pointer'
                    : mode === 'armed' || mode === 'ready'
                      ? 'bg-[var(--accent)] text-[var(--accent-contrast)] cursor-pointer'
                      : mode === 'armable'
                        ? 'bg-[var(--accent-fill)] text-[var(--accent)] cursor-pointer'
                        : 'bg-[var(--fill-tertiary)] text-[var(--text-quaternary)] cursor-default'
                }`}
              >
                {/* Pending affordance — a dashed ring around the button. Static
                    while armable (invites the tap); slowly spinning once armed
                    (queued, waiting for words). Purely decorative. */}
                {showRing && (
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute rounded-full border-[1.5px] border-dashed ${
                      mode === 'armed'
                        ? 'inset-[-4px] motion-safe:animate-[send-ring-spin_2.4s_linear_infinite]'
                        : 'inset-[-3px]'
                    }`}
                    style={{ borderColor: `color-mix(in srgb, var(--accent) ${mode === 'armed' ? 70 : 55}%, transparent)` }}
                  />
                )}
                {/* Send arrow */}
                <span className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ease-in-out ${mode === 'stop' ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </span>
                {/* Stop square */}
                <span className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ease-in-out ${mode === 'stop' ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                </span>
              </button>
            )
          })()}
        </div>
      </div>

      {/* STT error banner */}
      {stt.state === 'error' && stt.error && (
        <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-2)] py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-sm)] text-[length:var(--text-caption1)] text-[var(--system-red)]" style={{ background: 'color-mix(in srgb, var(--system-red) 12%, transparent)' }}>
          <span className="flex-1">Voice input error: {stt.error}</span>
          <button
            onClick={stt.dismissError}
            className="bg-none border-none cursor-pointer text-[var(--system-red)] text-[length:var(--text-caption1)] font-semibold py-0.5 px-1.5"
          >Dismiss</button>
        </div>
      )}
      </div>{/* /centered measure wrapper */}

      {/* STT model download modal */}
      <WhisperDownloadModal
        open={stt.state === 'no-model'}
        progress={stt.downloadProgress}
        onDownload={stt.startDownload}
        onCancel={stt.dismissDownload}
      />

      <style>{`
        @keyframes stt-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        /* Armed-send pending ring — a calm 2.4s rotation of the dashed ring so
           the queued Send reads as "waiting for your words" without being loud. */
        @keyframes send-ring-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        /* Idle base shadow + soft accent ring when the composer holds focus.
           Not a 1px border — a 4px --accent-fill wash. Overridden inline while
           streaming so the brighter loading ring takes precedence. */
        .composer-card-active { box-shadow: var(--shadow-card); }
        .composer-card-active:focus-within { box-shadow: var(--shadow-card), 0 0 0 4px var(--accent-fill); }
      `}</style>
    </div>
  )
}
