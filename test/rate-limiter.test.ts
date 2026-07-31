import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Workers runtime base class is unavailable under vitest's node environment; the
// Durable Object logic under test only needs `this.ctx` / `this.env` to be assigned.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { RateLimiter } = await import("../src/rate-limiter");
const { persistUsageQueueBatch } = await import("../src/usage-storage");
type UsageAggregateEvent = import("../src/types").UsageAggregateEvent;
type UsageEvent = import("../src/types").UsageEvent;
type Env = import("../src/types").Env;

type SqlValue = number | string | null;

function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`unsupported SQL binding: ${typeof value}`);
}

function isMultiStatement(query: string): boolean {
  return /;\s*\S/.test(query.trim().replace(/;\s*$/, ""));
}

interface FakeCursor<T> {
  toArray(): T[];
  one(): T;
}

function cursor<T>(rows: T[]): FakeCursor<T> {
  return {
    toArray: () => rows,
    one: () => {
      const first = rows[0];
      if (first === undefined) throw new Error("no rows");
      return first;
    },
  };
}

/** Minimal in-memory stand-in for DurableObjectStorage#sql backed by node:sqlite. */
function createSqlStorage(db: DatabaseSync) {
  return {
    exec<T>(query: string, ...bindings: unknown[]): FakeCursor<T> {
      if (isMultiStatement(query)) {
        db.exec(query);
        return cursor<T>([]);
      }
      const statement = db.prepare(query);
      const params = bindings.map(toSqlValue);
      if (/^\s*(SELECT|WITH)/i.test(query)) {
        return cursor(statement.all(...params) as T[]);
      }
      statement.run(...params);
      return cursor<T>([]);
    },
  };
}

interface FakeDurableObject {
  limiter: InstanceType<typeof RateLimiter>;
  db: DatabaseSync;
  queued: UsageAggregateEvent[];
  ready: Promise<void>;
}

function createLimiter(): FakeDurableObject {
  const db = new DatabaseSync(":memory:");
  const queued: UsageAggregateEvent[] = [];
  let alarm: number | null = null;
  let ready: Promise<void> = Promise.resolve();

  const ctx = {
    storage: {
      sql: createSqlStorage(db),
      getAlarm: async (): Promise<number | null> => alarm,
      setAlarm: async (value: number): Promise<void> => {
        alarm = value;
      },
    },
    blockConcurrencyWhile: (callback: () => Promise<void>): Promise<void> => {
      ready = callback();
      return ready;
    },
  };

  const env = {
    USAGE_QUEUE: {
      send: async (message: UsageAggregateEvent): Promise<void> => {
        queued.push(message);
      },
      sendBatch: async (messages: Array<{ body: UsageAggregateEvent }>): Promise<void> => {
        for (const message of messages) queued.push(message.body);
      },
    },
  } as unknown as Env;

  const limiter = new RateLimiter(ctx as unknown as DurableObjectState, env);
  return { limiter, db, queued, ready };
}

async function acquire(fixture: FakeDurableObject, estimatedTokens: number): Promise<string> {
  const response = await fixture.limiter.fetch(new Request("https://do/acquire", {
    method: "POST",
    body: JSON.stringify({ rpm: 0, maxConcurrency: 0, monthlyTokenLimit: 0, estimatedTokens }),
  }));
  const lease = await response.json() as { leaseId: string; allowed: boolean };
  expect(lease.allowed).toBe(true);
  return lease.leaseId;
}

async function release(
  fixture: FakeDurableObject,
  leaseId: string,
  actualTokens?: number,
  activity?: UsageEvent,
): Promise<void> {
  await fixture.limiter.fetch(new Request("https://do/release", {
    method: "POST",
    body: JSON.stringify({ leaseId, actualTokens, activity }),
  }));
}

function usageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    requestId: "req-1",
    gatewayKeyId: "key-1",
    providerId: "prov-1",
    credentialId: "cred-1",
    publicModel: "gpt-x",
    upstreamModel: "gpt-x-upstream",
    endpoint: "chat",
    statusCode: 200,
    usage: { promptTokens: 10, completionTokens: 20, cachedTokens: 0, totalTokens: 30 },
    latencyMs: 1234,
    createdAt: 1_800_000_000,
    ...overrides,
  };
}

function monthTokens(db: DatabaseSync): number {
  const row = db.prepare("SELECT month_tokens FROM state WHERE singleton = 1").get() as
    | { month_tokens: number }
    | undefined;
  return row?.month_tokens ?? 0;
}

