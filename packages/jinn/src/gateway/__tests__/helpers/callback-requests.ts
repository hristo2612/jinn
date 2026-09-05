import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { expect, vi } from "vitest";
import { api, type ApiContext } from "./callback-harness.js";

const GATEWAY_HEADERS = {
  host: "gateway.test",
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

export function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function postJson(context: ApiContext, urlPath: string, body: unknown) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: urlPath,
    headers: { ...GATEWAY_HEADERS },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  expect(captured.status).toBe(200);
  return captured.body;
}

export function postNotification(context: ApiContext, sessionId: string, message: string) {
  return postJson(context, `/api/sessions/${sessionId}/message`, {
    message,
    role: "notification",
    displayMessage: `Display: ${message}`,
  });
}

export function postUserMessage(context: ApiContext, sessionId: string, message: string) {
  return postJson(context, `/api/sessions/${sessionId}/message`, { message });
}

export function postCallbackDelivery(context: ApiContext, sessionId: string, callbackDeliveryId: string) {
  return postJson(context, `/api/sessions/${sessionId}/message`, { callbackDeliveryId });
}

export async function clearVisibleQueue(context: ApiContext, sessionId: string) {
  const req = Object.assign(Readable.from([]), {
    method: "DELETE",
    url: `/api/sessions/${sessionId}/queue`,
    headers: { ...GATEWAY_HEADERS },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  expect(captured.status).toBe(200);
  return captured.body;
}

/**
 * Installs `stub` as globalThis.fetch for the duration of `run` and restores the
 * original unconditionally — a test that leaves a stub behind poisons whatever
 * runs after it in the same process.
 */
export async function withFetch<T>(stub: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

export type RouteFetchBehavior = {
  /** Throw before reaching the route on the first N calls: a pre-accept timeout. */
  failBefore?: number;
  /** Reach the route, then throw on the first N calls: an accepted response lost in flight. */
  throwAfterAccepted?: number;
};

function makeRouteBackedFetch(context: ApiContext, behavior: RouteFetchBehavior) {
  let calls = 0;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (calls <= (behavior.failBefore ?? 0)) throw new Error(`pre-accept timeout ${calls}`);
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const req = Object.assign(Readable.from([Buffer.from(String(init?.body ?? ""))]), {
      method: init?.method ?? "GET",
      url: `${target.pathname}${target.search}`,
      headers: { ...GATEWAY_HEADERS },
    });
    const captured = makeResponse();
    await api.handleApiRequest(req as never, captured.res, context);
    if (calls <= (behavior.throwAfterAccepted ?? 0)) throw new Error(`accepted response lost ${calls}`);
    return { ok: captured.status >= 200 && captured.status < 300, status: captured.status } as Response;
  });
}

export type RouteFetch = ReturnType<typeof makeRouteBackedFetch>;

/** Runs `run` with fetch wired straight back into the gateway's route handler. */
export function withRouteBackedFetch<T>(
  context: ApiContext,
  behavior: RouteFetchBehavior,
  run: (routeFetch: RouteFetch) => Promise<T>,
): Promise<T> {
  const routeFetch = makeRouteBackedFetch(context, behavior);
  return withFetch(routeFetch as unknown as typeof globalThis.fetch, () => run(routeFetch));
}
