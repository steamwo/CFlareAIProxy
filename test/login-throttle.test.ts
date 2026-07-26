import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminApp } from "../src/admin";
import { RateLimiter } from "../src/rate-limiter";
import type { Env } from "../src/types";

type SqlValue = number | string | null;

function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
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
      if (/^\s*(SELECT|WITH)/i.test(query)) return cursor(statement.all(...params) as T[]);
      statement.run(...params);
      return cursor<T>([]);
    },
  };
}

interface ThrottleFixture {
  env: Env;
  db: DatabaseSync;
  ready: Promise<void>;
  /** Counts storage writes so the "successful login writes nothing" claim is testable. */
  alarmsSet: number;
}

/**
 * Wires the real RateLimiter DO behind a namespace stub so the admin login handler exercises
 * the deployed code path end to end, over a SQLite-backed fake of DO storage.
 */
function createEnv(overrides: Partial<Env> = {}): ThrottleFixture {
  const db = new DatabaseSync(":memory:");
  let ready: Promise<void> = Promise.resolve();
  const fixture: ThrottleFixture = {
    env: {} as Env,
    db,
    get ready() { return ready; },
    alarmsSet: 0,
  };

  const ctx = {
    storage: {
      sql: createSqlStorage(db),
      getAlarm: async (): Promise<number | null> => null,
      setAlarm: async (): Promise<void> => { fixture.alarmsSet += 1; },
    },
    blockConcurrencyWhile: (callback: () => Promise<void>): Promise<void> => {
      ready = callback();
      return ready;
    },
  };

  const limiter = new RateLimiter(ctx as unknown as DurableObjectState, {} as Env);
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (input: string, init?: RequestInit) => limiter.fetch(new Request(input, init)) }),
  } as unknown as DurableObjectNamespace;

  fixture.env = {
    ADMIN_TOKEN: "test-admin-token",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "correct-horse",
    APP_NAME: "CFlareAIProxy",
    RATE_LIMITER: namespace,
    ...overrides,
  } as Env;
  return fixture;
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>({ strict: false });
  app.route("/", createAdminApp());
  return app;
}

async function login(
  app: ReturnType<typeof createApp>,
  env: Env,
  password: string,
  ip = "203.0.113.9",
): Promise<Response> {
  return await app.request("https://example.test/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ username: "admin", password }),
  }, env);
}

const START_MS = Date.UTC(2026, 6, 26, 12, 0, 0);
const IP_THRESHOLD = 5;
const BASE_LOCK_MS = 60_000;

