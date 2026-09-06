import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A speech-derived message is one whose composed text contains any transcribed
// fragment. The composer must carry that provenance to onSend so the gateway can
// hand the engine a hidden context note — WITHOUT altering the operator's text.

const hoisted = vi.hoisted(() => ({
  // Captured second arg of useStt(events, onTranscript) — lets the test land a
  // transcript through the same choke point production uses, no media mocks.
  state: "idle",
  landTranscript: null as null | ((text: string) => void),
  // Stable references: returning fresh objects each render would retrigger the
  // org/skills effects and loop the component.
  orgData: { employees: [] as unknown[] },
  skillsData: [] as unknown[],
  refetchSkills: () => {},
}))

vi.mock("@/hooks/use-employees", () => ({
  useOrg: () => ({ data: hoisted.orgData }),
}))

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({ data: hoisted.skillsData, refetch: hoisted.refetchSkills }),
}))

vi.mock("@/hooks/use-stt", () => ({
  useStt: (_events: unknown, onTranscript: (text: string) => void) => {
    hoisted.landTranscript = onTranscript
    return {
      state: hoisted.state,
      available: true,
      error: null,
      analyser: null,
      languages: ["en"],
      selectedLanguage: "en",
      downloadProgress: null,
      cycleLanguage: vi.fn(),
      handleMicClick: vi.fn(),
      startRecording: vi.fn(),
      stopRecording: vi.fn(async () => null),
      cancelRecording: vi.fn(),
      startDownload: vi.fn(),
      dismissDownload: vi.fn(),
      dismissError: vi.fn(),
    }
  },
}))

import { ChatInput } from "../chat-input"

function renderInput() {
  const onSend = vi.fn()
  render(
    <ChatInput
      disabled={false}
      loading={false}
      onSend={onSend}
      onNewSession={vi.fn()}
      onStatusRequest={vi.fn()}
      events={[]}
    />,
  )
  const input = screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement
  return { onSend, input }
}

/** Land a dictated fragment through the STT transcript choke point. */
function speak(text: string) {
  act(() => {
    hoisted.landTranscript?.(text)
  })
}

/** The provenance flag onSend received on its most recent call. */
function lastSpeechFlag(onSend: ReturnType<typeof vi.fn>): boolean {
  const call = onSend.mock.calls.at(-1)
  return Boolean(call?.[3])
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  sessionStorage.clear()
  hoisted.state = "idle"
  hoisted.landTranscript = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("speech-to-text provenance on send", () => {
  it("marks a typed-only message as not speech-derived", () => {
    const { onSend, input } = renderInput()
    fireEvent.change(input, { target: { value: "book the room" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toBe("book the room")
    expect(lastSpeechFlag(onSend)).toBe(false)
  })

  it("marks a dictation-only message as speech-derived", () => {
    const { onSend, input } = renderInput()
    speak("book the room")
    expect(input.value).toBe("book the room")
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onSend.mock.calls[0][0]).toBe("book the room")
    expect(lastSpeechFlag(onSend)).toBe(true)
  })

  it("marks a mixed typed + dictated message as speech-derived", () => {
    const { onSend, input } = renderInput()
    fireEvent.change(input, { target: { value: "remind me to" } })
    speak("send the invoice")
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onSend.mock.calls[0][0]).toBe("remind me to send the invoice")
    expect(lastSpeechFlag(onSend)).toBe(true)
  })

  it("resets provenance when the composer is fully cleared", () => {
    const { onSend, input } = renderInput()
    speak("scratch that")
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.change(input, { target: { value: "typed fresh" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onSend.mock.calls[0][0]).toBe("typed fresh")
    expect(lastSpeechFlag(onSend)).toBe(false)
  })

  it("resets provenance after a speech-derived send", () => {
    const { onSend, input } = renderInput()
    speak("first dictated")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(lastSpeechFlag(onSend)).toBe(true)

    fireEvent.change(input, { target: { value: "second typed" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(onSend).toHaveBeenCalledTimes(2)
    expect(onSend.mock.calls[1][0]).toBe("second typed")
    expect(lastSpeechFlag(onSend)).toBe(false)
  })
})

it("retains armed dictation after a refused send", async () => {
  hoisted.state = "recording"
  const { onSend, input } = renderInput()
  onSend.mockResolvedValue(false)
  fireEvent.click(screen.getByRole("button", { name: "Send when transcription lands" }))
  await act(async () => { hoisted.landTranscript?.("Keep this dictated draft") })
  expect(onSend).toHaveBeenCalledTimes(1)
  expect(input.value).toBe("Keep this dictated draft")
})
