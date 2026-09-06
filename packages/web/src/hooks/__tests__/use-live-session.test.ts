/**
 * useLiveSession — read-only live pipeline (the Talk child-session modal path).
 *
 * Verifies the behaviours the modal relies on and that the old refetch-only hook
 * never had: live token streaming, live media, and a running-state spinner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

// Mock the API module the hook loads sessions through.
const getSession = vi.fn()
const getSessionMessages = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    getSession: (id: string, options?: unknown) => getSession(id, options),
    getSessionMessages: (id: string, options: unknown) => getSessionMessages(id, options),
  },
}))

import {
  __cacheLiveSessionSnapshotForTests,
  __clearLiveSessionSnapshotCacheForTests,
  __getLiveSessionSnapshotCacheSizeForTests,
  invalidateLiveSessionSnapshot,
  isRestingSnapshot,
  prefetchLiveSessionSnapshot,
  readPrefetchedLiveSessionSnapshot,
  SESSION_SNAPSHOT_REVISIT_TTL_MS,
  useLiveSession,
} from "../use-live-session"
import type { Message } from "@/lib/conversations"
import type { GatewayEvent, GatewayEventListener } from "@jinn/gateway-events"

/** A manual gateway subscribe that lets the test emit WS events. */
function makeBus() {
  let listener: GatewayEventListener | null = null
  const subscribe = (fn: GatewayEventListener) => {
    listener = fn
    return () => { listener = null }
  }
  const emit = (event: string, payload: unknown) => listener?.({ event, payload } as GatewayEvent)
  return { subscribe, emit }
}

