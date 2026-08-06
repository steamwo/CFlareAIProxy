import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPool } from "./account-pool";
import type { Env } from "./types";

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

interface LockResult {
  acquired: boolean;
  lockId?: string;
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

function lockRequest(credentialId: string, signal?: AbortSignal): Request {
  return new Request("https://account-pool.test/lock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credentialId, ttlMs: 60_000 }),
    signal,
  });
}

async function readLock(response: Response): Promise<LockResult> {
  expect(response.status).toBe(200);
  return response.json() as Promise<LockResult>;
}

async function unlock(pool: AccountPool, credentialId: string, lockId: string): Promise<void> {
  const response = await pool.fetch(new Request("https://account-pool.test/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credentialId, lockId }),
  }));
  expect(response.status).toBe(200);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountPool refresh locks", () => {
  it("grants exactly one owner for concurrent refresh attempts", async () => {
    const { pool, close } = await createPool();
    const results = await Promise.all([
      pool.fetch(lockRequest("credential-1")).then(readLock),
      pool.fetch(lockRequest("credential-1")).then(readLock),
    ]);

    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.filter((result) => !result.acquired)).toHaveLength(1);
    close();
  });

  it("keeps lock ownership after the acquiring request is cancelled", async () => {
    const { pool, close } = await createPool();
    const ownerController = new AbortController();
    const owner = await readLock(await pool.fetch(lockRequest("credential-1", ownerController.signal)));
    expect(owner.acquired).toBe(true);
    expect(owner.lockId).toBeTypeOf("string");

    // The refresh itself uses a separate bounded upstream signal. Cancelling the caller's
    // request signal must not release the Durable Object ownership record or let a second
    // request start another refresh with the same credential.
    ownerController.abort(new DOMException("Caller disconnected", "AbortError"));
    const contender = await readLock(await pool.fetch(lockRequest("credential-1")));
    expect(contender).toEqual({ acquired: false });

    await unlock(pool, "credential-1", owner.lockId!);
    const successor = await readLock(await pool.fetch(lockRequest("credential-1")));
    expect(successor.acquired).toBe(true);
    close();
  });
});
