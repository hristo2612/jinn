export interface GatewayProfile {
  id: string
  origin: string
}

export interface GatewaySocketConnection {
  readonly readyState: number
  binaryType: BinaryType
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void
  close(code?: number, reason?: string): void
}

export const GATEWAY_SOCKET_CONNECTING = 0
export const GATEWAY_SOCKET_OPEN = 1
export const GATEWAY_SOCKET_CLOSING = 2
export const GATEWAY_SOCKET_CLOSED = 3

export interface GatewayTransport {
  profile: GatewayProfile
  httpUrl(path: string): string
  socketUrl(path: string): string
  openSocket(path: string): GatewaySocketConnection
  request(path: string, init?: RequestInit): Promise<Response>
  navigate(switchUrl: string): void
}

export interface BrowserGatewayEnvironment {
  origin: string
  request(input: string, init?: RequestInit): Promise<Response>
  navigate(url: string): void
  openSocket?(url: string): GatewaySocketConnection
}

function gatewayPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`Gateway paths must be root-relative: ${path}`)
  }
  return path
}

function gatewayOrigin(origin: string): string {
  const parsed = new URL(origin)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Gateway origins must use HTTP or HTTPS: ${parsed.protocol}`)
  }
  return parsed.origin
}

export function createBrowserGatewayTransport(environment: BrowserGatewayEnvironment): GatewayTransport {
  const origin = gatewayOrigin(environment.origin)
  const httpUrl = (path: string) => {
    const resolved = new URL(gatewayPath(path), `${origin}/`)
    if (resolved.origin !== origin) {
      throw new Error(`Gateway paths must stay on the active profile origin: ${path}`)
    }
    return resolved.toString()
  }

  return {
    profile: { id: `browser:${origin}`, origin },
    httpUrl,
    socketUrl(path) {
      const url = new URL(httpUrl(path))
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      return url.toString()
    },
    openSocket(path) {
      const url = this.socketUrl(path)
      return environment.openSocket?.(url) ?? new WebSocket(url)
    },
    request(path, init = {}) {
      return environment.request(httpUrl(path), { ...init, credentials: "include" })
    },
    navigate(switchUrl) {
      const destination = new URL(switchUrl)
      if (destination.protocol !== "http:" && destination.protocol !== "https:") {
        throw new Error(`Workspace switch URLs must use HTTP or HTTPS: ${destination.protocol}`)
      }
      environment.navigate(switchUrl)
    },
  }
}

function browserEnvironment(): BrowserGatewayEnvironment {
  if (typeof window === "undefined" || window.location.origin === "null") {
    throw new Error("Browser gateway transport requires an HTTP or HTTPS page origin")
  }
  return {
    origin: window.location.origin,
    request: (input, init) => fetch(input, init),
    navigate: (url) => window.location.assign(url),
  }
}

let installedTransport: GatewayTransport | null = null

export function gatewayTransport(): GatewayTransport {
  installedTransport ??= createBrowserGatewayTransport(browserEnvironment())
  return installedTransport
}

/** Install the active profile transport. Native profile selection is the
 * second consumer; browser/PWA leaves the same-origin transport installed. */
export function installGatewayTransport(transport: GatewayTransport): () => void {
  const previous = installedTransport
  installedTransport = transport
  return () => {
    installedTransport = previous
  }
}

/** Recovery-only: replace WebKit's failed modulepreload resource before reload (270357). */
export async function reloadRoute(): Promise<void> {
  const urls = new Set(Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'))
    .map(link => new URL(link.href))
    .filter(url => url.origin === window.location.origin && url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js'))
    .map(url => url.href))
  await Promise.allSettled(Array.from(urls, async url => {
    const response = await fetch(url, { cache: 'reload', signal: AbortSignal.timeout(5_000) })
    await response.arrayBuffer()
  }))
  window.location.reload()
}
