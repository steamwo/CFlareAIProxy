from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new))


replace_once(
    "src/models.ts",
    '''export interface ProviderModelRefreshPage {
  providerId: string;
  results: ModelRefreshResult[];
  processed: number;
  total: number;
  remaining: number;
}

type ProviderProxyCache = Map<string, Promise<ProviderProxyConfig | null>>;
''',
    '''export interface ProviderModelRefreshPage {
  providerId: string;
  results: ModelRefreshResult[];
  /** Credentials attempted by this request. */
  processed: number;
  /** Credentials covered since this cycle started, including work completed by another sweep. */
  processedInCycle: number;
  total: number;
  remaining: number;
  complete: boolean;
  /** Opaque continuation token. Omitted once every credential in the cycle has been attempted. */
  nextCursor?: string;
}

interface ProviderModelRefreshCursor {
  version: 1;
  providerId: string;
  attemptedBefore: number;
  total: number;
  completed: number;
}

function encodeProviderModelRefreshCursor(cursor: ProviderModelRefreshCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

function decodeProviderModelRefreshCursor(
  providerId: string,
  cursor?: string,
): ProviderModelRefreshCursor | undefined {
  if (!cursor) return undefined;
  try {
    if (cursor.length > 1024) throw new Error("cursor is too long");
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ProviderModelRefreshCursor>;
    if (
      parsed.version !== 1
      || parsed.providerId !== providerId
      || !Number.isInteger(parsed.attemptedBefore)
      || Number(parsed.attemptedBefore) <= 0
      || !Number.isInteger(parsed.total)
      || Number(parsed.total) < 0
      || !Number.isInteger(parsed.completed)
      || Number(parsed.completed) < 0
      || Number(parsed.completed) > Number(parsed.total)
    ) throw new Error("invalid cursor payload");
    return parsed as ProviderModelRefreshCursor;
  } catch {
    throw new GatewayError(400, "MODEL_REFRESH_CURSOR_INVALID", "Invalid provider model refresh cursor");
  }
}

type ProviderProxyCache = Map<string, Promise<ProviderProxyConfig | null>>;
''',
)

replace_once(
    "src/models.ts",
    '''export async function runProviderModelRefreshPage(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
): Promise<ProviderModelRefreshPage> {
  const boundedLimit = Math.max(1, Math.min(MODEL_REFRESH_BATCH_LIMIT, Math.floor(limit) || MODEL_REFRESH_BATCH_LIMIT));
  const provider = await getProvider(env, providerId);
  const page = await env.DB.prepare(
    `SELECT c.id,
       (SELECT COUNT(*) FROM credentials total WHERE total.provider_id=? AND total.enabled=1) AS total
     FROM credentials c
     LEFT JOIN credential_refresh_attempts a ON a.credential_id=c.id
     WHERE c.provider_id=? AND c.enabled=1
     ORDER BY COALESCE(a.model_attempted_at, 0) ASC, c.priority, c.created_at
     LIMIT ?`,
  ).bind(providerId, providerId, boundedLimit).all<{ id: string; total: number }>();
  const results: ModelRefreshResult[] = [];
  const providerCache: ProviderCache = new Map([[providerId, Promise.resolve(provider)]]);
  const proxyCache: ProviderProxyCache = new Map();
  if (providerId === "opencode") {
    results.push(await refreshOpenCodeAnonymousModels(env, providerCache, proxyCache, false));
  }
  for (let index = 0; index < page.results.length; index += MODEL_REFRESH_CONCURRENCY) {
    const group = page.results.slice(index, index + MODEL_REFRESH_CONCURRENCY);
    await markModelRefreshAttempts(env, group.map((row) => row.id));
    results.push(...await Promise.all(
      group.map((row) => refreshCredentialModels(env, row.id, providerCache, proxyCache, false)),
    ));
  }
  if (results.some((item) => item.count > 0)) await invalidateModelCache(env);
  const total = Number(page.results[0]?.total ?? 0);
  return {
    providerId,
    results,
    processed: page.results.length,
    total,
    remaining: Math.max(0, total - page.results.length),
  };
}
''',
    '''export async function runProviderModelRefreshPage(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
  cursor?: string,
): Promise<ProviderModelRefreshPage> {
  const boundedLimit = Math.max(1, Math.min(MODEL_REFRESH_BATCH_LIMIT, Math.floor(limit) || MODEL_REFRESH_BATCH_LIMIT));
  const existingCycle = decodeProviderModelRefreshCursor(providerId, cursor);
  const attemptedBefore = existingCycle?.attemptedBefore ?? Math.floor(Date.now() / 1000);
  const provider = await getProvider(env, providerId);
  const page = await env.DB.prepare(
    `SELECT c.id,
       (SELECT COUNT(*)
        FROM credentials total
        LEFT JOIN credential_refresh_attempts total_a ON total_a.credential_id=total.id
        WHERE total.provider_id=? AND total.enabled=1
          AND COALESCE(total_a.model_attempted_at, 0) < ?) AS eligible
     FROM credentials c
     LEFT JOIN credential_refresh_attempts a ON a.credential_id=c.id
     WHERE c.provider_id=? AND c.enabled=1
       AND COALESCE(a.model_attempted_at, 0) < ?
     ORDER BY COALESCE(a.model_attempted_at, 0) ASC, c.priority, c.created_at
     LIMIT ?`,
  ).bind(providerId, attemptedBefore, providerId, attemptedBefore, boundedLimit)
    .all<{ id: string; eligible: number }>();
  const eligibleBefore = Number(page.results[0]?.eligible ?? 0);
  let total = existingCycle?.total ?? eligibleBefore;
  let completedBefore = existingCycle?.completed ?? 0;
  const expectedRemaining = Math.max(0, total - completedBefore);
  if (eligibleBefore > expectedRemaining) {
    total += eligibleBefore - expectedRemaining;
  } else if (eligibleBefore < expectedRemaining) {
    completedBefore += expectedRemaining - eligibleBefore;
  }

  const results: ModelRefreshResult[] = [];
  const providerCache: ProviderCache = new Map([[providerId, Promise.resolve(provider)]]);
  const proxyCache: ProviderProxyCache = new Map();
  if (providerId === "opencode" && !existingCycle) {
    results.push(await refreshOpenCodeAnonymousModels(env, providerCache, proxyCache, false));
  }
  for (let index = 0; index < page.results.length; index += MODEL_REFRESH_CONCURRENCY) {
    const group = page.results.slice(index, index + MODEL_REFRESH_CONCURRENCY);
    await markModelRefreshAttempts(env, group.map((row) => row.id));
    results.push(...await Promise.all(
      group.map((row) => refreshCredentialModels(env, row.id, providerCache, proxyCache, false)),
    ));
  }
  if (results.some((item) => item.count > 0)) await invalidateModelCache(env);

  const processed = page.results.length;
  const remaining = Math.max(0, eligibleBefore - processed);
  const completed = Math.min(total, completedBefore + processed);
  const complete = remaining === 0;
  return {
    providerId,
    results,
    processed,
    processedInCycle: completed,
    total,
    remaining,
    complete,
    nextCursor: complete ? undefined : encodeProviderModelRefreshCursor({
      version: 1,
      providerId,
      attemptedBefore,
      total,
      completed,
    }),
  };
}
''',
)

