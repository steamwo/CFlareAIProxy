import { describe, expect, it } from "vitest";
import { encryptSecret } from "../src/crypto";
import { getCredential, getProviderProxyConfig, getProviderProxySummary } from "../src/db";
import { pollOAuth } from "../src/oauth";
import type { Env } from "../src/types";

/**
 * The rotation primitives in test/key-rotation.test.ts prove the crypto layer honours
 * MASTER_KEY_PREVIOUS. These tests pin the other half: that the production read paths
 * actually forward env.MASTER_KEY_PREVIOUS. Dropping the third argument at any of these
 * call sites leaves the crypto unit tests green while breaking every rotating deployment,
 * so each accessor is exercised against ciphertext sealed under the retired key.
 */

function base64Key(fill: number): string {
  return Buffer.alloc(32, fill).toString("base64");
}

const CURRENT = base64Key(51);
const PREVIOUS = base64Key(52);

interface StubRows {
  credential?: Record<string, unknown> | null;
  providerProxy?: Record<string, unknown> | null;
  systemSetting?: Record<string, unknown> | null;
  provider?: Record<string, unknown> | null;
  oauthSession?: Record<string, unknown> | null;
}

function stubEnv(rows: StubRows, previous?: string): Env {
  const prepare = (query: string) => ({
    bind: (..._args: unknown[]) => ({
      first: <T>(): Promise<T | null> => Promise.resolve(rowFor(query) as T | null),
    }),
    first: <T>(): Promise<T | null> => Promise.resolve(rowFor(query) as T | null),
  });
  const rowFor = (query: string): Record<string, unknown> | null => {
    if (query.includes("FROM credentials")) return rows.credential ?? null;
    if (query.includes("FROM provider_proxies")) return rows.providerProxy ?? null;
    if (query.includes("FROM system_settings")) return rows.systemSetting ?? null;
    if (query.includes("FROM providers")) return rows.provider ?? null;
    if (query.includes("FROM oauth_sessions")) return rows.oauthSession ?? null;
    return null;
  };
  return {
    DB: { prepare },
    MASTER_KEY: CURRENT,
    ...(previous === undefined ? {} : { MASTER_KEY_PREVIOUS: previous }),
  } as unknown as Env;
}

async function credentialRow(secret: string, refresh: string | null, key: string) {
  return {
    id: "cred-1",
    provider_id: "codex",
    label: "acct",
    auth_type: "oauth",
    secret_ciphertext: await encryptSecret(secret, key),
    refresh_ciphertext: refresh === null ? null : await encryptSecret(refresh, key),
    expires_at: null,
    enabled: 1,
    priority: 100,
    weight: 1,
    max_concurrency: 4,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
  };
}

describe("getCredential forwards MASTER_KEY_PREVIOUS", () => {
  it("reads a credential still sealed under the retired key", async () => {
    const env = stubEnv({ credential: await credentialRow("access-old", "refresh-old", PREVIOUS) }, PREVIOUS);
    const credential = await getCredential(env, "cred-1");
    expect(credential.secret).toBe("access-old");
    expect(credential.refreshToken).toBe("refresh-old");
  });

  it("still reads a credential written under the current key during a rotation", async () => {
    const env = stubEnv({ credential: await credentialRow("access-new", null, CURRENT) }, PREVIOUS);
    const credential = await getCredential(env, "cred-1");
    expect(credential.secret).toBe("access-new");
    expect(credential.refreshToken).toBeUndefined();
  });

  it("fails when no previous key is configured, so a stalled rotation is loud", async () => {
    const env = stubEnv({ credential: await credentialRow("access-old", null, PREVIOUS) });
    await expect(getCredential(env, "cred-1")).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });
});

describe("OAuth session reads forward MASTER_KEY_PREVIOUS", () => {
  const provider = {
    id: "codex",
    name: "Codex",
    kind: "codex",
    base_url: "https://example.invalid",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
  };

  async function sessionRow(key: string) {
    return {
      id: "sess-1",
      provider_id: "codex",
      state: "state-1",
      // authorization_code needs no network call: readSession runs, then pollOAuth
      // returns the "requires callback exchange" placeholder.
      flow: "authorization_code",
      secret_ciphertext: await encryptSecret(JSON.stringify({ verifier: "v-old" }), key),
      payload_json: "{}",
      expires_at: Math.floor(Date.now() / 1000) + 600,
      created_at: 0,
    };
  }

  it("decrypts an in-flight session sealed under the retired key", async () => {
    const env = stubEnv({ provider, oauthSession: await sessionRow(PREVIOUS) }, PREVIOUS);
    await expect(pollOAuth(env, "codex", "sess-1")).resolves.toMatchObject({ status: "pending" });
  });

  it("fails the flow when the retired key is absent, rather than silently hanging", async () => {
    const env = stubEnv({ provider, oauthSession: await sessionRow(PREVIOUS) });
    await expect(pollOAuth(env, "codex", "sess-1")).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });
});

describe("proxy URL reads forward MASTER_KEY_PREVIOUS", () => {
  it("decrypts a provider proxy URL sealed under the retired key", async () => {
    const env = stubEnv(
      { providerProxy: { enabled: 1, proxy_url_ciphertext: await encryptSecret("socks5://10.0.0.1:1080", PREVIOUS) } },
      PREVIOUS,
    );
    const config = await getProviderProxyConfig(env, "codex");
    expect(config?.proxyUrl).toBe("socks5://10.0.0.1:1080");
    expect(config?.source).toBe("provider");
  });

  it("decrypts the system proxy URL sealed under the retired key", async () => {
    const env = stubEnv(
      { systemSetting: { value_ciphertext: await encryptSecret("http://10.0.0.2:3128", PREVIOUS) } },
      PREVIOUS,
    );
    const config = await getProviderProxyConfig(env, "codex");
    expect(config?.proxyUrl).toBe("http://10.0.0.2:3128");
    expect(config?.source).toBe("system");
  });

  it("summarizes both proxy slots without a decrypt failure mid-rotation", async () => {
    const env = stubEnv(
      {
        providerProxy: { enabled: 1, proxy_url_ciphertext: await encryptSecret("socks5://10.0.0.1:1080", PREVIOUS) },
        systemSetting: { value_ciphertext: await encryptSecret("http://10.0.0.2:3128", CURRENT) },
      },
      PREVIOUS,
    );
    const summary = await getProviderProxySummary(env, "codex");
    expect(summary.source).toBe("provider");
    expect(summary.hasProviderOverride).toBe(true);
    expect(summary.hasSystemProxy).toBe(true);
  });
});
