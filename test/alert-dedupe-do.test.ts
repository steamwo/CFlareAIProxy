import { beforeEach, describe, expect, it } from "vitest";
import { claimAlertDedupeSlot, resetAlertsState } from "../src/alerts";
import type { Env } from "../src/types";

function createEnv(): Env {
  let claimedAt: number | undefined;
  const stub = {
    async fetch(_url: string, init?: RequestInit) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { windowMs: number; now: number };
      const claimed = claimedAt === undefined || body.now - claimedAt >= body.windowMs;
      if (claimed) claimedAt = body.now;
      return Response.json({ claimed, claimedAt: claimedAt ?? body.now });
    },
  };
  return {
    RATE_LIMITER: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub,
    } as unknown as DurableObjectNamespace,
  } as Env;
}

beforeEach(() => resetAlertsState());

describe("alert dedupe Durable Object", () => {
  it("grants exactly one concurrent claim for the same alert window", async () => {
    const env = createEnv();
    const results = await Promise.all([
      claimAlertDedupeSlot(env, "provider_circuit_open", "codex", 60_000, 1_000),
      claimAlertDedupeSlot(env, "provider_circuit_open", "codex", 60_000, 1_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("re-arms after the requested window", async () => {
    const env = createEnv();
    expect(await claimAlertDedupeSlot(env, "provider_circuit_open", "codex", 60_000, 1_000)).toBe(true);
    resetAlertsState();
    expect(await claimAlertDedupeSlot(env, "provider_circuit_open", "codex", 60_000, 61_000)).toBe(true);
  });
});
