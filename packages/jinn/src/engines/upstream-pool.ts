import http from "node:http";
import https from "node:https";

/** The upstream request currently owning one client request, plus whether the
 *  client has already gone away (so a scheduled retry knows not to fire). Every
 *  terminal path clears `current`, which is what stops a handle whose keep-alive
 *  socket the pool has already recycled from ever being destroyed. */
export interface InflightUpstream {
  current?: http.ClientRequest;
  clientGone?: boolean;
}

/** Upstream sockets ONE proxy may hold at once. Sized for a single PTY's worst
 *  case — the main turn plus a full Task sub-agent fan-out. It used to be a
 *  gateway-wide ceiling shared by every session, so one session's fan-out (or a
 *  stream that wedged holding its socket) queued every other session's requests
 *  behind it; each proxy now owns its own pool, so this is a per-session bound. */
const MAX_SOCKETS = 64;

/** Backoff before each retry, one entry per retry. The observed upstream fault
 *  arrives in bursts lasting on the order of a second, so an immediate second
 *  attempt lands inside the same burst — that is exactly how a `bad record mac`
 *  followed one second later by `socket hang up` reached the CLI as a bare 502.
 *  Spreading the remaining attempts across ~400ms clears a burst without making
 *  a genuine outage slow to report. */
const RETRY_BACKOFF_MS = [100, 300];

/** Total upstream attempts allowed for one client request: the first, plus one
 *  per backoff step. Bounded by construction — there is no unbounded retry. */
export const MAX_UPSTREAM_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

/** How long to wait before the attempt that follows `attempt` (0-based). Only
 *  called while `attempt + 1 < MAX_UPSTREAM_ATTEMPTS`, so the index is in range. */
export function retryBackoffMs(attempt: number): number {
  return RETRY_BACKOFF_MS[attempt];
}

/** A keep-alive socket pool for one proxy's upstream. Keep-alive is what keeps
 *  per-request TLS handshake churn off the hot path; ownership is per-proxy so a
 *  fault or a fan-out in one PTY cannot reach another PTY's sockets.
 *  `protocol` exists for tests, which drive a plaintext local upstream. */
export function createUpstreamPool(protocol: "http:" | "https:" = "https:"): http.Agent {
  const options = { keepAlive: true, maxSockets: MAX_SOCKETS };
  return protocol === "http:" ? new http.Agent(options) : new https.Agent(options);
}

/** Is this upstream error a transient connection fault safe to retry on a fresh
 *  socket (request body fully buffered, nothing streamed to the client yet)?
 *  Covers stale/torn pooled sockets (ECONNRESET/EPIPE/"socket hang up") AND a
 *  CORRUPTED TLS socket — "bad record mac" / "decrypt error" / EPROTO — where the
 *  record layer received bytes it could not authenticate. Retries run with
 *  agent:false, so every one of them gets a brand-new socket. We deliberately do
 *  NOT retry idle-timeouts or post-response errors (can't retry once bytes have
 *  streamed to the client). */
export function isRetriableUpstreamError(err: NodeJS.ErrnoException): boolean {
  return (
    err.code === "ECONNRESET" ||
    err.code === "EPIPE" ||
    err.code === "EPROTO" ||
    /socket hang up/i.test(err.message) ||
    /bad record mac|decrypt error/i.test(err.message)
  );
}

/** Transport for the upstream call, chosen from the same protocol that picks
 *  the pool above. Lives here so a constructor does not spend its complexity
 *  budget on the branch. */
export const defaultRequestFn = (protocol?: "http:" | "https:") =>
  protocol === "http:" ? http.request : https.request;
