import { decryptSecret, encryptSecret } from "./crypto";
import { canonicalizeBuiltinRow } from "./builtin-channels";
import { GatewayError } from "./errors";
import {
  isOpenCodeAnonymousCredential, isOpenCodeAnonymousModel, openCodeAnonymousCredential, openCodeAnonymousCredentialRow,
} from "./providers/opencode-anonymous";
import type {
  Credential,
  CredentialRow,
  DiscoveredModelRow,
  Env,
  GatewayEndpoint,
  GatewayKeyRow,
  ModelRouteRow,
  ProviderConfig,
  ProviderProxyConfig,
  ProviderProxyRow,
  ProviderProxySummary,
  SystemProxySummary,
  ProviderRow,
  ProxyProtocol,
  QuotaSnapshot,
  QuotaSnapshotRow,
  UsageEvent,
} from "./types";
import { parseJson, sha256Hex } from "./utils";

export async function getProvider(env: Env, providerId: string): Promise<ProviderConfig> {
  const row = await env.DB.prepare("SELECT * FROM providers WHERE id = ? AND enabled = 1")
    .bind(providerId)
    .first<ProviderRow>();
  if (!row) throw new GatewayError(404, "PROVIDER_NOT_FOUND", `Provider ${providerId} was not found`);
  return hydrateProvider(row);
}

export function hydrateProvider(row: ProviderRow): ProviderConfig {
  const normalized = canonicalizeBuiltinRow(row);
  return {
    ...normalized,
    endpoints: parseJson<Record<string, string>>(normalized.endpoints_json, {}),
    auth: parseJson<Record<string, unknown>>(normalized.auth_json, {}),
    headers: parseJson<Record<string, string>>(normalized.headers_json, {}),
    options: parseJson<Record<string, unknown>>(normalized.options_json, {}),
  };
}

export async function listProviders(env: Env, includeDisabled = true): Promise<ProviderRow[]> {
  const query = includeDisabled ? "SELECT * FROM providers ORDER BY name" : "SELECT * FROM providers WHERE enabled = 1 ORDER BY name";
  const result = await env.DB.prepare(query).all<ProviderRow>();
  return result.results.map(canonicalizeBuiltinRow);
}


function maskedProxy(value: string | null): Omit<ProviderProxySummary, "source" | "hasProviderOverride" | "hasSystemProxy"> {
  let proxyProtocol: ProxyProtocol | undefined;
  let proxyHost: string | undefined;
  let runtimeReady = !value;
  if (value) {
    try {
      const parsed = new URL(value);
      proxyProtocol = parsed.protocol.replace(/:$/, "") as ProxyProtocol;
      proxyHost = parsed.hostname + (parsed.port ? `:${parsed.port}` : "");
      runtimeReady = ["http", "socks", "socks5", "socks5h"].includes(proxyProtocol);
    } catch {
      runtimeReady = false;
    }
  }
  return {
    enabled: Boolean(value),
    proxyProtocol,
    proxyHost,
    bridgeConfigured: false,
    runtimeReady,
  };
}

async function readSystemProxyUrl(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value_ciphertext FROM system_settings WHERE key='system_proxy_url'")
    .first<{ value_ciphertext: string | null }>();
  return row?.value_ciphertext ? await decryptSecret(row.value_ciphertext, env.MASTER_KEY) : "";
}

async function readProviderProxyUrl(env: Env, providerId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT enabled,proxy_url_ciphertext FROM provider_proxies WHERE provider_id=?")
    .bind(providerId)
    .first<{ enabled: number; proxy_url_ciphertext: string | null }>();
  if (!row || row.enabled !== 1 || !row.proxy_url_ciphertext) return "";
  return decryptSecret(row.proxy_url_ciphertext, env.MASTER_KEY);
}

export async function getProviderProxyConfig(env: Env, providerId: string): Promise<ProviderProxyConfig | null> {
  const providerProxy = await readProviderProxyUrl(env, providerId);
  const systemProxy = providerProxy ? "" : await readSystemProxyUrl(env);
  const proxyUrl = providerProxy || systemProxy;
  if (!proxyUrl) return null;
  return {
    providerId,
    enabled: true,
    bridgeUrl: env.PROXY_BRIDGE_URL?.trim() ?? "",
    proxyUrl,
    bridgeToken: env.PROXY_BRIDGE_TOKEN ?? "",
    noProxy: [],
    connectTimeoutMs: 20_000,
    requestTimeoutMs: 120_000,
    source: providerProxy ? "provider" : "system",
  };
}

