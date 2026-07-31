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

describe("admin API authentication", () => {
  it("leaves exactly the four public endpoints reachable without a session", async () => {
    const app = createTestApp();

    // /api/version answers anonymously; the other three report their own 401 rather than
    // being rejected by the guard, which is what keeps the login flow usable.
    expect((await app.request("https://example.test/admin/api/version", {}, env)).status).toBe(200);
    expect((await app.request("https://example.test/admin/api/session", {}, env)).status).toBe(401);

    const logout = await app.request("https://example.test/admin/api/logout", { method: "POST" }, env);
    expect(logout.status).toBe(200);
  });

  it("keeps the public surface to exactly those four, whatever gets registered", async () => {
    // Enumerating Hono's own route table means a route added anywhere — before or after
    // the guard, in this file or another — is covered automatically. Asserting against a
    // hand-written list of paths would go stale the moment someone adds an endpoint.
    const adminApp = createAdminApp();
    const app = createTestApp();
    const seen = new Set<string>();
    const publicPaths: string[] = [];

    for (const route of adminApp.routes) {
      // Hono registers middleware as ALL /admin/api/*; only probe concrete handlers.
      if (route.path.includes("*") || seen.has(route.path)) continue;
      seen.add(route.path);
      const url = `https://example.test${route.path.replace(/:[^/]+/g, "probe")}`;
      const response = await app.request(url, { method: route.method === "ALL" ? "GET" : route.method }, env);
      if (response.status !== 401) publicPaths.push(`${route.method} ${route.path}`);
    }

    // /api/login and /api/session answer 401 of their own accord (bad credentials, no
    // session), so they are indistinguishable from a guarded route by status alone and
    // are covered by the dedicated test above instead.
    expect(seen.size).toBeGreaterThan(10);
    expect(publicPaths.sort()).toEqual([
      "GET /admin/api/version",
      "POST /admin/api/logout",
    ]);
  });

  it("protects the routes index.ts attaches after createAdminApp returns", async () => {
    // These live on the worker's real app, mounted after the factory hands the instance
    // back. Asserting through createAdminApp alone would be vacuous: the guard rejects
    // unregistered paths with 401 too, so a 401 there proves nothing about wiring.
    const { default: worker } = await import("./index");
    for (const path of ["/admin/api/settings/logging", "/admin/api/credentials/paged", "/admin/api/overview-v2"]) {
      const response = await worker.fetch(new Request(`https://example.test${path}`), env, {} as ExecutionContext);
      expect(response.status, `${path} must require a session`).toBe(401);
    }
  });

  it("does not let a trailing slash bypass the guard", async () => {
    const app = createTestApp();
    const response = await app.request("https://example.test/admin/api/channels/", {}, env);
    expect(response.status).toBe(401);
  });
});

describe("admin request bodies", () => {
  it("reports malformed JSON as 400 rather than 500", async () => {
    const app = createTestApp();
    const authed = { ...env, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "pw" } as Env;
    const login = await app.request("https://example.test/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "pw" }),
    }, authed);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    for (const body of ["{ not json", "[]", "\"a string\""]) {
      const response = await app.request("https://example.test/admin/api/channels/codex", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body,
      }, authed);
      expect(response.status, `body ${body} must be rejected as a client error`).toBe(400);
      const payload = await response.json() as { error?: { code?: string } };
      expect(payload.error?.code).toBe("INVALID_JSON");
    }
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
