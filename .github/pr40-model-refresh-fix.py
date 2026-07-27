from pathlib import Path
import re

ROOT = Path(".")

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")

def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")

def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))

def regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}: {pattern[:120]!r}")
    write(path, updated)

replace_once(
    "src/models.ts",
    'import { getCredential, getProvider, listCredentialRows, loadCachedProvider } from "./db";',
    'import { getCredential, getProvider, getProviderProxyConfig, listCredentialRows, loadCachedProvider } from "./db";',
)
replace_once(
    "src/models.ts",
    'import type { Credential, DiscoveredModelRow, Env, GatewayEndpoint, ProviderConfig } from "./types";',
    'import type { Credential, DiscoveredModelRow, Env, GatewayEndpoint, ProviderConfig, ProviderProxyConfig } from "./types";',
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
''',
    '''export interface ModelRefreshResult {
  providerId: string;
  credentialId: string;
  count: number;
  endpoints: GatewayEndpoint[];
  error?: string;
}

type ProviderProxyCache = Map<string, Promise<ProviderProxyConfig | null>>;

function loadCachedProviderProxy(
  env: Env,
  providerId: string,
  cache?: ProviderProxyCache,
): Promise<ProviderProxyConfig | null> | undefined {
  if (!cache) return undefined;
  const cached = cache.get(providerId);
  if (cached) return cached;
  const pending = getProviderProxyConfig(env, providerId);
  pending.catch(() => cache.delete(providerId));
  cache.set(providerId, pending);
  return pending;
}
''',
)
replace_once(
    "src/models.ts",
    'async function fetchModelPayload(env: Env, provider: ProviderConfig, credential: Credential): Promise<Record<string, unknown>> {',
    '''async function fetchModelPayload(
  env: Env,
  provider: ProviderConfig,
  credential: Credential,
  proxyCache?: ProviderProxyCache,
): Promise<Record<string, unknown>> {''',
)
replace_once(
    "src/models.ts",
    '''  const timeoutMs = typeof provider.options.discovery_timeout_ms === "number" ? Math.max(1000, provider.options.discovery_timeout_ms) : 20_000;
  const init: RequestInit = { method, headers, body, redirect: "manual" };
''',
    '''  const timeoutMs = typeof provider.options.discovery_timeout_ms === "number" ? Math.max(1000, provider.options.discovery_timeout_ms) : 20_000;
  const proxyConfig = await loadCachedProviderProxy(env, provider.id, proxyCache);
  const init: RequestInit = { method, headers, body, redirect: "manual" };
''',
)
replace_once(
    "src/models.ts",
    '{ purpose: "models", timeoutMs })',
    '{ purpose: "models", timeoutMs, proxyConfig })',
)
replace_once(
    "src/models.ts",
    ': await providerFetch(env, provider, url, init, { purpose: "models", timeoutMs });',
    ': await providerFetch(env, provider, url, init, { purpose: "models", timeoutMs, proxyConfig });',
)

new_refresh_functions = r'''const MODEL_DISCOVERY_JSON_MAX_BYTES = 1_500_000;
const modelJsonEncoder = new TextEncoder();

interface DiscoveredModelWrite {
  credential_id: string;
  model_id: string;
  display_name: string;
  endpoint: GatewayEndpoint;
  owned_by: string;
  capabilities_json: string;
  raw_json: string;
  discovered_at: number;
}

/**
 * Rewrites one credential's catalogue with exactly two D1 statements regardless of model
 * count. This keeps the whole bounded sweep below the Free plan's 50-query invocation limit.
 */
function discoveredModelRewriteStatements(
  env: Env,
  providerId: string,
  credentialIds: string[],
  rows: DiscoveredModelWrite[],
): D1PreparedStatement[] {
  const rowsJson = JSON.stringify(rows);
  if (modelJsonEncoder.encode(rowsJson).byteLength > MODEL_DISCOVERY_JSON_MAX_BYTES) {
    throw new GatewayError(
      502,
      "MODEL_DISCOVERY_TOO_LARGE",
      `${providerId} returned too much model metadata to replace atomically`,
      "upstream_error",
    );
  }
  return [
    env.DB.prepare(
      `DELETE FROM discovered_models
       WHERE provider_id=?
         AND credential_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    ).bind(providerId, JSON.stringify([...new Set(credentialIds)])),
    env.DB.prepare(
      `INSERT INTO discovered_models
        (provider_id,credential_id,model_id,display_name,endpoint,owned_by,
         capabilities_json,raw_json,enabled,discovered_at)
       SELECT ?,
         CAST(json_extract(value,'$.credential_id') AS TEXT),
         CAST(json_extract(value,'$.model_id') AS TEXT),
         CAST(json_extract(value,'$.display_name') AS TEXT),
         CAST(json_extract(value,'$.endpoint') AS TEXT),
         CAST(json_extract(value,'$.owned_by') AS TEXT),
         CAST(json_extract(value,'$.capabilities_json') AS TEXT),
         CAST(json_extract(value,'$.raw_json') AS TEXT),
         1,
         CAST(json_extract(value,'$.discovered_at') AS INTEGER)
       FROM json_each(?)`,
    ).bind(providerId, rowsJson),
  ];
}

export async function refreshOpenCodeAnonymousModels(
  env: Env,
  providerCache?: ProviderCache,
  proxyCache?: ProviderProxyCache,
): Promise<ModelRefreshResult> {
  let provider: ProviderConfig | undefined;
  try {
    provider = await loadCachedProvider(env, "opencode", providerCache);
    const payload = await fetchModelPayload(env, provider, openCodeAnonymousCredential(), proxyCache);
    const models = parseModels(payload).filter((model) => isOpenCodeAnonymousModel(model.id));
    if (!models.length) throw new GatewayError(502, "MODEL_DISCOVERY_EMPTY", "OpenCode Zen returned no anonymous free models", "upstream_error");
    const endpointSet = new Set<GatewayEndpoint>();
    const now = Math.floor(Date.now() / 1000);
    const rows: DiscoveredModelWrite[] = [];
    for (const model of models) {
      for (const endpoint of endpointsForModel(provider, model.id)) {
        endpointSet.add(endpoint);
        rows.push({
          credential_id: "",
          model_id: model.id,
          display_name: model.displayName,
          endpoint,
          owned_by: model.ownedBy || "opencode",
          capabilities_json: JSON.stringify(model.capabilities),
          raw_json: JSON.stringify({ ...model.raw, anonymous: true }),
          discovered_at: now,
        });
      }
    }
    await env.DB.batch(discoveredModelRewriteStatements(env, provider.id, [""], rows));
    await Promise.all([env.CONFIG_CACHE.delete("models:public"), env.CONFIG_CACHE.delete("models:public:v2"), env.CONFIG_CACHE.delete("models:public:v3")]);
    return { providerId: "opencode", credentialId: "", count: models.length, endpoints: [...endpointSet] };
  } catch (error) {
    return {
      providerId: "opencode",
      credentialId: "",
      count: 0,
      endpoints: provider ? endpointsForProvider(provider) : ["chat"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ensureOpenCodeAnonymousModels'''

regex_once(
    "src/models.ts",
    r'export async function refreshOpenCodeAnonymousModels\(env: Env\): Promise<ModelRefreshResult> \{.*?\n\}\n\nexport async function ensureOpenCodeAnonymousModels',
    new_refresh_functions,
)

new_credential_refresh = r'''export async function refreshCredentialModels(
  env: Env,
  credentialId: string,
  providerCache?: ProviderCache,
  proxyCache?: ProviderProxyCache,
): Promise<ModelRefreshResult> {
  let credential: Credential | undefined;
  let provider: ProviderConfig | undefined;
  try {
    credential = await getCredential(env, credentialId);
    provider = await loadCachedProvider(env, credential.provider_id, providerCache);
    const payload = await fetchModelPayload(env, provider, credential, proxyCache);
    const models = parseModels(payload);
    if (!models.length) throw new GatewayError(502, "MODEL_DISCOVERY_EMPTY", `${provider.name} returned no recognizable models`, "upstream_error");
    const endpointSet = new Set<GatewayEndpoint>();
    const now = Math.floor(Date.now() / 1000);
    const discoveryScopes = discoveryCredentialScopes(provider.kind, credential.id);
    const rows: DiscoveredModelWrite[] = [];
    for (const model of models) {
      for (const endpoint of endpointsForModel(provider, model.id)) {
        endpointSet.add(endpoint);
        for (const scope of discoveryScopes) {
          rows.push({
            credential_id: scope,
            model_id: model.id,
            display_name: model.displayName,
            endpoint,
            owned_by: model.ownedBy || provider.id,
            capabilities_json: JSON.stringify(model.capabilities),
            raw_json: JSON.stringify(model.raw),
            discovered_at: now,
          });
        }
      }
    }
    await env.DB.batch(discoveredModelRewriteStatements(env, provider.id, discoveryScopes, rows));
    await Promise.all([env.CONFIG_CACHE.delete("models:public"), env.CONFIG_CACHE.delete("models:public:v2"), env.CONFIG_CACHE.delete("models:public:v3")]);
    return { providerId: provider.id, credentialId, count: models.length, endpoints: [...endpointSet] };
  } catch (error) {
    return {
      providerId: provider?.id ?? credential?.provider_id ?? "",
      credentialId,
      count: 0,
      endpoints: provider ? endpointsForProvider(provider) : ["chat"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function refreshProviderModels'''

regex_once(
    "src/models.ts",
    r'export async function refreshCredentialModels\(.*?\n\}\n\nexport async function refreshProviderModels',
    new_credential_refresh,
)

replace_once(
    "src/models.ts",
    '''export async function refreshProviderModels(env: Env, providerId: string): Promise<ModelRefreshResult[]> {
  await getProvider(env, providerId);
  const rows = await listCredentialRows(env, providerId);
  const results: ModelRefreshResult[] = [];
  if (providerId === "opencode") results.push(await refreshOpenCodeAnonymousModels(env));
  for (let index = 0; index < rows.length; index += 4) {
    results.push(...await Promise.all(rows.slice(index, index + 4).map((row) => refreshCredentialModels(env, row.id))));
  }
  return results;
}
''',
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
''',
)

new_batch_tail = r'''/**
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
export const MODEL_REFRESH_BATCH_LIMIT = 6;
const MODEL_REFRESH_CONCURRENCY = 4;
const MODEL_REFRESH_DO_NAME = "model-refresh";

async function markModelRefreshAttempts(env: Env, credentialIds: string[]): Promise<void> {
  if (!credentialIds.length) return;
  const attemptedAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO credential_refresh_attempts(credential_id,model_attempted_at)
     SELECT c.id, ? FROM credentials c
     JOIN json_each(?) requested ON c.id=CAST(requested.value AS TEXT)
     WHERE c.enabled=1
     ON CONFLICT(credential_id) DO UPDATE SET model_attempted_at=excluded.model_attempted_at`,
  ).bind(attemptedAt, JSON.stringify(credentialIds)).run();
}

/**
 * Executes one serialised sweep. Exported for the coordinator Durable Object and tests;
 * production callers should use refreshAllModels().
 */
export async function runModelRefreshSweep(
  env: Env,
  limit = MODEL_REFRESH_BATCH_LIMIT,
): Promise<ModelRefreshResult[]> {
  const boundedLimit = Math.max(1, Math.min(MODEL_REFRESH_BATCH_LIMIT, Math.floor(limit) || MODEL_REFRESH_BATCH_LIMIT));
  const result = await env.DB.prepare(
    `SELECT c.id FROM credentials c
     JOIN providers p ON p.id=c.provider_id AND p.enabled=1
     LEFT JOIN credential_refresh_attempts a ON a.credential_id = c.id
     WHERE c.enabled=1
     ORDER BY COALESCE(a.model_attempted_at, 0) ASC, c.provider_id, c.priority, c.created_at
     LIMIT ?`,
  ).bind(boundedLimit).all<{ id: string }>();
  const output: ModelRefreshResult[] = [];
  const providerCache: ProviderCache = new Map();
  const proxyCache: ProviderProxyCache = new Map();
  const openCode = await env.DB.prepare("SELECT enabled FROM providers WHERE id='opencode'").first<{ enabled: number }>();
  if (openCode?.enabled === 1) output.push(await refreshOpenCodeAnonymousModels(env, providerCache, proxyCache));

  for (let index = 0; index < result.results.length; index += MODEL_REFRESH_CONCURRENCY) {
    const group = result.results.slice(index, index + MODEL_REFRESH_CONCURRENCY);
    await markModelRefreshAttempts(env, group.map((row) => row.id));
    output.push(...await Promise.all(
      group.map((row) => refreshCredentialModels(env, row.id, providerCache, proxyCache)),
    ));
  }
  return output;
}

/**
 * Routes every production full sweep through one named DO. The DO holds the promise for the
 * active sweep, so admin and cron requests that overlap receive the same result instead of
 * selecting and processing the same accounts twice.
 */
export async function refreshAllModels(
  env: Env,
  limit = MODEL_REFRESH_BATCH_LIMIT,
): Promise<ModelRefreshResult[]> {
  const namespace = env.RATE_LIMITER;
  if (!namespace) return runModelRefreshSweep(env, limit);
  const stub = namespace.get(namespace.idFromName(MODEL_REFRESH_DO_NAME));
  const response = await stub.fetch("https://do.internal/models/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit }),
  });
  if (!response.ok) throw new Error(`model refresh coordinator returned ${response.status}`);
  return await response.json() as ModelRefreshResult[];
}
'''

regex_once(
    "src/models.ts",
    r'/\*\*\n \* Accounts whose catalogue is refreshed per invocation\..*?\nexport async function refreshAllModels\(env: Env, limit = MODEL_REFRESH_BATCH_LIMIT\): Promise<ModelRefreshResult\[]> \{.*?\n\}\n',
    new_batch_tail,
)

replace_once(
    "src/upstream-fetch.ts",
    '''export interface ProviderFetchOptions {
  timeoutMs?: number;
  purpose?: "inference" | "models" | "quota" | "oauth" | "test";
}
''',
    '''export interface ProviderFetchOptions {
  timeoutMs?: number;
  purpose?: "inference" | "models" | "quota" | "oauth" | "test";
  /** Preloaded by bounded batch jobs so repeated attempts do not re-read D1 proxy settings. */
  proxyConfig?: ProviderProxyConfig | null;
}
''',
)
replace_once(
    "src/upstream-fetch.ts",
    '  const config = await getProviderProxyConfig(env, provider.id);',
    '  const config = options.proxyConfig === undefined ? await getProviderProxyConfig(env, provider.id) : options.proxyConfig;',
)

replace_once(
    "src/rate-limiter.ts",
    'import type { Env, RateLease, UsageAggregateEvent, UsageEvent } from "./types";',
    '''import { runModelRefreshSweep, type ModelRefreshResult } from "./models";
import type { Env, RateLease, UsageAggregateEvent, UsageEvent } from "./types";''',
)
replace_once(
    "src/rate-limiter.ts",
    '''export interface AlertClaimResult {
  claimed: boolean;
  claimedAt: number;
}
''',
    '''export interface AlertClaimResult {
  claimed: boolean;
  claimedAt: number;
}

/** Coalesces overlapping refresh requests inside one Durable Object instance. */
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
}
''',
)
replace_once(
    "src/rate-limiter.ts",
    '''export class RateLimiter extends DurableObject<Env> {
  private alarmAt: number | null = null;
  private readonly environment: Env;
''',
    '''export class RateLimiter extends DurableObject<Env> {
  private alarmAt: number | null = null;
  private readonly environment: Env;
  private readonly modelRefreshGate = new ModelRefreshGate();
''',
)
replace_once(
    "src/rate-limiter.ts",
    '''    if (request.method === "POST" && url.pathname === "/alerts/claim") {
      const payload = await request.json() as { scope?: unknown; windowMs?: unknown; now?: unknown };
''',
    '''    if (request.method === "POST" && url.pathname === "/models/refresh") {
      const payload = await request.json() as { limit?: unknown };
      const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
        ? Math.max(1, Math.floor(payload.limit))
        : undefined;
      return Response.json(await this.modelRefreshGate.run(() => runModelRefreshSweep(this.environment, limit)));
    }
    if (request.method === "POST" && url.pathname === "/alerts/claim") {
      const payload = await request.json() as { scope?: unknown; windowMs?: unknown; now?: unknown };
''',
)

replace_once(
    "test/refresh-batching.test.ts",
    '''describe("model refresh batching", () => {
  it("asks the database for at most one batch", async () => {
''',
    '''describe("model refresh batching", () => {
  it("keeps the default inside the verified Free-plan D1 budget", () => {
    expect(MODEL_REFRESH_BATCH_LIMIT).toBe(6);
  });

  it("asks the database for at most one batch", async () => {
''',
)
replace_once(
    "test/refresh-batching.test.ts",
    '''  it("takes the least recently attempted catalogues first", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllModels(env);
    expect(capture.sql[0]).toContain("LEFT JOIN credential_refresh_attempts");
    expect(capture.sql[0]).toMatch(/ORDER BY\s+COALESCE\(a\.model_attempted_at, 0\) ASC/);
  });
});
''',
    '''  it("takes the least recently attempted catalogues from enabled providers first", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllModels(env);
    expect(capture.sql[0]).toContain("JOIN providers p ON p.id=c.provider_id AND p.enabled=1");
    expect(capture.sql[0]).toContain("LEFT JOIN credential_refresh_attempts");
    expect(capture.sql[0]).toMatch(/ORDER BY\s+COALESCE\(a\.model_attempted_at, 0\) ASC/);
  });

  it("packs attempt markers once per group instead of once per account", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
    const env = { DB: createDb(capture, ids) } as never;
    const results = await refreshAllModels(env);
    const markers = capture.sql
      .map((sql, index) => ({ sql, binds: capture.binds[index] ?? [] }))
      .filter((entry) => entry.sql.includes("INSERT INTO credential_refresh_attempts"));
    expect(markers).toHaveLength(2);
    expect(JSON.parse(String(markers[0]?.binds[1]))).toEqual(ids.slice(0, 4));
    expect(JSON.parse(String(markers[1]?.binds[1]))).toEqual(ids.slice(4));
    expect(results).toHaveLength(ids.length);
  });

  it("returns setup failures and still reaches later groups", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    const env = { DB: createDb(capture, ids) } as never;
    const results = await refreshAllModels(env);
    expect(results).toHaveLength(ids.length);
    expect(results.every((result) => result.error)).toBe(true);
  });
});
''',
)

write(
    "test/model-refresh-gate.test.ts",
    '''import { describe, expect, it, vi } from "vitest";
import { ModelRefreshGate } from "../src/rate-limiter";
import { refreshAllModels } from "../src/models";
import type { Env } from "../src/types";

describe("model refresh coordination", () => {
  it("coalesces overlapping work inside the fixed-name Durable Object", async () => {
    const gate = new ModelRefreshGate();
    let release!: (value: []) => void;
    const pending = new Promise<[]>((resolve) => { release = resolve; });
    const task = vi.fn(() => pending);

    const first = gate.run(task);
    const second = gate.run(task);
    expect(task).toHaveBeenCalledTimes(1);
    release([]);
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);

    await gate.run(async () => []);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("routes every production sweep through the same named instance", async () => {
    const idFromName = vi.fn(() => ({}) as DurableObjectId);
    const fetch = vi.fn(async () => Response.json([]));
    const env = {
      RATE_LIMITER: {
        idFromName,
        get: () => ({ fetch }),
      } as unknown as DurableObjectNamespace,
    } as Env;

    await refreshAllModels(env);
    expect(idFromName).toHaveBeenCalledWith("model-refresh");
    expect(fetch).toHaveBeenCalledWith(
      "https://do.internal/models/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
''',
)

write(
    "test/model-refresh-d1-budget.test.ts",
    '''import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/crypto";
import { MODEL_REFRESH_BATCH_LIMIT, runModelRefreshSweep } from "../src/models";
import type { CredentialRow, Env, ProviderRow } from "../src/types";

describe("model refresh D1 budget", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("completes the worst-case default batch below the Free-plan 50-query limit", async () => {
    const masterKey = Buffer.alloc(32, 7).toString("base64");
    const ciphertext = await encryptSecret("token", masterKey);
    const ids = Array.from({ length: MODEL_REFRESH_BATCH_LIMIT }, (_, index) => `c${index + 1}`);
    const credentials = new Map<string, CredentialRow>(ids.map((id, index) => [id, {
      id,
      provider_id: `p${index + 1}`,
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
    const providers = new Map<string, ProviderRow>(ids.map((_, index) => {
      const id = `p${index + 1}`;
      return [id, {
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
      }];
    }));

    let queries = 0;
    const spend = (count = 1): void => {
      queries += count;
      if (queries > 50) throw new Error(`D1 query limit exceeded at ${queries}`);
    };

    const statement = (sql: string, binds: unknown[] = []): D1PreparedStatement => ({
      bind: (...args: unknown[]) => statement(sql, args),
      async all() {
        spend();
        if (sql.includes("SELECT c.id FROM credentials c")) {
          return { results: ids.map((id) => ({ id })), success: true, meta: {} } as never;
        }
        return { results: [], success: true, meta: {} } as never;
      },
      async first() {
        spend();
        if (sql.includes("SELECT enabled FROM providers WHERE id='opencode'")) return { enabled: 0 } as never;
        if (sql.includes("SELECT * FROM credentials WHERE id = ?")) return credentials.get(String(binds[0])) as never;
        if (sql.includes("SELECT * FROM providers WHERE id = ? AND enabled = 1")) return providers.get(String(binds[0])) as never;
        if (sql.includes("FROM provider_proxies WHERE provider_id=?")) return null;
        if (sql.includes("FROM system_settings WHERE key='system_proxy_url'")) return null;
        return null;
      },
      async run() {
        spend();
        return { success: true, meta: { changes: 1 } } as never;
      },
      async raw() {
        throw new Error("not used");
      },
    } as D1PreparedStatement);

    const DB = {
      prepare: (sql: string) => statement(sql),
      async batch(statements: D1PreparedStatement[]) {
        spend(statements.length);
        return statements.map(() => ({ success: true, meta: {} }));
      },
    } as unknown as D1Database;

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "model-1", name: "Model 1" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const env = {
      DB,
      MASTER_KEY: masterKey,
      CONFIG_CACHE: { delete: async () => {} } as unknown as KVNamespace,
    } as Env;

    const results = await runModelRefreshSweep(env);
    expect(results).toHaveLength(MODEL_REFRESH_BATCH_LIMIT);
    expect(results.every((result) => result.count === 1 && !result.error)).toBe(true);
    expect(queries).toBeLessThanOrEqual(50);
  });
});
''',
)

print("Applied PR #40 model-refresh follow-up fixes")
