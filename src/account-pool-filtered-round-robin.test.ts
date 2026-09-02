import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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
    if (/^(SELECT|WITH|PRAGMA)\b/i.test(query.trim())) return { toArray: () => statement.all(...bindings) as unknown[] };
    statement.run(...bindings);
    return { toArray: () => [] };
  }
}

const ALL: PoolCandidate[] = ["a", "b", "c"].map((id) => ({ id, priority: 0, weight: 1, maxConcurrency: 1, enabled: true }));

async function createPool(): Promise<{ pool: AccountPool; close(): void }> {
  const database = new DatabaseSync(":memory:");
  let initialization: Promise<unknown> = Promise.resolve(undefined);
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

async function acquire(pool: AccountPool, candidates: PoolCandidate[] = ALL, sessionKey?: string): Promise<PoolLease> {
  const response = await pool.fetch(new Request("https://pool.test/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "provider", strategy: "round_robin", candidates, sessionKey }),
  }));
  const body = await response.json() as PoolLease & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "acquire failed");
  return body;
}

async function release(pool: AccountPool, lease: PoolLease): Promise<void> {
  const response = await pool.fetch(new Request("https://pool.test/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId: lease.leaseId, success: true }),
  }));
  expect(response.ok).toBe(true);
}

async function pick(pool: AccountPool, candidates: PoolCandidate[] = ALL, sessionKey?: string): Promise<string> {
  const lease = await acquire(pool, candidates, sessionKey);
  await release(pool, lease);
  return lease.credentialId;
}

describe("AccountPool filtered round robin", () => {
  it("continues from the lexical successor when the last-picked credential is filtered", async () => {
    const { pool, close } = await createPool();
    expect(await pick(pool)).toBe("a");
    expect(await pick(pool)).toBe("b");
    expect(await pick(pool, [ALL[0]!, ALL[2]!])).toBe("c");
    expect(await pick(pool, ALL)).toBe("a");
    close();
  });

  it("rotates evenly when the expected successor stays excluded", async () => {
    const { pool, close } = await createPool();
    expect(await pick(pool)).toBe("a");
    // Keep B filtered so the selector must continue around the credential ring instead of resetting the current slice.
    const withoutB = [ALL[0]!, ALL[2]!];
    const selected: string[] = [];
    for (let index = 0; index < 8; index += 1) selected.push(await pick(pool, withoutB));
    expect(selected).toEqual(["c", "a", "c", "a", "c", "a", "c", "a"]);
    close();
  });

  it("does not advance scheduler state on sticky affinity hits", async () => {
    const { pool, close } = await createPool();
    expect(await pick(pool, ALL, "session")).toBe("a");
    expect(await pick(pool, ALL, "session")).toBe("a");
    expect(await pick(pool, ALL)).toBe("b");
    close();
  });

  it("uses the first greater credential when a removed last-picked id is absent", async () => {
    const { pool, close } = await createPool();
    expect(await pick(pool)).toBe("a");
    expect(await pick(pool)).toBe("b");
    expect(await pick(pool, [ALL[0]!, ALL[2]!])).toBe("c");
    close();
  });
});
