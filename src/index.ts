import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAdminApp } from "./admin";
import { AccountPool } from "./account-pool";
import {
  deleteAlertSettings, getAlertSettings, sendAlert, updateAlertSettings, validateWebhookUrl,
} from "./alerts";
import { BUILTIN_CHANNELS } from "./builtin-channels";
import { buildCodexClientModelsResponse } from "./codex-client-models";
import { authenticateGatewayKey, getCredential, listModels } from "./db";
import { GatewayError, errorResponse } from "./errors";
import { getLoggingSettings, runtimeLog, updateLoggingSettings } from "./logging-settings";
import { enrichModelsWithCapabilities } from "./model-capabilities";
import { exchangeOAuthCode } from "./oauth";
import { ensureOpenCodeAnonymousModels, refreshCredentialModels } from "./models";
import { proxyGeneration } from "./proxy-v2";
import { refreshCredentialQuota } from "./quota";
import { RateLimiter } from "./rate-limiter";
import type { CredentialRow, Env, LogLevel, QuotaSnapshot, QuotaSnapshotRow, UsageQueueEvent } from "./types";
import { persistUsageQueueBatch } from "./usage-storage";
import { parseJson } from "./utils";

export { AccountPool, RateLimiter };

const app = new Hono<{ Bindings: Env }>({ strict: false });
const ACCOUNT_POOL_PROVIDER_IDS = BUILTIN_CHANNELS.map((channel) => channel.id);
const ACTIVITY_BUCKET_SECONDS = 5 * 60;
const ACTIVITY_BUCKET_COUNT = 24;
const LOG_LEVELS = new Set<LogLevel>(["error", "warn", "info", "debug"]);

app.use("/v1/*", cors({
  origin: "*",
  allowHeaders: ["authorization", "content-type", "x-session-id", "x-conversation-id", "x-request-id"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  exposeHeaders: ["x-request-id"],
  maxAge: 86400,
}));

app.get("/health", async (c) => {
  let database: "ok" | "schema_missing" | "error" = "ok";
  try {
    const schema = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='providers'",
    ).first<{ name: string }>();
    if (!schema) database = "schema_missing";
  } catch (error) {
    database = /no such table/i.test(error instanceof Error ? error.message : String(error)) ? "schema_missing" : "error";
  }
  return c.json({
    status: database === "ok" ? "ok" : "degraded",
    service: c.env.APP_NAME ?? "CFlareAIProxy",
    database,
    time: new Date().toISOString(),
  }, database === "ok" ? 200 : 503);
});

