import { describe, expect, it } from "vitest";
import type { Credential, ProviderConfig, ProxyRequestContext } from "../types";
import { buildGenericRequest } from "./generic";
import { supportsOpenAiPromptCacheKey } from "./openai-prompt-cache";

function provider(
  options: Record<string, unknown> = {},
  kind: ProviderConfig["kind"] = "openai-compatible",
  id = "provider-openai",
): ProviderConfig {
  return {
    id,
    name: id,
    kind,
    base_url: "https://upstream.example/v1",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: JSON.stringify(options),
    created_at: 0,
    updated_at: 0,
    endpoints: {},
    auth: {},
    headers: {},
    options,
  };
}

function credential(id = "credential-1"): Credential {
  return {
    id,
    provider_id: "provider-openai",
    label: id,
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

function context(options: {
  provider?: ProviderConfig;
  credential?: Credential;
  body?: Record<string, unknown>;
  gatewayKey?: string;
  sessionId?: string;
  publicModel?: string;
  upstreamModel?: string;
  endpoint?: ProxyRequestContext["endpoint"];
} = {}): ProxyRequestContext {
  const headers = new Headers();
  if (options.gatewayKey !== null) headers.set("authorization", `Bearer ${options.gatewayKey ?? "gateway-key-1"}`);
  if (options.sessionId) headers.set("session-id", options.sessionId);
  return {
    requestId: "request-prompt-cache",
    endpoint: options.endpoint ?? "responses",
    publicModel: options.publicModel ?? "public-model",
    upstreamModel: options.upstreamModel ?? "upstream-model",
    body: options.body ?? { model: "public-model", input: "hello" },
    originalRequest: new Request("https://gateway.example/v1/responses", { method: "POST", headers }),
    provider: options.provider ?? provider(),
    credential: options.credential ?? credential(),
  };
}

async function requestBody(value: ProxyRequestContext): Promise<Record<string, unknown>> {
  const request = await buildGenericRequest(value);
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

describe("OpenAI-compatible prompt cache support configuration", () => {
  it("defaults off and accepts provider aliases", () => {
    expect(supportsOpenAiPromptCacheKey(provider(), "upstream-model")).toBe(false);
    expect(supportsOpenAiPromptCacheKey(provider({ "support-prompt-cache-key": true }), "upstream-model")).toBe(true);
    expect(supportsOpenAiPromptCacheKey(provider({ support_prompt_cache_key: true }), "upstream-model")).toBe(true);
    expect(supportsOpenAiPromptCacheKey(provider({ supportPromptCacheKey: true }), "upstream-model")).toBe(true);
  });

  it("lets an explicit configured model override the provider default", () => {
    const enabledProvider = provider({
      "support-prompt-cache-key": true,
      models: [
        { id: "disabled-model", capabilities: { support_prompt_cache_key: false } },
        { id: "enabled-model", capabilities: { support_prompt_cache_key: true } },
      ],
    });
    expect(supportsOpenAiPromptCacheKey(enabledProvider, "disabled-model")).toBe(false);
    expect(supportsOpenAiPromptCacheKey(enabledProvider, "enabled-model")).toBe(true);
    expect(supportsOpenAiPromptCacheKey(enabledProvider, "other-model")).toBe(true);
  });

  it("never enables the feature for custom providers", () => {
    expect(supportsOpenAiPromptCacheKey(provider({ supportPromptCacheKey: true }, "custom"), "upstream-model")).toBe(false);
  });
});

describe("OpenAI-compatible prompt_cache_key request behavior", () => {
  it("strips caller prompt_cache_key while support is disabled", async () => {
    const body = await requestBody(context({
      body: { model: "public-model", input: "hello", prompt_cache_key: "caller-key" },
    }));
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it("preserves a valid caller key when support is enabled", async () => {
    const body = await requestBody(context({
      provider: provider({ supportPromptCacheKey: true, request_overrides: { prompt_cache_key: "configured-key" } }),
      body: { model: "public-model", input: "hello", prompt_cache_key: " caller-key " },
    }));
    expect(body.prompt_cache_key).toBe("caller-key");
  });

  it("uses a configured translated key when the caller did not provide one", async () => {
    const body = await requestBody(context({
      provider: provider({ supportPromptCacheKey: true, request_overrides: { prompt_cache_key: "configured-key" } }),
    }));
    expect(body.prompt_cache_key).toBe("configured-key");
  });

  it("derives a stable opaque key only from explicit session signals", async () => {
    const enabled = provider({ supportPromptCacheKey: true });
    const first = await requestBody(context({ provider: enabled, sessionId: "session-a" }));
    const second = await requestBody(context({ provider: enabled, sessionId: "session-a" }));
    const noSession = await requestBody(context({ provider: enabled }));
    const requestIdOnly = context({ provider: enabled });
    requestIdOnly.originalRequest.headers.set("x-client-request-id", "request-only");
    const requestIdBody = await requestBody(requestIdOnly);

    expect(first.prompt_cache_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(noSession.prompt_cache_key).toBeUndefined();
    expect(requestIdBody.prompt_cache_key).toBeUndefined();
  });

  it("isolates derived keys by tenant, account, provider, model, endpoint, and session", async () => {
    const enabled = provider({ supportPromptCacheKey: true });
    const base = await requestBody(context({ provider: enabled, sessionId: "session-a" }));
    const variants = await Promise.all([
      requestBody(context({ provider: enabled, sessionId: "session-a", gatewayKey: "gateway-key-2" })),
      requestBody(context({ provider: enabled, credential: credential("credential-2"), sessionId: "session-a" })),
      requestBody(context({ provider: provider({ supportPromptCacheKey: true }, "openai-compatible", "provider-2"), sessionId: "session-a" })),
      requestBody(context({ provider: enabled, sessionId: "session-a", upstreamModel: "upstream-model-2" })),
      requestBody(context({ provider: enabled, sessionId: "session-a", endpoint: "chat" })),
      requestBody(context({ provider: enabled, sessionId: "session-b" })),
    ]);
    const keys = variants.map((entry) => entry.prompt_cache_key);
    expect(new Set([base.prompt_cache_key, ...keys]).size).toBe(7);
  });

  it("does not derive without a gateway tenant scope", async () => {
    const value = context({ provider: provider({ supportPromptCacheKey: true }), sessionId: "session-a" });
    value.originalRequest.headers.delete("authorization");
    const body = await requestBody(value);
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it("leaves custom-provider passthrough behavior unchanged", async () => {
    const body = await requestBody(context({
      provider: provider({ supportPromptCacheKey: false }, "custom"),
      body: { model: "public-model", prompt_cache_key: "custom-key", messages: [] },
      endpoint: "chat",
    }));
    expect(body.prompt_cache_key).toBe("custom-key");
  });
});