function inflight(db: DatabaseSync): number {
  const row = db.prepare("SELECT inflight FROM state WHERE singleton = 1").get() as
    | { inflight: number }
    | undefined;
  return row?.inflight ?? 0;
}

function activityRequests(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(SUM(requests),0) AS requests FROM activity_buckets").get() as
    | { requests: number }
    | undefined;
  return row?.requests ?? 0;
}

const LEASE_TTL_MS = 15 * 60_000;
const START_MS = Date.UTC(2026, 6, 26, 12, 0, 0);

describe("RateLimiter expired-lease accounting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bills actual tokens when the lease already expired", async () => {
    const fixture = createLimiter();
    await fixture.ready;

    const longStream = await acquire(fixture, 100);
    expect(monthTokens(fixture.db)).toBe(100);

    // A stream that outlives the lease TTL: the next acquire runs cleanup and refunds it.
    vi.setSystemTime(START_MS + LEASE_TTL_MS + 60_000);
    const other = await acquire(fixture, 50);
    expect(monthTokens(fixture.db)).toBe(50);
    expect(inflight(fixture.db)).toBe(1);

    await release(fixture, longStream, 777, usageEvent());

    expect(monthTokens(fixture.db)).toBe(50 + 777);
    // cleanup() already dropped the expired lease's inflight slot; release must not drop it twice.
    expect(inflight(fixture.db)).toBe(1);

    await release(fixture, other, 10);
    expect(monthTokens(fixture.db)).toBe(777 + 10);
    expect(inflight(fixture.db)).toBe(0);
  });

  it("records activity for an expired lease", async () => {
    const fixture = createLimiter();
    await fixture.ready;

    const longStream = await acquire(fixture, 100);
    vi.setSystemTime(START_MS + LEASE_TTL_MS + 60_000);
    await acquire(fixture, 0);

    expect(activityRequests(fixture.db)).toBe(0);
    await release(fixture, longStream, 777, usageEvent());
    expect(activityRequests(fixture.db)).toBe(1);

    const row = fixture.db.prepare("SELECT requests, successes, total_tokens FROM activity_buckets").get() as
      | { requests: number; successes: number; total_tokens: number }
      | undefined;
    expect(row).toEqual({ requests: 1, successes: 1, total_tokens: 30 });
  });

  it("still records activity when the tombstone was already purged", async () => {
    const fixture = createLimiter();
    await fixture.ready;

    const longStream = await acquire(fixture, 100);
    // First cleanup after the TTL turns the lease into a tombstone...
    vi.setSystemTime(START_MS + LEASE_TTL_MS + 60_000);
    await acquire(fixture, 0);
    // ...and a cleanup past the tombstone retention window drops it. Accounting is lost by
    // then, but the request must still not vanish from the activity buckets.
    vi.setSystemTime(START_MS + LEASE_TTL_MS + 60_000 + 61 * 60_000);
    await acquire(fixture, 0);

    await release(fixture, longStream, 777, usageEvent());
    expect(activityRequests(fixture.db)).toBe(1);
    expect(monthTokens(fixture.db)).toBe(0);
  });

  it("keeps normal (non-expired) release accounting unchanged", async () => {
    const fixture = createLimiter();
    await fixture.ready;

    const lease = await acquire(fixture, 100);
    await release(fixture, lease, 42, usageEvent());

    expect(monthTokens(fixture.db)).toBe(42);
    expect(inflight(fixture.db)).toBe(0);
    expect(activityRequests(fixture.db)).toBe(1);
  });
});

// --- D1 side ---------------------------------------------------------------

