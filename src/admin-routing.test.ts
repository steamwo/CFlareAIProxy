import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAdminApp } from "./admin";
import type { Env } from "./types";

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/", createAdminApp());
  return app;
}

const env = {
  ADMIN_TOKEN: "test-admin-token",
  APP_NAME: "CFlareAIProxy",
} as Env;

/** Records every KV key the handler drops so the test can assert on cache invalidation. */
function createCacheSpy() {
  const deleted: string[] = [];
  return {
    deleted,
    kv: {
      get: async () => null,
      put: async () => undefined,
      delete: async (key: string) => { deleted.push(key); },
    } as unknown as KVNamespace,
  };
}

describe("admin route mounting", () => {
  it("serves admin API routes under a single /admin prefix", async () => {
    const app = createTestApp();

    const versionResponse = await app.request("https://example.test/admin/api/version", {}, env);
    expect(versionResponse.status).toBe(200);

    const sessionResponse = await app.request("https://example.test/admin/api/session", {}, env);
    expect(sessionResponse.status).toBe(401);
  });

  it("does not register the accidental doubled /admin/admin prefix", async () => {
    const app = createTestApp();
    const response = await app.request("https://example.test/admin/admin/api/session", {}, env);
    expect(response.status).toBe(404);
  });
});

describe("built-in channel updates", () => {
  /** Signs in through the real handler so the test exercises the deployed auth path. */
  async function signedInCookie(app: ReturnType<typeof createTestApp>, testEnv: Env): Promise<string> {
    const response = await app.request("https://example.test/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "pw" }),
    }, testEnv);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    return cookie.split(";")[0] ?? "";
  }

  it("drops the public model cache when a channel is toggled", async () => {
    const app = createTestApp();
    const cache = createCacheSpy();
    const statements: string[] = [];
    const channelEnv = {
      ...env,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "pw",
      CONFIG_CACHE: cache.kv,
      DB: {
        prepare(sql: string) {
          statements.push(sql);
          return { bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) };
        },
      } as unknown as D1Database,
    } as Env;

    const cookie = await signedInCookie(app, channelEnv);
    const response = await app.request("https://example.test/admin/api/channels/codex", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ enabled: false }),
    }, channelEnv);

    expect(response.status).toBe(200);
    expect(statements.some((sql) => sql.includes("UPDATE providers"))).toBe(true);
    // listModels joins providers ON p.enabled=1 and caches the result, so a disabled
    // channel keeps being advertised by /v1/models until these keys are dropped.
    expect(cache.deleted).toEqual(expect.arrayContaining([
      "models:public",
      "models:public:v2",
      "models:public:v3",
    ]));
    // `provider:<id>` was never written or read by anything; deleting it was a dead KV write.
    expect(cache.deleted.some((key) => key.startsWith("provider:"))).toBe(false);
  });
});