export async function getProviderProxySummary(env: Env, providerId: string): Promise<ProviderProxySummary> {
  const [providerProxy, systemProxy] = await Promise.all([
    readProviderProxyUrl(env, providerId),
    readSystemProxyUrl(env),
  ]);
  const effective = providerProxy || systemProxy;
  return {
    ...maskedProxy(effective || null),
    source: providerProxy ? "provider" : systemProxy ? "system" : "direct",
    hasProviderOverride: Boolean(providerProxy),
    hasSystemProxy: Boolean(systemProxy),
  };
}

export async function listProviderProxySummaries(env: Env): Promise<Record<string, ProviderProxySummary>> {
  const providers = await env.DB.prepare("SELECT id FROM providers ORDER BY id").all<{ id: string }>();
  const entries = await Promise.all(providers.results.map(async ({ id }) => [id, await getProviderProxySummary(env, id)] as const));
  return Object.fromEntries(entries);
}

export async function upsertProviderProxyConfig(
  env: Env,
  input: { providerId: string; proxyUrl: string },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const proxyUrl = input.proxyUrl.trim();
  const ciphertext = proxyUrl ? await encryptSecret(proxyUrl, env.MASTER_KEY) : null;
  await env.DB.prepare(
    `INSERT INTO provider_proxies
      (provider_id,enabled,bridge_url,proxy_url_ciphertext,bridge_token_ciphertext,no_proxy_json,
       connect_timeout_ms,request_timeout_ms,created_at,updated_at)
     VALUES(?,?,?, ?,NULL,'[]',20000,120000,?,?)
     ON CONFLICT(provider_id) DO UPDATE SET
       enabled=excluded.enabled,bridge_url='',proxy_url_ciphertext=excluded.proxy_url_ciphertext,
       bridge_token_ciphertext=NULL,no_proxy_json='[]',connect_timeout_ms=20000,
       request_timeout_ms=120000,updated_at=excluded.updated_at`,
  ).bind(input.providerId, proxyUrl ? 1 : 0, "", ciphertext, now, now).run();
}

export async function deleteProviderProxyConfig(env: Env, providerId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_proxies WHERE provider_id=?").bind(providerId).run();
}

export async function getSystemProxySummary(env: Env): Promise<SystemProxySummary> {
  const proxyUrl = await readSystemProxyUrl(env);
  return maskedProxy(proxyUrl || null);
}

export async function upsertSystemProxyUrl(env: Env, proxyUrl: string): Promise<void> {
  const normalized = proxyUrl.trim();
  const ciphertext = normalized ? await encryptSecret(normalized, env.MASTER_KEY) : null;
  await env.DB.prepare(
    `INSERT INTO system_settings(key,value_ciphertext,value_json,updated_at)
     VALUES('system_proxy_url',?,'{}',?)
     ON CONFLICT(key) DO UPDATE SET value_ciphertext=excluded.value_ciphertext,updated_at=excluded.updated_at`,
  ).bind(ciphertext, Math.floor(Date.now() / 1000)).run();
}

export async function deleteSystemProxyUrl(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM system_settings WHERE key='system_proxy_url'").run();
}