beforeEach(() => {
  getSession.mockReset()
  getSessionMessages.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("live session prefetch handoff", () => {
  it("seeds the destination snapshot so the mounted child has content with no duplicate transcript request", async () => {
    getSession.mockResolvedValue({
      id: "child-prefetched",
      status: "idle",
      messages: [{ id: "a1", role: "assistant", content: "Prefetched child report", timestamp: 10 }],
    })
    await prefetchLiveSessionSnapshot("child-prefetched")
    expect(getSession).toHaveBeenCalledTimes(1)
    const preview = readPrefetchedLiveSessionSnapshot("child-prefetched")
    expect(preview?.messages.at(-1)?.content).toBe("Prefetched child report")
    preview!.messages[0].content = "mutated clone"
    expect(readPrefetchedLiveSessionSnapshot("child-prefetched")?.messages[0].content).toBe("Prefetched child report")

    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("child-prefetched", { subscribe }))
    expect(result.current.hydrating).toBe(false)
    expect(result.current.messages.at(-1)?.content).toBe("Prefetched child report")
    await act(async () => { await Promise.resolve() })
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it("does not seed a cancelled handoff", async () => {
    const controller = new AbortController()
    getSession.mockImplementation(async () => {
      controller.abort()
      return { id: "child-cancelled", status: "idle", messages: [] }
    })
    await expect(prefetchLiveSessionSnapshot("child-cancelled", controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("child-cancelled", { subscribe }))
    expect(result.current.hydrating).toBe(true)
  })
})


describe("useLiveSession (read-only)", () => {
  it("loads only the session tail on initial hydration and tracks older availability", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "m3", role: "assistant", content: "three", timestamp: 3 },
        { id: "m4", role: "assistant", content: "four", timestamp: 4 },
      ],
      messagesPage: { hasOlder: true },
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )

    await act(async () => { await Promise.resolve() })

    expect(getSession).toHaveBeenCalledWith("s1", { last: 150 })
    expect(result.current.messages.map((m) => m.content)).toEqual(["three", "four"])
    expect(result.current.hasOlderMessages).toBe(true)
  })

  it("keeps missing and malformed legacy timestamps unknown during hydration", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u1", role: "user", content: "legacy user" },
        { id: "a1", role: "assistant", content: "legacy answer", timestamp: "not-a-timestamp" },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )

    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((message) => message.timestamp)).toEqual([0, 0])
  })

  it("does not invent a settlement timestamp for an unpersisted legacy error", async () => {
    getSession.mockResolvedValue({
      status: "error",
      lastError: "legacy failure",
      messages: [
        { id: "u1", role: "user", content: "legacy user" },
        { id: "t1", role: "assistant", content: "Used Read", timestamp: 2_000, toolCall: "Read" },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )

    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((message) => message.timestamp)).toEqual([0, 2_000, 0])
    expect(result.current.messages.at(-1)?.content).toBe("Error: legacy failure")
  })

  it("does not duplicate a persisted canonical terminal error during hydration", async () => {
    getSession.mockResolvedValue({
      status: "error",
      lastError: "operation failed",
      messages: [
        { id: "u1", role: "user", content: "perform the task", timestamp: 1 },
        { id: "e1", role: "assistant", content: "Used Read", timestamp: 2, toolCall: "Read" },
        { id: "a1", role: "assistant", content: "Error: operation failed", timestamp: 3 },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )

    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((message) => message.content)).toEqual([
      "perform the task",
      "Used Read",
      "Error: operation failed",
    ])
    expect(result.current.messages.filter((message) => message.content === "Error: operation failed")).toHaveLength(1)
  })

  it("does not append a canonical error beside a persisted legacy terminal error", async () => {
    getSession.mockResolvedValue({
      status: "error",
      lastError: "operation failed",
      messages: [
        { id: "u1", role: "user", content: "perform the task", timestamp: 1 },
        { id: "e1", role: "assistant", content: "Used Read", timestamp: 2, toolCall: "Read" },
        { id: "a1", role: "assistant", content: "⛔ operation failed", timestamp: 3 },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )

    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((message) => message.content)).toEqual([
      "perform the task",
      "Used Read",
      "⛔ operation failed",
    ])
    expect(result.current.messages.some((message) => message.content === "Error: operation failed")).toBe(false)
  })

  it("prepends older pages and dedupes the cursor message", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "m3", role: "assistant", content: "three", timestamp: 3 },
        { id: "m4", role: "assistant", content: "four", timestamp: 4 },
      ],
      messagesPage: { hasOlder: true },
    })
    getSessionMessages.mockResolvedValue({
      messages: [
        { id: "m1", role: "assistant", content: "one", timestamp: 1 },
        { id: "m2", role: "assistant", content: "two", timestamp: 2 },
        { id: "m3", role: "assistant", content: "three", timestamp: 3 },
      ],
      hasOlder: false,
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      await result.current.loadOlderMessages()
    })

    expect(getSessionMessages).toHaveBeenCalledWith("s1", { before: "m3", limit: 100 })
    expect(result.current.messages.map((m) => m.content)).toEqual(["one", "two", "three", "four"])
    expect(result.current.hasOlderMessages).toBe(false)
  })

  it("loads history and seeds loading from running state", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [{ id: "m1", role: "user", content: "hi" }],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual(["hi"])
    expect(result.current.loading).toBe(true) // running → spinner
  })

  it("filters obsolete block types from loaded history", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [{
        id: "m1",
        role: "assistant",
        content: "Answer text",
        blocks: [{
          id: "approval",
          type: "approval",
          version: 1,
          payload: { actionId: "approve" },
        }],
      }],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0]?.content).toBe("Answer text")
    expect(result.current.messages[0]?.blocks).toBeUndefined()
  })

  it("hydrates valid task-list blocks from loaded running history", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        {
          id: "tool-1",
          role: "assistant",
          content: "Using read_file",
          toolCall: "read_file",
        },
        {
          id: "plan-row",
          role: "assistant",
          content: "Plan",
          blocks: [{
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Read file", status: "running" }] },
          }],
        },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    expect(result.current.loading).toBe(true)
    expect(result.current.messages[0]?.toolCall).toBe("read_file")
    expect(result.current.messages[1]?.blocks?.[0]?.id).toBe("plan")
    expect(result.current.messages[1]?.blocks?.[0]?.payload).toEqual({
      items: [{ id: "a", text: "Read file", status: "running" }],
    })
  })

  it("accumulates streaming text and clears it on completion", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Hel" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "lo" })
    })
    expect(result.current.streamingText).toBe("Hello")
    expect(result.current.loading).toBe(true)
    expect(result.current.turnPending).toBe(true)
    expect(result.current.liveFinalResponseId).toBeNull()

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Hello there." })
      await Promise.resolve()
    })
    expect(result.current.streamingText).toBe("")
    expect(result.current.loading).toBe(false)
    expect(result.current.messages.at(-1)?.content).toBe("Hello there.")
    expect(result.current.turnPending).toBe(false)
    expect(result.current.liveFinalResponseId).toBe(result.current.messages.at(-1)?.id)
  })

  it("keeps a restored waiting turn pending when its prose is only partial", async () => {
    getSession.mockResolvedValue({
      status: "waiting",
      messages: [
        { id: "u1", role: "user", content: "keep going", timestamp: 1 },
        { id: "p1", role: "assistant", content: "Interim finding", timestamp: 2, partial: true },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })

    expect(result.current.loading).toBe(false)
    expect(result.current.turnPending).toBe(true)
    expect(result.current.liveFinalResponseId).toBeNull()
    expect(result.current.messages.at(-1)?.partial).toBe(true)
  })

  it("keeps the turn pending through interrupted, stopped, and result-less completion events", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "keep going", timestamp: 1 },
        { id: "p1", role: "assistant", content: "Interim finding", timestamp: 2, partial: true },
      ],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })

    act(() => { emit("session:interrupted", { sessionId: "s1" }) })
    expect(result.current.turnPending).toBe(true)
    expect(result.current.liveFinalResponseId).toBeNull()

    act(() => { emit("session:stopped", { sessionId: "s1" }) })
    expect(result.current.loading).toBe(false)
    expect(result.current.turnPending).toBe(true)
    expect(result.current.liveFinalResponseId).toBeNull()

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: null, error: null })
      await Promise.resolve()
    })
    expect(result.current.turnPending).toBe(true)
    expect(result.current.liveFinalResponseId).toBeNull()
    expect(result.current.messages.map((message) => message.content)).toEqual(["keep going", "Interim finding"])
  })

  it("batches a terminal completion error with its live final response identity", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [{ id: "u1", role: "user", content: "run it", timestamp: 1 }],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: null, error: "engine failed" })
      await Promise.resolve()
    })

    expect(result.current.turnPending).toBe(false)
    expect(result.current.messages.at(-1)?.content).toBe("Error: engine failed")
    expect(result.current.liveFinalResponseId).toBe(result.current.messages.at(-1)?.id)
  })

  it("reconciles only current-turn evidence before a canonical terminal error", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "old-user", role: "user", content: "older request", timestamp: 1 },
        { id: "old-final", role: "assistant", content: "older answer", timestamp: 2 },
        { id: "current-user", role: "user", content: "run the failing task", timestamp: 3 },
      ],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })

    const olderTurn = result.current.messages.slice(0, 2)

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Inspecting the failure." })
      emit("session:delta", {
        sessionId: "s1",
        type: "tool_use",
        toolName: "Read",
        toolId: "tool-read",
      })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Temporary progress",
        block: {
          op: "put",
          block: { id: "plan", type: "task-list", version: 1, payload: {} },
        },
      })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Delegated verification",
        block: {
          op: "put",
          block: { id: "delegate", type: "delegation", version: 1, payload: {} },
        },
      })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Followed up with verifier",
        block: {
          op: "put",
          block: { id: "dispatch", type: "dispatch", version: 1, payload: {} },
        },
      })
      emit("session:notification", {
        sessionId: "s1",
        message: "Verifier callback received",
        meta: { commKind: "callback" },
      })
      emit("session:attachment", {
        sessionId: "s1",
        id: "evidence-image",
        content: "Failure screenshot",
        media: [{ type: "image", url: "https://example.test/failure.png" }],
        timestamp: 4,
      })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: null, error: "engine failed" })
      await Promise.resolve()
    })

    expect(result.current.messages.slice(0, 2)[0]).toBe(olderTurn[0])
    expect(result.current.messages.slice(0, 2)[1]).toBe(olderTurn[1])
    expect(result.current.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      toolCall: message.toolCall,
      blockTypes: message.blocks?.map((block) => block.type) ?? [],
      mediaCount: message.media?.length ?? 0,
    }))).toEqual([
      { id: "old-user", role: "user", content: "older request", toolCall: undefined, blockTypes: [], mediaCount: 0 },
      { id: "old-final", role: "assistant", content: "older answer", toolCall: undefined, blockTypes: [], mediaCount: 0 },
      { id: "current-user", role: "user", content: "run the failing task", toolCall: undefined, blockTypes: [], mediaCount: 0 },
      { id: expect.any(String), role: "assistant", content: "Inspecting the failure.", toolCall: undefined, blockTypes: [], mediaCount: 0 },
      { id: expect.any(String), role: "assistant", content: "Used Read", toolCall: "Read", blockTypes: [], mediaCount: 0 },
      { id: expect.stringContaining("block-delegate-"), role: "assistant", content: "Delegated verification", toolCall: undefined, blockTypes: ["delegation"], mediaCount: 0 },
      { id: expect.stringContaining("block-dispatch-"), role: "assistant", content: "Followed up with verifier", toolCall: undefined, blockTypes: ["dispatch"], mediaCount: 0 },
      { id: expect.any(String), role: "notification", content: "Verifier callback received", toolCall: undefined, blockTypes: [], mediaCount: 0 },
      { id: "evidence-image", role: "assistant", content: "Failure screenshot", toolCall: undefined, blockTypes: [], mediaCount: 1 },
      { id: result.current.liveFinalResponseId, role: "assistant", content: "Error: engine failed", toolCall: undefined, blockTypes: [], mediaCount: 0 },
    ])
    expect(result.current.messages.some((message) => message.blocks?.some((block) => block.type === "task-list"))).toBe(false)
    expect(result.current.messages.filter((message) => message.id === result.current.liveFinalResponseId)).toHaveLength(1)
    expect(result.current.messages.filter((message) => message.content === "Error: engine failed")).toHaveLength(1)
  })

  it("replaces the live view on a shorter snapshot (redaction must win, no length gate)", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      // Streamed increments make the live view show the pre-redaction text.
      emit("session:delta", { sessionId: "s1", type: "text", content: "secret " })
      emit("session:delta", { sessionId: "s1", type: "text", content: "answer" })
    })
    expect(result.current.streamingText).toBe("secret answer")

    act(() => {
      // A shorter marked-final snapshot (hermes redaction) must REPLACE the live
      // view — the old length gate left "secret answer" visible for the turn.
      emit("session:delta", { sessionId: "s1", type: "text_snapshot", content: "[REDACTED]" })
    })
    expect(result.current.streamingText).toBe("[REDACTED]")
    expect(result.current.streamingText).not.toContain("secret")
  })

  it("does not duplicate the answer when a late tool_use froze the streamed text (grok dedup)", async () => {
    // Reproduces the grok duplicate: answer text streams live, then a transcript
    // tool_use lands LATE and freezes that streamed text into a permanent assistant
    // bubble. Completion then delivers the identical canonical result — which must
    // be reconciled by identity, NOT appended a second time.
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "The answer is 42." })
      // Late transcript tool_use → flushes the streamed text into a permanent bubble.
      emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using read", toolName: "read" })
    })
    // After the flush: one frozen answer bubble + one tool card, nothing streaming.
    expect(result.current.streamingText).toBe("")
    expect(result.current.messages.filter((m) => m.content === "The answer is 42." && !m.toolCall)).toHaveLength(1)

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "The answer is 42." })
      await Promise.resolve()
    })
    // Exactly ONE copy of the answer survives (no duplicate). The tool row is
    // EVIDENCE and survives completion (marked done) — the post-turn fold
    // files it away visually instead of the data layer deleting it.
    expect(result.current.messages.filter((m) => m.content === "The answer is 42." && !m.toolCall)).toHaveLength(1)
    expect(result.current.messages.some((m) => m.toolCall === "read" && m.content === "Used read")).toBe(true)
  })

  it("keeps partial interim prose loaded from a running session when completion arrives", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [
        { id: "u1", role: "user", content: "do it", timestamp: 1 },
        { id: "p1", role: "assistant", content: "PROGRESS-FIRST", timestamp: 2, partial: true },
        { id: "p2", role: "assistant", content: "Using Bash", timestamp: 3, partial: true, toolCall: "Bash" },
      ],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((m) => m.content)).toEqual(["do it", "PROGRESS-FIRST", "Using Bash"])

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "PROGRESS-FINAL" })
      await Promise.resolve()
    })

    // Interim prose is EVIDENCE and survives (it folds with the tools and
    // matches what a reload shows); the tool row is kept marked done. Only a
    // bubble duplicating the final answer drops.
    expect(result.current.messages.map((m) => m.content)).toEqual(["do it", "PROGRESS-FIRST", "Used Bash", "PROGRESS-FINAL"])
    expect(result.current.messages.filter((m) => m.toolCall)).toHaveLength(1)
  })

  it("keeps interim prose as evidence and dedupes only the final answer on completion", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "PROGRESS-FIRST" })
      emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using Bash", toolName: "Bash" })
      emit("session:delta", { sessionId: "s1", type: "tool_result", content: "TOOL-CALL-OK", toolName: "Bash" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "PROGRESS-FINAL" })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "PROGRESS-FINAL" })
      await Promise.resolve()
    })

    // PROGRESS-FIRST survives as an interim update; PROGRESS-FINAL appears
    // exactly once (the streamed copy never became a message; a flushed
    // duplicate of the result would drop).
    expect(result.current.messages.map((m) => m.content)).toEqual(["PROGRESS-FIRST", "Used Bash", "PROGRESS-FINAL"])
    expect(result.current.messages.filter((m) => m.content === "PROGRESS-FINAL")).toHaveLength(1)
  })

  it("dedupes a flushed bubble that IS the final answer (exactly one answer live)", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      // grok-style: the engine streams the FINAL answer, then a tool_use
      // flushes it into a message before completion repeats it as result.
      emit("session:delta", { sessionId: "s1", type: "text", content: "FINAL-ANSWER" })
      emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using Bash", toolName: "Bash" })
      emit("session:delta", { sessionId: "s1", type: "tool_result", content: "ok", toolName: "Bash" })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "FINAL-ANSWER" })
      await Promise.resolve()
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Used Bash", "FINAL-ANSWER"])
  })

  it("shows transient status deltas and clears them when real output arrives", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "status", content: "checking" })
      emit("session:delta", { sessionId: "s1", type: "status", content: "files" })
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Thinking: checking files"])

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "status", content: "Plan: patch parser" })
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Plan: patch parser"])
    expect(result.current.messages[0]?.role).toBe("notification")

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Done" })
    })
    expect(result.current.messages).toEqual([])
    expect(result.current.streamingText).toBe("Done")

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Done."])
  })

  it("applies live block put, patch, and remove deltas without text duplication", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Intro" })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
          },
        },
      })
    })

    expect(result.current.streamingText).toBe("")
    expect(result.current.messages.filter((m) => m.content === "Intro")).toHaveLength(1)
    expect(result.current.messages.at(-1)?.blocks?.[0]?.id).toBe("plan")

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan complete",
        block: {
          op: "patch",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            status: "done",
            payload: { summary: "Complete" },
          },
        },
      })
    })

    expect(result.current.messages.filter((m) => m.blocks?.[0]?.id === "plan")).toHaveLength(1)
    expect(result.current.messages.filter((m) => m.content === "Intro")).toHaveLength(1)
    expect(result.current.messages.find((m) => m.blocks?.[0]?.id === "plan")?.content).toBe("Plan complete")
    expect(result.current.messages.find((m) => m.blocks?.[0]?.id === "plan")?.blocks?.[0]?.payload).toMatchObject({ summary: "Complete" })

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        block: {
          op: "remove",
          block: { id: "plan", type: "task-list", version: 1, payload: {} },
        },
      })
    })

    expect(result.current.messages.filter((m) => m.blocks?.[0]?.id === "plan")).toHaveLength(0)
    expect(result.current.messages.filter((m) => m.content === "Intro")).toHaveLength(1)
  })

  it("preserves a block evidence timestamp across a live patch and canonical reload", async () => {
    const runningBlock = {
      id: "plan-stable-time",
      type: "task-list" as const,
      version: 1,
      title: "Plan",
      payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
    }
    const completedBlock = {
      ...runningBlock,
      version: 2,
      status: "done" as const,
      payload: { ...runningBlock.payload, summary: "Complete" },
    }
    getSession.mockResolvedValueOnce({
      status: "running",
      messages: [{
        id: "persisted-plan",
        role: "assistant",
        content: "Plan",
        timestamp: 2_000,
        blocks: [runningBlock],
      }],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s-stable-time", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => emit("session:delta", {
      sessionId: "s-stable-time",
      type: "block",
      content: "Plan complete",
      block: { op: "patch", block: completedBlock },
    }))
    const liveTimestamp = result.current.messages[0]?.timestamp
    expect(liveTimestamp).toBe(2_000)

    getSession.mockResolvedValueOnce({
      status: "idle",
      messages: [{
        id: "persisted-plan",
        role: "assistant",
        content: "Plan complete",
        timestamp: 2_000,
        blocks: [completedBlock],
      }],
    })
    await act(async () => { await result.current.reload("s-stable-time") })

    expect(result.current.messages[0]?.timestamp).toBe(liveTimestamp)
    expect(result.current.messages[0]?.blocks?.[0]).toMatchObject({ version: 2, status: "done" })
  })

  it("keeps equal-version Workflow activity monotonic across out-of-order live deltas and reload", async () => {
    const block = (action: string, activityOrder: number) => ({
      id: "workflow-definition:ordered-live",
      type: "workflow-definition" as const,
      version: 7,
      activityOrder,
      status: "done" as const,
      title: "Ordered live workflow",
      summary: action,
      payload: {
        workflowId: "ordered-live",
        action,
        definitionStatus: "active",
        openPath: "/workflow/ordered-live",
      },
    })
    getSession.mockResolvedValueOnce({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-ordered-live", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", {
        sessionId: "s-ordered-live",
        type: "block",
        content: "deleted",
        block: { op: "put", block: block("trigger-deleted", 20) },
      })
      emit("session:delta", {
        sessionId: "s-ordered-live",
        type: "block",
        content: "late created",
        block: { op: "put", block: block("trigger-created", 10) },
      })
    })
    expect(result.current.messages.flatMap((message) => message.blocks ?? [])[0]?.payload.action)
      .toBe("trigger-deleted")

    getSession.mockResolvedValueOnce({
      status: "idle",
      messages: [{
        id: "persisted-ordered-live",
        role: "assistant",
        content: "decided",
        timestamp: 30,
        blocks: [block("trigger-approval-decided", 30)],
      }],
    })
    await act(async () => { await result.current.reload("s-ordered-live") })
    act(() => emit("session:delta", {
      sessionId: "s-ordered-live",
      type: "block",
      content: "late definition update",
      block: { op: "put", block: block("updated", 25) },
    }))
    expect(result.current.messages.flatMap((message) => message.blocks ?? [])[0]).toMatchObject({
      activityOrder: 30,
      payload: { action: "trigger-approval-decided" },
    })
  })

  it.each([
    {
      label: "successful",
      status: "done",
      displayMessage: "📩 Design Lead replied\nThe design is ready.",
      meta: { kind: "child-reply", employee: "design-lead", childSessionId: "child-1" },
    },
    {
      label: "failed",
      status: "error",
      displayMessage: "⚠️ Design Lead couldn't finish\nThe build failed.",
      meta: { kind: "child-error", employee: "design-lead", childSessionId: "child-1" },
    },
  ])("renders a $label live child callback exactly once", async ({ status, displayMessage, meta }) => {
    const taskTitle = "Redesign the workflow canvas"
    getSession.mockResolvedValue({
      status: "running",
      messages: [{
        id: "handoff-message",
        role: "assistant",
        content: taskTitle,
        timestamp: 100,
        blocks: [{
          id: "dg-wi-1",
          type: "delegation",
          version: 1,
          status: "running",
          payload: {
            employee: "design-lead",
            employeeDisplay: "Design Lead",
            title: taskTitle,
            childSessionId: "child-1",
            workItemId: "wi-1",
            dispatchedAt: 100,
          },
        }],
      }],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: displayMessage,
        block: {
          op: "patch",
          block: {
            id: "dg-wi-1",
            type: "delegation",
            version: 1,
            status,
            payload: { repliedAt: 200 },
          },
        },
      })
      emit("session:notification", { sessionId: "s1", message: displayMessage, meta })
    })

    expect(result.current.messages.filter((message) => message.content === displayMessage)).toHaveLength(1)
    expect(result.current.messages.find((message) => message.blocks?.[0]?.id === "dg-wi-1")).toMatchObject({
      content: taskTitle,
      blocks: [{ status }],
    })
    expect(result.current.messages.at(-1)).toMatchObject({ role: "notification", content: displayMessage, meta })
  })

  it("keeps live task-list blocks separate from tool-call rows", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "file_edit", content: "file_edit" })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
          },
        },
      })
    })

    expect(result.current.messages).toHaveLength(2)
    expect(result.current.messages[0]?.toolCall).toBe("file_edit")
    expect(result.current.messages[0]?.blocks).toBeUndefined()
    expect(result.current.messages[1]?.blocks?.[0]?.id).toBe("plan")
  })

  it("drops live task-list blocks when a turn completes with text", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan running.",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
          },
        },
      })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual(["Done."])
    expect(result.current.messages.some((m) => m.blocks?.some((block) => block.id === "plan"))).toBe(false)
  })

  it("marks the matching unfinished tool row done when a block arrives before tool_result", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "file_edit", toolId: "tool-1" })
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Plan",
        block: {
          op: "put",
          block: {
            id: "plan",
            type: "task-list",
            version: 1,
            title: "Plan",
            payload: { items: [{ id: "a", text: "Edit file", status: "running" }] },
          },
        },
      })
      emit("session:delta", { sessionId: "s1", type: "tool_result", toolName: "file_edit", toolId: "tool-1" })
    })

    expect(result.current.messages.find((m) => m.toolCall === "file_edit")?.content).toBe("Used file_edit")
    expect(result.current.messages.some((m) => m.blocks?.some((block) => block.id === "plan"))).toBe(true)
  })

  it("marks only first-time live delegation puts with stable 0/60/120ms arrival provenance", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-arrivals", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })
    const put = (id: string) => emit("session:delta", {
      sessionId: "s-arrivals",
      type: "block",
      content: id,
      block: {
        op: "put",
        block: { id, type: "delegation", version: 1, status: "running", payload: { childSessionId: `child-${id}` } },
      },
    })

    act(() => { put("d1"); put("d2"); put("d3") })
    expect([...result.current.blockArrivals.entries()].map(([id, arrival]) => [id, arrival.delayMs]))
      .toEqual([["d1", 0], ["d2", 60], ["d3", 120]])
    const firstNonce = result.current.blockArrivals.get("d1")?.nonce

    act(() => put("d1"))
    expect(result.current.blockArrivals.get("d1")?.nonce).toBe(firstNonce)
    expect(result.current.messages.filter((m) => m.blocks?.some((b) => b.id === "d1"))).toHaveLength(1)
  })

  it("does not create delegation arrival provenance for hydration or patch", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [{
        id: "hydrated",
        role: "assistant",
        content: "Hydrated",
        blocks: [{ id: "d1", type: "delegation", version: 1, status: "running", payload: {} }],
      }],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-hydrated", { subscribe, readOnly: true }))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.blockArrivals.size).toBe(0)

    act(() => emit("session:delta", {
      sessionId: "s-hydrated",
      type: "block",
      block: { op: "patch", block: { id: "d1", type: "delegation", version: 2, status: "waiting", payload: {} } },
    }))
    expect(result.current.blockArrivals.size).toBe(0)
  })

  it("animates only first-time live dispatch puts with stable bounded provenance and one announcement", async () => {
    vi.useFakeTimers()
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result, unmount } = renderHook(() => useLiveSession("s-dispatch-live", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })
    const envelope = (id: string, op: "put" | "patch" = "put") => ({
      sessionId: "s-dispatch-live",
      type: "block",
      content: `Followed up: ${id}`,
      block: {
        op,
        block: {
          id,
          type: "dispatch",
          version: op === "put" ? 1 : 2,
          status: "done",
          payload: { targetSessionId: `child-${id}`, preview: id },
        },
      },
    })

    act(() => {
      emit("session:delta", envelope("dp-1"))
      emit("session:delta", envelope("dp-2"))
      emit("session:delta", envelope("dp-3"))
      emit("session:delta", envelope("dp-4"))
    })

    expect([...result.current.blockArrivals.entries()].map(([id, arrival]) => [id, arrival.delayMs]))
      .toEqual([["dp-1", 0], ["dp-2", 60], ["dp-3", 120], ["dp-4", 120]])
    const firstNonce = result.current.blockArrivals.get("dp-1")?.nonce
    act(() => { vi.advanceTimersByTime(80) })
    expect(result.current.blockAnnouncement).toBe("4 follow-ups sent")

    act(() => {
      emit("session:delta", envelope("dp-1"))
      emit("session:delta", envelope("dp-1", "patch"))
      vi.advanceTimersByTime(80)
    })
    expect(result.current.blockArrivals.get("dp-1")?.nonce).toBe(firstNonce)
    expect(result.current.blockAnnouncement).toBe("4 follow-ups sent")
    expect(result.current.messages.flatMap((message) => message.blocks ?? []).filter((block) => block.id === "dp-1"))
      .toHaveLength(1)

    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current.blockArrivals.size).toBe(0)
    act(() => emit("session:delta", envelope("dp-1")))
    expect(result.current.blockArrivals.size).toBe(0)

    unmount()
    vi.useRealTimers()
  })

  it("never creates dispatch arrival provenance from hydration, reconnect, pagination, or cached restoration", async () => {
    const hydratedDispatch: Message = {
      id: "hydrated-dispatch-message",
      role: "assistant",
      content: "Followed up: hydrated",
      timestamp: 10,
      blocks: [{
        id: "dp-hydrated",
        type: "dispatch",
        version: 1,
        status: "done",
        payload: { targetSessionId: "child-hydrated", preview: "hydrated" },
      }],
    }
    getSession.mockResolvedValue({
      id: "s-dispatch-history",
      status: "running",
      messages: [hydratedDispatch],
      messagesPage: { hasOlder: true },
    })
    getSessionMessages.mockResolvedValue({ messages: [{
      ...hydratedDispatch,
      id: "older-dispatch-message",
      blocks: [{ ...hydratedDispatch.blocks![0], id: "dp-older" }],
    }], hasOlder: false })
    const { subscribe, emit } = makeBus()
    const { result, rerender, unmount } = renderHook(
      ({ connectionSeq }) => useLiveSession("s-dispatch-history", { subscribe, readOnly: true, connectionSeq }),
      { initialProps: { connectionSeq: 0 } },
    )
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.blockArrivals.size).toBe(0)

    act(() => emit("session:delta", {
      sessionId: "s-dispatch-history",
      type: "block",
      block: { op: "patch", block: { ...hydratedDispatch.blocks![0], version: 2 } },
    }))
    expect(result.current.blockArrivals.size).toBe(0)

    rerender({ connectionSeq: 1 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)) })
    expect(result.current.blockArrivals.size).toBe(0)

    await act(async () => { await result.current.loadOlderMessages() })
    expect(result.current.blockArrivals.size).toBe(0)

    unmount()
    const cachedBus = makeBus()
    const cached = renderHook(() => useLiveSession("s-dispatch-history", { subscribe: cachedBus.subscribe, readOnly: true }))
    expect(cached.result.current.blockArrivals.size).toBe(0)
    act(() => cachedBus.emit("session:delta", {
      sessionId: "s-dispatch-history",
      type: "block",
      content: hydratedDispatch.content,
      block: { op: "put", block: hydratedDispatch.blocks![0] },
    }))
    expect(cached.result.current.blockArrivals.size).toBe(0)
    cached.unmount()
  })

  it("drops ephemeral dispatch arrival state across a session switch and Back restoration", async () => {
    getSession.mockImplementation(async (id: string) => ({ id, status: "running", messages: [] }))
    const { subscribe, emit } = makeBus()
    const { result, rerender } = renderHook(
      ({ sessionId }) => useLiveSession(sessionId, { subscribe, readOnly: true }),
      { initialProps: { sessionId: "s-dispatch-a" } },
    )
    await act(async () => { await Promise.resolve() })
    const livePut = {
      sessionId: "s-dispatch-a",
      type: "block",
      content: "Followed up: keep the identity stable",
      block: {
        op: "put",
        block: {
          id: "dp-switch",
          type: "dispatch",
          version: 1,
          status: "done",
          payload: { targetSessionId: "child-switch", preview: "keep the identity stable" },
        },
      },
    }

    act(() => emit("session:delta", livePut))
    expect(result.current.blockArrivals.has("dp-switch")).toBe(true)

    act(() => rerender({ sessionId: "s-dispatch-b" }))
    expect(result.current.blockArrivals.size).toBe(0)
    act(() => rerender({ sessionId: "s-dispatch-a" }))
    act(() => emit("session:delta", livePut))
    expect(result.current.blockArrivals.size).toBe(0)
  })

  it("marks a live active-to-terminal patch for one anchored fold cycle", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-settlement", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })

    act(() => emit("session:delta", {
      sessionId: "s-settlement",
      type: "block",
      block: {
        op: "put",
        block: {
          id: "d-settle",
          type: "delegation",
          version: 1,
          status: "running",
          payload: { employee: "dev", employeeDisplay: "Dev", title: "Audit transitions" },
        },
      },
    }))
    expect(result.current.liveTerminalDelegationIds.has("d-settle")).toBe(false)

    act(() => emit("session:delta", {
      sessionId: "s-settlement",
      type: "block",
      block: {
        op: "patch",
        block: { id: "d-settle", type: "delegation", version: 2, status: "done", payload: {} },
      },
    }))
    expect(result.current.liveTerminalDelegationIds.has("d-settle")).toBe(true)
    const settled = result.current.messages.flatMap((message) => message.blocks ?? []).find((block) => block.id === "d-settle")
    expect(settled?.payload).toMatchObject({ employee: "dev", employeeDisplay: "Dev", title: "Audit transitions" })
    expect(result.current.messages.flatMap((message) => message.blocks ?? []).filter((block) => block.id === "d-settle")).toHaveLength(1)
  })

  it("marks an earlier unfinished tool row done by toolId without closing a later tool", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "search", toolId: "tool-1" })
      emit("session:delta", { sessionId: "s1", type: "tool_use", toolName: "read", toolId: "tool-2" })
      emit("session:delta", { sessionId: "s1", type: "tool_result", toolId: "tool-1" })
    })

    expect(result.current.messages.find((m) => m.toolCall === "search")?.content).toBe("Used search")
    expect(result.current.messages.find((m) => m.toolCall === "read")?.content).toBe("Using read")
  })

  it("attaches interleaved receipt ids to the exact matching live tool rows", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-receipts", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s-receipts", type: "tool_use", toolName: "search", toolId: "call-1" })
      emit("session:delta", { sessionId: "s-receipts", type: "tool_use", toolName: "search", toolId: "call-2" })
      emit("session:delta", { sessionId: "s-receipts", type: "tool_result", toolName: "search", toolId: "call-1", activityReceiptId: "todo:wi_one" })
      emit("session:delta", { sessionId: "s-receipts", type: "tool_result", toolName: "search", toolId: "call-2", activityReceiptId: "todo:wi_two" })
    })

    expect(result.current.messages.filter((m) => m.toolCall === "search").map((m) => ({
      toolId: m.toolId,
      meta: m.meta,
    }))).toEqual([
      { toolId: "call-1", meta: { activityReceiptId: "todo:wi_one" } },
      { toolId: "call-2", meta: { activityReceiptId: "todo:wi_two" } },
    ])
  })

  it("uses the most recent still-open same-name row when a result has no tool id", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-name-fallback", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s-name-fallback", type: "tool_use", toolName: "search" })
      emit("session:delta", { sessionId: "s-name-fallback", type: "tool_use", toolName: "read" })
      emit("session:delta", { sessionId: "s-name-fallback", type: "tool_result", toolName: "search", activityReceiptId: "todo:wi_search" })
    })

    expect(result.current.messages.find((m) => m.toolCall === "search")).toMatchObject({
      content: "Used search",
      meta: { activityReceiptId: "todo:wi_search" },
    })
    expect(result.current.messages.find((m) => m.toolCall === "read")?.content).toBe("Using read")
  })

  it("ignores obsolete block types from live deltas", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", {
        sessionId: "s1",
        type: "block",
        content: "Diff",
        block: {
          op: "put",
          block: {
            id: "diff",
            type: "diff",
            version: 1,
            payload: { hunks: [{ before: "old", after: "new" }] },
          },
        },
      })
    })

    expect(result.current.messages).toEqual([])
  })

  it("appends a live media attachment", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:attachment", {
        sessionId: "s1",
        id: "att1",
        content: "chart",
        media: [{ type: "image", url: "https://x/y.png" }],
      })
    })
    const last = result.current.messages.at(-1)
    expect(last?.media?.[0]?.url).toBe("https://x/y.png")
    // Idempotent on a duplicate event (same id).
    act(() => {
      emit("session:attachment", {
        sessionId: "s1",
        id: "att1",
        content: "chart",
        media: [{ type: "image", url: "https://x/y.png" }],
      })
    })
    expect(result.current.messages.filter((m) => m.id === "att1").length).toBe(1)
  })

  it("ignores events for a different session", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    act(() => {
      emit("session:delta", { sessionId: "OTHER", type: "text", content: "nope" })
    })
    expect(result.current.streamingText).toBe("")
  })

  it("surfaces a load error instead of hanging (modal anti-hang)", async () => {
    getSession.mockRejectedValue(new Error("boom"))
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.messages).toEqual([])
    expect(result.current.session).toBeNull()
  })
})

