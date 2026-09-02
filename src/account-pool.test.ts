import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPool } from "./account-pool";
import { buildSessionAffinityKey } from "./session-affinity";
import type { Env, PoolCandidate, PoolLease } from "./types";

type SqlValue = string | number | bigint | Uint8Array | null;

class TestSqlStorage {
  constructor(private readonly database: DatabaseSync) {}

  exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] } {
    if (bindings.length === 0 && query.includes(";")) {
      this.database.exec(query);
      return { toArray: () => [] };
    }

    const statement = this.database.prepare(query);
    if (/^(SELECT|WITH|PRAGMA)\b/i.test(query.trim())) {
      const rows = statement.all(...bindings) as unknown[];
      return { toArray: () => rows };
    }
    statement.run(...bindings);
    return { toArray: () => [] };
  }
}

const PROVIDER_ID = "provider-1";
const GATEWAY_KEY_ID = "gateway-key-1";
const AFFINITY_TTL_MS = 15 * 60_000;
const CANDIDATES: PoolCandidate[] = [
  { id: "credential-a", priority: 0, weight: 1, maxConcurrency: 1, enabled: true },
  { id: "credential-b", priority: 0, weight: 1, maxConcurrency: 1, enabled: true },
];

async function createPool(): Promise<{ pool: AccountPool; close(): void }> {
  const database = new DatabaseSync(":memory:");
  let initialization = Promise.resolve<unknown>(undefined);
  const ctx = {
    storage: { sql: new TestSqlStorage(database) },
    blockConcurrencyWhile(callback: () => Promise<unknown>) {
      initialization = callback();
      return initialization;
    },
  } as unknown as DurableObjectState;
  const pool = new AccountPool(ctx, {} as Env);
  await initialization;
  return { pool, close: () => database.close() };
}

async function post<T>(pool: AccountPool, path: string, body: unknown): Promise<T> {
  const response = await pool.fetch(new Request(`https://account-pool.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `AccountPool ${path} failed`);
  return payload;
}

function acquire(
  pool: AccountPool,
  sessionKey: string | string[],
  candidates: PoolCandidate[] = CANDIDATES,
): Promise<PoolLease> {
  return post(pool, "/acquire", {
    providerId: PROVIDER_ID,
    strategy: "round_robin",
    candidates,
    sessionKey,
  });
}

function release(
  pool: AccountPool,
  lease: PoolLease,
  result: { success: boolean; statusCode?: number; cooldownMs?: number } = { success: true },
): Promise<{ ok: true }> {
  return post(pool, "/release", { leaseId: lease.leaseId, ...result });
}

async function aliasKeys(): Promise<[promptCacheKey: string, conversationKey: string]> {
  const request = new Request("https://gateway.test/v1/responses");
  const promptCacheKey = await buildSessionAffinityKey(
    request,
    { prompt_cache_key: "prompt-cache-1" },
    GATEWAY_KEY_ID,
    PROVIDER_ID,
  );
  const conversationKey = await buildSessionAffinityKey(
    request,
    { conversation: { id: "conversation-1" } },
    GATEWAY_KEY_ID,
    PROVIDER_ID,
  );
  const combined = await buildSessionAffinityKey(
    request,
    { prompt_cache_key: "prompt-cache-1", conversation: { id: "conversation-1" } },
    GATEWAY_KEY_ID,
    PROVIDER_ID,
  );
  if (typeof promptCacheKey !== "string" || typeof conversationKey !== "string") {
    throw new Error("Expected individual AccountPool affinity keys");
  }
  expect(combined).toEqual([promptCacheKey, conversationKey]);
  return [promptCacheKey, conversationKey];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountPool session affinity aliases", () => {
  it("reuses the initial credential through either Codex alias", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const [promptCacheKey, conversationKey] = await aliasKeys();

    const initial = await acquire(pool, [promptCacheKey, conversationKey]);
    expect(initial.credentialId).toBe("credential-a");
    await release(pool, initial);

    const byConversation = await acquire(pool, conversationKey);
    expect(byConversation.credentialId).toBe(initial.credentialId);
    await release(pool, byConversation);

    const byPromptCache = await acquire(pool, promptCacheKey);
    expect(byPromptCache.credentialId).toBe(initial.credentialId);
    await release(pool, byPromptCache);
    close();
  });

  it("returns to normal selection after aliases expire", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const [promptCacheKey, conversationKey] = await aliasKeys();

    const initial = await acquire(pool, [promptCacheKey, conversationKey]);
    expect(initial.credentialId).toBe("credential-a");
    await release(pool, initial);

    vi.advanceTimersByTime(AFFINITY_TTL_MS + 1);
    const afterExpiry = await acquire(pool, conversationKey);
    expect(afterExpiry.credentialId).toBe("credential-b");
    await release(pool, afterExpiry);
    close();
  });

  const invalidatedCandidateScenarios: Array<[string, PoolCandidate[]]> = [
    ["disabled", [{ ...CANDIDATES[0]!, enabled: false }, CANDIDATES[1]!]],
    ["removed", [CANDIDATES[1]!]],
  ];

  it.each(invalidatedCandidateScenarios)("ignores an alias for a %s credential", async (_state, candidates) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const [promptCacheKey] = await aliasKeys();

    const initial = await acquire(pool, promptCacheKey);
    expect(initial.credentialId).toBe("credential-a");
    await release(pool, initial);

    const replacement = await acquire(pool, promptCacheKey, candidates);
    expect(replacement.credentialId).toBe("credential-b");
    await release(pool, replacement);
    close();
  });

  it("ignores an alias while its credential is cooling down", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const [promptCacheKey] = await aliasKeys();

    const initial = await acquire(pool, promptCacheKey);
    expect(initial.credentialId).toBe("credential-a");
    await release(pool, initial, { success: false, statusCode: 429, cooldownMs: 60_000 });

    const replacement = await acquire(pool, promptCacheKey);
    expect(replacement.credentialId).toBe("credential-b");
    await release(pool, replacement);
    close();
  });

  it("cools down HTTP 402 credentials and rebinds affinity to the replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const [promptCacheKey] = await aliasKeys();

    const initial = await acquire(pool, promptCacheKey);
    expect(initial.credentialId).toBe("credential-a");
    await release(pool, initial, { success: false, statusCode: 402, cooldownMs: 60_000 });

    const replacement = await acquire(pool, promptCacheKey);
    expect(replacement.credentialId).toBe("credential-b");
    await release(pool, replacement);

    vi.advanceTimersByTime(60_001);
    const rebound = await acquire(pool, promptCacheKey);
    expect(rebound.credentialId).toBe("credential-b");
    await release(pool, rebound);
    close();
  });
});