export async function listRoutesForModel(
  env: Env,
  publicModel: string,
  endpoint: GatewayEndpoint,
): Promise<ModelRouteRow[]> {
  const configured = await env.DB.prepare(
    `SELECT r.* FROM model_routes r
     JOIN providers p ON p.id=r.provider_id AND p.enabled=1
     WHERE r.public_model = ? AND r.enabled = 1 AND r.endpoint = ?
     ORDER BY r.priority ASC, r.weight DESC, r.created_at ASC`,
  ).bind(publicModel, endpoint).all<ModelRouteRow>();
  if (configured.results.length) return configured.results;

  // Dynamically discovered models use provider/model. OpenAI-compatible providers
  // with an explicit model selection only expose the chosen aliases above.
  const separator = publicModel.indexOf("/");
  if (separator <= 0 || separator === publicModel.length - 1) return [];
  const providerId = publicModel.slice(0, separator);
  const upstreamModel = publicModel.slice(separator + 1);
  const provider = await env.DB.prepare("SELECT kind,options_json FROM providers WHERE id=? AND enabled=1")
    .bind(providerId).first<{ kind: string; options_json: string }>();
  if (!provider) return [];
  const options = parseJson<Record<string, unknown>>(provider.options_json, {});
  if (provider.kind === "openai-compatible" && Array.isArray(options.selected_models)) return [];

  const discovered = await env.DB.prepare(
    `SELECT dm.provider_id, MIN(dm.discovered_at) AS created_at
     FROM discovered_models dm
     LEFT JOIN credentials c ON c.id=dm.credential_id AND c.enabled=1
     WHERE dm.provider_id=? AND dm.model_id=? AND dm.endpoint=? AND dm.enabled=1
       AND (dm.credential_id='' OR c.id IS NOT NULL)
     GROUP BY dm.provider_id`,
  ).bind(providerId, upstreamModel, endpoint).all<{ provider_id: string; created_at: number }>();

  const providerWeight = typeof options.routing_weight === "number" ? Math.max(1, Math.floor(options.routing_weight)) : 1;
  return discovered.results.map((row) => ({
    id: `discovered:${row.provider_id}:${endpoint}:${upstreamModel}`,
    public_model: `${row.provider_id}/${upstreamModel}`,
    provider_id: row.provider_id,
    upstream_model: upstreamModel,
    endpoint,
    enabled: 1,
    priority: 100,
    weight: providerWeight,
    options_json: JSON.stringify({ dynamic: true }),
    created_at: row.created_at,
    updated_at: row.created_at,
  }));
}

