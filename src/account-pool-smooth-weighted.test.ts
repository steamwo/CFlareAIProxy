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

const CANDIDATES: PoolCandidate[] = [
  { id: "credential-a", priority: 0, weight: 5, maxConcurrency: 1, enabled: true },
  { id: "credential-b", priority: 0, weight: 1, maxConcurrency: 1, enabled: true },
];

async function createPool(): Promise<{ pool: AccountPool; database: DatabaseSync; close(): void }> {
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
  return { pool, database, close: () => database.close() };
}

async function post<T>(pool: AccountPool, path: string, body: unknown): Promise<{ response: Response; data: T & { error?: string } }> {
  const response = await pool.fetch(new Request(`https://account-pool.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { response, data: await response.json() as T & { error?: string } };
}

async function acquire(
  pool: AccountPool,
  providerId = "provider-1",
  candidates: PoolCandidate[] = CANDIDATES,
  sessionKey?: string,
): Promise<PoolLease> {
  const { response, data } = await post<PoolLease>(pool, "/acquire", {
    providerId,
    strategy: "smooth_weighted",
    candidates,
    sessionKey,
  });
  if (!response.ok) throw new Error(data.error ?? "acquire failed");
  return data;
}

async function release(pool: AccountPool, lease: PoolLease, success = true, cooldownMs?: number): Promise<void> {
  const { response, data } = await post<{ ok: boolean }>(pool, "/release", {
    leaseId: lease.leaseId,
    success,
    statusCode: success ? 200 : 429,
    cooldownMs,
  });
  if (!response.ok) throw new Error(data.error ?? "release failed");
}

async function selections(pool: AccountPool, count: number, providerId = "provider-1", candidates = CANDIDATES): Promise<string[]> {
  const output: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const lease = await acquire(pool, providerId, candidates);
    output.push(lease.credentialId);
    await release(pool, lease);
  }
  return output;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AccountPool smooth weighted scheduling", () => {
  it("produces a smooth deterministic sequence with the configured long-run ratio", async () => {
    const { pool, close } = await createPool();
    expect(await selections(pool, 12)).toEqual([
      "credential-a", "credential-a", "credential-a", "credential-b", "credential-a", "credential-a",
      "credential-a", "credential-a", "credential-a", "credential-b", "credential-a", "credential-a",
    ]);
    close();
  });

  it("preserves accumulated credit when candidates disappear temporarily and return", async () => {
    const { pool, close } = await createPool();
    expect(await selections(pool, 3)).toEqual(["credential-a", "credential-a", "credential-a"]);
    expect(await selections(pool, 1, "provider-1", [CANDIDATES[1]!])).toEqual(["credential-b"]);
    // B retained its accumulated credit instead of the active tier being reset, so B is
    // still ahead when the full configured set becomes eligible again.
    expect(await selections(pool, 1)).toEqual(["credential-b"]);
    close();
  });

  it("rotates evenly across remaining equal-weight credentials under persistent exclusion", async () => {
    const equal: PoolCandidate[] = ["a", "b", "c", "d"].map((suffix) => ({
      id: `credential-${suffix}`,
      priority: 0,
      weight: 1,
      maxConcurrency: 1,
      enabled: true,
    }));
    const { pool, close } = await createPool();
    const withoutA = equal.slice(1);
    const picked = await selections(pool, 30, "provider-filtered", withoutA);
    expect(Object.fromEntries(withoutA.map((candidate) => [candidate.id, picked.filter((id) => id === candidate.id).length])))
      .toEqual({ "credential-b": 10, "credential-c": 10, "credential-d": 10 });
    close();
  });

  it("does not accumulate scheduler credit while an account is cooling down", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const first = await acquire(pool);
    expect(first.credentialId).toBe("credential-a");
    await release(pool, first, false, 60_000);

    const duringCooldown = await acquire(pool);
    expect(duringCooldown.credentialId).toBe("credential-b");
    await release(pool, duringCooldown);

    vi.advanceTimersByTime(60_001);
    const recovered = await acquire(pool);
    expect(recovered.credentialId).toBe("credential-a");
    await release(pool, recovered);
    close();
  });

  it("resets the changed credential's credit when its configured weight changes and converges to the new ratio", async () => {
    const equal: PoolCandidate[] = CANDIDATES.map((candidate) => ({ ...candidate, weight: 1 }));
    const changed: PoolCandidate[] = [
      { ...equal[0]!, weight: 3 },
      equal[1]!,
    ];
    const { pool, close } = await createPool();
    await selections(pool, 4, "provider-weight-change", equal);
    const picked = await selections(pool, 40, "provider-weight-change", changed);
    expect(picked.filter((id) => id === "credential-a").length).toBe(30);
    expect(picked.filter((id) => id === "credential-b").length).toBe(10);
    close();
  });

  it("keeps provider scheduler state isolated", async () => {
    const equal: PoolCandidate[] = CANDIDATES.map((candidate) => ({ ...candidate, weight: 1 }));
    const { pool, close } = await createPool();
    expect(await selections(pool, 2, "provider-1", equal)).toEqual(["credential-a", "credential-b"]);
    expect(await selections(pool, 1, "provider-2", equal)).toEqual(["credential-a"]);
    close();
  });

  it("does not advance smooth scheduling on an affinity hit", async () => {
    const equal: PoolCandidate[] = CANDIDATES.map((candidate) => ({ ...candidate, weight: 1 }));
    const { pool, close } = await createPool();
    const initial = await acquire(pool, "provider-1", equal, "session-1");
    expect(initial.credentialId).toBe("credential-a");
    await release(pool, initial);

    const sticky = await acquire(pool, "provider-1", equal, "session-1");
    expect(sticky.credentialId).toBe("credential-a");
    await release(pool, sticky);

    const scheduled = await acquire(pool, "provider-1", equal);
    expect(scheduled.credentialId).toBe("credential-b");
    await release(pool, scheduled);
    close();
  });

  it("cleans scheduler state for credentials absent beyond the retention window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { pool, database, close } = await createPool();
    await selections(pool, 2, "provider-cleanup", CANDIDATES);
    expect(database.prepare("SELECT COUNT(*) AS count FROM smooth_weights WHERE provider_id=?").get("provider-cleanup"))
      .toMatchObject({ count: 2 });

    vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
    await selections(pool, 1, "provider-cleanup", [CANDIDATES[0]!]);
    expect(database.prepare("SELECT credential_id FROM smooth_weights WHERE provider_id=? ORDER BY credential_id").all("provider-cleanup"))
      .toEqual([{ credential_id: "credential-a" }]);
    close();
  });

  it("rejects non-integer, non-positive, and excessive smooth weights", async () => {
    const { pool, close } = await createPool();
    for (const weight of [0, -1, 1.5, 1_000_001]) {
      const invalid = [{ ...CANDIDATES[0]!, weight }, CANDIDATES[1]!];
      const { response, data } = await post<PoolLease>(pool, "/acquire", {
        providerId: "provider-1",
        strategy: "smooth_weighted",
        candidates: invalid,
      });
      expect(response.status).toBe(400);
      expect(data.error).toMatch(/integer between 1 and 1000000/);
    }
    close();
  });
});
