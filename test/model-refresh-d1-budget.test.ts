import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/crypto";
import { MODEL_REFRESH_BATCH_LIMIT, runModelRefreshSweep } from "../src/models";
import type { CredentialRow, Env, ProviderRow } from "../src/types";

describe("model refresh D1 budget", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("completes the worst-case default batch below the Free-plan 50-query limit", async () => {
    const masterKey = Buffer.alloc(32, 7).toString("base64");
    const ciphertext = await encryptSecret("token", masterKey);
    const ids = Array.from({ length: MODEL_REFRESH_BATCH_LIMIT }, (_, index) => `c${index + 1}`);
    const credentials = new Map<string, CredentialRow>(ids.map((id, index) => [id, {
      id,
      provider_id: `p${index + 1}`,
      label: id,
      auth_type: "api_key",
      secret_ciphertext: ciphertext,
      refresh_ciphertext: null,
      expires_at: null,
      enabled: 1,
      priority: 0,
      weight: 1,
      max_concurrency: 1,
      metadata_json: "{}",
      last_error: null,
      last_used_at: null,
      created_at: index,
      updated_at: index,
    }]));
    const providers = new Map<string, ProviderRow>(ids.map((_, index) => {
      const id = `p${index + 1}`;
      return [id, {
        id,
        name: id,
        kind: "openai-compatible",
        base_url: `https://${id}.example.test`,
        enabled: 1,
        pool_strategy: "round_robin",
        endpoints_json: JSON.stringify({ models: "/models", chat: "/chat/completions" }),
        auth_json: "{}",
        headers_json: "{}",
        options_json: "{}",
        created_at: index,
        updated_at: index,
      }];
    }));

    let queries = 0;
    const spend = (count = 1): void => {
      queries += count;
      if (queries > 50) throw new Error(`D1 query limit exceeded at ${queries}`);
    };

    const statement = (sql: string, binds: unknown[] = []): D1PreparedStatement => ({
      bind: (...args: unknown[]) => statement(sql, args),
      async all() {
        spend();
        if (sql.includes("SELECT c.id FROM credentials c")) {
          return { results: ids.map((id) => ({ id })), success: true, meta: {} } as never;
        }
        return { results: [], success: true, meta: {} } as never;
      },
      async first() {
        spend();
        if (sql.includes("SELECT enabled FROM providers WHERE id='opencode'")) return { enabled: 0 } as never;
        if (sql.includes("SELECT * FROM credentials WHERE id = ?")) return credentials.get(String(binds[0])) as never;
        if (sql.includes("SELECT * FROM providers WHERE id = ? AND enabled = 1")) return providers.get(String(binds[0])) as never;
        if (sql.includes("FROM provider_proxies WHERE provider_id=?")) return null;
        if (sql.includes("FROM system_settings WHERE key='system_proxy_url'")) return null;
        return null;
      },
      async run() {
        spend();
        return { success: true, meta: { changes: 1 } } as never;
      },
      async raw() {
        throw new Error("not used");
      },
    } as D1PreparedStatement);

    const DB = {
      prepare: (sql: string) => statement(sql),
      async batch(statements: D1PreparedStatement[]) {
        spend(statements.length);
        return statements.map(() => ({ success: true, meta: {} }));
      },
    } as unknown as D1Database;

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "model-1", name: "Model 1" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const env = {
      DB,
      MASTER_KEY: masterKey,
      CONFIG_CACHE: { delete: async () => {} } as unknown as KVNamespace,
    } as Env;

    const results = await runModelRefreshSweep(env);
    expect(results).toHaveLength(MODEL_REFRESH_BATCH_LIMIT);
    expect(results.every((result) => result.count === 1 && !result.error)).toBe(true);
    expect(queries).toBeLessThanOrEqual(50);
  });
});
