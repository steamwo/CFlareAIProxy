import { getCredential, getProvider, listCredentialRows } from "./db";
import { GatewayError } from "./errors";
import { providerAuthHeaders } from "./providers/headers";
import { buildQoderHeaders } from "./providers/qoder-crypto";
import { openCodeGatewayEndpoints } from "./providers/opencode";
import { fetchOpenCodeWithFailover } from "./providers/opencode-failover";
import { isOpenCodeAnonymousModel, openCodeAnonymousCredential } from "./providers/opencode-anonymous";
import type { Credential, DiscoveredModelRow, Env, GatewayEndpoint, ProviderConfig } from "./types";
import { normalizeBaseUrl } from "./utils";
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

async function fetchModelPayload(env: Env, provider: ProviderConfig, credential: Credential): Promise<Record<string, unknown>> {
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
  const init: RequestInit = { method, headers, body, redirect: "manual" };
  const response = provider.kind === "opencode"
    ? (await fetchOpenCodeWithFailover({
        env,
        provider,
        credential,
        target: url,
        init,
        fetcher: (target, requestInit) => providerFetch(env, provider, target, requestInit, { purpose: "models", timeoutMs }),
      })).response
    : await providerFetch(env, provider, url, init, { purpose: "models", timeoutMs });
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


export async function refreshOpenCodeAnonymousModels(env: Env): Promise<ModelRefreshResult> {
  const provider = await getProvider(env, "opencode");
  try {
    const payload = await fetchModelPayload(env, provider, openCodeAnonymousCredential());
    const models = parseModels(payload).filter((model) => isOpenCodeAnonymousModel(model.id));
    if (!models.length) throw new GatewayError(502, "MODEL_DISCOVERY_EMPTY", "OpenCode Zen returned no anonymous free models", "upstream_error");
    const endpointSet = new Set<GatewayEndpoint>();
    const now = Math.floor(Date.now() / 1000);
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("DELETE FROM discovered_models WHERE provider_id='opencode' AND credential_id=''"),
    ];
    for (const model of models) {
      for (const endpoint of endpointsForModel(provider, model.id)) {
        endpointSet.add(endpoint);
        statements.push(env.DB.prepare(
          `INSERT INTO discovered_models
            (provider_id,credential_id,model_id,display_name,endpoint,owned_by,capabilities_json,raw_json,enabled,discovered_at)
           VALUES('opencode','',?,?,?,?,?,?,1,?)`,
        ).bind(
          model.id, model.displayName, endpoint, model.ownedBy || "opencode",
          JSON.stringify(model.capabilities), JSON.stringify({ ...model.raw, anonymous: true }), now,
        ));
      }
    }
    await env.DB.batch(statements);
    await Promise.all([env.CONFIG_CACHE.delete("models:public"), env.CONFIG_CACHE.delete("models:public:v2"), env.CONFIG_CACHE.delete("models:public:v3")]);
    return { providerId: "opencode", credentialId: "", count: models.length, endpoints: [...endpointSet] };
  } catch (error) {
    return {
      providerId: "opencode",
      credentialId: "",
      count: 0,
      endpoints: ["chat"],
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

export async function refreshCredentialModels(env: Env, credentialId: string): Promise<ModelRefreshResult> {
  const credential = await getCredential(env, credentialId);
  const provider = await getProvider(env, credential.provider_id);
  try {
    const payload = await fetchModelPayload(env, provider, credential);
    const models = parseModels(payload);
    if (!models.length) throw new GatewayError(502, "MODEL_DISCOVERY_EMPTY", `${provider.name} returned no recognizable models`, "upstream_error");
    const endpointSet = new Set<GatewayEndpoint>();
    const now = Math.floor(Date.now() / 1000);
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("DELETE FROM discovered_models WHERE provider_id = ? AND credential_id = ?").bind(provider.id, credential.id),
    ];
    for (const model of models) {
      const modelEndpoints = endpointsForModel(provider, model.id);
      for (const endpoint of modelEndpoints) {
        endpointSet.add(endpoint);
        statements.push(env.DB.prepare(
          `INSERT INTO discovered_models
            (provider_id,credential_id,model_id,display_name,endpoint,owned_by,capabilities_json,raw_json,enabled,discovered_at)
           VALUES(?,?,?,?,?,?,?,?,1,?)`,
        ).bind(
          provider.id, credential.id, model.id, model.displayName, endpoint,
          model.ownedBy || provider.id, JSON.stringify(model.capabilities), JSON.stringify(model.raw), now,
        ));
      }
    }
    await env.DB.batch(statements);
    await Promise.all([env.CONFIG_CACHE.delete("models:public"), env.CONFIG_CACHE.delete("models:public:v2"), env.CONFIG_CACHE.delete("models:public:v3")]);
    return { providerId: provider.id, credentialId, count: models.length, endpoints: [...endpointSet] };
  } catch (error) {
    return {
      providerId: provider.id,
      credentialId,
      count: 0,
      endpoints: endpointsForProvider(provider),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function refreshProviderModels(env: Env, providerId: string): Promise<ModelRefreshResult[]> {
  await getProvider(env, providerId);
  const rows = await listCredentialRows(env, providerId);
  const results: ModelRefreshResult[] = [];
  if (providerId === "opencode") results.push(await refreshOpenCodeAnonymousModels(env));
  for (let index = 0; index < rows.length; index += 4) {
    results.push(...await Promise.all(rows.slice(index, index + 4).map((row) => refreshCredentialModels(env, row.id))));
  }
  return results;
}

export async function refreshAllModels(env: Env): Promise<ModelRefreshResult[]> {
  const result = await env.DB.prepare("SELECT id FROM credentials WHERE enabled=1 ORDER BY provider_id,priority,created_at").all<{ id: string }>();
  const output: ModelRefreshResult[] = [];
  const openCode = await env.DB.prepare("SELECT enabled FROM providers WHERE id='opencode'").first<{ enabled: number }>();
  if (openCode?.enabled === 1) output.push(await refreshOpenCodeAnonymousModels(env));
  for (let index = 0; index < result.results.length; index += 4) {
    output.push(...await Promise.all(result.results.slice(index, index + 4).map((row) => refreshCredentialModels(env, row.id))));
  }
  return output;
}

export async function listDiscoveredModels(env: Env): Promise<Array<DiscoveredModelRow & { credential_label: string; provider_name: string }>> {
  const result = await env.DB.prepare(
    `SELECT dm.*, c.label AS credential_label, p.name AS provider_name
     FROM discovered_models dm
     JOIN providers p ON p.id=dm.provider_id
     LEFT JOIN credentials c ON c.id=dm.credential_id
     ORDER BY p.name,dm.model_id,dm.endpoint,c.label`,
  ).all<DiscoveredModelRow & { credential_label: string; provider_name: string }>();
  return result.results;
}
