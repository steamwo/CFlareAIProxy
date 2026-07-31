import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCredentialAvailabilityForModel } from "../src/db";
import { OPENCODE_ANONYMOUS_CREDENTIAL_ID } from "../src/providers/opencode-anonymous";
import { captureQuotaHeaders, resetQuotaHeaderThrottle } from "../src/quota";
import type { CredentialRow, Env, QuotaSnapshot, QuotaWindow } from "../src/types";

const NOW_SECONDS = 1_800_000_000;

interface SnapshotRow {
  status: QuotaSnapshot["status"];
  quota_json: string;
  error_message: string | null;
  fetched_at: number;
  expires_at: number | null;
}

class FakeStatement {
  private values: unknown[] = [];

  constructor(private readonly db: FakeDatabase, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<D1Result<T>> {
    return { results: this.db.all(this.sql) as T[], success: true, meta: {} } as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql) as T | null;
  }

  async run(): Promise<D1Result> {
    this.db.run(this.sql, this.values);
    return { results: [], success: true, meta: {} } as unknown as D1Result;
  }
}

class FakeDatabase {
  readonly writes: Array<{ sql: string; values: unknown[] }> = [];
  readonly reads: string[] = [];
  snapshot: SnapshotRow | null = null;
  credentials: CredentialRow[] = [];

  prepare(sql: string): D1PreparedStatement {
    return new FakeStatement(this, sql) as unknown as D1PreparedStatement;
  }

  all(sql: string): unknown[] {
    this.reads.push(sql);
    if (sql.includes("FROM credentials c")) {
      return this.credentials.map((row) => ({
        ...row,
        quota_status: this.snapshot?.status ?? null,
        quota_json: this.snapshot?.quota_json ?? null,
        quota_fetched_at: this.snapshot?.fetched_at ?? null,
        quota_expires_at: this.snapshot?.expires_at ?? null,
      }));
    }
    return [];
  }

  first(sql: string): unknown {
    this.reads.push(sql);
    return sql.includes("FROM quota_snapshots") ? this.snapshot : null;
  }

  run(sql: string, values: unknown[]): void {
    this.writes.push({ sql, values });
    if (!sql.includes("INSERT INTO quota_snapshots")) return;
    const [, , status, quotaJson, errorMessage, fetchedAt, expiresAt] = values;
    this.snapshot = {
      status: status as QuotaSnapshot["status"],
      quota_json: String(quotaJson),
      error_message: typeof errorMessage === "string" ? errorMessage : null,
      fetched_at: Number(fetchedAt),
      expires_at: expiresAt === null ? null : Number(expiresAt),
    };
  }

  get snapshotWrites(): number {
    return this.writes.filter((write) => write.sql.includes("INSERT INTO quota_snapshots")).length;
  }

  storedSnapshot(): QuotaSnapshot {
    if (!this.snapshot) throw new Error("no snapshot stored");
    return JSON.parse(this.snapshot.quota_json) as QuotaSnapshot;
  }
}

function envWith(db: FakeDatabase): Env {
  return { DB: db as unknown as D1Database } as Env;
}

function credentialRow(id: string, providerId: string): CredentialRow {
  return {
    id,
    provider_id: providerId,
    label: id,
    auth_type: "api_key",
    secret_ciphertext: "cipher",
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 0,
    weight: 1,
    max_concurrency: 4,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
  };
}

function seedSnapshot(
  db: FakeDatabase,
  providerId: string,
  source: QuotaSnapshot["source"],
  windows: QuotaWindow[],
  overrides: Partial<SnapshotRow> = {},
): void {
  const snapshot: QuotaSnapshot = { provider: providerId, status: "ok", windows, source };
  db.snapshot = {
    status: "ok",
    quota_json: JSON.stringify(snapshot),
    error_message: null,
    fetched_at: NOW_SECONDS - 10,
    expires_at: NOW_SECONDS + 290,
    ...overrides,
  };
}

