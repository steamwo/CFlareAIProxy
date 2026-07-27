from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new))


# src/models.ts
replace_once(
    "src/models.ts",
    'import { getCredential, getProvider, getProviderProxyConfig, listCredentialRows, loadCachedProvider } from "./db";',
    'import { getCredential, getProvider, getProviderProxyConfig, loadCachedProvider } from "./db";',
)

replace_once(
    "src/models.ts",
    '''export interface ModelRefreshResult {
  providerId: string;
  credentialId: string;
  count: number;
  endpoints: GatewayEndpoint[];
  error?: string;
}

type ProviderProxyCache = Map<string, Promise<ProviderProxyConfig | null>>;''',
    '''export interface ModelRefreshResult {
  providerId: string;
  credentialId: string;
  count: number;
  endpoints: GatewayEndpoint[];
  error?: string;
}

export interface ProviderModelRefreshPage {
  providerId: string;
  results: ModelRefreshResult[];
  processed: number;
  total: number;
  remaining: number;
}

type ProviderProxyCache = Map<string, Promise<ProviderProxyConfig | null>>;

async function invalidateModelCache(env: Env): Promise<void> {
  await Promise.all([
    env.CONFIG_CACHE.delete("models:public"),
    env.CONFIG_CACHE.delete("models:public:v2"),
    env.CONFIG_CACHE.delete("models:public:v3"),
  ]);
}''',
)

replace_once(
    "src/models.ts",
    '''export async function refreshOpenCodeAnonymousModels(
  env: Env,
  providerCache?: ProviderCache,
  proxyCache?: ProviderProxyCache,
): Promise<ModelRefreshResult> {''',
    '''export async function refreshOpenCodeAnonymousModels(
  env: Env,
  providerCache?: ProviderCache,
  proxyCache?: ProviderProxyCache,
  invalidateCache = true,
): Promise<ModelRefreshResult> {''',
)

replace_once(
    "src/models.ts",
    '''export async function refreshCredentialModels(
  env: Env,
  credentialId: string,
  providerCache?: ProviderCache,
  proxyCache?: ProviderProxyCache,
): Promise<ModelRefreshResult> {''',
    '''export async function refreshCredentialModels(
  env: Env,
  credentialId: string,
  providerCache?: ProviderCache,
  proxyCache?: ProviderProxyCache,
  invalidateCache = true,
): Promise<ModelRefreshResult> {''',
)

models_text = read("src/models.ts")
cache_delete = '    await Promise.all([env.CONFIG_CACHE.delete("models:public"), env.CONFIG_CACHE.delete("models:public:v2"), env.CONFIG_CACHE.delete("models:public:v3")]);'
if models_text.count(cache_delete) != 2:
    raise RuntimeError(f"src/models.ts: expected two per-refresh cache invalidations, found {models_text.count(cache_delete)}")
write("src/models.ts", models_text.replace(cache_delete, "    if (invalidateCache) await invalidateModelCache(env);"))

replace_once(
    "src/models.ts",
    '''export async function refreshProviderModels(env: Env, providerId: string): Promise<ModelRefreshResult[]> {
  const provider = await getProvider(env, providerId);
  const rows = await listCredentialRows(env, providerId);
  const results: ModelRefreshResult[] = [];
  const providerCache: ProviderCache = new Map([[providerId, Promise.resolve(provider)]]);
  const proxyCache: ProviderProxyCache = new Map();
  if (providerId === "opencode") results.push(await refreshOpenCodeAnonymousModels(env, providerCache, proxyCache));
  for (let index = 0; index < rows.length; index += 4) {
    results.push(...await Promise.all(
      rows.slice(index, index + 4).map((row) => refreshCredentialModels(env, row.id, providerCache, proxyCache)),
    ));
  }
  return results;
}

/**
 * Six credentials leave a verified Free-plan D1 budget:
 *
 * selection + OpenCode probe + two packed attempt markers = 4 queries;
 * six worst-case credentials on distinct providers cost 36 queries
 * (credential, provider, provider/system proxy and two packed rewrite statements each);
 * the anonymous OpenCode refresh can use the remaining six-query margin.
 *
 * The sweep itself runs inside one fixed-name Durable Object, so its D1 budget is isolated
 * from the hourly retention/quota invocation and overlapping admin/cron refreshes coalesce.
 */
export const MODEL_REFRESH_BATCH_LIMIT = 6;''',
    '''/**
 * Five credentials fit both Free-plan ceilings in the true worst case: distinct providers,
 * no provider-specific proxy, successful writes and an enabled OpenCode anonymous catalogue.
 * That path uses at most 39 D1 queries and 48 total subrequests after cache invalidation is
 * collapsed to one three-key operation per sweep.
 */
export const MODEL_REFRESH_BATCH_LIMIT = 5;''',
)

