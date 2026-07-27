import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto";
import { getProvider, listCredentialAvailabilityForModel } from "../src/db";
import type { CredentialAvailability } from "../src/db";
import { routeRuntimeOptions } from "../src/model-capabilities";
import type { RouteRuntimeOptions } from "../src/model-capabilities";
import type { Env, ModelRouteRow, ProviderConfig } from "../src/types";

function base64Key(fill: number): string {
  return Buffer.alloc(32, fill).toString("base64");
}

describe("master key import memoization", () => {
  // Captured before any spy is installed so a restored implementation cannot
  // recurse back into the mock.
  const realImportKey = crypto.subtle.importKey.bind(crypto.subtle);
  // Inferred rather than annotated: importKey is an overloaded signature, and a
  // ReturnType<typeof vi.spyOn> annotation collapses it to a single incompatible one.
  let importKey = vi.spyOn(crypto.subtle, "importKey");

  beforeEach(() => {
    importKey = vi.spyOn(crypto.subtle, "importKey");
  });

  afterEach(() => {
    importKey.mockRestore();
  });

  it("imports the same MASTER_KEY only once across many encrypt/decrypt calls", async () => {
    // A distinct key per test keeps the isolate-level cache from leaking counts
    // between cases while still exercising the real cache.
    const key = base64Key(11);
    const first = await encryptSecret("token-a", key);
    const second = await encryptSecret("token-b", key);
    await expect(decryptSecret(first, key)).resolves.toBe("token-a");
    await expect(decryptSecret(second, key)).resolves.toBe("token-b");
    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it("shares one import across concurrent callers", async () => {
    const key = base64Key(12);
    const ciphertexts = await Promise.all([
      encryptSecret("a", key),
      encryptSecret("b", key),
      encryptSecret("c", key),
    ]);
    await Promise.all(ciphertexts.map((value) => decryptSecret(value, key)));
    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct keys separate and tolerates whitespace", async () => {
    const key = base64Key(13);
    const encrypted = await encryptSecret("payload", key);
    await expect(decryptSecret(encrypted, ` ${key} `)).resolves.toBe("payload");
    expect(importKey).toHaveBeenCalledTimes(1);

    const other = base64Key(14);
    await encryptSecret("payload", other);
    expect(importKey).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a failed import", async () => {
    const key = base64Key(15);
    importKey.mockImplementationOnce(() => Promise.reject(new Error("transient")));

    await expect(encryptSecret("x", key)).rejects.toMatchObject({ code: "INVALID_MASTER_KEY" });

    // A rejected entry must be evicted, otherwise the isolate would be poisoned
    // for the rest of its life.
    importKey.mockImplementation(realImportKey);
    await expect(encryptSecret("x", key)).resolves.toMatch(/^v1\./);
    expect(importKey).toHaveBeenCalledTimes(2);

    await encryptSecret("y", key);
    expect(importKey).toHaveBeenCalledTimes(2);
  });
});

/** Mirrors the per-request memo in proxy-v2: config is cached, availability is not. */
function attemptScope(env: Env, endpoint: "responses" | "chat" | "completions") {
  const providers = new Map<string, Promise<ProviderConfig>>();
  const runtimes = new Map<string, Promise<RouteRuntimeOptions>>();
  return {
    provider(providerId: string): Promise<ProviderConfig> {
      const cached = providers.get(providerId);
      if (cached) return cached;
      const pending = getProvider(env, providerId);
      providers.set(providerId, pending);
      return pending;
    },
    runtime(route: ModelRouteRow): Promise<RouteRuntimeOptions> {
      const cached = runtimes.get(route.id);
      if (cached) return cached;
      const pending = routeRuntimeOptions(env, route, endpoint);
      runtimes.set(route.id, pending);
      return pending;
    },
    availability(route: ModelRouteRow): Promise<CredentialAvailability[]> {
      return listCredentialAvailabilityForModel(env, route.provider_id, route.upstream_model, endpoint);
    },
  };
}

interface StubResult<T> {
  results: T[];
}

/** Minimal D1 stub that records every executed statement. */
function stubEnv(sql: string[]): Env {
  const rows: Record<string, unknown> = {
    providers: {
      id: "provider-1",
      name: "Provider One",
      kind: "openai-compatible",
      base_url: "https://upstream.test/v1",
      enabled: 1,
      pool_strategy: "round_robin",
      endpoints_json: "{}",
      auth_json: "{}",
      headers_json: "{}",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
    },
  };
  const credentialRow = {
    id: "cred-1",
    provider_id: "provider-1",
    label: "one",
    auth_type: "api_key",
    secret_ciphertext: "",
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 100,
    weight: 1,
    max_concurrency: 4,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    quota_status: null,
    quota_json: null,
    quota_fetched_at: null,
    quota_expires_at: null,
  };
  const prepare = (query: string) => ({
    bind: (..._args: unknown[]) => ({
      first: <T>(): Promise<T | null> => {
        sql.push(query);
        return Promise.resolve(query.includes("FROM providers") ? rows.providers as T : null);
      },
      all: <T>(): Promise<StubResult<T>> => {
        sql.push(query);
        return Promise.resolve({
          results: query.includes("FROM credentials") ? [credentialRow as T] : [],
        });
      },
    }),
  });
  return { DB: { prepare }, MASTER_KEY: base64Key(21) } as unknown as Env;
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
    created_at: 0,
    updated_at: 0,
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

    expect(sql.filter((query) => query.includes("FROM providers"))).toHaveLength(1);
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