async function availability(db: FakeDatabase, providerId: string) {
  return listCredentialAvailabilityForModel(envWith(db), providerId, "some-model", "chat");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECONDS * 1000);
  resetQuotaHeaderThrottle();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quota provenance and availability", () => {
  it("keeps an account available when a response-header window reports remaining=0", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-headers", "generic")];
    seedSnapshot(db, "generic", "headers", [
      { key: "requests", label: "请求", limit: 60, remaining: 0, source: "headers" },
    ]);

    const [entry] = await availability(db, "generic");
    expect(entry?.available).toBe(true);
    expect(entry?.reason).toBeUndefined();
  });

  it("still marks an account exhausted when the quota API reports remaining=0", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-api", "generic")];
    seedSnapshot(db, "generic", "api", [
      { key: "default", label: "配额", limit: 1000, remaining: 0, source: "api" },
    ]);

    const [entry] = await availability(db, "generic");
    expect(entry?.available).toBe(false);
    expect(entry?.retryAt).toBe(NOW_SECONDS + 290);
  });

  it("treats legacy snapshots without per-window source using the snapshot source", async () => {
    const legacyApi = new FakeDatabase();
    legacyApi.credentials = [credentialRow("cred-legacy-api", "generic")];
    seedSnapshot(legacyApi, "generic", "api", [{ key: "default", label: "配额", remaining: 0 }]);
    expect((await availability(legacyApi, "generic"))[0]?.available).toBe(false);

    const legacyHeaders = new FakeDatabase();
    legacyHeaders.credentials = [credentialRow("cred-legacy-headers", "generic")];
    seedSnapshot(legacyHeaders, "generic", "headers", [{ key: "requests", label: "请求", remaining: 0 }]);
    expect((await availability(legacyHeaders, "generic"))[0]?.available).toBe(true);
  });

  it("ignores an empty header window mixed into an API snapshot that still has quota", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-mixed", "generic")];
    seedSnapshot(db, "generic", "api", [
      { key: "default", label: "配额", limit: 1000, remaining: 400, source: "api" },
      { key: "requests", label: "请求", limit: 60, remaining: 0, source: "headers" },
    ]);

    expect((await availability(db, "generic"))[0]?.available).toBe(true);
  });

  it("prefers an empty API window's resetAt over the snapshot TTL", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-reset", "generic")];
    seedSnapshot(db, "generic", "api", [
      { key: "default", label: "配额", remaining: 0, resetAt: NOW_SECONDS + 60, source: "api" },
    ]);

    expect((await availability(db, "generic"))[0]?.retryAt).toBe(NOW_SECONDS + 60);
  });
});

describe("Qoder additive user/organization pools", () => {
  it("stays available while the organization package still has quota", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-qoder", "qoder")];
    seedSnapshot(db, "qoder", "api", [
      { key: "user", label: "个人额度", limit: 100, remaining: 0, source: "api" },
      { key: "organization", label: "组织资源包", limit: 500, remaining: 120, source: "api" },
    ]);

    expect((await availability(db, "qoder"))[0]?.available).toBe(true);
  });

  it("is exhausted only when both Qoder pools are empty", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-qoder", "qoder")];
    seedSnapshot(db, "qoder", "api", [
      { key: "user", label: "个人额度", limit: 100, remaining: 0, source: "api" },
      { key: "organization", label: "组织资源包", limit: 500, remaining: 0, source: "api" },
    ]);

    const [entry] = await availability(db, "qoder");
    expect(entry?.available).toBe(false);
    expect(entry?.reason).toBe("额度已用完，等待重置");
  });

  it("keeps the additive rule when an empty header window is also present", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-qoder", "qoder")];
    seedSnapshot(db, "qoder", "api", [
      { key: "user", label: "个人额度", limit: 100, remaining: 0, source: "api" },
      { key: "organization", label: "组织资源包", limit: 500, remaining: 0, source: "api" },
      { key: "requests", label: "请求", limit: 60, remaining: 42, source: "headers" },
    ]);

    // The healthy header window must not rescue a genuinely exhausted Qoder account.
    expect((await availability(db, "qoder"))[0]?.available).toBe(false);
  });
});

function rateLimitHeaders(remainingRequests: number, limitRequests = 60): Headers {
  return new Headers({
    "x-ratelimit-limit-requests": String(limitRequests),
    "x-ratelimit-remaining-requests": String(remainingRequests),
  });
}

