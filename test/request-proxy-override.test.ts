import { afterEach, describe, expect, it, vi } from "vitest";
import { providerFetchForCredential } from "../src/credential-fetch";
import type { Credential, Env, ProviderConfig } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function provider(): ProviderConfig {
  return {
    id: "provider",
    name: "Provider",
    kind: "openai-compatible",
    base_url: "https://example.com/v1",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    endpoints: {},
    auth: {},
    headers: {},
    options: {},
  };
}

function credential(): Credential {
  return {
    id: "credential",
    provider_id: "provider",
    label: "test",
    auth_type: "bearer",
    secret_ciphertext: "",
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 0,
    weight: 1,
    max_concurrency: 1,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    secret: "token",
    metadata: { proxy_url: "socks5://127.0.0.1:1080" },
  };
}

describe("execution-scoped proxy override", () => {
  it("lets a trusted direct override take precedence over credential proxy metadata", async () => {
    const fetchMock = vi.fn(async () => new Response("direct"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await providerFetchForCredential(
      {} as Env,
      provider(),
      credential(),
      "https://example.com/v1/models",
      { method: "GET" },
      { timeoutMs: 5000, requestProxyOverride: "direct" },
    );

    expect(await response.text()).toBe("direct");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});