import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/crypto";
import { MODEL_REFRESH_BATCH_LIMIT, runModelRefreshSweep, runProviderModelRefreshPage } from "../src/models";
import type { CredentialRow, Env, ProviderRow } from "../src/types";

interface Budget {
  d1: number;
  subrequests: number;
  cacheDeletes: number;
}

function providerRow(id: string, index = 0): ProviderRow {
  return {
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
  };
}

async function createEnv(input: {
  ids: string[];
  providerFor: (id: string, index: number) => string;
  globalSelection?: boolean;
  total?: number;
}): Promise<{ env: Env; budget: Budget }> {
  const masterKey = Buffer.alloc(32, 7).toString("base64");
  const ciphertext = await encryptSecret("token", masterKey);
  const credentials = new Map<string, CredentialRow>(input.ids.map((id, index) => [id, {
    id,
    provider_id: input.providerFor(id, index),
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
  const providers = new Map<string, ProviderRow>();
  for (const [index, id] of input.ids.entries()) {
    const providerId = input.providerFor(id, index);
    if (!providers.has(providerId)) providers.set(providerId, providerRow(providerId, index));
  }
  const budget: Budget = { d1: 0, subrequests: 0, cacheDeletes: 0 };
  const spendD1 = (count = 1): void => {
    budget.d1 += count;
    budget.subrequests += count;
    if (budget.d1 > 50) throw new Error(`D1 query limit exceeded at ${budget.d1}`);
    if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
  };

  const statement = (sql: string, binds: unknown[] = []): D1PreparedStatement => ({
    bind: (...args: unknown[]) => statement(sql, args),
    async all() {
      spendD1();
      if (sql.includes("SELECT c.id FROM credentials c")) {
        return { results: input.ids.map((id) => ({ id })), success: true, meta: {} } as never;
      }
      if (sql.includes("(SELECT COUNT(*) FROM credentials total")) {
        const limit = Number(binds[2] ?? MODEL_REFRESH_BATCH_LIMIT);
        return {
          results: input.ids.slice(0, limit).map((id) => ({ id, total: input.total ?? input.ids.length })),
          success: true,
          meta: {},
        } as never;
      }
      return { results: [], success: true, meta: {} } as never;
    },
    async first() {
      spendD1();
      if (sql.includes("SELECT enabled FROM providers WHERE id='opencode'")) return { enabled: 0 } as never;
      if (sql.includes("SELECT * FROM credentials WHERE id = ?")) return credentials.get(String(binds[0])) as never;
      if (sql.includes("SELECT * FROM providers WHERE id = ? AND enabled = 1")) return providers.get(String(binds[0])) as never;
      if (sql.includes("FROM provider_proxies WHERE provider_id=?")) return null;
      if (sql.includes("FROM system_settings WHERE key='system_proxy_url'")) return null;
      return null;
    },
    async run() {
      spendD1();
      return { success: true, meta: { changes: 1 } } as never;
    },
    async raw() {
      throw new Error("not used");
    },
  } as D1PreparedStatement);

  const DB = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: D1PreparedStatement[]) {
      spendD1(statements.length);
      return statements.map(() => ({ success: true, meta: {} }));
    },
  } as unknown as D1Database;

  vi.stubGlobal("fetch", vi.fn(async () => {
    budget.subrequests += 1;
    if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
    return new Response(JSON.stringify({ data: [{ id: "model-1", name: "Model 1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));

  const env = {
    DB,
    MASTER_KEY: masterKey,
    CONFIG_CACHE: {
      delete: async () => {
        budget.cacheDeletes += 1;
        budget.subrequests += 1;
        if (budget.subrequests > 50) throw new Error(`subrequest limit exceeded at ${budget.subrequests}`);
      },
    } as unknown as KVNamespace,
  } as Env;
  return { env, budget };
}

describe("model refresh budgets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the worst-case full sweep below D1 and total Free-plan limits", async () => {
    const ids = Array.from({ length: MODEL_REFRESH_BATCH_LIMIT }, (_, index) => `c${index + 1}`);
    const { env, budget } = await createEnv({
      ids,
      providerFor: (_id, index) => `p${index + 1}`,
      globalSelection: true,
    });
    const results = await runModelRefreshSweep(env);
    expect(results).toHaveLength(MODEL_REFRESH_BATCH_LIMIT);
    expect(results.every((result) => result.count === 1 && !result.error)).toBe(true);
    expect(budget.d1).toBeLessThanOrEqual(50);
    expect(budget.subrequests).toBeLessThanOrEqual(50);
    expect(budget.cacheDeletes).toBe(3);
  });

  it("limits a provider refresh to one coordinated safe page", async () => {
    const ids = Array.from({ length: 16 }, (_, index) => `c${index + 1}`);
    const { env, budget } = await createEnv({ ids, providerFor: () => "p1", total: ids.length });
    const page = await runProviderModelRefreshPage(env, "p1");
    expect(page.processed).toBe(MODEL_REFRESH_BATCH_LIMIT);
    expect(page.total).toBe(16);
    expect(page.remaining).toBe(16 - MODEL_REFRESH_BATCH_LIMIT);
    expect(page.results).toHaveLength(MODEL_REFRESH_BATCH_LIMIT);
    expect(budget.d1).toBeLessThanOrEqual(50);
    expect(budget.subrequests).toBeLessThanOrEqual(50);
    expect(budget.cacheDeletes).toBe(3);
  });
});