replace_once(
    "src/models.ts",
    '''export async function refreshProviderModels(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
): Promise<ProviderModelRefreshPage> {
  const namespace = env.RATE_LIMITER;
  if (!namespace) return runProviderModelRefreshPage(env, providerId, limit);
  const stub = namespace.get(namespace.idFromName(MODEL_REFRESH_DO_NAME));
  const response = await stub.fetch(`https://do.internal/models/refresh/provider/${encodeURIComponent(providerId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit }),
  });
''',
    '''export async function refreshProviderModels(
  env: Env,
  providerId: string,
  limit = MODEL_REFRESH_BATCH_LIMIT,
  cursor?: string,
): Promise<ProviderModelRefreshPage> {
  decodeProviderModelRefreshCursor(providerId, cursor);
  const namespace = env.RATE_LIMITER;
  if (!namespace) return runProviderModelRefreshPage(env, providerId, limit, cursor);
  const stub = namespace.get(namespace.idFromName(MODEL_REFRESH_DO_NAME));
  const response = await stub.fetch(`https://do.internal/models/refresh/provider/${encodeURIComponent(providerId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit, cursor }),
  });
''',
)

replace_once(
    "src/rate-limiter.ts",
    '''      const payload = await request.json() as { limit?: unknown };
      const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
        ? Math.max(1, Math.floor(payload.limit))
        : undefined;
      return Response.json(await this.modelRefreshGate.run(
        `provider:${providerId}`,
        () => runProviderModelRefreshPage(this.environment, providerId, limit),
      ));
''',
    '''      const payload = await request.json() as { limit?: unknown; cursor?: unknown };
      const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
        ? Math.max(1, Math.floor(payload.limit))
        : undefined;
      const cursor = typeof payload.cursor === "string" && payload.cursor ? payload.cursor : undefined;
      return Response.json(await this.modelRefreshGate.run(
        `provider:${providerId}:${cursor ?? "start"}`,
        () => runProviderModelRefreshPage(this.environment, providerId, limit, cursor),
      ));
''',
)

replace_once(
    "src/admin.ts",
    '''  app.post("/api/models/refresh/provider/:id", async (c) => {
    const page = await refreshProviderModels(c.env, c.req.param("id"));
    return c.json({
      data: page.results,
      providerId: page.providerId,
      processed: page.processed,
      total: page.total,
      remaining: page.remaining,
      complete: page.remaining === 0,
    });
  });
''',
    '''  app.post("/api/models/refresh/provider/:id", async (c) => {
    const page = await refreshProviderModels(c.env, c.req.param("id"), undefined, c.req.query("cursor") || undefined);
    return c.json({
      data: page.results,
      providerId: page.providerId,
      processed: page.processed,
      processedInCycle: page.processedInCycle,
      total: page.total,
      remaining: page.remaining,
      complete: page.complete,
      nextCursor: page.nextCursor ?? null,
    });
  });
''',
)

write("test/model-refresh-d1-budget.test.ts", '''import { afterEach, describe, expect, it, vi } from "vitest";
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
}): Promise<{ env: Env; budget: Budget; resetBudget: () => void }> {
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
      if (sql.includes("SELECT c.id FROM credentials c")) {
        return { results: input.ids.map((id) => ({ id })), success: true, meta: {} } as never;
      }
      if (sql.includes("AS eligible")) {
        const eligible = input.ids.filter((id) => !attempted.has(id));
        const limit = Number(binds.at(-1) ?? MODEL_REFRESH_BATCH_LIMIT);
        return {
          results: eligible.slice(0, limit).map((id) => ({ id, eligible: eligible.length })),
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
  return { env, budget, resetBudget };
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
});
''')

replace_once(
    "test/model-refresh-gate.test.ts",
    '''      : Response.json({ providerId: "p1", results: [], processed: 0, total: 0, remaining: 0 }));
''',
    '''      : Response.json({
          providerId: "p1",
          results: [],
          processed: 0,
          processedInCycle: 0,
          total: 0,
          remaining: 0,
          complete: true,
        }));
''',
)

print("Applied provider refresh cursor-cycle fix")