app.get("/v1/models", async (c) => {
  const authorization = c.req.header("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return errorResponse(new GatewayError(401, "AUTHENTICATION_ERROR", "Missing Bearer API key", "authentication_error"));
  try {
    const gatewayKey = await authenticateGatewayKey(c.env, match[1]);
    const allowedModels = parseJson<string[]>(gatewayKey.allowed_models_json, []);
    await ensureOpenCodeAnonymousModels(c.env).catch(() => null);
    const enriched = await enrichModelsWithCapabilities(c.env, await listModels(c.env, allowedModels));
    if (c.req.query("client_version") !== undefined) return c.json(await buildCodexClientModelsResponse(c.env, enriched));
    return c.json({ object: "list", data: enriched });
  } catch (error) {
    return errorResponse(error);
  }
});

app.post("/v1/responses", (c) => proxyGeneration(c, "responses"));
app.post("/v1/chat/completions", (c) => proxyGeneration(c, "chat"));
app.post("/v1/completions", (c) => proxyGeneration(c, "completions"));

app.get("/", (c) => c.redirect("/admin", 302));

const adminApp = createAdminApp();

adminApp.get("/api/settings/logging", async (c) => c.json({ data: await getLoggingSettings(c.env) }));
adminApp.put("/api/settings/logging", async (c) => {
  const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const level = typeof body.level === "string" && LOG_LEVELS.has(body.level as LogLevel)
    ? body.level as LogLevel
    : undefined;
  if (body.level !== undefined && !level) {
    throw new GatewayError(400, "LOG_LEVEL_INVALID", "日志级别必须为 error、warn、info 或 debug", "invalid_request_error");
  }
  const requestLoggingEnabled = typeof body.requestLoggingEnabled === "boolean"
    ? body.requestLoggingEnabled
    : undefined;
  return c.json({
    ok: true,
    data: await updateLoggingSettings(c.env, { requestLoggingEnabled, level }),
  });
});

adminApp.get("/api/settings/alerts", async (c) => c.json({ data: await getAlertSettings(c.env) }));
adminApp.put("/api/settings/alerts", async (c) => {
  const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  if (body.webhookUrl !== undefined && typeof body.webhookUrl !== "string") {
    throw new GatewayError(400, "ALERT_WEBHOOK_INVALID", "告警 Webhook 必须是字符串", "invalid_request_error");
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    throw new GatewayError(400, "ALERT_ENABLED_INVALID", "告警开关必须是布尔值", "invalid_request_error");
  }
  if (body.dedupeWindowMinutes !== undefined && typeof body.dedupeWindowMinutes !== "number") {
    throw new GatewayError(400, "ALERT_WINDOW_INVALID", "去重窗口必须是分钟数", "invalid_request_error");
  }
  const webhookUrl = typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : undefined;
  if (webhookUrl) validateWebhookUrl(webhookUrl);
  return c.json({
    ok: true,
    data: await updateAlertSettings(c.env, {
      ...(webhookUrl === undefined ? {} : { webhookUrl }),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.dedupeWindowMinutes === "number" ? { dedupeWindowMinutes: body.dedupeWindowMinutes } : {}),
    }),
  });
});
adminApp.delete("/api/settings/alerts", async (c) => c.json({ ok: true, data: await deleteAlertSettings(c.env) }));
adminApp.post("/api/settings/alerts/test", async (c) => {
  // The operator is waiting on the result, so this one send is awaited and both gates are
  // bypassed — a test that reported success without leaving the Worker would be useless.
  const result = await sendAlert(c.env, {
    type: "alert_test",
    severity: "info",
    target: "admin_console",
    title: "CFlareAIProxy 告警连通性测试",
    detail: "这是一条来自管理台的测试告警，收到即表示 Webhook 配置正确。",
    context: { source: "admin_console" },
  }, { bypassDedupe: true, bypassEnabled: true });
  return c.json({ ok: result.delivered, data: result });
});