describe("useLiveSession (editable write path)", () => {
  it("keeps a just-sent user message through a stale tail snapshot, then dedupes the server echo", async () => {
    const existing = { id: "a1", role: "assistant" as const, content: "Ready", timestamp: 1 }
    const optimistic = { id: "client-u1", role: "user" as const, content: "Run it", timestamp: 2 }
    const echoed = { id: "server-u1", role: "user" as const, content: "Run it", timestamp: 3 }
    getSession.mockResolvedValueOnce({ status: "idle", messages: [existing] })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-race", { subscribe }))

    // beginSend appends it pending; the server has not acknowledged it yet.
    const sending = { ...optimistic, sendState: "pending" as const }
    await act(async () => { await Promise.resolve() })
    act(() => { result.current.beginSend(optimistic) })
    expect(result.current.messages).toEqual([existing, sending])

    // The tail sync wins the race with persistence and does not contain the POST yet.
    getSession.mockResolvedValueOnce({ status: "idle", messages: [existing] })
    await act(async () => { await result.current.reload("s-race") })
    expect(result.current.messages).toEqual([existing, sending])

    // Once the canonical row arrives, it dedupes to ONE user message — and the
    // optimistic id is preserved (content adopts the server row) so the row and
    // its turn/fold key never remount: no first-send flicker.
    getSession.mockResolvedValueOnce({ status: "idle", messages: [existing, echoed] })
    await act(async () => { await result.current.reload("s-race") })
    const users = result.current.messages.filter((m) => m.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].id).toBe("client-u1")
    expect(users[0].content).toBe("Run it")
    expect(result.current.messages.map((m) => m.id)).toEqual(["a1", "client-u1"])
  })

  it("hydrates from the in-memory session cache immediately while revalidating", async () => {
    // The cached session is mid-run, so the snapshot is NOT "resting" and the
    // remount must still revalidate in the background (a resting idle snapshot
    // skips the refetch entirely — covered in the resting-snapshot suite).
    getSession.mockResolvedValueOnce({
      status: "running",
      messages: [{ id: "m1", role: "user", content: "cached question" }],
    })
    const { subscribe } = makeBus()
    const first = renderHook(() => useLiveSession("s-cache", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(first.result.current.messages.map((m) => m.content)).toEqual(["cached question"])
    first.unmount()

    let resolveFresh!: (value: unknown) => void
    getSession.mockReturnValueOnce(new Promise((resolve) => { resolveFresh = resolve }))
    const second = renderHook(() => useLiveSession("s-cache", { subscribe }))

    expect(second.result.current.hydrating).toBe(false)
    expect(second.result.current.messages.map((m) => m.content)).toEqual(["cached question"])
    expect(getSession).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveFresh({
        status: "idle",
        messages: [{ id: "m2", role: "assistant", content: "fresh answer" }],
      })
      await Promise.resolve()
    })
    expect(second.result.current.messages.map((m) => m.content)).toEqual(["fresh answer"])
  })

  it("reports hydrating for an uncached session until the first fetch resolves", async () => {
    let resolveFresh!: (value: unknown) => void
    getSession.mockReturnValue(new Promise((resolve) => { resolveFresh = resolve }))
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-cold", { subscribe }))

    expect(result.current.hydrating).toBe(true)

    await act(async () => {
      resolveFresh({ status: "idle", messages: [] })
      await Promise.resolve()
    })
    expect(result.current.hydrating).toBe(false)
  })

  it("keeps the pending user message visible while a newly-created session hydrates", async () => {
    let resolveFresh!: (value: unknown) => void
    getSession.mockReturnValue(new Promise((resolve) => { resolveFresh = resolve }))
    const { subscribe } = makeBus()
    const pendingUserMessage = {
      id: "u1",
      role: "user" as const,
      content: "start this task",
      timestamp: 1,
    }
    const { result } = renderHook(() =>
      useLiveSession("s-new", { subscribe, pendingUserMessage }),
    )

    expect(result.current.messages.map((m) => m.content)).toEqual(["start this task"])
    expect(result.current.loading).toBe(true)
    expect(result.current.hydrating).toBe(false)

    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((m) => m.content)).toEqual(["start this task"])
    expect(result.current.loading).toBe(true)
    expect(result.current.hydrating).toBe(false)

    await act(async () => {
      resolveFresh({
        status: "running",
        messages: [{ id: "u1", role: "user", content: "start this task", timestamp: 1 }],
      })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual(["start this task"])
    expect(result.current.loading).toBe(true)
    expect(result.current.hydrating).toBe(false)
  })

  it("dedupes paged canonical user snapshots so completion keeps the next prompt", async () => {
    const first = "first prompt"
    const second = "second prompt"
    getSession.mockResolvedValueOnce({
      status: "running",
      messages: [{ id: "server-first", role: "user", content: first, timestamp: 1001 }],
      messagesPage: { hasOlder: false },
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s-new", {
        subscribe,
        pendingUserMessage: {
          id: "client-first",
          role: "user",
          content: first,
          timestamp: 1000,
        },
      }),
    )

    await act(async () => { await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual([first])

    getSession.mockResolvedValueOnce({ status: "idle" })
    await act(async () => {
      emit("session:completed", { sessionId: "s-new", result: "OK" })
      await Promise.resolve()
    })
    expect(result.current.messages.map((m) => m.content)).toEqual([first, "OK"])

    act(() => {
      result.current.beginSend({
        id: "client-second",
        role: "user",
        content: second,
        timestamp: 3000,
      })
    })

    getSession.mockResolvedValueOnce({
      status: "running",
      messages: [
        { id: "server-first", role: "user", content: first, timestamp: 1001 },
        { id: "server-ok", role: "assistant", content: "OK", timestamp: 2000 },
        { id: "server-second", role: "user", content: second, timestamp: 3001 },
      ],
      messagesPage: { hasOlder: false },
    })
    await act(async () => {
      await result.current.reload("s-new")
    })
    expect(result.current.messages.map((m) => m.content)).toEqual([first, "OK", second])

    getSession.mockResolvedValueOnce({ status: "idle" })
    await act(async () => {
      emit("session:completed", { sessionId: "s-new", result: "OK2" })
      await Promise.resolve()
    })
    expect(result.current.messages.map((m) => m.content)).toEqual([first, "OK", second, "OK2"])
  })

  it("evicts old session cache entries so switching does not grow unbounded", () => {
    for (let i = 0; i < 25; i++) {
      __cacheLiveSessionSnapshotForTests(`s-${i}`, {
        messages: [{ id: `m-${i}`, role: "user", content: `message ${i}`, timestamp: i }],
        streamingText: "",
        loading: false,
        session: { id: `s-${i}`, status: "idle" },
        liveContextTokens: null,
        backgroundActivity: null,
      })
    }

    expect(__getLiveSessionSnapshotCacheSizeForTests()).toBeLessThanOrEqual(16)
  })

  it("replaces a cached in-flight snapshot with collapsed idle history after switching back", async () => {
    __cacheLiveSessionSnapshotForTests("s-stale", {
      messages: [
        { id: "u1", role: "user", content: "long task", timestamp: 1 },
        { id: "p1", role: "assistant", content: "Working through files", timestamp: 2 },
        { id: "t1", role: "assistant", content: "Using Bash", timestamp: 3, toolCall: "Bash" },
        { id: "p2", role: "assistant", content: "More progress", timestamp: 4 },
      ],
      streamingText: "partial final",
      loading: true,
      session: { id: "s-stale", status: "running" },
      liveContextTokens: 123,
      backgroundActivity: null,
    })
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u1", role: "user", content: "long task", timestamp: 1 },
        { id: "a1", role: "assistant", content: "Final answer", timestamp: 5 },
      ],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s-stale", { subscribe }))

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "long task",
      "Working through files",
      "Using Bash",
      "More progress",
    ])
    expect(result.current.streamingText).toBe("partial final")
    expect(result.current.loading).toBe(true)

    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((m) => m.content)).toEqual(["long task", "Final answer"])
    expect(result.current.messages.some((m) => m.toolCall)).toBe(false)
    expect(result.current.streamingText).toBe("")
    expect(result.current.loading).toBe(false)
    expect(result.current.liveContextTokens).toBeNull()
  })

  it("seeds loading from a running session after reload or tab switch", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [{ id: "m1", role: "user", content: "hi" }] })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.loading).toBe(true)
  })

  it("sets loading true when a queued turn starts", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.loading).toBe(false)

    act(() => {
      emit("session:started", { sessionId: "s1" })
    })
    expect(result.current.loading).toBe(true)
  })

  it("optimistic send → delta accumulation → completion replaces with result", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({
        id: "u1",
        role: "user",
        content: "do it",
        timestamp: 1,
      })
    })
    expect(result.current.messages.at(-1)?.content).toBe("do it")
    expect(result.current.loading).toBe(true)

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "work" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "ing" })
    })
    expect(result.current.streamingText).toBe("working")

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.streamingText).toBe("")
    expect(result.current.messages.map((m) => m.content)).toEqual(["do it", "Done."])
  })

  it("does not remove an older identical assistant answer when a later turn completes", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u-old", role: "user", content: "old question", timestamp: 1 },
        { id: "a-old", role: "assistant", content: "Done.", timestamp: 2 },
      ],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({
        id: "u-new",
        role: "user",
        content: "new question",
        timestamp: 3,
      })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "old question",
      "Done.",
      "new question",
      "Done.",
    ])
  })

  it("seeds backgroundActivity from the session fetch and clears it on session switch", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [],
      backgroundActivity: { activeStreams: 2, lastActivityAt: "2026-06-10T00:00:00Z" },
    })
    const { subscribe } = makeBus()
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useLiveSession(id, { subscribe }),
      { initialProps: { id: "s1" as string | null } },
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toEqual({
      activeStreams: 2,
      lastActivityAt: "2026-06-10T00:00:00Z",
    })

    // Switching away must not leak the previous session's indicator.
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    rerender({ id: "s2" })
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("updates backgroundActivity on session:background and clears on null", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toBeNull()

    act(() => {
      emit("session:background", {
        sessionId: "s1",
        backgroundActivity: { activeStreams: 3, lastActivityAt: "2026-06-10T01:00:00Z" },
      })
    })
    expect(result.current.backgroundActivity?.activeStreams).toBe(3)

    // The cleared case is an explicit event with backgroundActivity: null.
    act(() => {
      emit("session:background", { sessionId: "s1", backgroundActivity: null })
    })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("ignores session:background for a different session", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:background", {
        sessionId: "OTHER",
        backgroundActivity: { activeStreams: 9, lastActivityAt: "2026-06-10T01:00:00Z" },
      })
    })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("reconciles messages from the server on session:external-turn", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [{ id: "m1", role: "user", content: "hi" }],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual(["hi"])

    // The gateway persisted a CLI-typed turn — the event must trigger a refetch.
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "user", content: "typed in CLI" },
        { id: "m3", role: "assistant", content: "answered in CLI" },
      ],
    })
    await act(async () => {
      emit("session:external-turn", { sessionId: "s1" })
      await Promise.resolve()
    })
    expect(getSession).toHaveBeenCalledTimes(2)
    expect(result.current.messages.map((m) => m.content)).toEqual([
      "hi",
      "typed in CLI",
      "answered in CLI",
    ])
  })

  it("ignores session:external-turn for a different session", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(getSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      emit("session:external-turn", { sessionId: "OTHER" })
      await Promise.resolve()
    })
    expect(getSession).toHaveBeenCalledTimes(1)
  })
})