replace_once(
    "src/models.ts",
    '''  const openCode = await env.DB.prepare("SELECT enabled FROM providers WHERE id='opencode'").first<{ enabled: number }>();
  if (openCode?.enabled === 1) output.push(await refreshOpenCodeAnonymousModels(env, providerCache, proxyCache));

  for (let index = 0; index < result.results.length; index += MODEL_REFRESH_CONCURRENCY) {
    const group = result.results.slice(index, index + MODEL_REFRESH_CONCURRENCY);
    await markModelRefreshAttempts(env, group.map((row) => row.id));
    output.push(...await Promise.all(
      group.map((row) => refreshCredentialModels(env, row.id, providerCache, proxyCache)),
    ));
  }
  return output;
}''',
    '''  const openCode = await env.DB.prepare("SELECT enabled FROM providers WHERE id='opencode'").first<{ enabled: number }>();
  if (openCode?.enabled === 1) output.push(await refreshOpenCodeAnonymousModels(env, providerCache, proxyCache, false));

  for (let index = 0; index < result.results.length; index += MODEL_REFRESH_CONCURRENCY) {
    const group = result.results.slice(index, index + MODEL_REFRESH_CONCURRENCY);
    await markModelRefreshAttempts(env, group.map((row) => row.id));
    output.push(...await Promise.all(
      group.map((row) => refreshCredentialModels(env, row.id, providerCache, proxyCache, false)),
    ));
  }
  if (output.some((item) => item.count > 0)) await invalidateModelCache(env);
  return output;
}''',
)

replace_once(
    "src/models.ts",
    '''export async function refreshAllModels(
  env: Env,
  limit = MODEL_REFRESH_BATCH_LIMIT,
): Promise<ModelRefreshResult[]> {''',
    '''export async function runProviderModelRefreshPage(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
): Promise<ProviderModelRefreshPage> {
  const boundedLimit = Math.max(1, Math.min(MODEL_REFRESH_BATCH_LIMIT, Math.floor(limit) || MODEL_REFRESH_BATCH_LIMIT));
  const provider = await getProvider(env, providerId);
  const page = await env.DB.prepare(
    `SELECT c.id,
       (SELECT COUNT(*) FROM credentials total WHERE total.provider_id=? AND total.enabled=1) AS total
     FROM credentials c
     LEFT JOIN credential_refresh_attempts a ON a.credential_id=c.id
     WHERE c.provider_id=? AND c.enabled=1
     ORDER BY COALESCE(a.model_attempted_at, 0) ASC, c.priority, c.created_at
     LIMIT ?`,
  ).bind(providerId, providerId, boundedLimit).all<{ id: string; total: number }>();
  const results: ModelRefreshResult[] = [];
  const providerCache: ProviderCache = new Map([[providerId, Promise.resolve(provider)]]);
  const proxyCache: ProviderProxyCache = new Map();
  if (providerId === "opencode") {
    results.push(await refreshOpenCodeAnonymousModels(env, providerCache, proxyCache, false));
  }
  for (let index = 0; index < page.results.length; index += MODEL_REFRESH_CONCURRENCY) {
    const group = page.results.slice(index, index + MODEL_REFRESH_CONCURRENCY);
    await markModelRefreshAttempts(env, group.map((row) => row.id));
    results.push(...await Promise.all(
      group.map((row) => refreshCredentialModels(env, row.id, providerCache, proxyCache, false)),
    ));
  }
  if (results.some((item) => item.count > 0)) await invalidateModelCache(env);
  const total = Number(page.results[0]?.total ?? 0);
  return {
    providerId,
    results,
    processed: page.results.length,
    total,
    remaining: Math.max(0, total - page.results.length),
  };
}

export async function refreshProviderModels(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
): Promise<ProviderModelRefreshPage> {
  const namespace = env.RATE_LIMITER;
  if (!namespace) return runProviderModelRefreshPage(env, providerId, limit);
  const stub = namespace.get(namespace.idFromName(MODEL_REFRESH_DO_NAME));
  const response = await stub.fetch(`https://do.internal/models/refresh/provider/${encodeURIComponent(providerId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit }),
  });
  if (!response.ok) throw new Error(`provider model refresh coordinator returned ${response.status}`);
  return await response.json() as ProviderModelRefreshPage;
}

export async function refreshAllModels(
  env: Env,
  limit = MODEL_REFRESH_BATCH_LIMIT,
): Promise<ModelRefreshResult[]> {''',
)