export async function listModels(env: Env, allowedModels: string[] = []): Promise<Array<Record<string, unknown>>> {
  const cacheKey = "models:public:v3";
  const cached = await env.CONFIG_CACHE.get(cacheKey, "json").catch(() => null) as Array<Record<string, unknown>> | null;
  if (cached) {
    const allowed = new Set(allowedModels);
    return allowed.size ? cached.filter((model) => allowed.has(String(model.id))) : cached;
  }

  const [discoveredResult, routeResult] = await Promise.all([
    env.DB.prepare(
      `SELECT dm.provider_id, dm.model_id, MIN(dm.discovered_at) AS created_at,
              MAX(dm.display_name) AS display_name, GROUP_CONCAT(DISTINCT dm.endpoint) AS endpoints,
              MAX(dm.discovered_at) AS discovered_at, MAX(dm.owned_by) AS owned_by,
              p.kind, p.options_json
       FROM discovered_models dm
       JOIN providers p ON p.id=dm.provider_id AND p.enabled=1
       LEFT JOIN credentials c ON c.id=dm.credential_id AND c.enabled=1
       WHERE dm.enabled=1 AND (dm.credential_id='' OR c.id IS NOT NULL)
       GROUP BY dm.provider_id,dm.model_id
       ORDER BY dm.provider_id,dm.model_id`,
    ).all<{
      provider_id: string; model_id: string; created_at: number; display_name: string;
      endpoints: string; discovered_at: number; owned_by: string; kind: string; options_json: string;
    }>(),
    env.DB.prepare(
      `SELECT r.public_model, MIN(r.created_at) AS created_at, GROUP_CONCAT(DISTINCT r.endpoint) AS endpoints,
              GROUP_CONCAT(DISTINCT r.provider_id) AS providers
       FROM model_routes r JOIN providers p ON p.id=r.provider_id AND p.enabled=1
       WHERE r.enabled=1 GROUP BY r.public_model ORDER BY r.public_model`,
    ).all<{ public_model: string; created_at: number; endpoints: string; providers: string }>(),
  ]);

  const modelMap = new Map<string, Record<string, unknown>>();
  for (const row of discoveredResult.results) {
    const options = parseJson<Record<string, unknown>>(row.options_json, {});
    if (row.kind === "openai-compatible" && Array.isArray(options.selected_models)) continue;
    const id = `${row.provider_id}/${row.model_id}`;
    modelMap.set(id, {
      id,
      object: "model",
      created: row.created_at,
      owned_by: row.owned_by || row.provider_id,
      display_name: row.display_name || row.model_id,
      x_cflare_provider: row.provider_id,
      x_cflare_upstream_model: row.model_id,
      x_cflare_endpoints: row.endpoints ? row.endpoints.split(",") : [],
      x_cflare_discovered_at: row.discovered_at,
    });
  }
  for (const row of routeResult.results) {
    modelMap.set(row.public_model, {
      id: row.public_model,
      object: "model",
      created: row.created_at,
      owned_by: "cflare-route",
      display_name: row.public_model,
      x_cflare_providers: row.providers ? row.providers.split(",") : [],
      x_cflare_endpoints: row.endpoints ? row.endpoints.split(",") : [],
      x_cflare_managed_route: true,
    });
  }
  const models = [...modelMap.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  await env.CONFIG_CACHE.put(cacheKey, JSON.stringify(models), { expirationTtl: 120 }).catch(() => undefined);
  const allowed = new Set(allowedModels);
  return allowed.size ? models.filter((model) => allowed.has(String(model.id))) : models;
}

export async function listCredentialRows(env: Env, providerId: string): Promise<CredentialRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM credentials
     WHERE provider_id = ? AND enabled = 1
     ORDER BY priority ASC, created_at ASC`,
  )
    .bind(providerId)
    .all<CredentialRow>();
  return result.results;
}

export interface CredentialAvailability {
  row: CredentialRow;
  available: boolean;
  reason?: string;
  retryAt?: number;
}

function numericBalance(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function exhaustedUntil(snapshot: QuotaSnapshot, row: Pick<QuotaSnapshotRow, "fetched_at" | "expires_at">, now: number): { exhausted: boolean; reason?: string; retryAt?: number } {
  if (snapshot.status !== "ok") return { exhausted: false };
  if (snapshot.credits?.unlimited) return { exhausted: false };
  const creditBalance = numericBalance(snapshot.credits?.balance);
  if (snapshot.credits?.hasCredits === false || (creditBalance !== undefined && creditBalance <= 0)) {
    const retryAt = row.expires_at && row.expires_at > now ? row.expires_at : row.fetched_at + 300;
    return { exhausted: retryAt > now, reason: "可用余额已耗尽", retryAt };
  }

  const windows = snapshot.windows.filter((window) =>
    window.remaining !== undefined || window.remainingPercent !== undefined || window.usedPercent !== undefined,
  );
  if (!windows.length) return { exhausted: false };
  const isEmpty = (window: QuotaSnapshot["windows"][number]) =>
    (window.remaining !== undefined && window.remaining <= 0)
    || (window.remainingPercent !== undefined && window.remainingPercent <= 0)
    || (window.usedPercent !== undefined && window.usedPercent >= 100);

  // Qoder personal and organization packages are additive: either pool can keep the account usable.
  const qoderPools = windows.filter((window) => window.key === "user" || window.key === "organization");
  const exhausted = qoderPools.length
    ? qoderPools.every(isEmpty)
    : windows.some(isEmpty);
  if (!exhausted) return { exhausted: false };
  const resetCandidates = windows.filter(isEmpty).map((window) => window.resetAt).filter((value): value is number => typeof value === "number" && value > now);
  const retryAt = resetCandidates.length
    ? Math.min(...resetCandidates)
    : row.expires_at && row.expires_at > now ? row.expires_at : row.fetched_at + 300;
  return { exhausted: retryAt > now, reason: "额度已用完，等待重置", retryAt };
}

export async function listCredentialAvailabilityForModel(
  env: Env,
  providerId: string,
  upstreamModel: string,
  endpoint: GatewayEndpoint,
): Promise<CredentialAvailability[]> {
  const result = await env.DB.prepare(
    `SELECT c.*, q.status AS quota_status, q.quota_json, q.fetched_at AS quota_fetched_at, q.expires_at AS quota_expires_at
     FROM credentials c
     LEFT JOIN quota_snapshots q ON q.credential_id=c.id
     WHERE c.provider_id=? AND c.enabled=1
       AND (
         NOT EXISTS(
           SELECT 1 FROM discovered_models any_model
           WHERE any_model.provider_id=c.provider_id AND any_model.endpoint=? AND any_model.enabled=1
         )
         OR EXISTS(
           SELECT 1 FROM discovered_models dm
           WHERE dm.provider_id=c.provider_id AND dm.endpoint=? AND dm.model_id=? AND dm.enabled=1
             AND (dm.credential_id='' OR dm.credential_id=c.id)
         )
       )
     ORDER BY c.priority ASC,c.created_at ASC`,
  ).bind(providerId, endpoint, endpoint, upstreamModel).all<CredentialRow & {
    quota_status: QuotaSnapshot["status"] | null;
    quota_json: string | null;
    quota_fetched_at: number | null;
    quota_expires_at: number | null;
  }>();
  const now = Math.floor(Date.now() / 1000);
  const output = result.results.map((entry) => {
    const { quota_status, quota_json, quota_fetched_at, quota_expires_at, ...row } = entry;
    if (!quota_json || !quota_status || quota_fetched_at === null) return { row, available: true } satisfies CredentialAvailability;
    const snapshot = parseJson<QuotaSnapshot>(quota_json, { provider: providerId, status: quota_status, windows: [], source: "configured" });
    const state = exhaustedUntil(snapshot, { fetched_at: quota_fetched_at, expires_at: quota_expires_at }, now);
    return state.exhausted
      ? { row, available: false, reason: state.reason, retryAt: state.retryAt }
      : { row, available: true };
  });
  if (providerId === "opencode" && isOpenCodeAnonymousModel(upstreamModel)) {
    output.push({ row: openCodeAnonymousCredentialRow(), available: true });
  }
  return output;
}

export async function listCredentialRowsForModel(
  env: Env,
  providerId: string,
  upstreamModel: string,
  endpoint: GatewayEndpoint,
): Promise<CredentialRow[]> {
  return (await listCredentialAvailabilityForModel(env, providerId, upstreamModel, endpoint))
    .filter((entry) => entry.available)
    .map((entry) => entry.row);
}

export async function listDiscoveredModelRows(env: Env, providerId?: string): Promise<DiscoveredModelRow[]> {
  const result = providerId
    ? await env.DB.prepare("SELECT * FROM discovered_models WHERE provider_id=? ORDER BY model_id,endpoint,credential_id").bind(providerId).all<DiscoveredModelRow>()
    : await env.DB.prepare("SELECT * FROM discovered_models ORDER BY provider_id,model_id,endpoint,credential_id").all<DiscoveredModelRow>();
  return result.results;
}

export async function getCredential(env: Env, credentialId: string): Promise<Credential> {
  if (isOpenCodeAnonymousCredential(credentialId)) return openCodeAnonymousCredential();
  const row = await env.DB.prepare("SELECT * FROM credentials WHERE id = ?")
    .bind(credentialId)
    .first<CredentialRow>();
  if (!row || row.enabled !== 1) {
    throw new GatewayError(503, "NO_CREDENTIAL", "No enabled credential is available", "upstream_error");
  }
  return {
    ...row,
    secret: await decryptSecret(row.secret_ciphertext, env.MASTER_KEY),
    refreshToken: row.refresh_ciphertext ? await decryptSecret(row.refresh_ciphertext, env.MASTER_KEY) : undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
  };
}

export async function createCredential(
  env: Env,
  input: {
    providerId: string;
    label: string;
    authType: string;
    secret: string;
    refreshToken?: string;
    expiresAt?: number;
    enabled?: boolean;
    priority?: number;
    weight?: number;
    maxConcurrency?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const secretCiphertext = await encryptSecret(input.secret, env.MASTER_KEY);
  const refreshCiphertext = input.refreshToken ? await encryptSecret(input.refreshToken, env.MASTER_KEY) : null;
  await env.DB.prepare(
    `INSERT INTO credentials
      (id, provider_id, label, auth_type, secret_ciphertext, refresh_ciphertext, expires_at,
       enabled, priority, weight, max_concurrency, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.providerId,
      input.label,
      input.authType,
      secretCiphertext,
      refreshCiphertext,
      input.expiresAt ?? null,
      input.enabled === false ? 0 : 1,
      input.priority ?? 100,
      Math.max(1, input.weight ?? 1),
      Math.max(1, input.maxConcurrency ?? 4),
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    )
    .run();
  await env.CONFIG_CACHE.delete(`provider:${input.providerId}`);
  return id;
}

