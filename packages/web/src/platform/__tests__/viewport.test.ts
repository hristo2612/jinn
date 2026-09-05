import { afterEach, describe, expect, it } from "vitest"
import { createPlatform, type Runtime } from "../contracts"
import { createWebAdapter, type WebPlatformEnvironment } from "../adapters/web"
import { startKeyboardInset } from "../viewport"

const runtime: Runtime = {
  container: "browser",
  os: "unknown",
  engine: "unknown",
  secureContext: true,
  appVersion: "test",
  userAgent: "viewport-test",
}

function fakeViewport(height: number) {
  const listeners = new Map<string, Set<() => void>>()
  return {
    height,
    scale: 1,
    offsetTop: 0,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
    resizeTo(next: number) {
      this.height = next
      for (const listener of listeners.get("resize") ?? []) listener()
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

function makePlatform(viewport?: ReturnType<typeof fakeViewport>, innerHeight = 844) {
  const environment: WebPlatformEnvironment = { secureContext: true, visualViewport: viewport, innerHeight: () => innerHeight }
  return createPlatform({ runtime, adapters: [createWebAdapter(environment)] })
}

function inset(): string {
  return document.documentElement.style.getPropertyValue("--keyboard-inset")
}

describe("platform viewport keyboard inset", () => {
  afterEach(() => document.documentElement.style.removeProperty("--keyboard-inset"))

  it("publishes zero without visualViewport", () => {
    const stop = startKeyboardInset(makePlatform())
    expect(inset()).toBe("0px")
    stop()
  })

  it("does not mistake pinch zoom or zoom panning for the keyboard", () => {
    const viewport = fakeViewport(844)
    const stop = startKeyboardInset(makePlatform(viewport))
    viewport.scale = 2
    viewport.resizeTo(422)
    expect(inset()).toBe("0px")
    viewport.offsetTop = 100
    viewport.resizeTo(422)
    expect(inset()).toBe("0px")
    viewport.scale = 1
    viewport.offsetTop = 0
    viewport.resizeTo(508)
    expect(inset()).toBe("336px")
    stop()
  })

  it("publishes, clamps, resets, and unsubscribes the observed inset", () => {
    const viewport = fakeViewport(844)
    const stop = startKeyboardInset(makePlatform(viewport))

    viewport.resizeTo(508)
    expect(inset()).toBe("336px")
    viewport.resizeTo(900)
    expect(inset()).toBe("0px")
    stop()

    expect(inset()).toBe("0px")
    expect(viewport.listenerCount("resize")).toBe(0)
    expect(viewport.listenerCount("scroll")).toBe(0)
  })
})
