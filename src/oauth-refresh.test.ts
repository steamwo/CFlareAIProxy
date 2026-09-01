import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "./errors";
import type { Credential, Env, ProviderConfig } from "./types";

const dbMocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  getProvider: vi.fn(),
  getProviderProxyConfig: vi.fn(),
  updateCredentialTokens: vi.fn(),
}));

vi.mock("./db", () => dbMocks);

import { refreshCredential } from "./oauth";

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
      client_id: "codex-client",
    },
    headers: {},
    options: {},
  };
}

function expiredCredential(): Credential {
  return {
    id: "credential-codex",
    provider_id: "codex",
    label: "Codex test",
    auth_type: "oauth",
    secret_ciphertext: "",
    refresh_ciphertext: "",
    expires_at: 1,
    enabled: 1,
    priority: 100,
    weight: 1,
    max_concurrency: 4,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    secret: "old-access",
    refreshToken: "refresh-token",
    metadata: {},
  };
}

const env = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderProxyConfig.mockResolvedValue(null);
  dbMocks.updateCredentialTokens.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex OAuth refresh transport", () => {
  it("uses a bounded 30 second request and exposes timeout as an OAuth refresh failure", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    let failure: unknown;
    try {
      await refreshCredential(env, codexProvider(), expiredCredential());
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure).toMatchObject({
      status: 504,
      code: "OAUTH_REFRESH_FAILED",
      type: "upstream_error",
    });
    expect((failure as Error).message).toContain("30000 ms");
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("grant_type")).toBe("refresh_token");
  });

  it("does not inherit cancellation from an unrelated request waiter", async () => {
    const caller = new AbortController();
    caller.abort("downstream request ended");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(caller.signal);
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await refreshCredential(env, codexProvider(), expiredCredential());

    expect(refreshed.secret).toBe("new-access");
    expect(dbMocks.updateCredentialTokens).toHaveBeenCalledOnce();
  });
});
