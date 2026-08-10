import { describe, expect, it } from "vitest";
import { normalizeCapabilities, validateModelCapabilities } from "../model-capabilities";
import type { Credential, ProviderConfig, ProxyRequestContext } from "../types";
import { buildGenericRequest } from "./generic";

function provider(enabled: boolean): ProviderConfig {
  return {
    id: "provider-openai",
    name: "OpenAI compatible",
    kind: "openai-compatible",
    base_url: "https://upstream.example/v1",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: JSON.stringify({ supportPromptCacheKey: enabled }),
    created_at: 0,
    updated_at: 0,
    endpoints: {},
    auth: {},
    headers: {},
    options: { supportPromptCacheKey: enabled },
  };
}

function credential(): Credential {
  return {
    id: "credential-1",
    provider_id: "provider-openai",
    label: "one",
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
    secret: "upstream-secret",
    metadata: {},
  };
}

function context(enabled: boolean): ProxyRequestContext {
  const body = { model: "public-model", input: "hello", prompt_cache_key: "caller-key" };
  return {
    requestId: "request-route-prompt-cache",
    endpoint: "responses",
    publicModel: "public-model",
    upstreamModel: "upstream-model",
    body,
    originalRequest: new Request("https://gateway.example/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer gateway-key" },
    }),
    provider: provider(enabled),
    credential: credential(),
  };
}

async function upstreamBody(value: ProxyRequestContext): Promise<Record<string, unknown>> {
  const request = await buildGenericRequest(value);
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

describe("route-scoped OpenAI prompt cache capability", () => {
  it("accepts route capability aliases", () => {
    expect(normalizeCapabilities({ "support-prompt-cache-key": true }).supportsPromptCacheKey).toBe(true);
    expect(normalizeCapabilities({ support_prompt_cache_key: false }).supportsPromptCacheKey).toBe(false);
    expect(normalizeCapabilities({ supportsPromptCacheKey: true }).supportsPromptCacheKey).toBe(true);
  });

  it("lets an enabled route override a disabled provider", async () => {
    const value = context(false);
    validateModelCapabilities(value.body, { supportsPromptCacheKey: true });
    expect((await upstreamBody(value)).prompt_cache_key).toBe("caller-key");
  });

  it("lets a disabled route override an enabled provider", async () => {
    const value = context(true);
    validateModelCapabilities(value.body, { supportsPromptCacheKey: false });
    expect((await upstreamBody(value)).prompt_cache_key).toBeUndefined();
  });

  it("replaces the prior route decision when provider fallback evaluates the same request body", async () => {
    const value = context(true);
    validateModelCapabilities(value.body, { supportsPromptCacheKey: false });
    expect((await upstreamBody(value)).prompt_cache_key).toBeUndefined();

    validateModelCapabilities(value.body, { supportsPromptCacheKey: true });
    expect((await upstreamBody(value)).prompt_cache_key).toBe("caller-key");
  });
});
