import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_THRESHOLD,
  backoffMsForFailures,
  getProviderHealth,
  orderHealthyRoutes,
  recordProviderFailure,
  recordProviderSuccess,
  resetRoutingHealthMemo,
} from "../src/routing-health";
import type { Env, ModelRouteRow } from "../src/types";

interface KvCounters {
  get: number;
  put: number;
  delete: number;
}

interface FakeKv {
  store: Map<string, string>;
  counters: KvCounters;
  namespace: KVNamespace;
}

/** Minimal Map-backed KVNamespace stand-in that records every operation. */
function createFakeKv(): FakeKv {
  const store = new Map<string, string>();
  const counters: KvCounters = { get: 0, put: 0, delete: 0 };
  const namespace = {
    async get(name: string, type?: string): Promise<unknown> {
      counters.get += 1;
      const raw = store.get(name) ?? null;
      if (type === "json") return raw === null ? null : JSON.parse(raw) as unknown;
      return raw;
    },
    async put(name: string, value: string): Promise<void> {
      counters.put += 1;
      store.set(name, value);
    },
    async delete(name: string): Promise<void> {
      counters.delete += 1;
      store.delete(name);
    },
  };
  return { store, counters, namespace: namespace as unknown as KVNamespace };
}

interface FailurePayload {
  now: number;
  windowMs: number;
  threshold: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

interface FakePool {
  namespace: DurableObjectNamespace;
  calls: { failure: number; reset: number };
  windows: Map<string, number[]>;
}

/**
 * Stand-in for the account pool Durable Object, single-threaded like the real one:
 * every /health/failure lands sequentially on the same window array.
 */
function createFakePool(options: { supported?: boolean } = {}): FakePool {
  const supported = options.supported !== false;
  const windows = new Map<string, number[]>();
  const calls = { failure: 0, reset: 0 };

  const stubFor = (providerId: string) => ({
    async fetch(input: string, init?: RequestInit): Promise<Response> {
      const path = new URL(input).pathname;
      if (!supported) return new Response("Not found", { status: 404 });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Partial<FailurePayload> : {};
      if (path === "/health/reset") {
        calls.reset += 1;
        windows.delete(providerId);
        return Response.json({ failures: 0, disabledUntil: 0 });
      }
      if (path === "/health/failure") {
        calls.failure += 1;
        const now = body.now ?? Date.now();
        const windowMs = body.windowMs ?? 600_000;
        const threshold = body.threshold ?? 3;
        const base = body.baseBackoffMs ?? 30_000;
        const max = body.maxBackoffMs ?? 900_000;
        const window = [...(windows.get(providerId) ?? []).filter((entry) => entry > now - windowMs), now];
        windows.set(providerId, window);
        const failures = window.length;
        const backoff = failures >= threshold ? Math.min(max, base * 2 ** Math.min(5, failures - threshold)) : 0;
        return Response.json({ failures, disabledUntil: backoff > 0 ? now + backoff : 0 });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const namespace = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get(id: { name: string }) { return stubFor(id.name); },
  };
  return { namespace: namespace as unknown as DurableObjectNamespace, calls, windows };
}

function createEnv(kv: FakeKv, pool: FakePool): Env {
  return { CONFIG_CACHE: kv.namespace, ACCOUNT_POOL: pool.namespace } as unknown as Env;
}

function route(providerId: string, overrides: Partial<ModelRouteRow> = {}): ModelRouteRow {
  return {
    id: `route-${providerId}`,
    public_model: "demo-model",
    provider_id: providerId,
    upstream_model: "upstream-model",
    endpoint: "chat",
    enabled: 1,
    priority: 100,
    weight: 1,
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const NOW = 1_800_000_000_000;

beforeEach(() => {
  resetRoutingHealthMemo();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("failure threshold", () => {
  it("keeps the breaker closed below the threshold and opens it exactly at the threshold", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    for (let attempt = 1; attempt < FAILURE_THRESHOLD; attempt += 1) {
      const state = await recordProviderFailure(env, "codex", 500, "upstream boom");
      expect(state.failures).toBe(attempt);
      expect(state.disabledUntil).toBe(0);
    }

    const opened = await recordProviderFailure(env, "codex", 500, "upstream boom");
    expect(opened.failures).toBe(FAILURE_THRESHOLD);
    expect(opened.disabledUntil).toBe(NOW + 30_000);
    expect(opened.lastStatus).toBe(500);
    expect(opened.lastError).toBe("upstream boom");
  });

  it("persists the open breaker so a fresh isolate reading KV sees it", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) {
      await recordProviderFailure(env, "kimi", 502, "bad gateway");
    }

    resetRoutingHealthMemo();
    const state = await getProviderHealth(env, "kimi");
    expect(state?.disabledUntil).toBe(NOW + 30_000);
    expect(state?.failures).toBe(FAILURE_THRESHOLD);
  });

  it("does not leak the internal failure window through the public state", async () => {
    const kv = createFakeKv();
    const env = createEnv(kv, createFakePool({ supported: false }));
    const state = await recordProviderFailure(env, "qoder", 500, "boom");
    expect(Object.keys(state).sort()).toEqual(
      ["disabledUntil", "failures", "lastError", "lastStatus", "providerId", "updatedAt"],
    );
  });
});

describe("backoff schedule", () => {
  it("computes exponential backoff capped at 15 minutes", () => {
    expect(backoffMsForFailures(0)).toBe(0);
    expect(backoffMsForFailures(FAILURE_THRESHOLD - 1)).toBe(0);
    expect(backoffMsForFailures(3)).toBe(30_000);
    expect(backoffMsForFailures(4)).toBe(60_000);
    expect(backoffMsForFailures(5)).toBe(120_000);
    expect(backoffMsForFailures(6)).toBe(240_000);
    expect(backoffMsForFailures(7)).toBe(480_000);
    expect(backoffMsForFailures(8)).toBe(900_000);
    expect(backoffMsForFailures(9)).toBe(900_000);
    expect(backoffMsForFailures(50)).toBe(15 * 60_000);
  });

  it("escalates disabledUntil across consecutive failures and never exceeds the cap", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    const deadlines: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const state = await recordProviderFailure(env, "codex", 503, "unavailable");
      deadlines.push(state.disabledUntil === 0 ? 0 : state.disabledUntil - NOW);
    }

    expect(deadlines).toEqual([0, 0, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  });
});

describe("success path KV cost", () => {
  it("performs no KV write when there is no failure state to clear", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      await recordProviderSuccess(env, "codex");
    }

    expect(kv.counters.put).toBe(0);
    expect(kv.counters.delete).toBe(0);
    expect(pool.calls.reset).toBe(0);
  });

  it("clears the breaker exactly once when failure state exists", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    await recordProviderFailure(env, "codex", 500, "boom");
    kv.counters.delete = 0;

    await recordProviderSuccess(env, "codex");
    await recordProviderSuccess(env, "codex");
    await recordProviderSuccess(env, "codex");

    expect(kv.counters.delete).toBe(1);
    expect(pool.calls.reset).toBe(1);
    expect(await getProviderHealth(env, "codex")).toBeNull();
  });

  it("still clears remote state when forced even if this isolate sees nothing", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    await recordProviderSuccess(env, "codex", { force: true });

    expect(kv.counters.delete).toBe(1);
    expect(pool.calls.reset).toBe(1);
  });

  it("does not write on failures that leave the breaker state materially unchanged", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await recordProviderFailure(env, "codex", 500, "boom");
    }
    const writesWhileEscalating = kv.counters.put;

    // Backoff has saturated at the cap: further failures must stop rewriting KV.
    kv.counters.put = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await recordProviderFailure(env, "codex", 500, "boom");
    }

    expect(writesWhileEscalating).toBeLessThanOrEqual(8);
    expect(kv.counters.put).toBe(0);
  });
});

