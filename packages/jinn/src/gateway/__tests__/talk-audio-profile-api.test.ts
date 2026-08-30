import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import { TALK_SESSION_TTL_MS } from "../../talk/session/registry.js";
import { startTalkSessionReaper } from "../session-schedulers.js";
import { baseConfig, call, stubMintingFetch } from "./helpers/talk-route-harness.js";

vi.hoisted(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

let config: JinnConfig;
let minting: ReturnType<typeof stubMintingFetch>;

beforeEach(() => {
  config = baseConfig();
  minting = stubMintingFetch();
});

afterAll(() => {
  vi.useRealTimers();
});

describe("Talk audio profiles", () => {
  it("mints the driving default and returns its effective VAD", async () => {
    const opened = await call(config, "POST", "/api/talk/sessions");
    const sent = minting.calls[0]!.body as { session: { audio: { input: Record<string, unknown> } } };
    expect(sent.session.audio.input).toMatchObject({
      noise_reduction: { type: "far_field" },
      turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: false },
    });
    expect(opened.body).toMatchObject({ vadType: "semantic_vad", noiseReduction: "far_field" });
  });

  it("accepts a close-mic override for open and reissue", async () => {
    const opened = await call(config, "POST", "/api/talk/sessions", { noiseReduction: "near_field" });
    const first = minting.calls[0]!.body as { session: { audio: { input: Record<string, unknown> } } };
    expect(first.session.audio.input.noise_reduction).toEqual({ type: "near_field" });

    await call(config, "POST", `/api/talk/sessions/${opened.body.id as string}/park`);
    await vi.advanceTimersByTimeAsync(TALK_SESSION_TTL_MS + 1);
    const resumed = await call(config, "POST", `/api/talk/sessions/${opened.body.id as string}/resume`, {
      noiseReduction: "near_field",
    });
    const second = minting.calls.at(-1)!.body as { session: { audio: { input: Record<string, unknown> } } };
    expect(second.session.audio.input.noise_reduction).toEqual({ type: "near_field" });
    expect(resumed.body).toMatchObject({ vadType: "semantic_vad", noiseReduction: "near_field" });
  });

  it("reaps elapsed live sessions only when the gateway-owned schedule ticks", async () => {
    let tick: (() => void) | undefined;
    let stopped = false;
    const stop = startTalkSessionReaper((run) => {
      tick = run;
      return () => { stopped = true; };
    });
    const opened = await call(config, "POST", "/api/talk/sessions");

    await vi.advanceTimersByTimeAsync(TALK_SESSION_TTL_MS + 1);
    tick?.();

    const parked = await call(config, "GET", `/api/talk/sessions/${opened.body.id as string}`);
    expect(parked.body).toMatchObject({ state: "parked" });
    stop();
    expect(stopped).toBe(true);
  });

  it("rejects an unknown microphone profile before minting", async () => {
    const response = await call(config, "POST", "/api/talk/sessions", { noiseReduction: "studio" });
    expect(response.status).toBe(400);
    expect(minting.calls).toHaveLength(0);
  });
});
