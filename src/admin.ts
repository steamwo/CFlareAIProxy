import { Hono } from "hono";
import { BUILTIN_CHANNELS, getBuiltinChannel, isBuiltinChannelId, standardOpenAiConfig } from "./builtin-channels";
import { encryptSecret } from "./crypto";
import {
  createCredential, createGatewayKey, deleteProviderProxyConfig, deleteSystemProxyUrl, getCredential, getProvider,
  getProviderProxySummary, getSystemProxySummary, listCredentialAvailabilityForModel, listCredentialRows, listModels,
  listProviderProxySummaries, listProviders, upsertProviderProxyConfig, upsertSystemProxyUrl,
} from "./db";
import { GatewayError, errorResponse } from "./errors";
import { exchangeOAuthCode, pollOAuth, startOAuth } from "./oauth";
import { listDiscoveredModels, refreshAllModels, refreshCredentialModels, refreshProviderModels } from "./models";
import { listQuotaSnapshots, refreshAllQuotas, refreshCredentialQuota } from "./quota";
import type { CredentialRow, Env, GatewayEndpoint, GatewayKeyRow, ModelRouteRow, PoolStrategy, ProviderConfig, ProviderRow } from "./types";
import { normalizeBaseUrl, parseJson, timingSafeEqualText } from "./utils";
import { providerFetch, testProviderProxy, testSystemProxy, validateProxyUrl } from "./upstream-fetch";
import { getProviderHealthMap, recordProviderSuccess } from "./routing-health";

const ADMIN_UI_VERSION = "0.5.3";
const SESSION_COOKIE = "cflare_admin_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

interface AdminSession {
  username: string;
  expiresAt: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseCookies(request: Request): Record<string, string> {
  const output: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    output[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return output;
}

async function signSessionPayload(payload: string, env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.ADMIN_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

async function createSessionToken(username: string, env: Env): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({ v: 1, u: username, exp: expiresAt, nonce: crypto.randomUUID() })));
  return { token: `${payload}.${await signSessionPayload(payload, env)}`, expiresAt };
}

async function readSession(request: Request, env: Env): Promise<AdminSession | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !env.ADMIN_TOKEN) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = await signSessionPayload(payload, env);
  if (!timingSafeEqualText(signature, expected)) return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { u?: unknown; exp?: unknown };
    if (typeof decoded.u !== "string" || typeof decoded.exp !== "number" || decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    return { username: decoded.u, expiresAt: decoded.exp };
  } catch {
    return null;
  }
}

function adminCredentials(env: Env): { username: string; password: string } {
  return {
    username: env.ADMIN_USERNAME?.trim() || "admin",
    password: env.ADMIN_PASSWORD || env.ADMIN_TOKEN || "",
  };
}

async function requireAdmin(request: Request, env: Env): Promise<AdminSession> {
  const headerToken = request.headers.get("x-admin-token") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (env.ADMIN_TOKEN && headerToken && timingSafeEqualText(headerToken, env.ADMIN_TOKEN)) {
    return { username: adminCredentials(env).username, expiresAt: Math.floor(Date.now() / 1000) + 300 };
  }
  const session = await readSession(request, env);
  if (!session) throw new GatewayError(401, "ADMIN_AUTH_REQUIRED", "Administrator login is required", "authentication_error");
  return session;
}

function sessionCookie(token: string, request: Request, maxAge = SESSION_TTL_SECONDS): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function jsonObject(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fallback;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new GatewayError(400, "INVALID_REQUEST", `${name} is required`, "invalid_request_error");
  return value.trim();
}

function optionalEnabled(value: unknown): number | null {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function priceInput(body: Record<string, unknown>): { input: number; output: number; cache: number } {
  return {
    input: typeof body.inputMicrosPerMillion === "number" ? Math.max(0, Math.floor(body.inputMicrosPerMillion)) : 0,
    output: typeof body.outputMicrosPerMillion === "number" ? Math.max(0, Math.floor(body.outputMicrosPerMillion)) : 0,
    cache: typeof body.cacheMicrosPerMillion === "number" ? Math.max(0, Math.floor(body.cacheMicrosPerMillion)) : 0,
  };
}

interface ProviderModelSelection {
  upstreamModel: string;
  publicModel: string;
  endpoints: GatewayEndpoint[];
}

function modelEndpoints(apiMode: string): GatewayEndpoint[] {
  if (apiMode === "chat") return ["chat"];
  if (apiMode === "responses") return ["responses"];
  return ["chat", "responses"];
}

function normalizeModelSelections(value: unknown, apiMode: string): ProviderModelSelection[] {
  if (!Array.isArray(value)) return [];
  const allowedEndpoints = new Set(modelEndpoints(apiMode));
  const output: ProviderModelSelection[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const upstreamModel = typeof record.upstreamModel === "string" ? record.upstreamModel.trim() : "";
    if (!upstreamModel) continue;
    const publicModel = typeof record.publicModel === "string" && record.publicModel.trim() ? record.publicModel.trim() : upstreamModel;
    const requested = Array.isArray(record.endpoints)
      ? record.endpoints.filter((entry): entry is GatewayEndpoint => entry === "chat" || entry === "responses" || entry === "completions")
      : modelEndpoints(apiMode);
    const endpoints = [...new Set(requested.filter((entry) => allowedEndpoints.has(entry)))];
    output.push({ upstreamModel, publicModel, endpoints: endpoints.length ? endpoints : modelEndpoints(apiMode) });
  }
  return output;
}

async function syncProviderModelRoutes(
  env: Env,
  providerId: string,
  selections: ProviderModelSelection[],
  weight: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM model_routes WHERE provider_id=? AND json_extract(options_json,'$.managed_by')='provider-model-selection'").bind(providerId),
  ];
  for (const selection of selections) {
    for (const endpoint of selection.endpoints) {
      statements.push(env.DB.prepare(
        `INSERT INTO model_routes(id,public_model,provider_id,upstream_model,endpoint,enabled,priority,weight,options_json,created_at,updated_at)
         VALUES(?,?,?,?,?,1,100,?,?,?,?)`,
      ).bind(
        crypto.randomUUID(), selection.publicModel, providerId, selection.upstreamModel, endpoint,
        Math.max(1, weight), JSON.stringify({ managed_by: "provider-model-selection" }), now, now,
      ));
    }
  }
  await env.DB.batch(statements);
}