describe("captureQuotaHeaders throttling", () => {
  it("writes once for a run of identical header values", async () => {
    const db = new FakeDatabase();
    for (let index = 0; index < 20; index += 1) {
      await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(58));
    }
    expect(db.snapshotWrites).toBe(1);
  });

  it("does not write on ordinary per-request drift within the interval", async () => {
    const db = new FakeDatabase();
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(60));
    for (const remaining of [59, 58, 57, 12, 3, 1]) {
      await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(remaining));
    }
    expect(db.snapshotWrites).toBe(1);
  });

  it("writes immediately when a window crosses into empty", async () => {
    const db = new FakeDatabase();
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(60));
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(0));
    expect(db.snapshotWrites).toBe(2);

    // ...and back out of empty, but repeats of the same state stay throttled.
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(0));
    expect(db.snapshotWrites).toBe(2);
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(60));
    expect(db.snapshotWrites).toBe(3);
  });

  it("writes again once the throttle interval elapses", async () => {
    const db = new FakeDatabase();
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(58));
    vi.setSystemTime((NOW_SECONDS + 121) * 1000);
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(58));
    expect(db.snapshotWrites).toBe(2);
  });

  it("throttles per credential rather than globally", async () => {
    const db = new FakeDatabase();
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(58));
    await captureQuotaHeaders(envWith(db), "cred-b", "generic", rateLimitHeaders(58));
    expect(db.snapshotWrites).toBe(2);
  });

  it("skips anonymous OpenCode credentials entirely", async () => {
    const db = new FakeDatabase();
    await captureQuotaHeaders(envWith(db), OPENCODE_ANONYMOUS_CREDENTIAL_ID, "opencode", rateLimitHeaders(0));
    expect(db.writes).toHaveLength(0);
    expect(db.reads).toHaveLength(0);
  });

  it("ignores responses that carry no rate-limit headers", async () => {
    const db = new FakeDatabase();
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", new Headers({ "content-type": "application/json" }));
    expect(db.writes).toHaveLength(0);
  });

  it("tags persisted header windows so availability ignores them", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-a", "generic")];
    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(0));

    const stored = db.storedSnapshot();
    expect(stored.windows.map((window) => window.source)).toEqual(["headers"]);
    expect((await availability(db, "generic"))[0]?.available).toBe(true);
  });
});

describe("header captures merged onto an API snapshot", () => {
  it("preserves API windows, plan and credits instead of replacing them", async () => {
    const db = new FakeDatabase();
    db.credentials = [credentialRow("cred-a", "qoder")];
    const apiSnapshot: QuotaSnapshot = {
      provider: "qoder",
      plan: "Qoder",
      status: "ok",
      source: "api",
      windows: [{ key: "user", label: "个人额度", limit: 100, remaining: 0, source: "api" }],
      credits: { balance: 0, hasCredits: false },
      raw: { userQuota: { total: 100, remaining: 0 } },
    };
    db.snapshot = {
      status: "ok",
      quota_json: JSON.stringify(apiSnapshot),
      error_message: null,
      fetched_at: NOW_SECONDS - 10,
      expires_at: NOW_SECONDS + 290,
    };

    await captureQuotaHeaders(envWith(db), "cred-a", "qoder", rateLimitHeaders(59));

    const stored = db.storedSnapshot();
    expect(stored.source).toBe("api");
    expect(stored.plan).toBe("Qoder");
    expect(stored.credits).toEqual({ balance: 0, hasCredits: false });
    expect(stored.raw).toEqual(apiSnapshot.raw);
    expect(stored.windows.map((window) => window.key)).toEqual(["user", "requests"]);
    expect(stored.windows.find((window) => window.key === "user")?.source).toBe("api");
    expect(stored.windows.find((window) => window.key === "requests")?.source).toBe("headers");

    // The credentials-exhausted verdict from the API snapshot must survive the header merge.
    expect((await availability(db, "qoder"))[0]?.available).toBe(false);
  });

  it("does not resurrect an errored quota-API snapshot as ok", async () => {
    const db = new FakeDatabase();
    const errored: QuotaSnapshot = { provider: "generic", status: "error", source: "api", windows: [] };
    db.snapshot = {
      status: "error",
      quota_json: JSON.stringify(errored),
      error_message: "quota endpoint returned 401",
      fetched_at: NOW_SECONDS - 10,
      expires_at: NOW_SECONDS + 50,
    };

    await captureQuotaHeaders(envWith(db), "cred-a", "generic", rateLimitHeaders(59));

    expect(db.snapshot?.status).toBe("error");
    expect(db.snapshot?.error_message).toBe("quota endpoint returned 401");
  });
});
