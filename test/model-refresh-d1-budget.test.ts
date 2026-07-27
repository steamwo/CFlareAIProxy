import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/crypto";
import { base64UrlDecode, base64UrlEncode } from "../src/utils";
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

interface EnvControls {
  addCredential: (id: string, providerId: string) => void;
  markAttempted: (ids: string[]) => void;
}

async function createEnv(input: {
  ids: string[];
  providerFor: (id: string, index: number) => string;
}): Promise<{ env: Env; budget: Budget; resetBudget: () => void; controls: EnvControls }> {
  const masterKey = Buffer.alloc(32, 7).toString("base64");
  const ciphertext = await encryptSecret("token", masterKey);
  const ids = [...input.ids];
  const credentials = new Map<string, CredentialRow>();
  const providers = new Map<string, ProviderRow>();

  const addCredential = (id: string, providerId: string): void => {
    const index = credentials.size;
    ids.push(id);
    credentials.set(id, {
      id,
      provider_id: providerId,
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
    });
    if (!providers.has(providerId)) providers.set(providerId, providerRow(providerId, index));
  };
  ids.splice(0);
  for (const [index, id] of input.ids.entries()) addCredential(id, input.providerFor(id, index));

  const attempted = new Set<string>();
  const budget: Budget = { d1: 0, subrequests: 0, cacheDeletes: 0 };
  const resetBudget = (): void => {
    budget.d1 = 0;
    budget.subrequests = 0;
    budget.cacheDeletes = 0;
  };
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
      if (sql.includes("AND COALESCE(a.model_attempted_at, 0) < ?")) {
        const providerId = String(binds[0]);
        const limit = Number(binds.at(-1) ?? MODEL_REFRESH_BATCH_LIMIT);
        const eligible = ids.filter((id) => {
          const credential = credentials.get(id);
          return credential?.provider_id === providerId && credential.enabled === 1 && !attempted.has(id);
        });
        return { results: eligible.slice(0, limit).map((id) => ({ id })), success: true, meta: {} } as never;
      }
      if (sql.includes("SELECT c.id FROM credentials c")) {
        const limit = Number(binds[0] ?? MODEL_REFRESH_BATCH_LIMIT);
        return { results: ids.slice(0, limit).map((id) => ({ id })), success: true, meta: {} } as never;
      }
      return { results: [], success: true, meta: {} } as never;
    },
    async first() {
      spendD1();
      if (sql.includes("COUNT(*) AS total") && sql.includes("AS remaining")) {
        const providerId = String(binds[1]);
        const enabled = ids.filter((id) => {
          const credential = credentials.get(id);
          return credential?.provider_id === providerId && credential.enabled === 1;
        });
        return {
          total: enabled.length,
          remaining: enabled.filter((id) => !attempted.has(id)).length,
        } as never;
      }
      if (sql.includes("SELECT enabled FROM providers WHERE id='opencode'")) return { enabled: 0 } as never;
      if (sql.includes("SELECT * FROM credentials WHERE id = ?")) return credentials.get(String(binds[0])) as never;
      if (sql.includes("SELECT * FROM providers WHERE id = ? AND enabled = 1")) return providers.get(String(binds[0])) as never;
      if (sql.includes("FROM provider_proxies WHERE provider_id=?")) return null;
      if (sql.includes("FROM system_settings WHERE key='system_proxy_url'")) return null;
      return null;
    },
    async run() {
      spendD1();
      if (sql.includes("INSERT INTO credential_refresh_attempts")) {
        for (const id of JSON.parse(String(binds[1] ?? "[]")) as string[]) attempted.add(id);
      }
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
  return {
    env,
    budget,
    resetBudget,
    controls: {
      addCredential,
      markAttempted: (credentialIds) => {
        for (const id of credentialIds) attempted.add(id);
      },
    },
  };
}

