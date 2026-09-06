import { describe, it, expect } from 'vitest'
import type { Message } from '@/lib/conversations'
import { reconcileCompletedTurnMessages } from '../completed-turn-messages'

describe("reconcileCompletedTurnMessages", () => {
  it("classifies success and error evidence identically except for canonical success dedup", () => {
    const olderUser: Message = { id: "older-user", role: "user", content: "older request", timestamp: 1 }
    const olderFinal: Message = { id: "older-final", role: "assistant", content: "older answer", timestamp: 2 }
    const currentEvidence: Message[] = [
      { id: "current-user", role: "user", content: "current request", timestamp: 3 },
      { id: "interim", role: "assistant", content: "Interim prose", timestamp: 4 },
      { id: "tool", role: "assistant", content: "Using Read", timestamp: 5, toolCall: "Read" },
      { id: "notification", role: "notification", content: "Callback received", timestamp: 6 },
      {
        id: "media",
        role: "assistant",
        content: "Screenshot",
        timestamp: 7,
        media: [{ type: "image", url: "https://example.test/evidence.png" }],
      },
      {
        id: "delegation",
        role: "assistant",
        content: "Delegated",
        timestamp: 8,
        blocks: [{ id: "delegation", type: "delegation", version: 1, payload: {} }],
      },
      {
        id: "dispatch",
        role: "assistant",
        content: "Followed up",
        timestamp: 9,
        blocks: [{ id: "dispatch", type: "dispatch", version: 1, payload: {} }],
      },
      {
        id: "task-list",
        role: "assistant",
        content: "Temporary plan",
        timestamp: 10,
        blocks: [{ id: "plan", type: "task-list", version: 1, payload: {} }],
      },
      {
        id: "native-agents",
        role: "assistant",
        content: "Native Codex agents",
        timestamp: 10,
        blocks: [{ id: "native", type: "task-list", version: 2, status: 'completed', payload: { kind: 'native-agents', items: [] } }],
      },
      { id: "empty", role: "assistant", content: "  ", timestamp: 11 },
      { id: "streamed-result", role: "assistant", content: "Canonical result", timestamp: 12 },
    ]
    const messages = [olderUser, olderFinal, ...currentEvidence]
    const successFinal: Message = {
      id: "success-final",
      role: "assistant",
      content: "Canonical result",
      timestamp: 20,
    }
    const errorFinal: Message = {
      id: "error-final",
      role: "assistant",
      content: "Error: engine failed",
      timestamp: 21,
    }

    const success = reconcileCompletedTurnMessages({
      messages,
      turnStart: 2,
      finalMessage: successFinal,
      exactResult: successFinal.content,
    })
    const error = reconcileCompletedTurnMessages({
      messages,
      turnStart: 2,
      finalMessage: errorFinal,
    })

    expect(success[0]).toBe(olderUser)
    expect(success[1]).toBe(olderFinal)
    expect(error[0]).toBe(olderUser)
    expect(error[1]).toBe(olderFinal)
    expect(success.slice(2, -1)).toEqual(error.slice(2, -1).filter((message) => message.id !== "streamed-result"))
    expect(success.some((message) => message.id === "streamed-result")).toBe(false)
    expect(error.some((message) => message.id === "streamed-result")).toBe(true)
    expect(success.some((message) => message.id === "task-list" || message.id === "empty")).toBe(false)
    expect(error.some((message) => message.id === "task-list" || message.id === "empty")).toBe(false)
    expect(success.some((message) => message.id === 'native-agents')).toBe(true)
    expect(error.some((message) => message.id === 'native-agents')).toBe(true)
    expect(success.find((message) => message.id === "tool")?.content).toBe("Used Read")
    expect(error.find((message) => message.id === "tool")?.content).toBe("Used Read")
    expect(success.at(-1)).toEqual({ ...successFinal, meta: { assistantPhase: 'final' } })
    expect(error.at(-1)).toEqual({ ...errorFinal, meta: { assistantPhase: 'final' } })
    expect(success.find((message) => message.id === 'interim')?.meta?.assistantPhase).toBe('commentary')
  })
})