adminApp.get("/api/overview-v2", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const since = now - 24 * 60 * 60;
  const availabilitySince = now - 7 * 24 * 60 * 60;
  const [providerCounts, credentialCounts, routeCounts, keyCounts, usage, providerUsage, modelUsage, availability] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM providers").first<{ total: number; enabled: number | null }>(),
    c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled, SUM(CASE WHEN last_error IS NOT NULL AND last_error<>'' THEN 1 ELSE 0 END) errors FROM credentials").first<{ total: number; enabled: number | null; errors: number | null }>(),
    c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM model_routes").first<{ total: number; enabled: number | null }>(),
    c.env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM gateway_keys").first<{ total: number; enabled: number | null }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(requests),0) requests,
        COALESCE(SUM(successes),0) successes,
        COALESCE(SUM(total_tokens),0) tokens,
        COALESCE(SUM(cost_micros),0) cost_micros,
        COALESCE(SUM(latency_sum_ms)*1.0/NULLIF(SUM(requests),0),0) average_latency_ms,
        COALESCE(SUM(first_token_sum_ms)*1.0/NULLIF(SUM(first_token_samples),0),0) average_first_token_ms
       FROM request_activity_5m WHERE bucket>=?`,
    ).bind(since).first<{ requests: number; successes: number; tokens: number; cost_micros: number; average_latency_ms: number; average_first_token_ms: number }>(),
    c.env.DB.prepare(
      `SELECT provider_id, COALESCE(SUM(requests),0) requests, COALESCE(SUM(total_tokens),0) tokens
       FROM request_activity_5m WHERE bucket>=? GROUP BY provider_id ORDER BY requests DESC LIMIT 10`,
    ).bind(since).all<{ provider_id: string; requests: number; tokens: number }>(),
    c.env.DB.prepare(
      `SELECT public_model, COALESCE(SUM(requests),0) requests, COALESCE(SUM(total_tokens),0) tokens
       FROM request_activity_5m WHERE bucket>=? GROUP BY public_model ORDER BY requests DESC LIMIT 10`,
    ).bind(since).all<{ public_model: string; requests: number; tokens: number }>(),
    c.env.DB.prepare(
      `SELECT CAST(bucket/3600 AS INTEGER)*3600 AS bucket,
        COALESCE(SUM(requests),0) requests,
        COALESCE(SUM(successes),0) successes,
        COALESCE(SUM(latency_sum_ms)*1.0/NULLIF(SUM(requests),0),0) average_latency_ms
       FROM request_activity_5m WHERE bucket>=?
       GROUP BY CAST(bucket/3600 AS INTEGER) ORDER BY bucket`,
    ).bind(availabilitySince).all<{ bucket: number; requests: number; successes: number; average_latency_ms: number }>(),
  ]);
  const requests = Number(usage?.requests ?? 0);
  const successes = Number(usage?.successes ?? 0);
  return c.json({
    service: c.env.APP_NAME ?? "CFlareAIProxy",
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
      tokens: Number(usage?.tokens ?? 0),
      costMicros: Number(usage?.cost_micros ?? 0),
      averageLatencyMs: Number(usage?.average_latency_ms ?? 0),
      averageFirstTokenMs: Number(usage?.average_first_token_ms ?? 0),
    },
    providerUsage: providerUsage.results,
    modelUsage: modelUsage.results,
    availability: availability.results.map((row) => ({
      bucket: Number(row.bucket),
      requests: Number(row.requests),
      successes: Number(row.successes),
      successRate: Number(row.requests) > 0 ? Number(row.successes) / Number(row.requests) * 100 : 0,
      averageLatencyMs: Number(row.average_latency_ms ?? 0),
    })),
  });
});

adminApp.get("/api/auth-files/:id/export", async (c) => {
  const credential = await getCredential(c.env, c.req.param("id"));
  if (!ACCOUNT_POOL_PROVIDER_IDS.some((id) => id === credential.provider_id)) {
    throw new GatewayError(400, "AUTH_FILE_EXPORT_UNSUPPORTED", "仅内置渠道账号支持导出认证文件", "invalid_request_error");
  }
  const payload: Record<string, unknown> = {
    ...credential.metadata,
    type: credential.provider_id,
    provider_id: credential.provider_id,
    access_token: credential.secret,
  };
  if (credential.refreshToken) payload.refresh_token = credential.refreshToken;
  if (credential.expires_at !== null) payload.expires_at = credential.expires_at;
  const safeName = credential.label.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80)
    || credential.provider_id;
  c.header("content-disposition", `attachment; filename="${safeName}.json"`);
  return c.json(payload);
});

// Keep the original /credentials response backward-compatible for internal
// provider-key workflows. The account-pool page is intentionally limited to
// credentials belonging to fixed built-in channels; OpenAI-compatible provider
// keys remain managed from the provider configuration page.
adminApp.get("/api/credentials/paged", async (c) => {
  const queryInteger = (value: string | undefined, fallback: number, maximum: number): number => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
  };

  const requestedPage = queryInteger(c.req.query("page"), 1, 1_000_000);
  const pageSize = queryInteger(c.req.query("pageSize"), 6, 100);
  const provider = c.req.query("provider")?.trim() || "";
  if (provider && !ACCOUNT_POOL_PROVIDER_IDS.some((id) => id === provider)) {
    return c.json({ data: [], quotas: [], activity: {}, total: 0, page: 1, pageSize, pageCount: 1 });
  }

  const placeholders = ACCOUNT_POOL_PROVIDER_IDS.map(() => "?").join(",");
  const countStatement = provider
    ? c.env.DB.prepare("SELECT COUNT(*) AS total FROM credentials WHERE provider_id=?").bind(provider)
    : c.env.DB.prepare(`SELECT COUNT(*) AS total FROM credentials WHERE provider_id IN (${placeholders})`).bind(...ACCOUNT_POOL_PROVIDER_IDS);
  const count = await countStatement.first<{ total: number }>();
  const total = Number(count?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const offset = (page - 1) * pageSize;
  const dataStatement = provider
    ? c.env.DB.prepare("SELECT * FROM credentials WHERE provider_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(provider, pageSize, offset)
    : c.env.DB.prepare(`SELECT * FROM credentials WHERE provider_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...ACCOUNT_POOL_PROVIDER_IDS, pageSize, offset);
  const result = await dataStatement.all<CredentialRow>();
  const data = result.results.map(({ secret_ciphertext, refresh_ciphertext, metadata_json, ...row }) => ({
    ...row,
    metadata_json,
    has_refresh_token: Boolean(refresh_ciphertext),
    key_hint: secret_ciphertext ? "AES-GCM" : "",
    metadata: parseJson<Record<string, unknown>>(metadata_json, {}),
  }));

  let quotas: Array<QuotaSnapshotRow & { snapshot: QuotaSnapshot; credential_label: string; provider_name: string }> = [];
  let activity: Record<string, unknown> = {};
  if (data.length > 0) {
    const ids = data.map((row) => row.id);
    const bindings = ids.map(() => "?").join(",");
    const [quotaResult, activityResult] = await Promise.all([
      c.env.DB.prepare(
        `SELECT q.*,c.label AS credential_label,p.name AS provider_name
         FROM quota_snapshots q JOIN credentials c ON c.id=q.credential_id JOIN providers p ON p.id=q.provider_id
         WHERE q.credential_id IN (${bindings}) ORDER BY q.fetched_at DESC`,
      ).bind(...ids).all<QuotaSnapshotRow & { credential_label: string; provider_name: string }>(),
      c.env.DB.prepare(
        `SELECT credential_id,bucket,requests,successes,failures
         FROM request_activity_5m WHERE credential_id IN (${bindings}) AND bucket>=?
         ORDER BY bucket ASC`,
      ).bind(...ids, Math.floor(Date.now() / 1000) - ACTIVITY_BUCKET_SECONDS * ACTIVITY_BUCKET_COUNT)
        .all<{ credential_id: string; bucket: number; requests: number; successes: number; failures: number }>(),
    ]);
    quotas = quotaResult.results.map((row) => ({ ...row, snapshot: parseJson<QuotaSnapshot>(row.quota_json, { provider: row.provider_id, status: "unknown", windows: [], source: "configured" }) }));
    const buckets = new Map<string, Array<{ bucket: number; requests: number; successes: number; failures: number }>>();
    for (const row of activityResult.results) {
      const values = buckets.get(row.credential_id) ?? [];
      values.push({ bucket: Number(row.bucket), requests: Number(row.requests), successes: Number(row.successes), failures: Number(row.failures) });
      buckets.set(row.credential_id, values);
    }
    activity = Object.fromEntries(data.map((row) => [row.id, buckets.get(row.id) ?? []]));
  }
  return c.json({ data, quotas, activity, total, page, pageSize, pageCount });
});

