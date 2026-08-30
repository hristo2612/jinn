import { beforeEach, describe, expect, it, vi } from "vitest"

const authFetch = vi.fn()
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>()
  return { ...original, authFetch: (...args: unknown[]) => authFetch(...args) }
})

const localExecute = vi.fn()
vi.mock("@/components/talk/tools/registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/talk/tools/registry")>()
  return { ...original, executeToolCall: (...args: unknown[]) => localExecute(...args) }
})

const { createTalkDriver } = await import("../session-driver")

const operation = {
  name: "talk_comment_todo",
  description: "Add one verified comment.",
  parameters: {
    type: "object" as const,
    properties: { id: { type: "string" }, body: { type: "string" } },
    required: ["id", "body"],
    additionalProperties: false as const,
  },
  target: "gateway" as const,
  intent: "todos",
  mutability: "write" as const,
  operatorOnly: true,
  verification: "comment-reread",
}

const approvalOperation = {
  ...operation,
  name: "commit_voice_approval",
  description: "Commit from durable speech evidence.",
  parameters: { ...operation.parameters, properties: { challengeId: { type: "string" } }, required: ["challengeId"] },
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  authFetch.mockReset()
  localExecute.mockReset()
})

describe("gateway-target Talk controls", () => {
  it("suppresses a late effect and provider reply after the attachment stops", async () => {
    let finish: (response: Response) => void = () => {}
    authFetch.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const applyUiEffect = vi.fn().mockResolvedValue(undefined)
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-stopped", manifest: { version: 1, operations: [operation] },
      send: (event) => sent.push(event), onState: () => {}, onError: () => {}, applyUiEffect,
    })

    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done", call_id: "late-call", name: operation.name, arguments: "{}",
    }))
    driver.stop()
    finish(response({
      ok: true, verified: true, receiptId: "late-receipt", replayed: false,
      operation: operation.name, data: {}, evidence: {}, uiEffect: { invalidate: ["todos"] },
    }))
    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledOnce())
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()

    expect(applyUiEffect).not.toHaveBeenCalled()
    expect(sent.filter((event) => event.type === "conversation.item.create")).toHaveLength(0)
    expect(sent.filter((event) => event.type === "response.create")).toHaveLength(0)
  })

  it("applies a replayed gateway receipt once across replacement drivers", async () => {
    const applyUiEffect = vi.fn().mockResolvedValue(undefined)
    authFetch.mockResolvedValue(response({
      ok: true, verified: true, receiptId: "shared-receipt", replayed: true,
      operation: operation.name, data: {}, evidence: {}, uiEffect: { invalidate: ["todos"] },
    }))
    const options = {
      sessionId: "talk-replay", manifest: { version: 1 as const, operations: [operation] },
      send: () => {}, onState: () => {}, onError: () => {}, applyUiEffect,
    }

    createTalkDriver(options).receive(JSON.stringify({
      type: "response.function_call_arguments.done", call_id: "call-a", name: operation.name, arguments: "{}",
    }))
    createTalkDriver(options).receive(JSON.stringify({
      type: "response.function_call_arguments.done", call_id: "call-b", name: operation.name, arguments: "{}",
    }))

    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(applyUiEffect).toHaveBeenCalledTimes(1))
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
    expect(applyUiEffect).toHaveBeenCalledTimes(1)
  })

  it("routes through the gateway, applies a verified UI effect, and never runs the browser executor", async () => {
    const applyUiEffect = vi.fn().mockResolvedValue(undefined)
    authFetch.mockResolvedValue(response({
      ok: true,
      verified: true,
      receiptId: "receipt-1",
      replayed: false,
      operation: operation.name,
      data: { commentId: "comment-1" },
      evidence: { id: "comment-1" },
      uiEffect: { invalidate: ["todo:ABC-1"], navigate: "/todos/ABC-1" },
    }))
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [operation] },
      send: (event) => sent.push(event),
      onState: () => {},
      onError: () => {},
      applyUiEffect,
    })

    driver.receive(JSON.stringify({
      type: "response.function_call_arguments.done",
      event_id: "event-1",
      item_id: "item-1",
      call_id: "call-1",
      name: operation.name,
      arguments: '{"id":"ABC-1","body":"done"}',
    }))

    await vi.waitFor(() => expect(applyUiEffect).toHaveBeenCalledOnce())
    expect(localExecute).not.toHaveBeenCalled()
    expect(authFetch).toHaveBeenCalledTimes(1)
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ providerCallId: "call-1", providerItemId: "item-1", tool: operation.name })
    const output = sent.find((event) => event.type === "conversation.item.create")!.item as { output: string }
    expect(JSON.parse(output.output)).toMatchObject({ ok: true, verified: true, receiptId: "receipt-1" })
  })

  it("does not apply an unverified effect", async () => {
    const applyUiEffect = vi.fn()
    authFetch.mockResolvedValue(response({ ok: false, code: "verification-failed", error: "No evidence." }))
    const driver = createTalkDriver({
      sessionId: "talk-1",
      manifest: { version: 1, operations: [operation] },
      send: () => {},
      onState: () => {},
      onError: () => {},
      applyUiEffect,
    })
    driver.receive(JSON.stringify({ type: "response.function_call_arguments.done", call_id: "call-2", name: operation.name, arguments: "{}" }))
    await vi.waitFor(() => expect(authFetch).toHaveBeenCalledOnce())
    expect(applyUiEffect).not.toHaveBeenCalled()
  })

  it("persists final voice evidence before one approval call and applies one verified effect", async () => {
    const applyUiEffect = vi.fn().mockResolvedValue(undefined)
    authFetch
      .mockResolvedValueOnce(response({ ok: true, inputOrdinal: 2 }))
      .mockResolvedValueOnce(response({
        ok: true, verified: true, receiptId: "approval-receipt", replayed: false,
        operation: approvalOperation.name, data: { decision: "approve" }, evidence: { state: "approved" },
        uiEffect: { navigate: "/todos/ABC-1" },
      }))
    const sent: Array<Record<string, unknown>> = []
    const driver = createTalkDriver({
      sessionId: "talk-1", browserInstanceId: "browser-1", credentialGeneration: 3,
      manifest: { version: 1, operations: [approvalOperation] }, send: (event) => sent.push(event),
      onState: () => {}, onError: () => {}, applyUiEffect,
    })
    driver.receive(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed", event_id: "voice-event-2",
      item_id: "voice-item-2", transcript: "approve",
    }))
    const call = JSON.stringify({
      type: "response.function_call_arguments.done", event_id: "tool-event-1", item_id: "tool-item-1",
      call_id: "approval-call-1", name: approvalOperation.name, arguments: '{"challengeId":"challenge-1"}',
    })
    driver.receive(call)
    driver.receive(call)

    await vi.waitFor(() => expect(applyUiEffect).toHaveBeenCalledOnce())
    expect(authFetch).toHaveBeenCalledTimes(2)
    expect(authFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/talk/sessions/talk-1/transcript", "/api/talk/sessions/talk-1/control",
    ])
    const control = JSON.parse(String((authFetch.mock.calls[1]![1] as RequestInit).body))
    expect(control).toMatchObject({
      providerCallId: "approval-call-1", providerEventId: "tool-event-1", providerItemId: "tool-item-1",
      providerTranscriptItemId: "voice-item-2", browserInstanceId: "browser-1", credentialGeneration: 3,
      arguments: '{"challengeId":"challenge-1"}',
    })
    expect(sent.filter((event) => event.type === "conversation.item.create")).toHaveLength(1)
  })
})