describe("concurrent failure counting", () => {
  it("does not lose counts when failures race on the same provider", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    const states = await Promise.all(
      Array.from({ length: 8 }, () => recordProviderFailure(env, "codex", 500, "avalanche")),
    );

    // The Durable Object is the source of truth: eight failures produce counts 1..8.
    expect(states.map((state) => state.failures).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(states.filter((state) => state.disabledUntil > NOW)).toHaveLength(8 - (FAILURE_THRESHOLD - 1));
    expect(pool.calls.failure).toBe(8);
  });

  it("collapses a concurrent burst into a bounded number of KV writes", async () => {
    const kv = createFakeKv();
    const pool = createFakePool();
    const env = createEnv(kv, pool);

    await Promise.all(Array.from({ length: 20 }, () => recordProviderFailure(env, "codex", 500, "avalanche")));

    expect(kv.counters.put).toBeLessThanOrEqual(20);
    resetRoutingHealthMemo();
    const state = await getProviderHealth(env, "codex");
    expect(state?.disabledUntil).toBeGreaterThan(NOW);
  });

  it("keeps window semantics under concurrency when the Durable Object is unavailable", async () => {
    const kv = createFakeKv();
    const pool = createFakePool({ supported: false });
    const env = createEnv(kv, pool);

    await Promise.all(Array.from({ length: 6 }, () => recordProviderFailure(env, "codex", 500, "avalanche")));
    const state = await getProviderHealth(env, "codex");

    // Read-modify-write races can drop counts, but the breaker must still open.
    expect(state?.failures).toBeGreaterThanOrEqual(FAILURE_THRESHOLD);
    expect(state?.disabledUntil).toBeGreaterThan(NOW);
    expect(pool.calls.failure).toBe(0);
  });

  it("ages failures out of the window in the fallback path", async () => {
    const kv = createFakeKv();
    const env = createEnv(kv, createFakePool({ supported: false }));

    await recordProviderFailure(env, "codex", 500, "boom");
    await recordProviderFailure(env, "codex", 500, "boom");
    expect((await getProviderHealth(env, "codex"))?.disabledUntil).toBe(0);

    // Both earlier failures fall outside the 10 minute window.
    vi.setSystemTime(NOW + 11 * 60_000);
    const state = await recordProviderFailure(env, "codex", 500, "boom");
    expect(state.failures).toBe(1);
    expect(state.disabledUntil).toBe(0);
  });
});

