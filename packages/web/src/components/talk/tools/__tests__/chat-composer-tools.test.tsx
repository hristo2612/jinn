import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatInput } from "@/components/chat/chat-input"
import {
  publishScreenContext,
  resetPageContext,
} from "../../context/page-context-store"
import { currentSituation, dismissSituation } from "../../talk-situation-store"
import { createTalkDriver } from "../../transport/session-driver"
import type { TalkControlOperation } from "../../transport/control-manifest"
import { executeBrowserToolCall } from "../browser-tool-executor"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  sendMessage: vi.fn(),
  orgData: { employees: [] as unknown[] },
  skillsData: [] as unknown[],
  refetchSkills: vi.fn(),
}))

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  authFetch: (...args: unknown[]) => mocks.authFetch(...args),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>()
  return { ...original, api: { ...original.api, sendMessage: (...args: unknown[]) => mocks.sendMessage(...args) } }
})

vi.mock("@/hooks/use-employees", () => ({
  useOrg: () => ({ data: mocks.orgData }),
}))

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({ data: mocks.skillsData, refetch: mocks.refetchSkills }),
}))

vi.mock("@/hooks/use-stt", () => ({
  useStt: () => ({
    state: "idle",
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
  }),
}))

const CURRENT_CHAT_TOOLS = [
  "talk_draft_reply",
  "talk_replace_draft",
  "talk_send_draft",
  "talk_draft_and_send",
] as const

function operation(name: typeof CURRENT_CHAT_TOOLS[number]): TalkControlOperation {
  const takesMessage = name !== "talk_send_draft"
  return {
    name,
    description: `Drive the visible composer with ${name}.`,
    parameters: {
      type: "object",
      properties: takesMessage ? { message: { type: "string", description: "The visible draft text." } } : {},
      required: takesMessage ? ["message"] : [],
      additionalProperties: false,
    },
    target: "browser",
    intent: "sessions",
    mutability: "effect",
    operatorOnly: false,
    verification: "browser-receipt",
  }
}

function selectChat(id = "visible-session"): void {
  window.history.replaceState({}, "", `/?session=${id}`)
  publishScreenContext({
    version: 1,
    revision: 0,
    routeId: "chat",
    capturedAt: "2026-08-18T12:00:00.000Z",
    freshness: "complete",
    missing: [],
    title: "Visible chat",
    kind: "chat",
    path: "/",
    params: {},
    filters: {},
    selection: { kind: "chat session", id },
    selectedObject: null,
    visibleItems: [],
    controls: [],
    meaningfulText: "",
    browserInstanceId: "browser-1",
    focus: null,
    hidden: false,
    visualGaps: [],
  })
}

function renderComposer(sendResult: boolean = true) {
  const onSend = vi.fn(async (_message: string) => sendResult)
  render(
    <ChatInput
      sessionId="visible-session"
      disabled={false}
      loading={false}
      onSend={onSend}
      onNewSession={vi.fn()}
      onStatusRequest={vi.fn()}
      events={[]}
    />,
  )
  return {
    input: screen.getByPlaceholderText("Type a message...") as HTMLTextAreaElement,
    onSend,
  }
}

async function call(name: typeof CURRENT_CHAT_TOOLS[number], message?: string) {
  const args = message === undefined ? "{}" : JSON.stringify({ message })
  let result: Awaited<ReturnType<typeof executeBrowserToolCall>> | undefined
  await act(async () => {
    result = await executeBrowserToolCall(name, args)
  })
  return result!
}

beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
  resetPageContext()
  selectChat()
  Element.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.checkVisibility = vi.fn(() => true)
  mocks.sendMessage.mockResolvedValue({})
})

afterEach(() => {
  dismissSituation()
  resetPageContext()
})

