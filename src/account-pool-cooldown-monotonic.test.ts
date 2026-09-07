import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPool } from "./account-pool";
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
      return { toArray: () => statement.all(...bindings) as unknown[] };
    }
    statement.run(...bindings);
    return { toArray: () => [] };
  }
}

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

async function request(pool: AccountPool, path: string, body: unknown): Promise<Response> {
  return pool.fetch(new Request(`https://account-pool.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function acquire(pool: AccountPool, candidates: PoolCandidate[]): Promise<PoolLease> {
  const response = await request(pool, "/acquire", {
    providerId: "provider-1",
    strategy: "round_robin",
    candidates,
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<PoolLease>;
}

async function release(
  pool: AccountPool,
  lease: PoolLease,
  cooldownMs: number,
): Promise<void> {
  const response = await request(pool, "/release", {
    leaseId: lease.leaseId,
    success: false,
    statusCode: 429,
    cooldownMs,
  });
  expect(response.ok).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountPool cooldown monotonicity", () => {
  it("does not shorten an active credential cooldown after a later failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const candidates: PoolCandidate[] = [
      { id: "credential-a", priority: 0, weight: 1, maxConcurrency: 2, enabled: true },
    ];

    // Keep two requests in flight so both failures can be reported at the same instant.
    const first = await acquire(pool, candidates);
    const second = await acquire(pool, candidates);

    await release(pool, first, 10 * 60_000);
    // Failure count makes this 2 seconds, still much shorter than the active 10-minute deadline.
    await release(pool, second, 1_000);

    vi.advanceTimersByTime(2_001);
    const stillCooling = await request(pool, "/acquire", {
      providerId: "provider-1",
      strategy: "round_robin",
      candidates,
      model: "gpt-test",
    });
    expect(stillCooling.status).toBe(400);
    await expect(stillCooling.json()).resolves.toMatchObject({
      error: expect.stringContaining("cooling down"),
    });

    vi.advanceTimersByTime(10 * 60_000 - 2_001 + 1);
    const recovered = await request(pool, "/acquire", {
      providerId: "provider-1",
      strategy: "round_robin",
      candidates,
    });
    expect(recovered.ok).toBe(true);
    close();
  });
});