describe("orderHealthyRoutes compatibility", () => {
  it("keeps priority ordering and reports health for every provider", async () => {
    const kv = createFakeKv();
    const env = createEnv(kv, createFakePool());
    const routes = [route("b", { priority: 200 }), route("a", { priority: 100 })];

    const ordered = await orderHealthyRoutes(env, routes);

    expect(ordered.routes.map((entry) => entry.provider_id)).toEqual(["a", "b"]);
    expect(ordered.blockedUntil).toBeUndefined();
    expect(Object.keys(ordered.health).sort()).toEqual(["a", "b"]);
    expect(ordered.health.a).toBeNull();
  });

  it("drops tripped providers and reports blockedUntil when all are tripped", async () => {
    const kv = createFakeKv();
    const env = createEnv(kv, createFakePool());
    for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) {
      await recordProviderFailure(env, "a", 500, "boom");
    }

    const partial = await orderHealthyRoutes(env, [route("a"), route("b")]);
    expect(partial.routes.map((entry) => entry.provider_id)).toEqual(["b"]);
    expect(partial.blockedUntil).toBeUndefined();

    const none = await orderHealthyRoutes(env, [route("a")]);
    expect(none.routes).toEqual([]);
    expect(none.blockedUntil).toBe(NOW + 30_000);
  });

  it("re-admits a provider once its backoff has elapsed", async () => {
    const kv = createFakeKv();
    const env = createEnv(kv, createFakePool());
    for (let attempt = 0; attempt < FAILURE_THRESHOLD; attempt += 1) {
      await recordProviderFailure(env, "a", 500, "boom");
    }
    expect((await orderHealthyRoutes(env, [route("a")])).routes).toEqual([]);

    vi.setSystemTime(NOW + 30_001);
    expect((await orderHealthyRoutes(env, [route("a")])).routes.map((entry) => entry.provider_id)).toEqual(["a"]);
  });
});

describe("stored state hardening", () => {
  it("ignores malformed KV payloads instead of throwing", async () => {
    const kv = createFakeKv();
    const env = createEnv(kv, createFakePool({ supported: false }));
    kv.store.set("provider-health:v1:codex", "not-json");

    expect(await getProviderHealth(env, "codex")).toBeNull();
    const state = await recordProviderFailure(env, "codex", 500, "boom");
    expect(state.failures).toBe(1);
  });

  it("truncates oversized upstream error messages", async () => {
    const kv = createFakeKv();
    const env = createEnv(kv, createFakePool());
    const state = await recordProviderFailure(env, "codex", 500, "x".repeat(2000));
    expect(state.lastError?.length).toBeLessThanOrEqual(501);
  });
});