describe("model refresh budgets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the worst-case full sweep below D1 and total Free-plan limits", async () => {
    const ids = Array.from({ length: MODEL_REFRESH_BATCH_LIMIT }, (_, index) => `c${index + 1}`);
    const { env, budget } = await createEnv({
      ids,
      providerFor: (_id, index) => `p${index + 1}`,
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
    const { env, budget } = await createEnv({ ids, providerFor: () => "p1" });
    const page = await runProviderModelRefreshPage(env, "p1");
    expect(page.processed).toBe(MODEL_REFRESH_BATCH_LIMIT);
    expect(page.processedInCycle).toBe(MODEL_REFRESH_BATCH_LIMIT);
    expect(page.total).toBe(16);
    expect(page.remaining).toBe(16 - MODEL_REFRESH_BATCH_LIMIT);
    expect(page.complete).toBe(false);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.results).toHaveLength(MODEL_REFRESH_BATCH_LIMIT);
    expect(budget.d1).toBeLessThanOrEqual(50);
    expect(budget.subrequests).toBeLessThanOrEqual(50);
    expect(budget.cacheDeletes).toBe(3);
  });

  it("finishes one 16-account provider cycle across four cursor pages", async () => {
    const ids = Array.from({ length: 16 }, (_, index) => `c${index + 1}`);
    const { env, budget, resetBudget } = await createEnv({ ids, providerFor: () => "p1" });
    const pages = [];
    let cursor: string | undefined;
    do {
      resetBudget();
      const page = await runProviderModelRefreshPage(env, "p1", MODEL_REFRESH_BATCH_LIMIT, cursor);
      pages.push(page);
      expect(budget.d1).toBeLessThanOrEqual(50);
      expect(budget.subrequests).toBeLessThanOrEqual(50);
      cursor = page.nextCursor;
    } while (!pages.at(-1)?.complete);

    expect(pages.map((page) => page.processed)).toEqual([5, 5, 5, 1]);
    expect(pages.map((page) => page.processedInCycle)).toEqual([5, 10, 15, 16]);
    expect(pages.map((page) => page.remaining)).toEqual([11, 6, 1, 0]);
    expect(pages.map((page) => page.total)).toEqual([16, 16, 16, 16]);
    expect(pages.map((page) => page.complete)).toEqual([false, false, false, true]);
    expect(pages.at(-1)?.nextCursor).toBeUndefined();
    expect(new Set(pages.flatMap((page) => page.results.map((result) => result.credentialId)))).toEqual(new Set(ids));
  });
  it("recomputes dynamic progress when additions and external completions overlap", async () => {
    const ids = Array.from({ length: 16 }, (_, index) => `c${index + 1}`);
    const { env, controls, resetBudget } = await createEnv({ ids, providerFor: () => "p1" });
    const first = await runProviderModelRefreshPage(env, "p1");
    expect(first.processedInCycle).toBe(5);
    expect(first.remaining).toBe(11);

    controls.markAttempted(["c6", "c7"]);
    controls.addCredential("c17", "p1");
    controls.addCredential("c18", "p1");
    controls.addCredential("c19", "p1");
    resetBudget();

    const second = await runProviderModelRefreshPage(
      env,
      "p1",
      MODEL_REFRESH_BATCH_LIMIT,
      first.nextCursor,
    );
    expect(second.processed).toBe(5);
    expect(second.total).toBe(19);
    expect(second.processedInCycle).toBe(12);
    expect(second.remaining).toBe(7);
  });

  it("rejects a structurally valid cursor whose signed cutoff was modified", async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `c${index + 1}`);
    const { env } = await createEnv({ ids, providerFor: () => "p1" });
    const first = await runProviderModelRefreshPage(env, "p1");
    const [payload, signature] = String(first.nextCursor).split(".");
    if (!payload || !signature) throw new Error("cursor envelope missing");
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
      attemptedBefore: number;
    };
    const modifiedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
      ...parsed,
      attemptedBefore: parsed.attemptedBefore + 3600,
    })));

    await expect(runProviderModelRefreshPage(
      env,
      "p1",
      MODEL_REFRESH_BATCH_LIMIT,
      `${modifiedPayload}.${signature}`,
    )).rejects.toMatchObject({
      status: 400,
      code: "MODEL_REFRESH_CURSOR_INVALID",
    });
  });

  it("continues an existing provider cycle with MASTER_KEY_PREVIOUS after rotation", async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `c${index + 1}`);
    const { env } = await createEnv({ ids, providerFor: () => "p1" });
    const previousMasterKey = env.MASTER_KEY;
    const first = await runProviderModelRefreshPage(env, "p1");
    expect(first.processed).toBe(MODEL_REFRESH_BATCH_LIMIT);
    expect(first.nextCursor).toEqual(expect.any(String));

    Object.assign(env, {
      MASTER_KEY: Buffer.alloc(32, 8).toString("base64"),
      MASTER_KEY_PREVIOUS: previousMasterKey,
    });

    const second = await runProviderModelRefreshPage(
      env,
      "p1",
      MODEL_REFRESH_BATCH_LIMIT,
      first.nextCursor,
    );
    expect(second.processed).toBe(1);
    expect(second.processedInCycle).toBe(6);
    expect(second.remaining).toBe(0);
    expect(second.complete).toBe(true);
    expect(second.nextCursor).toBeUndefined();
    expect(second.results.map((result) => result.credentialId)).toEqual(["c6"]);
  });

});