describe("Talk driving the visible chat composer", () => {
  it("fills a draft without sending it", async () => {
    const { input, onSend } = renderComposer()

    const result = await call("talk_draft_reply", "We should keep the ring orb.")

    expect(result.ok).toBe(true)
    expect(input.value).toBe("We should keep the ring orb.")
    expect(onSend).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    if (!result.ok) throw new Error("expected a draft receipt")
    expect(result.data).toEqual({ performed: "draft", characters: 28 })
  })

  it("replaces the visible draft and still does not send", async () => {
    const { input, onSend } = renderComposer()
    await call("talk_draft_reply", "We should keep the ring orb.")

    const result = await call("talk_replace_draft", "We should keep the mist orb.")

    expect(result.ok).toBe(true)
    expect(input.value).toBe("We should keep the mist orb.")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("sends the text that is visibly in the composer exactly once", async () => {
    const { input, onSend } = renderComposer()
    fireEvent.change(input, { target: { value: "Ship the visible draft." } })
    const result = await call("talk_send_draft")
    expect(result.ok).toBe(true)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]?.[0]).toBe("Ship the visible draft.")
    expect(input.value).toBe("")

    const repeated = await call("talk_send_draft")
    expect(repeated.ok).toBe(false)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("drafts and sends once without raising another confirmation", async () => {
    const { input, onSend } = renderComposer()
    const result = await call("talk_draft_and_send", "Ship the four variants.")
    expect(result.ok).toBe(true)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]?.[0]).toBe("Ship the four variants.")
    expect(input.value).toBe("")
    expect(currentSituation()).toBeNull()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it.each([["talk_send_draft", undefined], ["talk_draft_and_send", "Ship only after delivery."]] as const)(
    "reports %s as failed when the composer transport fails", async (name, message) => {
      const { input, onSend } = renderComposer(false)
      if (name === "talk_send_draft") fireEvent.change(input, { target: { value: "Ship only after delivery." } })
      const result = await call(name, message)
      expect(result.ok).toBe(false)
      expect(onSend).toHaveBeenCalledTimes(1)
      if (result.ok) throw new Error("expected a failed delivery receipt")
      expect(result.error).toContain("not sent")
    })

  it("runs a replayed browser-local call once through the real Talk driver", async () => {
    const { onSend } = renderComposer()
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: CURRENT_CHAT_TOOLS.map(operation) },
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
    })
    const frame = JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "composer-call-1",
      name: "talk_draft_and_send",
      arguments: JSON.stringify({ message: "Send once." }),
    })

    driver.receive(frame)
    driver.receive(frame)

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(mocks.authFetch).not.toHaveBeenCalled()
    expect(sent.filter((event) => event.type === "conversation.item.create")).toHaveLength(1)
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(1)
  })

  it("refuses to clobber a draft or act after the selected chat changes", async () => {
    const { input, onSend } = renderComposer()
    fireEvent.change(input, { target: { value: "Keep this manual draft." } })

    expect((await call("talk_draft_reply", "Overwrite it.")).ok).toBe(false)
    expect(input.value).toBe("Keep this manual draft.")

    selectChat("other-session")

    expect((await call("talk_send_draft")).ok).toBe(false)
    expect(onSend).not.toHaveBeenCalled()
    expect(input.value).toBe("Keep this manual draft.")
  })
})

describe("the existing named-session lane", () => {
  it("still asks in the live manifest lane and a refusal sends nothing", async () => {
    renderComposer()
    const sent: Array<Record<string, unknown>> = []
    const namedSend: TalkControlOperation = {
      name: "talk_send_to_session",
      description: "Send one message to a named chat after consent.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The named session id." },
          message: { type: "string", description: "The operator message." },
        },
        required: ["id", "message"],
        additionalProperties: false,
      },
      target: "browser",
      intent: "sessions",
      mutability: "effect",
      operatorOnly: false,
      verification: "browser-receipt",
    }
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [namedSend] },
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
    })
    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "named-send-1",
      name: "talk_send_to_session",
      arguments: JSON.stringify({ id: "named-session", message: "Ship it." }),
    }))

    await waitFor(() => expect(currentSituation()).not.toBeNull())
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    dismissSituation()

    await waitFor(() => expect(sent.some((event) => event.type === "conversation.item.create")).toBe(true))
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })
})
