import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TodoCaptureWire } from "@/lib/api"

const startTodoCapture = vi.hoisted(() => vi.fn())
const getTodoCapture = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { startTodoCapture, getTodoCapture } }
})

const stt = vi.hoisted(() => ({
  state: "idle" as string,
  available: true,
  downloadProgress: null as number | null,
  analyser: null,
  languages: ["en"],
  selectedLanguage: "en",
  error: null as string | null,
  cycleLanguage: vi.fn(),
  handleMicClick: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn<() => Promise<string | null>>(),
  cancelRecording: vi.fn(),
  startDownload: vi.fn(),
  dismissDownload: vi.fn(),
  dismissError: vi.fn(),
}))
vi.mock("@/hooks/use-stt", () => ({ useStt: vi.fn(() => stt) }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ events: [] }) }))

import { QuickCaptureBar } from "../capture-bar"

function wire(): TodoCaptureWire {
  return {
    captureId: "cap-1",
    sessionId: "cap-1",
    stage: "starting",
    workItemId: null,
    workItemTitle: null,
    routedTo: null,
    extraWorkItemIds: [],
    error: null,
    waitingReason: null,
  }
}

function renderBar(onClose = vi.fn()) {
  render(<QuickCaptureBar onClose={onClose} />)
  return { onClose }
}

function draft(text: string) {
  const textarea = screen.getByTestId("quick-capture-input") as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: text } })
  return textarea
}

beforeEach(() => {
  vi.clearAllMocks()
  startTodoCapture.mockResolvedValue(wire())
  stt.state = "idle"
  stt.error = null
})

afterEach(() => { vi.useRealTimers() })

describe("QuickCaptureBar", () => {
  it("preserves multiline input; Enter adds a line and Mod+Enter dispatches", async () => {
    renderBar()
    const text = "Rough idea\n\nKeep both details"
    const textarea = draft(text)

    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(startTodoCapture).not.toHaveBeenCalled()
    expect(textarea.value).toBe(text)

    await act(async () => { fireEvent.keyDown(textarea, { key: "Enter", metaKey: true }) })
    expect(startTodoCapture).toHaveBeenCalledWith({
      text,
      speechDerived: false,
      action: "shape-and-dispatch",
    })
  })

  it("presents exactly two unambiguous icon-led capture actions", () => {
    renderBar()

    const actions = screen.getAllByTestId(/^quick-capture-action-/)
    expect(actions).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Shape only" }).textContent).toContain("Shape")
    expect(screen.getByRole("button", { name: "Shape and dispatch" }).textContent).toContain("Shape & Dispatch")
    expect(screen.getByRole("button", { name: "Shape only" }).getAttribute("title")).toMatch(/without dispatching/i)
    expect(screen.getByRole("button", { name: "Shape and dispatch" }).getAttribute("title")).toMatch(/then start/i)
    for (const action of actions) expect(action.querySelector("svg")).toBeTruthy()
  })

  it("keeps the multiline field borderless at rest and visible on keyboard focus", () => {
    renderBar()

    const textarea = screen.getByTestId("quick-capture-input")
    expect(textarea.className).not.toContain("shadow-[inset_0_0_0_1px_var(--separator)]")
    expect(textarea.className).toContain("focus-visible:shadow-[inset_0_0_0_1.5px_var(--accent)]")
  })

  it("hands Shape to the shaping-only capture path", async () => {
    renderBar()
    draft("shape this, but leave it unassigned")

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Shape only" })) })

    expect(startTodoCapture).toHaveBeenCalledWith({
      text: "shape this, but leave it unassigned",
      speechDerived: false,
      action: "shape",
    })
  })

  it("hands Shape & Dispatch to shaping followed by dispatch", async () => {
    renderBar()
    draft("shape this and start it")

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Shape and dispatch" })) })

    expect(startTodoCapture).toHaveBeenCalledWith({
      text: "shape this and start it",
      speechDerived: false,
      action: "shape-and-dispatch",
    })
  })

  it("acknowledges gateway acceptance and dismisses without polling downstream work", async () => {
    vi.useFakeTimers()
    const { onClose } = renderBar()
    draft("accept this capture")

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Shape and dispatch" })) })

    const acknowledgement = screen.getByRole("status")
    expect(acknowledgement.textContent?.trim()).toBe("Captured")
    expect(acknowledgement.querySelector("svg, ol, ul, progress, [aria-valuenow]")).toBeNull()
    expect(screen.queryByTestId("capture-pipeline")).toBeNull()
    expect(document.querySelector('[data-testid^="capture-step-"]')).toBeNull()
    expect(getTodoCapture).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => { vi.advanceTimersByTime(700) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("keeps send failures visible and retryable", async () => {
    startTodoCapture.mockRejectedValueOnce(new Error("Todo Shaper engine is unavailable"))
    renderBar()
    draft("retry this capture")

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Shape only" })) })

    expect((await screen.findByRole("alert")).textContent).toContain("Todo Shaper engine is unavailable")
    expect((screen.getByRole("button", { name: "Shape only" }) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Shape only" })) })
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Captured"))
    expect(startTodoCapture).toHaveBeenCalledTimes(2)
  })

  it("starts only one session while the initial handoff is pending", async () => {
    let accept!: (value: TodoCaptureWire) => void
    startTodoCapture.mockReturnValue(new Promise<TodoCaptureWire>((resolve) => { accept = resolve }))
    renderBar()
    draft("one capture only")
    const action = screen.getByRole("button", { name: "Shape and dispatch" })

    fireEvent.click(action)
    fireEvent.click(action)
    expect(startTodoCapture).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.queryByTestId("capture-pipeline")).toBeNull()
    expect(document.querySelector('[data-testid^="capture-step-"]')).toBeNull()

    await act(async () => { accept(wire()) })
  })
})