export async function updateCredentialTokens(
  env: Env,
  credentialId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresAt: number | undefined,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const secretCiphertext = await encryptSecret(accessToken, env.MASTER_KEY);
  const refreshCiphertext = refreshToken ? await encryptSecret(refreshToken, env.MASTER_KEY) : null;
  await env.DB.prepare(
    `UPDATE credentials SET secret_ciphertext = ?,
      refresh_ciphertext = COALESCE(?, refresh_ciphertext),
      expires_at = COALESCE(?, expires_at), metadata_json = COALESCE(?, metadata_json),
      last_error = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(
      secretCiphertext,
      refreshCiphertext,
      expiresAt ?? null,
      metadata ? JSON.stringify(metadata) : null,
      Math.floor(Date.now() / 1000),
      credentialId,
    )
    .run();
}

export async function setCredentialError(env: Env, credentialId: string, message: string): Promise<void> {
  if (isOpenCodeAnonymousCredential(credentialId)) return;
  await env.DB.prepare("UPDATE credentials SET last_error = ?, updated_at = ? WHERE id = ?")
    .bind(message.slice(0, 1000), Math.floor(Date.now() / 1000), credentialId)
    .run();
}

export async function authenticateGatewayKey(env: Env, rawKey: string): Promise<GatewayKeyRow> {
  const hash = await sha256Hex(rawKey);
  const row = await env.DB.prepare("SELECT * FROM gateway_keys WHERE key_hash = ? AND enabled = 1")
    .bind(hash)
    .first<GatewayKeyRow>();
  const now = Math.floor(Date.now() / 1000);
  if (!row || (row.expires_at !== null && row.expires_at <= now)) {
    throw new GatewayError(401, "AUTHENTICATION_ERROR", "Invalid or expired API key", "authentication_error");
  }
  return row;
}

export async function createGatewayKey(
  env: Env,
  input: {
    name: string;
    rpm?: number;
    maxConcurrency?: number;
    monthlyTokenLimit?: number;
    allowedModels?: string[];
    expiresAt?: number;
  },
): Promise<{ id: string; key: string }> {
  const id = crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint8Array(24));
  let encoded = "";
  for (const byte of random) encoded += byte.toString(16).padStart(2, "0");
  const key = `sk_cfapi_${encoded}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO gateway_keys
      (id, name, key_prefix, key_hash, enabled, rpm, max_concurrency,
       monthly_token_limit, allowed_models_json, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.name,
      key.slice(0, 12),
      await sha256Hex(key),
      input.rpm ?? 60,
      input.maxConcurrency ?? 8,
      input.monthlyTokenLimit ?? 0,
      JSON.stringify(input.allowedModels ?? []),
      input.expiresAt ?? null,
      now,
      now,
    )
    .run();
  return { id, key };
}

export async function insertUsage(env: Env, event: UsageEvent): Promise<void> {
  let costMicros = 0;
  if (event.providerId && event.upstreamModel) {
    const price = await env.DB.prepare(
      `SELECT input_micros_per_million, output_micros_per_million, cache_micros_per_million
       FROM model_prices WHERE provider_id = ? AND model = ?`,
    ).bind(event.providerId, event.upstreamModel).first<{
      input_micros_per_million: number;
      output_micros_per_million: number;
      cache_micros_per_million: number;
    }>();
    if (price) {
      const cachedTokens = Math.min(event.usage.promptTokens, event.usage.cachedTokens);
      const uncachedInputTokens = Math.max(0, event.usage.promptTokens - cachedTokens);
      costMicros = Math.max(0, Math.ceil(
        (uncachedInputTokens * price.input_micros_per_million
          + cachedTokens * price.cache_micros_per_million
          + event.usage.completionTokens * price.output_micros_per_million) / 1_000_000,
      ));
    }
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO request_logs
      (request_id, gateway_key_id, provider_id, credential_id, public_model, upstream_model,
       endpoint, status_code, prompt_tokens, completion_tokens, cached_tokens, total_tokens, cost_micros, latency_ms,
       first_token_ms, error_code, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      event.requestId,
      event.gatewayKeyId ?? null,
      event.providerId ?? null,
      event.credentialId ?? null,
      event.publicModel ?? null,
      event.upstreamModel ?? null,
      event.endpoint ?? null,
      event.statusCode,
      event.usage.promptTokens,
      event.usage.completionTokens,
      event.usage.cachedTokens,
      event.usage.totalTokens,
      costMicros,
      event.latencyMs,
      event.firstTokenMs ?? null,
      event.errorCode ?? null,
      event.errorMessage?.slice(0, 1000) ?? null,
      event.createdAt,
    )
    .run();
}
