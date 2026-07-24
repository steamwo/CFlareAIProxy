import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAdminApp } from "./admin";
import { AccountPool } from "./account-pool";
import { authenticateGatewayKey, insertUsage, listModels } from "./db";
import { GatewayError, errorResponse } from "./errors";
import { enrichModelsWithCapabilities } from "./model-capabilities";
import { exchangeOAuthCode } from "./oauth";
import { ensureOpenCodeAnonymousModels, refreshCredentialModels } from "./models";
import { proxyGeneration } from "./proxy-v2";
import { refreshCredentialQuota } from "./quota";
import { RateLimiter } from "./rate-limiter";
import type { CredentialRow, Env, QuotaSnapshot, QuotaSnapshotRow, UsageEvent } from "./types";
import { parseJson } from "./utils";

export { AccountPool, RateLimiter };

const app = new Hono<{ Bindings: Env }>({ strict: false });

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
    const models = await listModels(c.env, allowedModels);
    return c.json({ object: "list", data: await enrichModelsWithCapabilities(c.env, models) });
  } catch (error) {
    return errorResponse(error);
  }
});

app.post("/v1/responses", (c) => proxyGeneration(c, "responses"));
app.post("/v1/chat/completions", (c) => proxyGeneration(c, "chat"));
app.post("/v1/completions", (c) => proxyGeneration(c, "completions"));

app.get("/", (c) => c.redirect("/admin", 302));

const adminApp = createAdminApp();

// Keep the original /credentials response backward-compatible while giving the
// account-pool UI a real D1-backed paginated query. The existing /api/* admin
// middleware on adminApp also protects routes registered after construction.
adminApp.get("/api/credentials/paged", async (c) => {
  const queryInteger = (value: string | undefined, fallback: number, maximum: number): number => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
  };

  const requestedPage = queryInteger(c.req.query("page"), 1, 1_000_000);
  const pageSize = queryInteger(c.req.query("pageSize"), 9, 100);
  const provider = c.req.query("provider")?.trim() || "";
  const countStatement = provider
    ? c.env.DB.prepare("SELECT COUNT(*) AS total FROM credentials WHERE provider_id=?").bind(provider)
    : c.env.DB.prepare("SELECT COUNT(*) AS total FROM credentials");
  const count = await countStatement.first<{ total: number }>();
  const total = Number(count?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const offset = (page - 1) * pageSize;
  const dataStatement = provider
    ? c.env.DB.prepare("SELECT * FROM credentials WHERE provider_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(provider, pageSize, offset)
    : c.env.DB.prepare("SELECT * FROM credentials ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(pageSize, offset);
  const result = await dataStatement.all<CredentialRow>();
  const data = result.results.map(({ secret_ciphertext, refresh_ciphertext, metadata_json, ...row }) => ({
    ...row,
    metadata_json,
    has_refresh_token: Boolean(refresh_ciphertext),
    key_hint: secret_ciphertext ? "AES-GCM" : "",
    metadata: parseJson<Record<string, unknown>>(metadata_json, {}),
  }));

  let quotas: Array<QuotaSnapshotRow & { snapshot: QuotaSnapshot; credential_label: string; provider_name: string }> = [];
  if (data.length) {
    const placeholders = data.map(() => "?").join(",");
    const quotaResult = await c.env.DB.prepare(
      `SELECT q.*, c.label AS credential_label, p.name AS provider_name
       FROM quota_snapshots q
       JOIN credentials c ON c.id=q.credential_id
       JOIN providers p ON p.id=q.provider_id
       WHERE q.credential_id IN (${placeholders})
       ORDER BY p.name,c.priority,c.created_at`,
    ).bind(...data.map((row) => row.id)).all<QuotaSnapshotRow & { credential_label: string; provider_name: string }>();
    quotas = quotaResult.results.map((row) => ({
      ...row,
      snapshot: parseJson<QuotaSnapshot>(row.quota_json, {
        provider: row.provider_id,
        status: row.status,
        windows: [],
        source: "configured",
      }),
    }));
  }

  return c.json({ data, quotas, total, page, pageSize, pageCount });
});

app.route("/", adminApp);

app.get("/oauth/callback/:provider", async (c) => {
  try {
    const result = await exchangeOAuthCode(c.env, c.req.param("provider"), {
      state: c.req.query("state"),
      code: c.req.query("code"),
      callbackUrl: c.req.url,
    });
    if (result.credentialId) {
      c.executionCtx.waitUntil(Promise.allSettled([
        refreshCredentialModels(c.env, result.credentialId),
        refreshCredentialQuota(c.env, result.credentialId),
      ]).then(() => undefined));
    }
    return c.html(`<!doctype html><meta charset="utf-8"><title>OAuth complete</title><body style="font-family:system-ui;padding:3rem"><h1>授权完成</h1><p>Credential ID: <code>${result.credentialId ?? "created"}</code></p><p>可以关闭此页面。</p></body>`);
  } catch (error) {
    const response = errorResponse(error);
    return new Response(await response.text(), { status: response.status, headers: { "content-type": "application/json; charset=utf-8" } });
  }
});

// A browser tab can keep an old Vite entry bundle open across deployments. If
// that bundle requests a fingerprinted route chunk which no longer exists,
// Workers Static Assets falls through to the Worker. Return a tiny valid module
// which refreshes the SPA shell instead of leaving navigation permanently stuck.
app.get("/admin/assets/*", (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (!pathname.endsWith(".js")) {
    return c.json({ error: { message: "Asset not found", type: "invalid_request_error", code: "ASSET_NOT_FOUND" } }, 404, {
      "cache-control": "no-store",
    });
  }

  const recoveryModule = `
const key = "cflare:chunk-reload-at";
const parameter = "__asset_reload";
const now = Date.now();
try {
  const previous = Number(window.sessionStorage.getItem(key)) || 0;
  if (now - previous > 30000) {
    window.sessionStorage.setItem(key, String(now));
    const url = new URL(window.location.href);
    url.searchParams.set(parameter, String(now));
    window.location.replace(url.toString());
  }
} catch {
  window.location.reload();
}
console.error("A stale CFlareAIProxy asset was requested; refreshing the application.", import.meta.url);
export default { render: () => null };
`;

  return new Response(recoveryModule, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

app.notFound((c) => c.json({ error: { message: "Not found", type: "invalid_request_error", code: "NOT_FOUND" } }, 404));
app.onError((error) => errorResponse(error));

const handler: ExportedHandler<Env, UsageEvent> = {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<UsageEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await insertUsage(env, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: "usage_insert_failed", request_id: message.body.requestId, error: error instanceof Error ? error.message : String(error) }));
        message.retry();
      }
    }
  },
};

export default handler;