describe("resting-snapshot revisits", () => {
  const idleSnapshot = (id: string) => ({
    messages: [{ id: "m1", role: "assistant" as const, content: "cached transcript", timestamp: 1 }],
    streamingText: "",
    loading: false,
    session: { id, status: "idle", title: "Cached title", employee: "jinn-dev" },
    liveContextTokens: null,
    backgroundActivity: null,
    hasOlderMessages: false,
  })

  it("restores turnPending when the same hook switches between cached sessions", async () => {
    __cacheLiveSessionSnapshotForTests("s-waiting", {
      messages: [
        { id: "u-waiting", role: "user", content: "keep going", timestamp: 1 },
        { id: "p-waiting", role: "assistant", content: "Interim finding", timestamp: 2, partial: true },
      ],
      streamingText: "",
      loading: false,
      turnPending: true,
      session: { id: "s-waiting", status: "waiting" },
      liveContextTokens: null,
      backgroundActivity: null,
      hasOlderMessages: false,
    })
    __cacheLiveSessionSnapshotForTests("s-done", {
      messages: [
        { id: "u-done", role: "user", content: "finished task", timestamp: 3 },
        { id: "a-done", role: "assistant", content: "Final answer", timestamp: 4 },
      ],
      streamingText: "",
      loading: false,
      turnPending: false,
      session: { id: "s-done", status: "idle" },
      liveContextTokens: null,
      backgroundActivity: null,
      hasOlderMessages: false,
    })
    getSession.mockReturnValue(new Promise(() => {}))
    const { subscribe } = makeBus()
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useLiveSession(id, { subscribe, readOnly: true }),
      { initialProps: { id: "s-waiting" } },
    )

    expect(result.current.turnPending).toBe(true)

    rerender({ id: "s-done" })
    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((message) => message.content)).toEqual(["finished task", "Final answer"])
    expect(result.current.turnPending).toBe(false)
    expect(result.current.liveFinalResponseId).toBeNull()
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it("isolates live final identity and in-flight loads when a cached resting session takes over", async () => {
    getSession
      .mockResolvedValueOnce({
        status: "running",
        messages: [{ id: "u-live", role: "user", content: "live task", timestamp: 1 }],
      })
      .mockResolvedValueOnce({ status: "idle" })
    const { subscribe, emit } = makeBus()
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useLiveSession(id, { subscribe, readOnly: true }),
      { initialProps: { id: "s-live" } },
    )
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      emit("session:completed", { sessionId: "s-live", result: "Live final" })
      await Promise.resolve()
    })
    expect(result.current.liveFinalResponseId).toBe(result.current.messages.at(-1)?.id)

    __cacheLiveSessionSnapshotForTests("s-revalidating", {
      messages: [{ id: "u-old", role: "user", content: "old pending task", timestamp: 3 }],
      streamingText: "",
      loading: false,
      turnPending: true,
      session: { id: "s-revalidating", status: "waiting" },
      liveContextTokens: null,
      backgroundActivity: null,
      hasOlderMessages: false,
    })
    __cacheLiveSessionSnapshotForTests("s-resting", {
      messages: [
        { id: "u-resting", role: "user", content: "resting task", timestamp: 5 },
        { id: "a-resting", role: "assistant", content: "Resting final", timestamp: 6 },
      ],
      streamingText: "",
      loading: false,
      turnPending: false,
      session: { id: "s-resting", status: "idle" },
      liveContextTokens: null,
      backgroundActivity: null,
      hasOlderMessages: false,
    })
    let resolveOldLoad!: (value: unknown) => void
    getSession.mockReturnValueOnce(new Promise((resolve) => { resolveOldLoad = resolve }))

    rerender({ id: "s-revalidating" })
    await act(async () => { await Promise.resolve() })
    expect(result.current.turnPending).toBe(true)
    expect(result.current.liveFinalResponseId).toBeNull()

    rerender({ id: "s-resting" })
    await act(async () => { await Promise.resolve() })
    expect(result.current.messages.map((message) => message.content)).toEqual(["resting task", "Resting final"])
    expect(result.current.turnPending).toBe(false)
    expect(result.current.liveFinalResponseId).toBeNull()

    await act(async () => {
      resolveOldLoad({
        status: "waiting",
        messages: [{ id: "u-old", role: "user", content: "stale server response", timestamp: 7 }],
      })
      await Promise.resolve()
    })
    expect(result.current.messages.map((message) => message.content)).toEqual(["resting task", "Resting final"])
    expect(result.current.turnPending).toBe(false)
  })

  it("renders a fresh idle snapshot WITHOUT refetching, and emits meta from it", async () => {
    __cacheLiveSessionSnapshotForTests("s9", idleSnapshot("s9"))
    const { subscribe } = makeBus()
    const onMeta = vi.fn()
    const { result } = renderHook(() => useLiveSession("s9", { subscribe, readOnly: true, onMeta }))
    await act(async () => { await Promise.resolve() })

    expect(result.current.messages.map((m) => m.content)).toEqual(["cached transcript"])
    expect(result.current.hydrating).toBe(false)
    expect(getSession).not.toHaveBeenCalled()
    expect(onMeta).toHaveBeenCalledWith(expect.objectContaining({ title: "Cached title", employee: "jinn-dev" }))
  })

  it("still revalidates when the cached session was RUNNING", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    __cacheLiveSessionSnapshotForTests("s10", {
      ...idleSnapshot("s10"),
      loading: true,
      session: { id: "s10", status: "running" },
    })
    const { subscribe } = makeBus()
    renderHook(() => useLiveSession("s10", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it("invalidateLiveSessionSnapshot forces a cold fetch on the next visit", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    __cacheLiveSessionSnapshotForTests("s11", idleSnapshot("s11"))
    invalidateLiveSessionSnapshot("s11")
    const { subscribe } = makeBus()
    renderHook(() => useLiveSession("s11", { subscribe, readOnly: true }))
    await act(async () => { await Promise.resolve() })
    expect(getSession).toHaveBeenCalledTimes(1)
  })
})

