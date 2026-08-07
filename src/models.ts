import { getCredential, getProvider, getProviderProxyConfig, loadCachedProvider } from "./db";
import type { ProviderCache } from "./db";
import { GatewayError } from "./errors";
import { providerAuthHeaders } from "./providers/headers";
import { buildQoderHeaders } from "./providers/qoder-crypto";
import { openCodeGatewayEndpoints } from "./providers/opencode";
import { fetchOpenCodeWithFailover } from "./providers/opencode-failover";
import { isOpenCodeAnonymousModel, openCodeAnonymousCredential } from "./providers/opencode-anonymous";
import { discoveryCredentialScopes } from "./qoder-model-routing";
import type { Credential, DiscoveredModelRow, Env, GatewayEndpoint, ProviderConfig, ProviderProxyConfig } from "./types";
import { base64Decode, base64UrlDecode, base64UrlEncode, normalizeBaseUrl } from "./utils";
import { providerFetch } from "./upstream-fetch";

interface ModelCandidate {
  id: string;
  displayName: string;
  ownedBy: string;
  capabilities: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface ModelRefreshResult {
  providerId: string;
  credentialId: string;
  count: number;
  endpoints: GatewayEndpoint[];
  error?: string;
}

export interface ProviderModelRefreshPage {
  providerId: string;
  results: ModelRefreshResult[];
  /** Credentials attempted by this request. */
  processed: number;
  /** Credentials covered since this cycle started, including work completed by another sweep. */
  processedInCycle: number;
  total: number;
  remaining: number;
  complete: boolean;
  /** Opaque continuation token. Omitted once every credential in the cycle has been attempted. */
  nextCursor?: string;
}

interface ProviderModelRefreshCursor {
  version: 2;
  providerId: string;
  attemptedBefore: number;
}

const providerRefreshCursorEncoder = new TextEncoder();
const providerRefreshCursorDecoder = new TextDecoder();
const providerRefreshCursorKeyCache = new Map<string, Promise<CryptoKey>>();
const PROVIDER_REFRESH_CURSOR_KEY_CACHE_LIMIT = 4;
const PROVIDER_REFRESH_CURSOR_CONTEXT = providerRefreshCursorEncoder.encode(
  "CFlareAIProxy/provider-model-refresh-cursor/v2",
);

function invalidProviderModelRefreshCursor(): GatewayError {
  return new GatewayError(400, "MODEL_REFRESH_CURSOR_INVALID", "Invalid provider model refresh cursor");
}

async function providerRefreshCursorKey(
  base64Key: string | undefined,
  slot: "MASTER_KEY" | "MASTER_KEY_PREVIOUS",
): Promise<CryptoKey> {
  const normalized = typeof base64Key === "string" ? base64Key.trim() : "";
  if (!normalized) {
    throw new GatewayError(
      503,
      "MASTER_KEY_MISSING",
      "MASTER_KEY is not configured. Set it to a base64-encoded 32-byte Worker secret and redeploy.",
      "configuration_error",
    );
  }
  const cached = providerRefreshCursorKeyCache.get(normalized);
  if (cached) return cached;

  const pending = (async () => {
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = base64Decode(normalized);
    } catch {
      throw new GatewayError(
        503,
        slot === "MASTER_KEY" ? "INVALID_MASTER_KEY" : "INVALID_MASTER_KEY_PREVIOUS",
        `${slot} is invalid. It must be a base64-encoded 32-byte key.`,
        "configuration_error",
      );
    }
    if (raw.byteLength !== 32) {
      throw new GatewayError(
        503,
        slot === "MASTER_KEY" ? "INVALID_MASTER_KEY" : "INVALID_MASTER_KEY_PREVIOUS",
        `${slot} is invalid. It must be a base64-encoded 32-byte key.`,
        "configuration_error",
      );
    }
    const material = new Uint8Array(raw.byteLength + PROVIDER_REFRESH_CURSOR_CONTEXT.byteLength);
    material.set(raw);
    material.set(PROVIDER_REFRESH_CURSOR_CONTEXT, raw.byteLength);
    const derived = await crypto.subtle.digest("SHA-256", material);
    return crypto.subtle.importKey(
      "raw",
      derived,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  })();
  pending.catch(() => {
    if (providerRefreshCursorKeyCache.get(normalized) === pending) {
      providerRefreshCursorKeyCache.delete(normalized);
    }
  });
  if (providerRefreshCursorKeyCache.size >= PROVIDER_REFRESH_CURSOR_KEY_CACHE_LIMIT) {
    providerRefreshCursorKeyCache.clear();
  }
  providerRefreshCursorKeyCache.set(normalized, pending);
  return pending;
}

async function encodeProviderModelRefreshCursor(
  env: Env,
  cursor: ProviderModelRefreshCursor,
): Promise<string> {
  const payload = base64UrlEncode(providerRefreshCursorEncoder.encode(JSON.stringify(cursor)));
  const key = await providerRefreshCursorKey(env.MASTER_KEY, "MASTER_KEY");
  const signature = await crypto.subtle.sign("HMAC", key, providerRefreshCursorEncoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyProviderModelRefreshCursorSignature(
  env: Env,
  payload: string,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const encoded = providerRefreshCursorEncoder.encode(payload);
  const current = await providerRefreshCursorKey(env.MASTER_KEY, "MASTER_KEY");
  if (await crypto.subtle.verify("HMAC", current, signature, encoded)) return true;
  const previous = typeof env.MASTER_KEY_PREVIOUS === "string" ? env.MASTER_KEY_PREVIOUS.trim() : "";
  if (!previous) return false;
  const previousKey = await providerRefreshCursorKey(env.MASTER_KEY_PREVIOUS, "MASTER_KEY_PREVIOUS");
  return crypto.subtle.verify("HMAC", previousKey, signature, encoded);
}

async function decodeProviderModelRefreshCursor(
  env: Env,
  providerId: string,
  cursor?: string,
): Promise<ProviderModelRefreshCursor | undefined> {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 2048) throw new Error("cursor is too long");
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid cursor envelope");
    const [payload, signatureValue] = parts;
    const signature = base64UrlDecode(signatureValue);
    if (!await verifyProviderModelRefreshCursorSignature(env, payload, signature)) {
      throw new Error("cursor signature mismatch");
    }
    const parsed = JSON.parse(
      providerRefreshCursorDecoder.decode(base64UrlDecode(payload)),
    ) as Partial<ProviderModelRefreshCursor>;
    if (
      parsed.version !== 2
      || parsed.providerId !== providerId
      || !Number.isInteger(parsed.attemptedBefore)
      || Number(parsed.attemptedBefore) <= 0
    ) throw new Error("invalid cursor payload");
    return parsed as ProviderModelRefreshCursor;
  } catch (error) {
    if (error instanceof GatewayError && error.status === 503) throw error;
    throw invalidProviderModelRefreshCursor();
  }
}

type ProviderProxyCache = Map<string, Promise<ProviderProxyConfig | null>>;

async function invalidateModelCache(env: Env): Promise<void> {
  await Promise.all([
    env.CONFIG_CACHE.delete("models:public"),
    env.CONFIG_CACHE.delete("models:public:v2"),
    env.CONFIG_CACHE.delete("models:public:v3"),
  ]);
}

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function candidateArrays(payload: Record<string, unknown>): unknown[][] {
  const arrays: unknown[][] = [];
  const push = (value: unknown): void => { if (Array.isArray(value)) arrays.push(value); };
  push(payload.data); push(payload.models); push(payload.items); push(payload.result); push(payload.chat);
  if (payload.chat && typeof payload.chat === "object" && !Array.isArray(payload.chat)) {
    arrays.push(Object.entries(payload.chat as Record<string, unknown>).map(([key, value]) =>
      value && typeof value === "object" && !Array.isArray(value) ? { key, ...(value as Record<string, unknown>) } : { key, value },
    ));
  }
  const data = record(payload.data);
  push(data.data); push(data.models); push(data.items); push(data.result); push(data.list);
  const result = record(payload.result);
  push(result.data); push(result.models); push(result.items); push(result.list);
  return arrays;
}

export function parseModels(payload: Record<string, unknown>): ModelCandidate[] {
  const output = new Map<string, ModelCandidate>();
  for (const array of candidateArrays(payload)) {
    for (const value of array) {
      if (typeof value === "string" && value.trim()) {
        const id = value.trim();
        output.set(id, { id, displayName: id, ownedBy: "", capabilities: {}, raw: { id } });
        continue;
      }
      const item = record(value);
      const id = firstString(item, ["id", "model", "model_id", "modelId", "key", "name", "value", "code"]);
      if (!id) continue;
      const displayName = firstString(item, ["display_name", "displayName", "label", "title", "name"]) ?? id;
      const ownedBy = firstString(item, ["owned_by", "ownedBy", "provider", "vendor", "organization"]) ?? "";
      output.set(id, { id, displayName, ownedBy, capabilities: record(item.capabilities), raw: item });
    }
  }
  return [...output.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function configuredString(provider: ProviderConfig, key: string): string | undefined {
  const value = provider.options[key] ?? provider.auth[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function modelsUrl(provider: ProviderConfig): string {
  const base = normalizeBaseUrl(provider.base_url);
  const configured = provider.endpoints.models ?? configuredString(provider, "models_url");
  if (configured) return configured.startsWith("http") ? configured : `${base}${configured.startsWith("/") ? "" : "/"}${configured}`;
  return `${base}/models`;
}

function endpointsForProvider(provider: ProviderConfig): GatewayEndpoint[] {
  const configured = provider.options.discovery_endpoints;
  if (Array.isArray(configured)) {
    const values = configured.filter((value): value is GatewayEndpoint => value === "chat" || value === "responses" || value === "completions");
    if (values.length) return [...new Set(values)];
  }
  if (provider.kind === "codex") return ["responses", "chat", "completions"];
  if (provider.kind === "qoder") return ["chat"];
  const available = (["responses", "chat", "completions"] as GatewayEndpoint[]).filter((endpoint) => typeof provider.endpoints[endpoint] === "string");
  return available.length ? available : ["chat"];
}

function endpointsForModel(provider: ProviderConfig, modelId: string): GatewayEndpoint[] {
  if (provider.kind === "opencode") return openCodeGatewayEndpoints(provider, modelId);
  return endpointsForProvider(provider);
}

async function fetchModelPayload(
  env: Env,
  provider: ProviderConfig,
  credential: Credential,
  proxyCache?: ProviderProxyCache,
): Promise<Record<string, unknown>> {
  const url = modelsUrl(provider);
  let headers = providerAuthHeaders(provider, credential);
  if (provider.kind === "qoder") {
    const userId = typeof credential.metadata.user_id === "string" ? credential.metadata.user_id : "";
    if (!userId) throw new GatewayError(503, "QODER_CREDENTIAL_INVALID", "Qoder credential is missing metadata.user_id", "upstream_error");
    headers = new Headers(await buildQoderHeaders(new Uint8Array(), url, {
      userId,
      token: credential.secret,
      name: typeof credential.metadata.name === "string" ? credential.metadata.name : undefined,
      email: typeof credential.metadata.email === "string" ? credential.metadata.email : undefined,
      machineId: typeof credential.metadata.machine_id === "string" ? credential.metadata.machine_id : undefined,
    }));
    headers.set("accept", "application/json");
    headers.set("accept-encoding", "identity");
  }
  const extraHeaders = provider.options.models_headers;
  if (extraHeaders && typeof extraHeaders === "object" && !Array.isArray(extraHeaders)) {
    for (const [key, value] of Object.entries(extraHeaders as Record<string, unknown>)) if (typeof value === "string") headers.set(key, value);
  }
  const method = typeof provider.options.models_method === "string" ? provider.options.models_method.toUpperCase() : "GET";
  const configuredBody = provider.options.models_body;
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : typeof configuredBody === "string" ? configuredBody : configuredBody === undefined ? undefined : JSON.stringify(configuredBody);
  if (body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const timeoutMs = typeof provider.options.discovery_timeout_ms === "number" ? Math.max(1000, provider.options.discovery_timeout_ms) : 20_000;
  const proxyConfig = await loadCachedProviderProxy(env, provider.id, proxyCache);
  const init: RequestInit = { method, headers, body, redirect: "manual" };
  const response = provider.kind === "opencode"
    ? (await fetchOpenCodeWithFailover({
        env,
        provider,
        credential,
        target: url,
        init,
        fetcher: (target, requestInit) => providerFetch(env, provider, target, requestInit, { purpose: "models", timeoutMs, proxyConfig }),
      })).response
    : await providerFetch(env, provider, url, init, { purpose: "models", timeoutMs, proxyConfig });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GatewayError(response.status, "MODEL_DISCOVERY_FAILED", `${provider.name} models returned ${response.status}: ${text.slice(0, 500)}`, "upstream_error");
  }
  const payload = await response.json().catch(() => null);
  if (Array.isArray(payload)) return { data: payload };
  if (!payload || typeof payload !== "object") {
    throw new GatewayError(502, "MODEL_DISCOVERY_INVALID", `${provider.name} returned an invalid models payload`, "upstream_error");
  }
  return payload as Record<string, unknown>;
}


const MODEL_DISCOVERY_JSON_MAX_BYTES = 1_500_000;
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
  invalidateCache = true,
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
    if (invalidateCache) await invalidateModelCache(env);
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

export async function ensureOpenCodeAnonymousModels(env: Env, maxAgeSeconds = 3600): Promise<ModelRefreshResult | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(discovered_at) AS discovered_at FROM discovered_models WHERE provider_id='opencode' AND credential_id='' AND enabled=1",
  ).first<{ discovered_at: number | null }>();
  const now = Math.floor(Date.now() / 1000);
  if (row?.discovered_at && row.discovered_at >= now - maxAgeSeconds) return null;
  return refreshOpenCodeAnonymousModels(env);
}

export async function refreshCredentialModels(
  env: Env,
  credentialId: string,
  providerCache?: ProviderCache,
  proxyCache?: ProviderProxyCache,
  invalidateCache = true,
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
    if (invalidateCache) await invalidateModelCache(env);
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

/**
 * Five credentials fit both Free-plan ceilings in the true worst case: distinct providers,
 * no provider-specific proxy, successful writes and an enabled OpenCode anonymous catalogue.
 * That path uses at most 39 D1 queries and 48 total subrequests after cache invalidation is
 * collapsed to one three-key operation per sweep.
 */
export const MODEL_REFRESH_BATCH_LIMIT = 5;
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
}

/**
 * Routes every production full sweep through one named DO. The DO holds the promise for the
 * active sweep, so admin and cron requests that overlap receive the same result instead of
 * selecting and processing the same accounts twice.
 */
export async function runProviderModelRefreshPage(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
  cursor?: string,
): Promise<ProviderModelRefreshPage> {
  const boundedLimit = Math.max(1, Math.min(MODEL_REFRESH_BATCH_LIMIT, Math.floor(limit) || MODEL_REFRESH_BATCH_LIMIT));
  const existingCycle = await decodeProviderModelRefreshCursor(env, providerId, cursor);
  const attemptedBefore = existingCycle?.attemptedBefore ?? Math.floor(Date.now() / 1000);
  const provider = await getProvider(env, providerId);
  const page = await env.DB.prepare(
    `SELECT c.id
     FROM credentials c
     LEFT JOIN credential_refresh_attempts a ON a.credential_id=c.id
     WHERE c.provider_id=? AND c.enabled=1
       AND COALESCE(a.model_attempted_at, 0) < ?
     ORDER BY COALESCE(a.model_attempted_at, 0) ASC, c.priority, c.created_at
     LIMIT ?`,
  ).bind(providerId, attemptedBefore, boundedLimit).all<{ id: string }>();

  const results: ModelRefreshResult[] = [];
  const providerCache: ProviderCache = new Map([[providerId, Promise.resolve(provider)]]);
  const proxyCache: ProviderProxyCache = new Map();
  if (providerId === "opencode" && !existingCycle) {
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

  // Dynamic-cycle semantics: new enabled credentials join the active cycle, while credentials
  // completed by another coordinated sweep or disabled during the cycle stop counting as pending.
  // Recompute both values from current D1 state instead of trying to infer two independent changes
  // from one net delta carried in the cursor.
  const progress = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN COALESCE(a.model_attempted_at, 0) < ? THEN 1 ELSE 0 END), 0) AS remaining
     FROM credentials c
     LEFT JOIN credential_refresh_attempts a ON a.credential_id=c.id
     WHERE c.provider_id=? AND c.enabled=1`,
  ).bind(attemptedBefore, providerId).first<{ total: number; remaining: number }>();
  const total = Math.max(0, Number(progress?.total ?? 0));
  const remaining = Math.max(0, Math.min(total, Number(progress?.remaining ?? 0)));
  const processedInCycle = total - remaining;
  const complete = remaining === 0;
  return {
    providerId,
    results,
    processed: page.results.length,
    processedInCycle,
    total,
    remaining,
    complete,
    nextCursor: complete ? undefined : await encodeProviderModelRefreshCursor(env, {
      version: 2,
      providerId,
      attemptedBefore,
    }),
  };
}

export async function refreshProviderModels(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
  cursor?: string,
): Promise<ProviderModelRefreshPage> {
  await decodeProviderModelRefreshCursor(env, providerId, cursor);
  const namespace = env.RATE_LIMITER;
  if (!namespace) return runProviderModelRefreshPage(env, providerId, limit, cursor);
  const stub = namespace.get(namespace.idFromName(MODEL_REFRESH_DO_NAME));
  const response = await stub.fetch(`https://do.internal/models/refresh/provider/${encodeURIComponent(providerId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit, cursor }),
  });
  if (!response.ok) throw new Error(`provider model refresh coordinator returned ${response.status}`);
  return await response.json() as ProviderModelRefreshPage;
}

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

export async function listDiscoveredModels(env: Env): Promise<Array<DiscoveredModelRow & { credential_label: string; provider_name: string }>> {
  const result = await env.DB.prepare(
    `SELECT dm.*, c.label AS credential_label, p.name AS provider_name
     FROM discovered_models dm
     JOIN providers p ON p.id=dm.provider_id
     LEFT JOIN credentials c ON c.id=dm.credential_id AND c.provider_id=dm.provider_id
     WHERE p.kind<>'qoder'
       OR (
         p.enabled=1
         AND (
           (dm.credential_id<>'' AND c.enabled=1)
           OR (
             dm.credential_id=''
             AND EXISTS(
               SELECT 1 FROM credentials qoder_credential
               WHERE qoder_credential.provider_id=p.id AND qoder_credential.enabled=1
             )
           )
         )
       )
     ORDER BY p.name,dm.model_id,dm.endpoint,c.label`,
  ).all<DiscoveredModelRow & { credential_label: string; provider_name: string }>();
  return result.results;
}
