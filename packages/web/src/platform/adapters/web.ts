import type {
  Capability,
  OperationResult,
  PlatformAdapter,
  PlatformCapability,
  PlatformEventListener,
  PlatformIntent,
} from "../contracts"

interface ViewportLike {
  height: number
  offsetTop: number
  scale?: number
  addEventListener(type: "resize" | "scroll", listener: () => void): void
  removeEventListener(type: "resize" | "scroll", listener: () => void): void
}

type NotificationPermissionValue = "default" | "prompt" | "denied" | "granted"

export interface WebPlatformEnvironment {
  secureContext: boolean
  share?: (data: ShareData) => Promise<void>
  vibrate?: (pattern: VibratePattern) => boolean
  notificationPermission?: () => NotificationPermissionValue
  requestNotificationPermission?: () => Promise<NotificationPermissionValue>
  presentNotification?: (title: string, options?: NotificationOptions) => void
  writeClipboard?: (text: string) => Promise<void>
  setBadge?: (count?: number) => Promise<void>
  openExternal?: (url: string) => void
  visualViewport?: ViewportLike
  innerHeight?: () => number
}

const available: Capability = {
  supported: true,
  permission: "not-applicable",
  configured: true,
  available: true,
}

const unavailable: Capability = {
  supported: false,
  permission: "not-applicable",
  configured: false,
  available: false,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failed(code: string, error: unknown): OperationResult {
  return { status: "failed", error: { code, message: errorMessage(error) } }
}

function classifyError(code: string, error: unknown): OperationResult {
  if (error instanceof DOMException && error.name === "AbortError") return { status: "cancelled" }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return { status: "denied", permission: "denied" }
  }
  return failed(code, error)
}

const SECURE_CONTEXT_CAPABILITIES = new Set<PlatformCapability>([
  "notifications.present",
  "notifications.request-permission",
  "badges.set",
  "badges.clear",
  "sharing.share",
  "clipboard.copy",
])

type SupportCheck = (environment: WebPlatformEnvironment) => boolean
const SUPPORT_CHECKS: Partial<Record<PlatformCapability, SupportCheck>> = {
  "feedback.selection": (environment) => Boolean(environment.vibrate),
  "feedback.impact": (environment) => Boolean(environment.vibrate),
  "feedback.notify": (environment) => Boolean(environment.vibrate),
  "notifications.present": (environment) => Boolean(environment.presentNotification),
  "notifications.request-permission": (environment) => Boolean(environment.requestNotificationPermission),
  "badges.set": (environment) => Boolean(environment.setBadge),
  "badges.clear": (environment) => Boolean(environment.setBadge),
  "sharing.share": (environment) => Boolean(environment.share),
  "navigation.open-external": (environment) => Boolean(environment.openExternal),
  "clipboard.copy": (environment) => Boolean(environment.writeClipboard),
  "viewport.keyboard-inset": (environment) => Boolean(environment.visualViewport && environment.innerHeight),
}

function isSupported(capability: PlatformCapability, environment: WebPlatformEnvironment): boolean {
  if (!environment.secureContext && SECURE_CONTEXT_CAPABILITIES.has(capability)) return false
  return SUPPORT_CHECKS[capability]?.(environment) ?? false
}

function webCapability(capability: PlatformCapability, environment: WebPlatformEnvironment): Capability {
  if (!isSupported(capability, environment)) return unavailable
  if (!capability.startsWith("notifications.")) return available
  const current = environment.notificationPermission?.() ?? "prompt"
  const permission = current === "default" ? "prompt" : current
  const canRequest = capability === "notifications.request-permission" && permission === "prompt"
  return {
    supported: true,
    permission,
    configured: true,
    available: permission === "granted" || canRequest,
  }
}

type WebHandler = (intent: PlatformIntent, environment: WebPlatformEnvironment) => Promise<OperationResult>

async function performFeedback(intent: PlatformIntent, environment: WebPlatformEnvironment): Promise<OperationResult> {
  const vibrate = environment.vibrate
  if (!vibrate) return { status: "unsupported" }
  return vibrate(intent.kind === "feedback.selection" ? 8 : 12)
    ? { status: "performed" }
    : failed("feedback-rejected", "The browser rejected feedback")
}

async function performShare(intent: PlatformIntent, environment: WebPlatformEnvironment): Promise<OperationResult> {
  const share = environment.share
  if (!share) return { status: "unsupported" }
  const input = intent as Extract<PlatformIntent, { kind: "sharing.share" }>
  try {
    await share({ title: input.title, text: input.text, url: input.url })
    return { status: "performed", value: { method: "share" } }
  } catch (error) {
    return classifyError("share", error)
  }
}

async function performClipboard(intent: PlatformIntent, environment: WebPlatformEnvironment): Promise<OperationResult> {
  const write = environment.writeClipboard
  if (!write) return { status: "unsupported" }
  const input = intent as Extract<PlatformIntent, { kind: "clipboard.copy" }>
  try {
    await write(input.text)
    return { status: "performed", value: { method: "clipboard" } }
  } catch (error) {
    return classifyError("clipboard-write", error)
  }
}