function createD1(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE request_activity_5m (
      bucket INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      gateway_key_id TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      credential_id TEXT NOT NULL DEFAULT '',
      public_model TEXT NOT NULL DEFAULT '',
      upstream_model TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL DEFAULT '',
      requests INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micros INTEGER NOT NULL DEFAULT 0,
      latency_sum_ms INTEGER NOT NULL DEFAULT 0,
      first_token_sum_ms INTEGER NOT NULL DEFAULT 0,
      first_token_samples INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (bucket, source_id, provider_id, credential_id, public_model, upstream_model, endpoint)
    );
    CREATE TABLE usage_flush_dedupe (
      flush_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE model_prices (
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_micros_per_million INTEGER NOT NULL DEFAULT 0,
      output_micros_per_million INTEGER NOT NULL DEFAULT 0,
      cache_micros_per_million INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_id, model)
    );
  `);

  interface BoundStatement {
    sql: string;
    params: SqlValue[];
  }
  const run = (statement: BoundStatement): void => {
    const prepared = db.prepare(statement.sql);
    if (/^\s*(SELECT|WITH)/i.test(statement.sql)) {
      prepared.all(...statement.params);
      return;
    }
    prepared.run(...statement.params);
  };

  const makeStatement = (sql: string, params: SqlValue[]) => ({
    sql,
    params,
    bind: (...values: unknown[]) => makeStatement(sql, values.map(toSqlValue)),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => {
      run({ sql, params });
      return { success: true };
    },
  });

  return {
    prepare: (sql: string) => makeStatement(sql, []),
    batch: async (statements: BoundStatement[]) => {
      db.exec("BEGIN");
      try {
        for (const statement of statements) run(statement);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

function d1Env(db: DatabaseSync): Env {
  return { DB: createD1(db) } as unknown as Env;
}

function storedRequests(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(SUM(requests),0) AS requests FROM request_activity_5m").get() as
    | { requests: number }
    | undefined;
  return row?.requests ?? 0;
}

describe("activity aggregation across flush boundaries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sums the same bucket across two flushes without losing requests", async () => {
    const fixture = createLimiter();
    await fixture.ready;

    // Two requests, flush, then one more request landing in the very same 5m bucket.
    for (const requestId of ["a", "b"]) {
      const lease = await acquire(fixture, 0);
      await release(fixture, lease, 0, usageEvent({ requestId }));
    }
    await fixture.limiter.alarm();

    const lease = await acquire(fixture, 0);
    await release(fixture, lease, 0, usageEvent({ requestId: "c" }));
    await fixture.limiter.alarm();

    expect(fixture.queued).toHaveLength(2);
    expect(fixture.queued.map((event) => event.requests)).toEqual([2, 1]);
    expect(new Set(fixture.queued.map((event) => event.flushId)).size).toBe(2);
    // Same 5m bucket in both flushes — the D1 merge must add, not MAX().
    expect(new Set(fixture.queued.map((event) => event.bucket)).size).toBe(1);

    const db = new DatabaseSync(":memory:");
    await persistUsageQueueBatch(d1Env(db), fixture.queued);
    expect(storedRequests(db)).toBe(3);
  });

  it("is idempotent when a flush event is redelivered", async () => {
    const fixture = createLimiter();
    await fixture.ready;

    for (const requestId of ["a", "b"]) {
      const lease = await acquire(fixture, 0);
      await release(fixture, lease, 0, usageEvent({ requestId }));
    }
    await fixture.limiter.alarm();
    const [flush] = fixture.queued;
    expect(flush).toBeDefined();
    if (!flush) throw new Error("expected a flush event");

    const db = new DatabaseSync(":memory:");
    const env = d1Env(db);
    await persistUsageQueueBatch(env, [flush]);
    expect(storedRequests(db)).toBe(2);

    // Queue retry (wrangler max_retries=3) redelivers the identical message.
    await persistUsageQueueBatch(env, [flush]);
    expect(storedRequests(db)).toBe(2);

    // ...including when the retry arrives in the same batch as itself.
    await persistUsageQueueBatch(env, [flush, flush]);
    expect(storedRequests(db)).toBe(2);
  });

  it("does not resend an already-flushed delta when the alarm reruns", async () => {
    const fixture = createLimiter();
    await fixture.ready;

    const lease = await acquire(fixture, 0);
    await release(fixture, lease, 0, usageEvent());
    await fixture.limiter.alarm();
    await fixture.limiter.alarm();

    expect(fixture.queued).toHaveLength(1);

    const db = new DatabaseSync(":memory:");
    await persistUsageQueueBatch(d1Env(db), fixture.queued);
    expect(storedRequests(db)).toBe(1);
  });

  it("still merges legacy cumulative events that carry no flushId", async () => {
    const db = new DatabaseSync(":memory:");
    const env = d1Env(db);
    const base: UsageAggregateEvent = {
      kind: "aggregate",
      bucket: 1_800_000_000,
      sourceId: "key-1",
      gatewayKeyId: "key-1",
      providerId: "prov-1",
      credentialId: "cred-1",
      publicModel: "gpt-x",
      upstreamModel: "gpt-x-upstream",
      endpoint: "chat",
      requests: 2,
      successes: 2,
      failures: 0,
      promptTokens: 20,
      completionTokens: 40,
      cachedTokens: 0,
      totalTokens: 60,
      latencySumMs: 100,
      firstTokenSumMs: 0,
      firstTokenSamples: 0,
      updatedAt: 1_800_000_100,
    };
    await persistUsageQueueBatch(env, [base]);
    await persistUsageQueueBatch(env, [{ ...base, requests: 3, updatedAt: 1_800_000_200 }]);
    expect(storedRequests(db)).toBe(3);
  });
});
