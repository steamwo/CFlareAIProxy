import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAdminApp } from "./admin";
import { AccountPool } from "./account-pool";
import { authenticateGatewayKey, insertUsage, listModels } from "./db";
import { GatewayError, errorResponse } from "./errors";
import { exchangeOAuthCode } from "./oauth";
import { ensureOpenCodeAnonymousModels, refreshCredentialModels } from "./models";
import { refreshCredentialQuota } from "./quota";
import { proxyGeneration } from "./proxy";
import { RateLimiter } from "./rate-limiter";
import type { Env, UsageEvent } from "./types";
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
    return c.json({ object: "list", data: await listModels(c.env, allowedModels) });
  } catch (error) {
    return errorResponse(error);
  }
});

app.post("/v1/responses", (c) => proxyGeneration(c, "responses"));
app.post("/v1/chat/completions", (c) => proxyGeneration(c, "chat"));
app.post("/v1/completions", (c) => proxyGeneration(c, "completions"));

app.get("/", (c) => c.redirect("/admin", 302));
// createAdminApp() already owns the /admin base path. Registering it at /
// keeps the final paths explicit and makes /admin work with or without a slash.
app.route("/", createAdminApp());

// Optional callback for providers that allow an HTTPS Worker redirect URI.
// Codex's seeded configuration uses the bundled localhost callback helper instead.
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
