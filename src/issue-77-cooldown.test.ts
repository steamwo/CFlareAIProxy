import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPool } from "./account-pool";
import type { Env, PoolCandidate, PoolLease } from "./types";
import {
  classifyTransportError,
  classifyUpstreamResponse,
  credentialCooldownEligible,
  providerFailureEligible,
} from "./upstream-errors";

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

const CANDIDATE: PoolCandidate = {
  id: "credential-a",
  priority: 0,
  weight: 1,
  maxConcurrency: 1,
  enabled: true,
};

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

async function rawPost(pool: AccountPool, path: string, body: unknown): Promise<Response> {
  return pool.fetch(new Request(`https://account-pool.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function post<T>(pool: AccountPool, path: string, body: unknown): Promise<T> {
  const response = await rawPost(pool, path, body);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `AccountPool ${path} failed`);
  return payload;
}

async function acquire(pool: AccountPool): Promise<PoolLease> {
  return post(pool, "/acquire", {
    providerId: "provider-1",
    strategy: "round_robin",
    candidates: [CANDIDATE],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Issue #77 transport classification", () => {
  it("maps client aborts to 499 without provider or credential punishment", () => {
    const error = classifyTransportError(new DOMException("operation aborted", "AbortError"), "Upstream", 10_000);
    expect(error.status).toBe(499);
    expect(error.code).toBe("CLIENT_CANCELED");
    expect(credentialCooldownEligible(error)).toBe(false);
    expect(providerFailureEligible(error)).toBe(false);
  });

  it("keeps statusless EOF retryable without credential cooldown", () => {
    const error = classifyTransportError(new Error("unexpected EOF"), "Upstream", 10_000);
    expect(error.status).toBe(502);
    expect(error.code).toBe("UPSTREAM_CONNECTION_LIFECYCLE");
    expect(credentialCooldownEligible(error)).toBe(false);
    expect(providerFailureEligible(error)).toBe(true);
  });

  it("keeps actual timeouts eligible for cooldown", () => {
    const error = classifyTransportError(new DOMException("timed out", "TimeoutError"), "Upstream", 10_000);
    expect(error.status).toBe(504);
    expect(error.code).toBe("UPSTREAM_TIMEOUT");
    expect(credentialCooldownEligible(error)).toBe(true);
  });

  it("treats stored-response item misses as client-correctable", () => {
    const classified = classifyUpstreamResponse(
      400,
      JSON.stringify({ error: { code: "item_not_found", type: "invalid_request_error", message: "stored item not found" } }),
      new Headers(),
      "codex",
    );
    expect(classified).toMatchObject({
      status: 400,
      code: "RESPONSE_ITEM_NOT_FOUND",
      retryable: false,
      credentialFailure: false,
      providerFailure: false,
    });
  });
});

describe("Issue #77 AccountPool cooldown contract", () => {
  it("does not increment cooldown state when eligibility is explicitly false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const first = await acquire(pool);
    await post(pool, "/release", {
      leaseId: first.leaseId,
      success: false,
      statusCode: 502,
      cooldownMs: 60_000,
      cooldownEligible: false,
    });
    const second = await acquire(pool);
    expect(second.credentialId).toBe(CANDIDATE.id);
    close();
  });

  it("still cools explicit credential/server failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const { pool, close } = await createPool();
    const first = await acquire(pool);
    await post(pool, "/release", {
      leaseId: first.leaseId,
      success: false,
      statusCode: 500,
      cooldownMs: 60_000,
      cooldownEligible: true,
    });
    await expect(acquire(pool)).rejects.toThrow("busy or cooling down");
    close();
  });

  it.each(["round_robin", "weighted", "smooth_weighted", "fill_first", "least_inflight"])(
    "preserves the original route model in %s exhaustion errors",
    async (strategy) => {
      const { pool, close } = await createPool();
      const model = 'client-opus(high)\\"fake-code';
      const first = await rawPost(pool, "/acquire", {
        providerId: "provider-1",
        strategy,
        candidates: [CANDIDATE],
        model,
      });
      expect(first.ok).toBe(true);

      const exhausted = await rawPost(pool, "/acquire", {
        providerId: "provider-1",
        strategy,
        candidates: [CANDIDATE],
        model,
      });
      expect(exhausted.status).toBe(400);
      const payload = await exhausted.json() as { error: string };
      expect(payload.error).toContain(JSON.stringify(model));
      close();
    },
  );
});
