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
