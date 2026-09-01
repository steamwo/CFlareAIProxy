import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshCredential } from "../src/oauth";
import type { Credential, Env, ProviderConfig } from "../src/types";

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

function createEnv(): Env {
  const statement = () => ({
    bind: () => statement(),
    first: async () => null,
    run: async () => ({ meta: { changes: 1 } }),
    all: async () => ({ results: [] }),
  });
  return {
    DB: { prepare: statement },
    MASTER_KEY,
  } as unknown as Env;
}

function codexProvider(): ProviderConfig {
  return {
    id: "codex",
    name: "Codex",
    kind: "codex",
    base_url: "https://chatgpt.com/backend-api/codex",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    endpoints: {},
    auth: {
      token_url: "https://auth.openai.com/oauth/token",
      client_id: "app-client-id",
    },
    headers: {},
    options: {},
  };
}

function expiringCredential(): Credential {
  return {
    id: "credential-1",
    provider_id: "codex",
    label: "Codex test",
    auth_type: "oauth",
    secret_ciphertext: "",
    refresh_ciphertext: null,
    expires_at: Math.floor(Date.now() / 1000) - 1,
    enabled: 1,
    priority: 0,
    weight: 1,
    max_concurrency: 1,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    secret: "expired-access-token",
    refreshToken: "refresh-token",
    metadata: {},
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Codex OAuth refresh transport failures", () => {
  it("classifies the independent 30 second timeout as an observable OAuth refresh failure", async () => {
    const refreshController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(refreshController.signal);
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(init?.signal).toBe(refreshController.signal);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = refreshCredential(createEnv(), codexProvider(), expiringCredential());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    refreshController.abort(new DOMException("Codex OAuth refresh timed out", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({
      status: 504,
      code: "OAUTH_REFRESH_FAILED",
      type: "upstream_error",
      message: "Codex OAuth refresh timed out after 30000 ms",
    });
    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("classifies other refresh transport failures without exposing an internal error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network connection reset");
    }));

    await expect(refreshCredential(createEnv(), codexProvider(), expiringCredential())).rejects.toMatchObject({
      status: 502,
      code: "OAUTH_REFRESH_FAILED",
      type: "upstream_error",
      message: "Codex OAuth refresh request failed: network connection reset",
    });
  });
});
