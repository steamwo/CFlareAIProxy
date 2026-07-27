import { afterEach, describe, expect, it, vi } from "vitest";
import { pollOAuth } from "../src/oauth";
import type { Env } from "../src/types";

/**
 * `intervalSeconds` in the start response is advice the client is free to ignore, so the
 * gateway enforces its own floor. These tests pin the two properties that matter: a hot
 * loop stops reaching the provider, and a throttled poll costs no database write — the
 * latter being the failure mode where throttling would simply trade an upstream request
 * for a more expensive D1 write.
 */

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

async function encrypt(plaintext: string): Promise<string> {
  const { encryptSecret } = await import("../src/crypto");
  return encryptSecret(plaintext, MASTER_KEY);
}

interface Harness {
  env: Env;
  writes: string[];
  fetchMock: ReturnType<typeof vi.fn>;
}

async function createHarness(lastPolledAt?: number): Promise<Harness> {
  const secret = await encrypt(JSON.stringify({ deviceCode: "device-1", deviceId: "id-1" }));
  const payload = {};
  let storedLastPolledAt: number | null = lastPolledAt ?? null;
  const writes: string[] = [];

  const rowFor = (sql: string): Record<string, unknown> | null => {
    if (sql.includes("FROM providers")) {
      return {
        id: "kimi", name: "Kimi", kind: "kimi", base_url: "https://example.test",
        enabled: 1, pool_strategy: "round_robin",
        endpoints_json: "{}",
        auth_json: JSON.stringify({ token_url: "https://example.test/token", client_id: "c1" }),
        headers_json: "{}", options_json: "{}", created_at: 0, updated_at: 0,
      };
    }
    if (sql.includes("FROM oauth_sessions")) {
      return {
        id: "session-1", provider_id: "kimi", state: "state-1", flow: "device_code",
        secret_ciphertext: secret, payload_json: JSON.stringify(payload), last_polled_at: storedLastPolledAt,
        expires_at: Math.floor(Date.now() / 1000) + 600, created_at: 0,
      };
    }
    return null;
  };

  // Both `prepare().first()` and `prepare().bind().first()` are used across the code under
  // test, so the stub answers either shape.
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => {
      if (sql.includes("UPDATE oauth_sessions SET last_polled_at")) {
        const [at, _id, cutoff] = args as [number, string, number];
        const claimed = storedLastPolledAt === null || storedLastPolledAt <= cutoff;
        if (claimed) {
          storedLastPolledAt = at;
          writes.push(sql);
        }
        return { meta: { changes: claimed ? 1 : 0 } };
      }
      writes.push(sql);
      return { meta: { changes: 1 } };
    },
    first: async () => rowFor(sql),
    all: async () => ({ results: [] }),
  });
  const prepare = vi.fn(statement);

  // A pending device-code answer keeps the flow in its polling state.
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }));
  vi.stubGlobal("fetch", fetchMock);

  return {
    env: { DB: { prepare }, MASTER_KEY } as unknown as Env,
    writes,
    fetchMock,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("oauth poll throttling", () => {
  it("forwards the first poll of a session", async () => {
    const harness = await createHarness();
    const result = await pollOAuth(harness.env, "kimi", "session-1");
    expect(result.status).toBe("pending");
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reach the provider again inside the window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = await createHarness(now);
    const result = await pollOAuth(harness.env, "kimi", "session-1");
    expect(result.status).toBe("pending");
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it("charges no database write for a throttled poll", async () => {
    const now = Math.floor(Date.now() / 1000);
    const harness = await createHarness(now);
    await pollOAuth(harness.env, "kimi", "session-1");
    expect(harness.writes).toHaveLength(0);
  });

  it("resumes once the window has passed", async () => {
    const stale = Math.floor(Date.now() / 1000) - 60;
    const harness = await createHarness(stale);
    await pollOAuth(harness.env, "kimi", "session-1");
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.writes.some((sql) => sql.includes("UPDATE oauth_sessions"))).toBe(true);
  });

  it("allows only one concurrent poll to reach the provider", async () => {
    const harness = await createHarness();
    const results = await Promise.all([
      pollOAuth(harness.env, "kimi", "session-1"),
      pollOAuth(harness.env, "kimi", "session-1"),
    ]);
    expect(results.every((result) => result.status === "pending")).toBe(true);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a throttled answer indistinguishable from an ordinary pending one", async () => {
    const now = Math.floor(Date.now() / 1000);
    const throttled = await pollOAuth((await createHarness(now)).env, "kimi", "session-1");
    const ordinary = await pollOAuth((await createHarness()).env, "kimi", "session-1");
    // Both report pending with a retry hint and nothing that names rate limiting.
    expect(throttled.status).toBe(ordinary.status);
    expect(JSON.stringify(throttled)).not.toMatch(/throttl|rate|limit/i);
  });
});