# src/rate-limiter.ts
replace_once(
    "src/rate-limiter.ts",
    'import { runModelRefreshSweep, type ModelRefreshResult } from "./models";',
    'import { runModelRefreshSweep, runProviderModelRefreshPage } from "./models";',
)

replace_once(
    "src/rate-limiter.ts",
    '''/** Coalesces overlapping refresh requests inside one Durable Object instance. */
export class ModelRefreshGate {
  private running: Promise<ModelRefreshResult[]> | null = null;

  run(task: () => Promise<ModelRefreshResult[]>): Promise<ModelRefreshResult[]> {
    if (!this.running) {
      const execution = task();
      this.running = execution;
      void execution.finally(() => {
        if (this.running === execution) this.running = null;
      }).catch(() => undefined);
    }
    return this.running;
  }
}''',
    '''/** Serialises all catalogue sweeps and coalesces duplicate work by scope. */
export class ModelRefreshGate {
  private readonly active = new Map<string, Promise<unknown>>();
  private tail: Promise<void> = Promise.resolve();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.active.get(key);
    if (existing) return existing as Promise<T>;
    const execution = this.tail.then(() => task(), () => task());
    this.active.set(key, execution);
    this.tail = execution.then(() => undefined, () => undefined);
    void execution.finally(() => {
      if (this.active.get(key) === execution) this.active.delete(key);
    }).catch(() => undefined);
    return execution;
  }
}''',
)

replace_once(
    "src/rate-limiter.ts",
    '''    if (request.method === "POST" && url.pathname === "/models/refresh") {
      const payload = await request.json() as { limit?: unknown };
      const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
        ? Math.max(1, Math.floor(payload.limit))
        : undefined;
      return Response.json(await this.modelRefreshGate.run(() => runModelRefreshSweep(this.environment, limit)));
    }
    if (request.method === "POST" && url.pathname === "/alerts/claim") {''',
    '''    if (request.method === "POST" && url.pathname === "/models/refresh") {
      const payload = await request.json() as { limit?: unknown };
      const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
        ? Math.max(1, Math.floor(payload.limit))
        : undefined;
      return Response.json(await this.modelRefreshGate.run("all", () => runModelRefreshSweep(this.environment, limit)));
    }
    if (request.method === "POST" && url.pathname.startsWith("/models/refresh/provider/")) {
      const providerId = decodeURIComponent(url.pathname.slice("/models/refresh/provider/".length));
      if (!providerId) return new Response("Provider is required", { status: 400 });
      const payload = await request.json() as { limit?: unknown };
      const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
        ? Math.max(1, Math.floor(payload.limit))
        : undefined;
      return Response.json(await this.modelRefreshGate.run(
        `provider:${providerId}`,
        () => runProviderModelRefreshPage(this.environment, providerId, limit),
      ));
    }
    if (request.method === "POST" && url.pathname === "/alerts/claim") {''',
)