function parseOpenAiModelIds(payload: unknown): string[] {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const raw = Array.isArray(payload) ? payload : Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return [...new Set(raw.map((item) => {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object") return "";
    const row = item as Record<string, unknown>;
    return typeof row.id === "string" ? row.id.trim() : typeof row.name === "string" ? row.name.trim() : "";
  }).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function testOpenAiProvider(
  env: Env,
  input: { providerId?: string; baseUrl: string; apiKey: string; apiMode: string },
): Promise<{ models: string[]; latencyMs: number; status: number }> {
  const standard = standardOpenAiConfig(input.apiMode === "chat" || input.apiMode === "responses" ? input.apiMode : "both");
  const now = Math.floor(Date.now() / 1000);
  const provider: ProviderConfig = {
    id: input.providerId || `test-${crypto.randomUUID()}`,
    name: "OpenAI-compatible test",
    kind: "openai-compatible",
    base_url: normalizeBaseUrl(input.baseUrl),
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: JSON.stringify(standard.endpoints),
    auth_json: JSON.stringify(standard.auth),
    headers_json: JSON.stringify(standard.headers),
    options_json: JSON.stringify(standard.options),
    created_at: now,
    updated_at: now,
    endpoints: standard.endpoints,
    auth: standard.auth,
    headers: standard.headers,
    options: standard.options,
  };
  let apiKey = input.apiKey;
  if (!apiKey && input.providerId) {
    const rows = await listCredentialRows(env, input.providerId).catch(() => []);
    if (rows[0]) apiKey = (await getCredential(env, rows[0].id)).secret;
  }
  const url = `${provider.base_url.replace(/\/+$/, "")}/models`;
  const startedAt = Date.now();
  const response = await providerFetch(env, provider, url, {
    method: "GET",
    headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    redirect: "manual",
  }, { purpose: "models", timeoutMs: 30_000 });
  const text = await response.text();
  if (!response.ok) throw new GatewayError(response.status, "PROVIDER_TEST_FAILED", `API Key 测试失败：HTTP ${response.status} · ${text.slice(0, 500)}`, "upstream_error");
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new GatewayError(502, "PROVIDER_MODELS_INVALID", "上游 /models 没有返回有效 JSON", "upstream_error"); }
  const models = parseOpenAiModelIds(payload);
  if (!models.length) throw new GatewayError(502, "PROVIDER_MODELS_EMPTY", "API Key 可连接，但 /models 没有返回可识别的模型", "upstream_error");
  return { models, latencyMs: Date.now() - startedAt, status: response.status };
}

async function invalidateModelCache(env: Env): Promise<void> {
  await Promise.all([
    env.CONFIG_CACHE.delete("models:public"),
    env.CONFIG_CACHE.delete("models:public:v2"),
    env.CONFIG_CACHE.delete("models:public:v3"),
  ]);
}

export function createAdminApp() {
  // Keep the complete admin route tree on an explicit base path. Using
  // strict:false makes /admin and /admin/ equivalent and avoids a fragile
  // redirect + nested-root combination in local Wrangler development.
  const app = new Hono<{ Bindings: Env }>({ strict: false }).basePath("/admin");
  app.get("/api/version", (c) => c.json({ service: c.env.APP_NAME ?? "CFlareAPI", version: ADMIN_UI_VERSION }));

  app.post("/api/login", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const expected = adminCredentials(c.env);
    if (!expected.password || !timingSafeEqualText(username, expected.username) || !timingSafeEqualText(password, expected.password)) {
      throw new GatewayError(401, "ADMIN_LOGIN_FAILED", "用户名或密码错误", "authentication_error");
    }
    const session = await createSessionToken(expected.username, c.env);
    c.header("set-cookie", sessionCookie(session.token, c.req.raw));
    c.header("cache-control", "no-store");
    return c.json({ authenticated: true, username: expected.username, expiresAt: session.expiresAt, service: c.env.APP_NAME ?? "CFlareAPI" });
  });
  app.get("/api/session", async (c) => {
    const session = await readSession(c.req.raw, c.env);
    if (!session) throw new GatewayError(401, "ADMIN_AUTH_REQUIRED", "Administrator login is required", "authentication_error");
    c.header("cache-control", "no-store");
    return c.json({ authenticated: true, username: session.username, expiresAt: session.expiresAt, service: c.env.APP_NAME ?? "CFlareAPI" });
  });
  app.post("/api/logout", (c) => {
    c.header("set-cookie", sessionCookie("", c.req.raw, 0));
    c.header("cache-control", "no-store");
    return c.json({ ok: true });
  });

  app.use("/api/*", async (c, next) => {
    try {
      await requireAdmin(c.req.raw, c.env);
      c.header("cache-control", "no-store");
      await next();
    } catch (error) {
      return errorResponse(error);
    }
  });

  app.get("/api/overview", async (c) => {
    const now = Math.floor(Date.now() / 1000);
    const since = now - 24 * 60 * 60;
    const availabilitySince = now - 7 * 24 * 60 * 60;
    const [providerCounts, credentialCounts, routeCounts, keyCounts, usage, providerUsage, modelUsage, availability] = await Promise.all([
      c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM providers").first<{ total: number; enabled: number | null }>(),
      c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled, SUM(CASE WHEN last_error IS NOT NULL AND last_error<>'' THEN 1 ELSE 0 END) errors FROM credentials").first<{ total: number; enabled: number | null; errors: number | null }>(),
      c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM model_routes").first<{ total: number; enabled: number | null }>(),
      c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM gateway_keys").first<{ total: number; enabled: number | null }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) requests,
          SUM(CASE WHEN status_code>=200 AND status_code<400 THEN 1 ELSE 0 END) successes,
          COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_micros),0) cost_micros,
          COALESCE(AVG(latency_ms),0) average_latency_ms, COALESCE(AVG(first_token_ms),0) average_first_token_ms
         FROM request_logs WHERE created_at>=?`,
      ).bind(since).first<{ requests: number; successes: number | null; tokens: number; cost_micros: number; average_latency_ms: number; average_first_token_ms: number }>(),
      c.env.DB.prepare(
        `SELECT provider_id, COUNT(*) requests, COALESCE(SUM(total_tokens),0) tokens
         FROM request_logs WHERE created_at>=? GROUP BY provider_id ORDER BY requests DESC LIMIT 10`,
      ).bind(since).all<{ provider_id: string | null; requests: number; tokens: number }>(),
      c.env.DB.prepare(
        `SELECT public_model, COUNT(*) requests, COALESCE(SUM(total_tokens),0) tokens
         FROM request_logs WHERE created_at>=? GROUP BY public_model ORDER BY requests DESC LIMIT 10`,
      ).bind(since).all<{ public_model: string | null; requests: number; tokens: number }>(),
      c.env.DB.prepare(
        `SELECT CAST(created_at/3600 AS INTEGER)*3600 AS bucket,
          COUNT(*) AS requests,
          SUM(CASE WHEN status_code>=200 AND status_code<400 THEN 1 ELSE 0 END) AS successes,
          COALESCE(AVG(latency_ms),0) AS average_latency_ms
         FROM request_logs WHERE created_at>=?
         GROUP BY bucket ORDER BY bucket`,
      ).bind(availabilitySince).all<{ bucket: number; requests: number; successes: number | null; average_latency_ms: number }>(),
    ]);
    const requests = usage?.requests ?? 0;
    const successes = usage?.successes ?? 0;
    return c.json({
      service: c.env.APP_NAME ?? "CFlareAPI",
      publicBaseUrl: c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin,
      now,
      counts: {
        providers: providerCounts ?? { total: 0, enabled: 0 },
        credentials: credentialCounts ?? { total: 0, enabled: 0, errors: 0 },
        routes: routeCounts ?? { total: 0, enabled: 0 },
        keys: keyCounts ?? { total: 0, enabled: 0 },
      },
      usage24h: {
        requests,
        successes,
        successRate: requests > 0 ? successes / requests * 100 : 0,
        tokens: usage?.tokens ?? 0,
        costMicros: usage?.cost_micros ?? 0,
        averageLatencyMs: usage?.average_latency_ms ?? 0,
        averageFirstTokenMs: usage?.average_first_token_ms ?? 0,
      },
      providerUsage: providerUsage.results,
      modelUsage: modelUsage.results,
      availability: availability.results.map((row) => ({
        bucket: row.bucket,
        requests: row.requests,
        successes: row.successes ?? 0,
        successRate: row.requests > 0 ? (row.successes ?? 0) / row.requests * 100 : 0,
        averageLatencyMs: row.average_latency_ms ?? 0,
      })),
    });
  });

  app.get("/api/channels", async (c) => {
    const [providers, proxies, credentials, models] = await Promise.all([
      listProviders(c.env, true),
      listProviderProxySummaries(c.env),
      c.env.DB.prepare("SELECT provider_id,COUNT(*) total,SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM credentials GROUP BY provider_id").all<{ provider_id: string; total: number; enabled: number | null }>(),
      c.env.DB.prepare("SELECT provider_id,COUNT(DISTINCT model_id) total FROM discovered_models WHERE enabled=1 GROUP BY provider_id").all<{ provider_id: string; total: number }>(),
    ]);
    const credentialMap = new Map(credentials.results.map((row) => [row.provider_id, row]));
    const modelMap = new Map(models.results.map((row) => [row.provider_id, row.total]));
    const rows = providers.filter((provider) => isBuiltinChannelId(provider.id));
    return c.json({
      data: rows.map((provider) => {
        const definition = getBuiltinChannel(provider.id)!;
        const account = credentialMap.get(provider.id);
        return {
          ...provider,
          entityType: "channel",
          description: definition.description,
          authMode: definition.authMode,
          accountCount: account?.total ?? 0,
          enabledAccountCount: account?.enabled ?? 0,
          modelCount: modelMap.get(provider.id) ?? 0,
          proxy: proxies[provider.id],
        };
      }),
    });
  });

  app.patch("/api/channels/:id", async (c) => {
    const id = c.req.param("id");
    if (!isBuiltinChannelId(id)) throw new GatewayError(404, "CHANNEL_NOT_FOUND", "Built-in channel not found");
    const body = await c.req.json<Record<string, unknown>>();
    const poolStrategy = typeof body.poolStrategy === "string" ? body.poolStrategy : body.pool_strategy;
    await c.env.DB.prepare(
      "UPDATE providers SET enabled=COALESCE(?,enabled),pool_strategy=COALESCE(?,pool_strategy),updated_at=? WHERE id=?",
    ).bind(
      optionalEnabled(body.enabled),
      typeof poolStrategy === "string" ? poolStrategy : null,
      Math.floor(Date.now() / 1000),
      id,
    ).run();
    await c.env.CONFIG_CACHE.delete(`provider:${id}`);
    return c.json({ ok: true });
  });

  app.get("/api/providers", async (c) => {
    const [providers, proxies] = await Promise.all([listProviders(c.env, true), listProviderProxySummaries(c.env)]);
    return c.json({
      data: providers.filter((provider) => !isBuiltinChannelId(provider.id)).map((provider) => {
        const options = parseJson<Record<string, unknown>>(provider.options_json, {});
        return {
          ...provider,
          entityType: "provider",
          apiMode: options.api_mode ?? "both",
          routingWeight: typeof options.routing_weight === "number" ? options.routing_weight : 1,
          modelSelections: Array.isArray(options.selected_models) ? options.selected_models : [],
          proxy: proxies[provider.id],
        };
      }),
    });
  });

  app.post("/api/providers/test", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const rawBaseUrl = typeof body.baseUrl === "string" ? body.baseUrl : body.base_url;
    const baseUrl = stringValue(rawBaseUrl, "baseUrl");
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const apiMode = typeof body.apiMode === "string" ? body.apiMode : "both";
    const providerId = typeof body.providerId === "string" && body.providerId.trim() ? body.providerId.trim() : undefined;
    return c.json(await testOpenAiProvider(c.env, { providerId, baseUrl, apiKey, apiMode }));
  });

  app.post("/api/providers", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const id = stringValue(body.id, "id").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
      throw new GatewayError(400, "PROVIDER_ID_INVALID", "供应商 ID 只能包含小写字母、数字、下划线和短横线");
    }
    if (isBuiltinChannelId(id)) throw new GatewayError(409, "PROVIDER_ID_RESERVED", "该 ID 为内置渠道保留");
    const name = stringValue(body.name, "name");
    const rawBaseUrl = typeof body.baseUrl === "string" ? body.baseUrl : body.base_url;
    const baseUrl = normalizeBaseUrl(stringValue(rawBaseUrl, "baseUrl"));
    const rawMode = typeof body.apiMode === "string" ? body.apiMode : "both";
    const apiMode = rawMode === "chat" || rawMode === "responses" ? rawMode : "both";
    const standard = standardOpenAiConfig(apiMode);
    const routingWeight = Math.max(1, Math.floor(optionalNumber(body.routingWeight) ?? 1));
    const selections = normalizeModelSelections(body.modelSelections, apiMode);
    const now = Math.floor(Date.now() / 1000);
    const options = { ...standard.options, routing_weight: routingWeight, selected_models: selections };
    await c.env.DB.prepare(
      `INSERT INTO providers(id,name,kind,base_url,enabled,pool_strategy,endpoints_json,auth_json,headers_json,options_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, name, "openai-compatible", baseUrl, optionalEnabled(body.enabled) ?? 1,
      typeof body.poolStrategy === "string" ? body.poolStrategy : "weighted",
      JSON.stringify(standard.endpoints), JSON.stringify(standard.auth), JSON.stringify(standard.headers),
      JSON.stringify(options), now, now,
    ).run();
    let credentialId: string | undefined;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    try {
      if (apiKey) {
        credentialId = await createCredential(c.env, {
          providerId: id,
          label: typeof body.apiKeyLabel === "string" && body.apiKeyLabel.trim() ? body.apiKeyLabel.trim() : `${name} · 默认 Key`,
          authType: "api_key",
          secret: apiKey,
        });
      }
      await syncProviderModelRoutes(c.env, id, selections, routingWeight);
    } catch (error) {
      await c.env.DB.prepare("DELETE FROM providers WHERE id=?").bind(id).run().catch(() => undefined);
      throw error;
    }
    if (credentialId) c.executionCtx.waitUntil(refreshCredentialModels(c.env, credentialId).then(() => undefined));
    await invalidateModelCache(c.env);
    return c.json({ id, credentialId: credentialId ?? null, routeCount: selections.reduce((sum, item) => sum + item.endpoints.length, 0) }, 201);
  });

  app.patch("/api/providers/:id", async (c) => {
    const id = c.req.param("id");
    if (isBuiltinChannelId(id)) throw new GatewayError(400, "BUILTIN_CHANNEL_READ_ONLY", "内置渠道配置不可修改");
    const body = await c.req.json<Record<string, unknown>>();
    const row = await c.env.DB.prepare("SELECT * FROM providers WHERE id=?").bind(id).first<ProviderRow>();
    if (!row) throw new GatewayError(404, "PROVIDER_NOT_FOUND", "Provider not found");
    const previousOptions = parseJson<Record<string, unknown>>(row.options_json, {});
    const rawMode = typeof body.apiMode === "string" ? body.apiMode : previousOptions.api_mode;
    const apiMode = rawMode === "chat" || rawMode === "responses" ? rawMode : "both";
    const standard = standardOpenAiConfig(apiMode);
    const rawBaseUrl = typeof body.baseUrl === "string" ? body.baseUrl : body.base_url;
    const routingWeight = Math.max(1, Math.floor(optionalNumber(body.routingWeight) ?? (typeof previousOptions.routing_weight === "number" ? previousOptions.routing_weight : 1)));
    const selections = body.modelSelections === undefined
      ? normalizeModelSelections(previousOptions.selected_models, apiMode)
      : normalizeModelSelections(body.modelSelections, apiMode);
    const options = { ...previousOptions, ...standard.options, routing_weight: routingWeight, selected_models: selections };
    await c.env.DB.prepare(
      `UPDATE providers SET name=?,kind='openai-compatible',base_url=?,enabled=?,pool_strategy=?,
       endpoints_json=?,auth_json=?,headers_json=?,options_json=?,updated_at=? WHERE id=?`,
    ).bind(
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : row.name,
      typeof rawBaseUrl === "string" && rawBaseUrl.trim() ? normalizeBaseUrl(rawBaseUrl) : row.base_url,
      optionalEnabled(body.enabled) ?? row.enabled,
      typeof body.poolStrategy === "string" ? body.poolStrategy : row.pool_strategy,
      JSON.stringify(standard.endpoints), JSON.stringify(standard.auth), JSON.stringify(standard.headers),
      JSON.stringify(options), Math.floor(Date.now() / 1000), id,
    ).run();
    let credentialId: string | undefined;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (apiKey) {
      credentialId = await createCredential(c.env, {
        providerId: id,
        label: typeof body.apiKeyLabel === "string" && body.apiKeyLabel.trim() ? body.apiKeyLabel.trim() : `${row.name} · 新 Key`,
        authType: "api_key",
        secret: apiKey,
      });
      c.executionCtx.waitUntil(refreshCredentialModels(c.env, credentialId).then(() => undefined));
    }
    await syncProviderModelRoutes(c.env, id, selections, routingWeight);
    await Promise.all([c.env.CONFIG_CACHE.delete(`provider:${id}`), recordProviderSuccess(c.env, id), invalidateModelCache(c.env)]);
    return c.json({ ok: true, credentialId: credentialId ?? null, routeCount: selections.reduce((sum, item) => sum + item.endpoints.length, 0) });
  });

  app.delete("/api/providers/:id", async (c) => {
    const id = c.req.param("id");
    if (isBuiltinChannelId(id)) throw new GatewayError(400, "BUILTIN_CHANNEL_READ_ONLY", "内置渠道不可删除");
    const exists = await c.env.DB.prepare("SELECT id FROM providers WHERE id=?").bind(id).first<{ id: string }>();
    if (!exists) throw new GatewayError(404, "PROVIDER_NOT_FOUND", "Provider not found");
    await c.env.DB.prepare("DELETE FROM providers WHERE id=?").bind(id).run();
    await Promise.all([c.env.CONFIG_CACHE.delete(`provider:${id}`), invalidateModelCache(c.env)]);
    return c.json({ ok: true });
  });

  app.get("/api/settings/proxy", async (c) => c.json({ data: await getSystemProxySummary(c.env) }));
  app.put("/api/settings/proxy", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const proxyUrl = typeof body.proxyUrl === "string" ? body.proxyUrl.trim() : "";
    if (proxyUrl) validateProxyUrl(proxyUrl);
    await upsertSystemProxyUrl(c.env, proxyUrl);
    return c.json({ ok: true, data: await getSystemProxySummary(c.env) });
  });
  app.delete("/api/settings/proxy", async (c) => {
    await deleteSystemProxyUrl(c.env);
    return c.json({ ok: true, data: await getSystemProxySummary(c.env) });
  });
  app.post("/api/settings/proxy/test", async (c) => c.json(await testSystemProxy(c.env)));

  app.get("/api/providers/:id/proxy", async (c) => c.json({ data: await getProviderProxySummary(c.env, c.req.param("id")) }));
  app.put("/api/providers/:id/proxy", async (c) => {
    const providerId = c.req.param("id");
    const exists = await c.env.DB.prepare("SELECT id FROM providers WHERE id=?").bind(providerId).first<{ id: string }>();
    if (!exists) throw new GatewayError(404, "PROVIDER_NOT_FOUND", "Provider not found");
    const body = await c.req.json<Record<string, unknown>>();
    const proxyUrl = typeof body.proxyUrl === "string" ? body.proxyUrl.trim() : "";
    if (proxyUrl) validateProxyUrl(proxyUrl);
    await upsertProviderProxyConfig(c.env, { providerId, proxyUrl });
    return c.json({ ok: true, data: await getProviderProxySummary(c.env, providerId) });
  });
  app.delete("/api/providers/:id/proxy", async (c) => {
    await deleteProviderProxyConfig(c.env, c.req.param("id"));
    return c.json({ ok: true, data: await getProviderProxySummary(c.env, c.req.param("id")) });
  });
  app.post("/api/providers/:id/proxy/test", async (c) => {
    const provider = await getProvider(c.env, c.req.param("id"));
    return c.json(await testProviderProxy(c.env, provider));
  });

  app.get("/api/models", async (c) => {
    const [data, publicModels] = await Promise.all([listDiscoveredModels(c.env), listModels(c.env)]);
    return c.json({ data, public: publicModels });
  });
  app.post("/api/models/refresh", async (c) => c.json({ data: await refreshAllModels(c.env) }));
  app.post("/api/models/refresh/provider/:id", async (c) => c.json({ data: await refreshProviderModels(c.env, c.req.param("id")) }));
  app.post("/api/models/refresh/credential/:id", async (c) => c.json(await refreshCredentialModels(c.env, c.req.param("id"))));

  app.get("/api/quotas", async (c) => c.json({ data: await listQuotaSnapshots(c.env) }));
  app.post("/api/quotas/refresh", async (c) => c.json({ data: await refreshAllQuotas(c.env) }));
  app.post("/api/quotas/refresh/:id", async (c) => c.json(await refreshCredentialQuota(c.env, c.req.param("id"))));

  app.get("/api/integrations/opencode", async (c) => {
    const models = await listModels(c.env);
    const origin = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
    const modelEntries = Object.fromEntries(models.map((model) => {
      const id = String(model.id);
      return [id, { name: typeof model.display_name === "string" ? model.display_name : id }];
    }));
    const firstModel = models[0]?.id;
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        cflareapi: {
          npm: "@ai-sdk/openai-compatible",
          name: "CFlareAPI",
          options: { baseURL: `${origin}/v1`, apiKey: "{env:CFLARE_API_KEY}" },
          models: modelEntries,
        },
      },
    };
    if (firstModel) config.model = `cflareapi/${String(firstModel)}`;
    return c.json({ config, baseUrl: `${origin}/v1`, modelCount: models.length, defaultModel: firstModel ?? null });
  });

  app.get("/api/credentials", async (c) => {
    const provider = c.req.query("provider");
    const sql = provider ? "SELECT * FROM credentials WHERE provider_id=? ORDER BY created_at DESC" : "SELECT * FROM credentials ORDER BY created_at DESC";
    const result = provider
      ? await c.env.DB.prepare(sql).bind(provider).all<CredentialRow>()
      : await c.env.DB.prepare(sql).all<CredentialRow>();
    const data = result.results.map(({ secret_ciphertext, refresh_ciphertext, metadata_json, ...row }) => ({
      ...row,
      has_refresh_token: Boolean(refresh_ciphertext),
      key_hint: secret_ciphertext ? "AES-GCM" : "",
      metadata: parseJson<Record<string, unknown>>(metadata_json, {}),
    }));
    return c.json({ data });
  });
  app.post("/api/credentials", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const id = await createCredential(c.env, {
      providerId: stringValue(body.providerId, "providerId"),
      label: stringValue(body.label, "label"),
      authType: typeof body.authType === "string" ? body.authType : "api_key",
      secret: stringValue(body.secret, "secret"),
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : undefined,
      expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : undefined,
      enabled: body.enabled !== false && body.enabled !== 0,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      weight: typeof body.weight === "number" ? body.weight : undefined,
      maxConcurrency: typeof body.maxConcurrency === "number" ? body.maxConcurrency : undefined,
      metadata: jsonObject(body.metadata),
    });
    c.executionCtx.waitUntil(Promise.allSettled([
      refreshCredentialModels(c.env, id), refreshCredentialQuota(c.env, id),
    ]).then(() => undefined));
    return c.json({ id }, 201);
  });
  app.patch("/api/credentials/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const row = await c.env.DB.prepare("SELECT * FROM credentials WHERE id=?").bind(c.req.param("id")).first<CredentialRow>();
    if (!row) throw new GatewayError(404, "CREDENTIAL_NOT_FOUND", "Credential not found");
    const secretCiphertext = typeof body.secret === "string" && body.secret
      ? await encryptSecret(body.secret, c.env.MASTER_KEY)
      : row.secret_ciphertext;
    const refreshCiphertext = typeof body.refreshToken === "string" && body.refreshToken
      ? await encryptSecret(body.refreshToken, c.env.MASTER_KEY)
      : row.refresh_ciphertext;
    const expiresAt = body.expiresAt === null
      ? null
      : typeof body.expiresAt === "number" ? Math.floor(body.expiresAt) : row.expires_at;
    await c.env.DB.prepare(
      `UPDATE credentials SET enabled=?, priority=?, weight=?, max_concurrency=?, label=?, secret_ciphertext=?,
       refresh_ciphertext=?, expires_at=?, metadata_json=?, updated_at=? WHERE id=?`,
    ).bind(
      optionalEnabled(body.enabled) ?? row.enabled,
      optionalNumber(body.priority) ?? row.priority,
      Math.max(1, optionalNumber(body.weight) ?? row.weight),
      Math.max(1, optionalNumber(body.maxConcurrency) ?? row.max_concurrency),
      typeof body.label === "string" && body.label.trim() ? body.label.trim() : row.label,
      secretCiphertext,
      refreshCiphertext,
      expiresAt,
      body.metadata ? JSON.stringify(jsonObject(body.metadata)) : row.metadata_json,
      Math.floor(Date.now()/1000), row.id,
    ).run();
    await Promise.all([c.env.CONFIG_CACHE.delete(`provider:${row.provider_id}`), invalidateModelCache(c.env)]);
    c.executionCtx.waitUntil(Promise.allSettled([
      refreshCredentialModels(c.env, row.id), refreshCredentialQuota(c.env, row.id),
    ]).then(() => undefined));
    return c.json({ ok: true });
  });
  app.delete("/api/credentials/:id", async (c) => {
    const row = await c.env.DB.prepare("SELECT provider_id FROM credentials WHERE id=?")
      .bind(c.req.param("id")).first<{ provider_id: string }>();
    if (!row) throw new GatewayError(404, "CREDENTIAL_NOT_FOUND", "Credential not found");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM discovered_models WHERE credential_id=?").bind(c.req.param("id")),
      c.env.DB.prepare("DELETE FROM quota_snapshots WHERE credential_id=?").bind(c.req.param("id")),
      c.env.DB.prepare("DELETE FROM credentials WHERE id=?").bind(c.req.param("id")),
    ]);
    await Promise.all([c.env.CONFIG_CACHE.delete(`provider:${row.provider_id}`), invalidateModelCache(c.env)]);
    return c.json({ ok: true });
  });

  app.get("/api/auth-files", async (c) => {
    const result = await c.env.DB.prepare("SELECT * FROM credentials ORDER BY provider_id,created_at DESC").all<CredentialRow>();
    return c.json({ data: result.results.map(({ secret_ciphertext, refresh_ciphertext, metadata_json, ...row }) => ({
      ...row, has_refresh_token: Boolean(refresh_ciphertext), key_hint: secret_ciphertext ? "AES-GCM" : "",
      metadata: parseJson<Record<string, unknown>>(metadata_json, {}),
    })) });
  });
  app.post("/api/auth-files/import", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const auth = jsonObject(body.auth);
    const access = [auth.access_token, auth.token, auth.api_key, body.secret].find((value) => typeof value === "string" && value.length > 0);
    if (typeof access !== "string") throw new GatewayError(400, "AUTH_FILE_INVALID", "auth.access_token, auth.token or auth.api_key is required", "invalid_request_error");
    const refresh = typeof auth.refresh_token === "string" ? auth.refresh_token : undefined;
    let expiresAt: number | undefined;
    if (typeof auth.expires_at === "number") expiresAt = auth.expires_at > 10_000_000_000 ? Math.floor(auth.expires_at / 1000) : Math.floor(auth.expires_at);
    else if (typeof auth.expire_time === "number") expiresAt = auth.expire_time > 10_000_000_000 ? Math.floor(auth.expire_time / 1000) : Math.floor(auth.expire_time);
    const metadata = { ...auth };
    delete metadata.access_token; delete metadata.token; delete metadata.api_key; delete metadata.refresh_token;
    const id = await createCredential(c.env, {
      providerId: stringValue(body.providerId, "providerId"),
      label: typeof body.label === "string" ? body.label : "imported auth file",
      authType: typeof body.authType === "string" ? body.authType : "oauth",
      secret: access, refreshToken: refresh, expiresAt,
      enabled: body.enabled !== 0 && body.enabled !== false,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      weight: typeof body.weight === "number" ? body.weight : undefined,
      maxConcurrency: typeof body.maxConcurrency === "number" ? body.maxConcurrency : undefined,
      metadata,
    });
    c.executionCtx.waitUntil(Promise.allSettled([
      refreshCredentialModels(c.env, id), refreshCredentialQuota(c.env, id),
    ]).then(() => undefined));
    return c.json({ id }, 201);
  });
  app.patch("/api/auth-files/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    await c.env.DB.prepare("UPDATE credentials SET enabled=COALESCE(?,enabled), updated_at=? WHERE id=?")
      .bind(optionalEnabled(body.enabled), Math.floor(Date.now()/1000), c.req.param("id")).run();
    await invalidateModelCache(c.env);
    if (body.enabled === true || body.enabled === 1) c.executionCtx.waitUntil(Promise.allSettled([
      refreshCredentialModels(c.env, c.req.param("id")), refreshCredentialQuota(c.env, c.req.param("id")),
    ]).then(() => undefined));
    return c.json({ ok: true });
  });

  app.get("/api/routes", async (c) => {
    const [result, providerResult] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM model_routes ORDER BY public_model,priority,created_at").all<ModelRouteRow>(),
      c.env.DB.prepare("SELECT id,enabled FROM providers").all<{ id: string; enabled: number }>(),
    ]);
    const providerEnabled = new Map(providerResult.results.map((row) => [row.id, row.enabled === 1]));
    const healthMap = await getProviderHealthMap(c.env, result.results.map((row) => row.provider_id));
    const data = await Promise.all(result.results.map(async (row) => {
      const availability = await listCredentialAvailabilityForModel(c.env, row.provider_id, row.upstream_model, row.endpoint);
      const availableCredentials = availability.filter((entry) => entry.available).length;
      const totalCredentials = availability.length;
      const health = healthMap[row.provider_id];
      const now = Date.now();
      let status: "ready" | "degraded" | "unavailable" = "ready";
      let reason: string | undefined;
      let retryAt: number | undefined;
      if (row.enabled !== 1) {
        status = "unavailable";
        reason = "该路由已停用";
      } else if (providerEnabled.get(row.provider_id) === false) {
        status = "unavailable";
        reason = "供应商或渠道已停用";
      } else if (health && health.disabledUntil > now) {
        status = "unavailable";
        reason = health.lastError ? `上游已熔断：${health.lastError}` : "上游连续失败，已临时熔断";
        retryAt = Math.floor(health.disabledUntil / 1000);
      } else if (availableCredentials === 0) {
        status = "unavailable";
        const blocked = availability.find((entry) => !entry.available);
        reason = blocked?.reason ?? "没有可用账号";
        retryAt = blocked?.retryAt;
      } else if (availableCredentials < totalCredentials || (health?.failures ?? 0) > 0) {
        status = "degraded";
        reason = availableCredentials < totalCredentials ? "部分账号因额度或冷却被摘除" : "上游近期有失败，仍在观察";
      }
      return {
        ...row,
        health: health ? {
          failures: health.failures,
          disabledUntil: health.disabledUntil,
          lastStatus: health.lastStatus,
          lastError: health.lastError,
        } : undefined,
        availability: { status, availableCredentials, totalCredentials, reason, retryAt },
      };
    }));
    return c.json({ data });
  });
  app.post("/api/routes/provider/:id/recover", async (c) => {
    await recordProviderSuccess(c.env, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/routes", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const id = crypto.randomUUID(); const now = Math.floor(Date.now()/1000);
    await c.env.DB.prepare(
      `INSERT INTO model_routes(id,public_model,provider_id,upstream_model,endpoint,enabled,priority,weight,options_json,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, stringValue(body.publicModel,"publicModel"), stringValue(body.providerId,"providerId"),
      stringValue(body.upstreamModel,"upstreamModel"), (typeof body.endpoint === "string" ? body.endpoint : "chat") as GatewayEndpoint,
      optionalEnabled(body.enabled) ?? 1, typeof body.priority === "number" ? body.priority : 100,
      typeof body.weight === "number" ? body.weight : 1, JSON.stringify(jsonObject(body.options)), now, now,
    ).run();
    await invalidateModelCache(c.env);
    return c.json({ id }, 201);
  });
  app.patch("/api/routes/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const row = await c.env.DB.prepare("SELECT * FROM model_routes WHERE id=?").bind(c.req.param("id")).first<ModelRouteRow>();
    if (!row) throw new GatewayError(404, "ROUTE_NOT_FOUND", "Model route not found");
    await c.env.DB.prepare(
      `UPDATE model_routes SET enabled=?,priority=?,weight=?,public_model=?,provider_id=?,upstream_model=?,endpoint=?,options_json=?,updated_at=? WHERE id=?`,
    ).bind(
      optionalEnabled(body.enabled) ?? row.enabled,
      optionalNumber(body.priority) ?? row.priority,
      Math.max(1, optionalNumber(body.weight) ?? row.weight),
      typeof body.publicModel === "string" && body.publicModel.trim() ? body.publicModel.trim() : row.public_model,
      typeof body.providerId === "string" && body.providerId.trim() ? body.providerId.trim() : row.provider_id,
      typeof body.upstreamModel === "string" && body.upstreamModel.trim() ? body.upstreamModel.trim() : row.upstream_model,
      typeof body.endpoint === "string" ? body.endpoint : row.endpoint,
      body.options ? JSON.stringify(jsonObject(body.options)) : row.options_json,
      Math.floor(Date.now()/1000), row.id,
    ).run();
    await invalidateModelCache(c.env);
    return c.json({ ok:true });
  });
  app.delete("/api/routes/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM model_routes WHERE id=?").bind(c.req.param("id")).run();
    await invalidateModelCache(c.env);
    return c.json({ok:true});
  });

  app.get("/api/keys", async (c) => {
    const result = await c.env.DB.prepare("SELECT * FROM gateway_keys ORDER BY created_at DESC").all<GatewayKeyRow>();
    return c.json({ data: result.results.map(({key_hash,...row})=>row) });
  });
  app.post("/api/keys", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    return c.json(await createGatewayKey(c.env, {
      name: stringValue(body.name,"name"), rpm: typeof body.rpm === "number" ? body.rpm : undefined,
      maxConcurrency: typeof body.maxConcurrency === "number" ? body.maxConcurrency : undefined,
      monthlyTokenLimit: typeof body.monthlyTokenLimit === "number" ? body.monthlyTokenLimit : undefined,
      allowedModels: Array.isArray(body.allowedModels) ? body.allowedModels.filter((v):v is string=>typeof v==="string") : undefined,
      expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : undefined,
    }), 201);
  });
  app.patch("/api/keys/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const row = await c.env.DB.prepare("SELECT * FROM gateway_keys WHERE id=?").bind(c.req.param("id")).first<GatewayKeyRow>();
    if (!row) throw new GatewayError(404, "GATEWAY_KEY_NOT_FOUND", "Gateway key not found");
    const expiresAt = body.expiresAt === null
      ? null
      : typeof body.expiresAt === "number" ? Math.floor(body.expiresAt) : row.expires_at;
    await c.env.DB.prepare(
      `UPDATE gateway_keys SET name=?,enabled=?,rpm=?,max_concurrency=?,monthly_token_limit=?,allowed_models_json=?,expires_at=?,updated_at=? WHERE id=?`,
    ).bind(
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : row.name,
      optionalEnabled(body.enabled) ?? row.enabled,
      Math.max(1, optionalNumber(body.rpm) ?? row.rpm),
      Math.max(1, optionalNumber(body.maxConcurrency) ?? row.max_concurrency),
      Math.max(0, optionalNumber(body.monthlyTokenLimit) ?? row.monthly_token_limit),
      Array.isArray(body.allowedModels) ? JSON.stringify(body.allowedModels.filter((value): value is string => typeof value === "string")) : row.allowed_models_json,
      expiresAt,
      Math.floor(Date.now()/1000), row.id,
    ).run();
    return c.json({ok:true});
  });
  app.delete("/api/keys/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM gateway_keys WHERE id=?").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });

  app.get("/api/prices", async (c) => {
    const result = await c.env.DB.prepare(
      "SELECT * FROM model_prices ORDER BY provider_id, model",
    ).all();
    return c.json({ data: result.results });
  });
  app.put("/api/prices", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const providerId = stringValue(body.providerId, "providerId");
    const model = stringValue(body.model, "model");
    const { input, output, cache } = priceInput(body);
    await c.env.DB.prepare(
      `INSERT INTO model_prices(provider_id,model,input_micros_per_million,output_micros_per_million,cache_micros_per_million,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(provider_id,model) DO UPDATE SET
       input_micros_per_million=excluded.input_micros_per_million,
       output_micros_per_million=excluded.output_micros_per_million,
       cache_micros_per_million=excluded.cache_micros_per_million,
       updated_at=excluded.updated_at`,
    ).bind(providerId, model, input, output, cache, Math.floor(Date.now() / 1000)).run();
    return c.json({ ok: true });
  });
  app.delete("/api/prices", async (c) => {
    const providerId = stringValue(c.req.query("provider"), "provider");
    const model = stringValue(c.req.query("model"), "model");
    await c.env.DB.prepare("DELETE FROM model_prices WHERE provider_id=? AND model=?")
      .bind(providerId, model).run();
    return c.json({ ok: true });
  });
  app.put("/api/prices/:provider/:model", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const { input, output, cache } = priceInput(body);
    await c.env.DB.prepare(
      `INSERT INTO model_prices(provider_id,model,input_micros_per_million,output_micros_per_million,cache_micros_per_million,updated_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(provider_id,model) DO UPDATE SET
       input_micros_per_million=excluded.input_micros_per_million,
       output_micros_per_million=excluded.output_micros_per_million,
       cache_micros_per_million=excluded.cache_micros_per_million,
       updated_at=excluded.updated_at`,
    ).bind(
      c.req.param("provider"), decodeURIComponent(c.req.param("model")), input, output, cache, Math.floor(Date.now() / 1000),
    ).run();
    return c.json({ ok: true });
  });
  app.delete("/api/prices/:provider/:model", async (c) => {
    await c.env.DB.prepare("DELETE FROM model_prices WHERE provider_id=? AND model=?")
      .bind(c.req.param("provider"), decodeURIComponent(c.req.param("model"))).run();
    return c.json({ ok: true });
  });

  app.get("/api/logs", async (c) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(c.req.query("limit") ?? "50",10) || 50));
    const result = await c.env.DB.prepare("SELECT * FROM request_logs ORDER BY created_at DESC LIMIT ?").bind(limit).all();
    return c.json({data:result.results});
  });

  app.post("/api/oauth/:provider/start", async (c) => c.json(await startOAuth(c.env,c.req.param("provider"))));
  app.post("/api/oauth/:provider/poll", async (c) => {
    const body=await c.req.json<{sessionId:string}>();
    const result = await pollOAuth(c.env,c.req.param("provider"),body.sessionId);
    if (result.credentialId) c.executionCtx.waitUntil(Promise.allSettled([
      refreshCredentialModels(c.env, result.credentialId), refreshCredentialQuota(c.env, result.credentialId),
    ]).then(() => undefined));
    return c.json(result);
  });
  app.post("/api/oauth/:provider/exchange", async (c) => {
    const body=await c.req.json<{sessionId?:string;state?:string;code?:string;callbackUrl?:string}>();
    const result = await exchangeOAuthCode(c.env,c.req.param("provider"),body);
    if (result.credentialId) c.executionCtx.waitUntil(Promise.allSettled([
      refreshCredentialModels(c.env, result.credentialId), refreshCredentialQuota(c.env, result.credentialId),
    ]).then(() => undefined));
    return c.json(result);
  });

  app.onError((error,c)=>errorResponse(error));
  return app;
}