async function requestNotificationPermission(
  intent: PlatformIntent,
  environment: WebPlatformEnvironment,
): Promise<OperationResult> {
  const request = environment.requestNotificationPermission
  const currentPermission = environment.notificationPermission
  if (!request || !currentPermission) return { status: "unsupported" }
  const current = currentPermission()
  if (current === "granted") return { status: "performed", value: { permission: "granted" } }
  if (current === "denied") return { status: "denied", permission: "denied" }
  const input = intent as Extract<PlatformIntent, { kind: "notifications.request-permission" }>
  if (!input.userGesture) return { status: "permission-required", permission: "prompt" }
  const permission = await request()
  if (permission === "granted") return { status: "performed", value: { permission } }
  if (permission === "denied") return { status: "denied", permission: "denied" }
  return { status: "permission-required", permission: "prompt" }
}

async function presentNotification(
  intent: PlatformIntent,
  environment: WebPlatformEnvironment,
): Promise<OperationResult> {
  const present = environment.presentNotification
  if (!present) return { status: "unsupported" }
  const permission = environment.notificationPermission?.()
  if (permission === "denied") return { status: "denied", permission: "denied" }
  if (permission !== "granted") {
    return { status: "permission-required", permission: "prompt" }
  }
  const input = intent as Extract<PlatformIntent, { kind: "notifications.present" }>
  present(input.title, { body: input.body })
  return { status: "performed" }
}

async function setBadge(intent: PlatformIntent, environment: WebPlatformEnvironment): Promise<OperationResult> {
  const update = environment.setBadge
  if (!update) return { status: "unsupported" }
  const count = intent.kind === "badges.set" ? intent.count : undefined
  await update(count)
  return { status: "performed" }
}

async function openExternal(intent: PlatformIntent, environment: WebPlatformEnvironment): Promise<OperationResult> {
  const open = environment.openExternal
  if (!open) return { status: "unsupported" }
  const input = intent as Extract<PlatformIntent, { kind: "navigation.open-external" }>
  open(input.url)
  return { status: "performed" }
}

const WEB_HANDLERS: Partial<Record<PlatformIntent["kind"], WebHandler>> = {
  "feedback.selection": performFeedback,
  "feedback.impact": performFeedback,
  "feedback.notify": performFeedback,
  "notifications.present": presentNotification,
  "notifications.request-permission": requestNotificationPermission,
  "badges.set": setBadge,
  "badges.clear": setBadge,
  "sharing.share": performShare,
  "navigation.open-external": openExternal,
  "clipboard.copy": performClipboard,
}

async function performWebIntent(intent: PlatformIntent, environment: WebPlatformEnvironment): Promise<OperationResult> {
  if (!environment.secureContext && SECURE_CONTEXT_CAPABILITIES.has(intent.kind)) {
    return { status: "unsupported", reason: "secure-context-required" }
  }
  const handler = WEB_HANDLERS[intent.kind]
  if (!handler) return { status: "unsupported" }
  try {
    return await handler(intent, environment)
  } catch (error) {
    return failed("web-operation", error)
  }
}

function observeKeyboardInset(
  environment: WebPlatformEnvironment,
  listener: PlatformEventListener,
): (() => void) | null {
  const viewport = environment.visualViewport
  const innerHeight = environment.innerHeight
  if (!viewport || !innerHeight) return null

  const update = () => {
    // Pinch zoom shrinks the visual viewport without opening the keyboard.
    const obscured = (viewport.scale ?? 1) === 1
      ? innerHeight() - viewport.height - viewport.offsetTop
      : 0
    listener({ kind: "viewport.keyboard-inset", inset: Math.max(0, Math.round(obscured)) })
  }
  update()
  viewport.addEventListener("resize", update)
  viewport.addEventListener("scroll", update)
  return () => {
    viewport.removeEventListener("resize", update)
    viewport.removeEventListener("scroll", update)
  }
}

export function createWebAdapter(environment: WebPlatformEnvironment): PlatformAdapter {
  return {
    name: "web",
    capability: async (capability) => webCapability(capability, environment),
    perform: (intent) => performWebIntent(intent, environment),
    observe(capability, listener) {
      return capability === "viewport.keyboard-inset" ? observeKeyboardInset(environment, listener) : null
    },
  }
}

export function createBrowserEnvironment(): WebPlatformEnvironment {
  if (typeof window === "undefined" || typeof navigator === "undefined") return { secureContext: false }
  return {
    get secureContext() { return window.isSecureContext !== false },
    get share() {
      return typeof navigator.share === "function" ? navigator.share.bind(navigator) : undefined
    },
    get vibrate() {
      return typeof navigator.vibrate === "function" ? navigator.vibrate.bind(navigator) : undefined
    },
    get notificationPermission() {
      return typeof Notification === "undefined" ? undefined : () => Notification.permission
    },
    get requestNotificationPermission() {
      return typeof Notification === "undefined" ? undefined : () => Notification.requestPermission()
    },
    get presentNotification() {
      return typeof Notification === "undefined"
        ? undefined
        : (title: string, options?: NotificationOptions) => { new Notification(title, options) }
    },
    get writeClipboard() {
      return navigator.clipboard?.writeText ? navigator.clipboard.writeText.bind(navigator.clipboard) : undefined
    },
    get setBadge() {
      const badgeNavigator = navigator as Navigator & {
        setAppBadge?: (contents?: number) => Promise<void>
        clearAppBadge?: () => Promise<void>
      }
      return badgeNavigator.setAppBadge
        ? (count?: number) => count === undefined && badgeNavigator.clearAppBadge
          ? badgeNavigator.clearAppBadge()
          : badgeNavigator.setAppBadge!(count)
        : undefined
    },
    openExternal: (url) => { window.open(url, "_blank", "noopener,noreferrer") },
    get visualViewport() { return window.visualViewport ?? undefined },
    innerHeight: () => window.innerHeight,
  }
}
