import { describe, expect, it } from "vitest";
import { getProvider, listCredentialAvailabilityForModel } from "../src/db";
import { routeRuntimeOptions } from "../src/model-capabilities";
import type { Env, GatewayEndpoint, ModelRouteRow } from "../src/types";

interface StubStatement {
  bind(...values: unknown[]): StubStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

function providerRow(id: string): Record<string, unknown> {
  return {
    id,
    name: "Provider",
    kind: "openai-compatible",
    base_url: "https://example.com/v1",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: JSON.stringify({ chat: "/chat/completions" }),
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: 1,
    updated_at: 1,
  };
}

function stubEnv(sql: string[]): Env {
  return {
    DB: {
      prepare(query: string): StubStatement {
        sql.push(query);
        let bindings: unknown[] = [];
        return {
          bind(...values: unknown[]): StubStatement {
            bindings = values;
            return this;
          },
          async first<T>(): Promise<T | null> {
            if (query.includes("SELECT * FROM providers")) return providerRow(String(bindings[0])) as T;
            if (query.includes("LEFT JOIN discovered_models")) return {
              provider_options_json: "{}",
              capabilities_json: null,
              raw_json: null,
            } as T;
            return null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            return { results: [] };
          },
        };
      },
    },
  } as unknown as Env;
}

function route(id: string): ModelRouteRow {
  return {
    id,
    public_model: "public-model",
    provider_id: "provider-1",
    upstream_model: "upstream-model",
    endpoint: "chat",
    enabled: 1,
    priority: 100,
    weight: 1,
    options_json: "{}",
    created_at: 1,
    updated_at: 1,
  };
}

function requestMemo<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key: string): Promise<T> => {
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = load(key);
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
    cache.set(key, pending);
    return pending;
  };
}

function attemptScope(env: Env, endpoint: GatewayEndpoint) {
  const providerFor = requestMemo((providerId: string) => getProvider(env, providerId));
  const runtimeByRoute = new Map<string, ReturnType<typeof routeRuntimeOptions>>();
  const runtimeFor = (target: ModelRouteRow): ReturnType<typeof routeRuntimeOptions> => {
    const cached = runtimeByRoute.get(target.id);
    if (cached) return cached;
    const pending = routeRuntimeOptions(env, target, endpoint);
    pending.catch(() => {
      if (runtimeByRoute.get(target.id) === pending) runtimeByRoute.delete(target.id);
    });
    runtimeByRoute.set(target.id, pending);
    return pending;
  };
  return {
    provider: providerFor,
    runtime: runtimeFor,
    availability: (target: ModelRouteRow) => listCredentialAvailabilityForModel(
      env,
      target.provider_id,
      target.upstream_model,
      endpoint,
    ),
  };
}

describe("per-request attempt memo", () => {
  it("reuses provider config across the two attempts on one route", async () => {
    const sql: string[] = [];
    const env = stubEnv(sql);
    const scope = attemptScope(env, "chat");
    const target = route("route-1");

    const first = await scope.provider(target.provider_id);
    const second = await scope.provider(target.provider_id);

    expect(second).toBe(first);
    expect(sql.filter((query) => query.includes("FROM providers"))).toHaveLength(1);
  });

  it("reuses route runtime options across the two attempts on one route", async () => {
    const sql: string[] = [];
    const env = stubEnv(sql);
    const scope = attemptScope(env, "chat");
    const target = route("route-1");

    const first = await scope.runtime(target);
    const second = await scope.runtime(target);

    expect(second).toBe(first);
    expect(sql.filter((query) => query.includes("discovered_models"))).toHaveLength(1);
  });

  it("still queries config once per distinct route in the attempt plan", async () => {
    const sql: string[] = [];
    const env = stubEnv(sql);
    const scope = attemptScope(env, "chat");
    const plan = [route("route-1"), route("route-1"), route("route-2"), route("route-2")];

    for (const entry of plan) await scope.runtime(entry);

    expect(sql.filter((query) => query.includes("discovered_models"))).toHaveLength(2);
  });

  it("never reuses credential availability between attempts", async () => {
    const sql: string[] = [];
    const env = stubEnv(sql);
    const scope = attemptScope(env, "chat");
    const target = route("route-1");

    const first = await scope.availability(target);
    const second = await scope.availability(target);

    // A fresh array each time: a credential put on cooldown by the first attempt
    // must be re-evaluated, so this query is intentionally not memoized.
    expect(second).not.toBe(first);
    expect(sql.filter((query) => query.includes("FROM credentials"))).toHaveLength(2);
  });

  it("issues exactly one provider, one runtime, and two availability reads for a two-attempt route", async () => {
    const sql: string[] = [];
    const env = stubEnv(sql);
    const scope = attemptScope(env, "chat");
    const target = route("route-1");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await Promise.all([scope.provider(target.provider_id), scope.runtime(target), scope.availability(target)]);
    }

    // The runtime read now joins provider options so configured per-model capabilities can
    // be resolved without adding a fifth D1 round trip. Count the primary provider lookup
    // separately from the route runtime query instead of matching every mention of the table.
    expect(sql.filter((query) => query.includes("SELECT * FROM providers"))).toHaveLength(1);
    expect(sql.filter((query) => query.includes("discovered_models") && !query.includes("FROM credentials"))).toHaveLength(1);
    expect(sql.filter((query) => query.includes("FROM credentials"))).toHaveLength(2);
    // Six serial reads collapse to four, of which each attempt's three overlap.
    expect(sql).toHaveLength(4);
  });
});

describe("provider identity assumption", () => {
  it("returns a provider whose id equals the queried id", async () => {
    const sql: string[] = [];
    const provider = await getProvider(stubEnv(sql), "provider-1");
    // proxy-v2 relies on this to start the availability query from route.provider_id
    // without awaiting getProvider first.
    expect(provider.id).toBe("provider-1");
  });
});