describe("isRestingSnapshot", () => {
  const base = {
    messages: [],
    streamingText: "",
    loading: false,
    session: { status: "idle" } as Record<string, unknown>,
    liveContextTokens: null,
    backgroundActivity: null,
    hasOlderMessages: false,
    updatedAt: 1_000_000,
  }

  it("accepts a fresh, idle, non-streaming snapshot (error status too)", () => {
    expect(isRestingSnapshot(base, base.updatedAt + 1_000)).toBe(true)
    expect(isRestingSnapshot({ ...base, session: { status: "error" } }, base.updatedAt)).toBe(true)
  })

  it("rejects once the revisit TTL is exceeded", () => {
    expect(isRestingSnapshot(base, base.updatedAt + SESSION_SNAPSHOT_REVISIT_TTL_MS)).toBe(true)
    expect(isRestingSnapshot(base, base.updatedAt + SESSION_SNAPSHOT_REVISIT_TTL_MS + 1)).toBe(false)
  })

  it("rejects loading / streaming / running / unknown-status / missing-session snapshots", () => {
    const now = base.updatedAt
    expect(isRestingSnapshot({ ...base, loading: true }, now)).toBe(false)
    expect(isRestingSnapshot({ ...base, streamingText: "tail" }, now)).toBe(false)
    expect(isRestingSnapshot({ ...base, session: { status: "running" } }, now)).toBe(false)
    expect(isRestingSnapshot({ ...base, session: { status: "waiting" } }, now)).toBe(false)
    expect(isRestingSnapshot({ ...base, session: {} }, now)).toBe(false)
    expect(isRestingSnapshot({ ...base, session: null }, now)).toBe(false)
  })
})