describe("admin login throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects the correct password once the failure threshold is reached", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    for (let attempt = 0; attempt < IP_THRESHOLD; attempt += 1) {
      const response = await login(app, fixture.env, `wrong-${attempt}`);
      expect(response.status, `attempt ${attempt} must be a plain auth failure`).toBe(401);
    }

    // The credentials are valid from here on; only the lock stands in the way.
    const locked = await login(app, fixture.env, "correct-horse");
    expect(locked.status).toBe(429);
    const payload = await locked.json() as { error?: { code?: string } };
    expect(payload.error?.code).toBe("ADMIN_LOGIN_THROTTLED");
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("lifts the lock automatically once it expires", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    for (let attempt = 0; attempt < IP_THRESHOLD; attempt += 1) await login(app, fixture.env, "wrong");
    expect((await login(app, fixture.env, "correct-horse")).status).toBe(429);

    // Still inside the first lock window.
    vi.setSystemTime(START_MS + BASE_LOCK_MS - 1_000);
    expect((await login(app, fixture.env, "correct-horse")).status).toBe(429);

    // Past it: no operator action, no alarm, the lock is simply gone.
    vi.setSystemTime(START_MS + BASE_LOCK_MS + 1_000);
    const recovered = await login(app, fixture.env, "correct-horse");
    expect(recovered.status).toBe(200);
    expect(fixture.alarmsSet).toBe(0);
  });

  it("escalates the lock as failures continue past the threshold", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    for (let attempt = 0; attempt < IP_THRESHOLD; attempt += 1) await login(app, fixture.env, "wrong");

    // Wait out the first lock, then fail once more: the next lock must be longer, not equal.
    vi.setSystemTime(START_MS + BASE_LOCK_MS + 1_000);
    expect((await login(app, fixture.env, "wrong")).status).toBe(401);

    vi.setSystemTime(START_MS + BASE_LOCK_MS + 1_000 + BASE_LOCK_MS + 1_000);
    expect((await login(app, fixture.env, "correct-horse")).status).toBe(429);

    vi.setSystemTime(START_MS + BASE_LOCK_MS + 1_000 + 2 * BASE_LOCK_MS + 1_000);
    expect((await login(app, fixture.env, "correct-horse")).status).toBe(200);
  });

  it("clears the failure counter after a successful login", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    for (let attempt = 0; attempt < IP_THRESHOLD - 1; attempt += 1) {
      expect((await login(app, fixture.env, "wrong")).status).toBe(401);
    }
    expect((await login(app, fixture.env, "correct-horse")).status).toBe(200);
    expect(rowsFor(fixture.db)).toHaveLength(0);

    // A full fresh budget must be available again, rather than one attempt from a lock.
    for (let attempt = 0; attempt < IP_THRESHOLD - 1; attempt += 1) {
      expect((await login(app, fixture.env, "wrong")).status).toBe(401);
    }
    expect((await login(app, fixture.env, "correct-horse")).status).toBe(200);
  });

  it("decays an idle failure counter without any successful login", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    for (let attempt = 0; attempt < IP_THRESHOLD - 1; attempt += 1) await login(app, fixture.env, "wrong");

    vi.setSystemTime(START_MS + 16 * 60_000);
    // The stale counter is gone, so these do not tip the scope over the threshold.
    for (let attempt = 0; attempt < IP_THRESHOLD - 1; attempt += 1) {
      expect((await login(app, fixture.env, "wrong")).status).toBe(401);
    }
    expect((await login(app, fixture.env, "correct-horse")).status).toBe(200);
  });

  it("does not leak attempt budget, lock duration, or username validity", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    const bodies: string[] = [];
    for (let attempt = 0; attempt < IP_THRESHOLD; attempt += 1) {
      bodies.push(await (await login(app, fixture.env, "wrong")).text());
    }
    // Every pre-lock rejection is byte-identical: no countdown, no "N attempts left".
    expect(new Set(bodies).size).toBe(1);

    const unknownUser = await app.request("https://example.test/admin/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
      body: JSON.stringify({ username: "nobody", password: "whatever" }),
    }, fixture.env);
    const wrongPassword = await login(app, fixture.env, "wrong", "198.51.100.7");
    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(await unknownUser.text()).toBe(await wrongPassword.text());

    const locked = await login(app, fixture.env, "correct-horse");
    const lockedBody = await locked.text();
    expect(lockedBody).not.toMatch(/\d/);
    expect(locked.headers.get("retry-after")).toBeNull();
  });

  it("isolates the lock to the offending IP", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    for (let attempt = 0; attempt < IP_THRESHOLD; attempt += 1) await login(app, fixture.env, "wrong", "203.0.113.9");
    expect((await login(app, fixture.env, "correct-horse", "203.0.113.9")).status).toBe(429);
    expect((await login(app, fixture.env, "correct-horse", "198.51.100.7")).status).toBe(200);
  });

  it("caps a distributed attack that rotates IPs on every attempt", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    // Never reuses an IP, so the per-IP counter never fires; only the global one can stop it.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await login(app, fixture.env, "wrong", `198.51.100.${attempt}`);
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }
    expect((await login(app, fixture.env, "correct-horse", "198.51.100.200")).status).toBe(429);
  });

  it("keeps the counter table bounded under a sustained rotating-IP attack", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    // Two hours of an attacker burning a fresh IP every attempt, four attempts a minute.
    for (let minute = 0; minute < 120; minute += 1) {
      for (let step = 0; step < 4; step += 1) {
        vi.setSystemTime(START_MS + minute * 60_000 + step * 15_000);
        await login(app, fixture.env, "wrong", `10.0.${minute % 256}.${step}`);
      }
    }

    // Once the global scope locks, failures are rejected before they are recorded, so the
    // unindexed prune scan cannot be grown without bound by attacker traffic.
    expect(rowsFor(fixture.db).length).toBeLessThan(80);
  });

  it("fails closed when the throttle store is unreachable", async () => {
    const app = createApp();
    const broken = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }),
    } as unknown as DurableObjectNamespace;
    const fixture = createEnv({ RATE_LIMITER: broken });

    const response = await login(app, fixture.env, "correct-horse");
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("writes no throttle rows for a first-try successful login", async () => {
    const app = createApp();
    const fixture = createEnv();
    await fixture.ready;

    expect((await login(app, fixture.env, "correct-horse")).status).toBe(200);
    expect(rowsFor(fixture.db)).toHaveLength(0);
    expect(fixture.alarmsSet).toBe(0);
  });
});

function rowsFor(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT scope, failures, locked_until FROM login_attempts").all();
}