# src/admin.ts
replace_once(
    "src/admin.ts",
    '  app.post("/api/models/refresh/provider/:id", async (c) => c.json({ data: await refreshProviderModels(c.env, c.req.param("id")) }));',
    '''  app.post("/api/models/refresh/provider/:id", async (c) => {
    const page = await refreshProviderModels(c.env, c.req.param("id"));
    return c.json({
      data: page.results,
      providerId: page.providerId,
      processed: page.processed,
      total: page.total,
      remaining: page.remaining,
      complete: page.remaining === 0,
    });
  });''',
)

# test/model-refresh-gate.test.ts
write("test/model-refresh-gate.test.ts", '''import { describe, expect, it, vi } from "vitest";
import { ModelRefreshGate } from "../src/rate-limiter";
import { refreshAllModels, refreshProviderModels } from "../src/models";
import type { Env } from "../src/types";

describe("model refresh coordination", () => {
  it("coalesces equal scopes and serialises different scopes", async () => {
    const gate = new ModelRefreshGate();
    let release!: (value: string[]) => void;
    const pending = new Promise<string[]>((resolve) => { release = resolve; });
    const firstTask = vi.fn(() => pending);
    const secondTask = vi.fn(async () => ["second"]);

    const first = gate.run("provider:p1", firstTask);
    const duplicate = gate.run("provider:p1", firstTask);
    const second = gate.run("all", secondTask);
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(secondTask).not.toHaveBeenCalled();

    release(["first"]);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([["first"], ["first"]]);
    await expect(second).resolves.toEqual(["second"]);
    expect(secondTask).toHaveBeenCalledTimes(1);
  });

  it("routes full and provider sweeps through the same named instance", async () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId);
    const fetch = vi.fn(async (url: string) => url.endsWith("/models/refresh")
      ? Response.json([])
      : Response.json({ providerId: "p1", results: [], processed: 0, total: 0, remaining: 0 }));
    const env = {
      RATE_LIMITER: {
        idFromName,
        get: () => ({ fetch }),
      } as unknown as DurableObjectNamespace,
    } as Env;

    await refreshAllModels(env);
    await refreshProviderModels(env, "p1");
    expect(idFromName).toHaveBeenNthCalledWith(1, "model-refresh");
    expect(idFromName).toHaveBeenNthCalledWith(2, "model-refresh");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://do.internal/models/refresh",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://do.internal/models/refresh/provider/p1",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
''')