// createAdminApp() already owns the /admin base path.
app.route("/", adminApp);

app.onError((error, c) => {
  runtimeLog({ requestLoggingEnabled: true, level: "error" }, "error", { event: "unhandled_error", error: error instanceof Error ? error.message : String(error) });
  return errorResponse(error);
});

/**
 * Mirrors `max_retries` in wrangler.jsonc. A message delivered for the (max_retries + 1)-th
 * time has no retry left, so a failure on that delivery is what actually sends it to the DLQ —
 * there is no DLQ consumer to observe it after the fact.
 */
const USAGE_QUEUE_MAX_RETRIES = 3;

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<UsageQueueEvent>, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await persistUsageQueueBatch(env, batch.messages.map((message) => message.body));
    } catch (error) {
      const attempts = Math.max(0, ...batch.messages.map((message) => message.attempts));
      if (attempts > USAGE_QUEUE_MAX_RETRIES) {
        const message = error instanceof Error ? error.message : String(error);
        // Dedupe target is the queue, not the batch: a broken D1 fails every batch, and one
        // notification per window is the useful signal.
        ctx.waitUntil(sendAlert(env, {
          type: "usage_queue_dlq",
          severity: "critical",
          target: batch.queue,
          title: `用量队列 ${batch.queue} 消息进入死信队列`,
          detail: `批次重试 ${attempts} 次后仍然失败，${batch.messages.length} 条用量记录将丢失，统计与计费数据会出现缺口。错误：${message}`,
          context: { queue: batch.queue, attempts, batchSize: batch.messages.length },
        }).then(() => undefined));
      }
      throw error;
    }
  },
};