# test/model-refresh-d1-budget.test.ts
write("test/model-refresh-d1-budget.test.ts", '''import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/crypto";
import { MODEL_REFRESH_BATCH_LIMIT, runModelRefreshSweep, runProviderModelRefreshPage } from "../src/models";
import type { CredentialRow, Env, ProviderRow } from "../src/types";

interface Budget {
  d1: number;
  subrequests: number;
  cacheDeletes: number;
}

function providerRow(id: string, index = 0): ProviderRow {
  return {
    id,
    name: id,
    kind: "openai-compatible",
    base_url: `https://${id}.example.test`,
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: JSON.stringify({ models: "/models", chat: "/chat/completions" }),
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: index,
    updated_at: index,
  };
}

async function createEnv(input: {
  ids: string[];
  providerFor: (id: string, index: number) => string;
  globalSelection?: boolean;
  total?: number;
}): Promise<{ env: Env; budget: Budget }> {
  const masterKey = Buffer.alloc(32, 7).toString("base64");
  const ciphertext = await encryptSecret("token", masterKey);
  const credentials = new Map<string, CredentialRow>(input.ids.map((id, index) => [id, {
    id,
    provider_id: input.providerFor(id, index),
    label: id,
    auth_type: "api_key",
    secret_ciphertext: ciphertext,
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 0,
    weight: 1,
    max_concurrency: 1,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: index,
    updated_at: index,
  }]));
  const providers = new Map<string, ProviderRow>();
  for (const [index, id] of input.ids.entries()) {
    const providerId = input.providerFor(id, index);
    if (!providers.has(providerId)) providers.set(providerId, providerRow(providerId, index));
  }
  const budget: Budget = { d1: 0, subrequests: 0, cacheDeletes: 0 };
  const spendD1 = (count = 1): void => {
    budget.d1 += count;
    budget.subrequests += count;
    if (budget.d1 > 50) throw new Error(`D1 query limit exceeded at ${budget.d1}`);
    if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
  };

  const statement = (sql: string, binds: unknown[] = []): D1PreparedStatement => ({
    bind: (...args: unknown[]) => statement(sql, args),
    async all() {
      spendD1();
      if (sql.includes("SELECT c.id FROM credentials c")) {
        return { results: input.ids.map((id) => ({ id })), success: true, meta: {} } as never;
      }
      if (sql.includes("(SELECT COUNT(*) FROM credentials total")) {
        const limit = Number(binds[2] ?? MODEL_REFRESH_BATCH_LIMIT);
        return {
          results: input.ids.slice(0, limit).map((id) => ({ id, total: input.total ?? input.ids.length })),
          success: true,
          meta: {},
        } as never;
      }
      return { results: [], success: true, meta: {} } as never;
    },
    async first() {
      spendD1();
      if (sql.includes("SELECT enabled FROM providers WHERE id='opencode'")) return { enabled: 0 } as never;
      if (sql.includes("SELECT * FROM credentials WHERE id = ?")) return credentials.get(String(binds[0])) as never;
      if (sql.includes("SELECT * FROM providers WHERE id = ? AND enabled = 1")) return providers.get(String(binds[0])) as never;
      if (sql.includes("FROM provider_proxies WHERE provider_id=?")) return null;
      if (sql.includes("FROM system_settings WHERE key='system_proxy_url'")) return null;
      return null;
    },
    async run() {
      spendD1();
      return { success: true, meta: { changes: 1 } } as never;
    },
    async raw() {
      throw new Error("not used");
    },
  } as D1PreparedStatement);

  const DB = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: D1PreparedStatement[]) {
      spendD1(statements.length);
      return statements.map(() => ({ success: true, meta: {} }));
    },
  } as unknown as D1Database;

  vi.stubGlobal("fetch", vi.fn(async () => {
    budget.subrequests += 1;
    if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
    return new Response(JSON.stringify({ data: [{ id: "model-1", name: "Model 1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));

  const env = {
    DB,
    MASTER_KEY: masterKey,
    CONFIG_CACHE: {
      delete: async () => {
        budget.cacheDeletes += 1;
        budget.subrequests += 1;
        if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
      },
    } as unknown as KVNamespace,
  } as Env;
  return { env, budget };
}

describe("model refresh budgets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the worst-case full sweep below D1 and total Free-plan limits", async () => {
    const ids = Array.from({ length: MODEL_REFRESH_BATCH_LIMIT }, (_, index) => `c${index + 1}`);
    const { env, budget } = await createEnv({
      ids,
      providerFor: (_id, index) => `p${index + 1}`,
      globalSelection: true,
    });
    const results = await runModelRefreshSweep(env);
    expect(results).toHaveLength(MODEL_REFRESH_BATCH_LIMIT);
    expect(results.every((result) => result.count === 1 && !result.error)).toBe(true);
    expect(budget.d1).toBeLessThanOrEqual(50);
    expect(budget.subrequests).toBeLessThanOrEqual(50);
    expect(budget.cacheDeletes).toBe(3);
  });

  it("limits a provider refresh to one coordinated safe page", async () => {
    const ids = Array.from({ length: 16 }, (_, index) => `c${index + 1}`);
    const { env, budget } = await createEnv({ ids, providerFor: () => "p1", total: ids.length });
    const page = await runProviderModelRefreshPage(env, "p1");
    expect(page.processed).toBe(MODEL_REFRESH_BATCH_LIMIT);
    expect(page.total).toBe(16);
    expect(page.remaining).toBe(16 - MODEL_REFRESH_BATCH_LIMIT);
    expect(page.results).toHaveLength(MODEL_REFRESH_BATCH_LIMIT);
    expect(budget.d1).toBeLessThanOrEqual(50);
    expect(budget.subrequests).toBeLessThanOrEqual(50);
    expect(budget.cacheDeletes).toBe(3);
  });
});
''')

print("Applied provider refresh coordination and budget fixes")
