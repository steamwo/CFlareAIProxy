import { describe, expect, it } from "vitest";
import { configuredModelCapabilities, normalizeCapabilities } from "../model-capabilities";
import type { Credential, ProviderConfig, ProviderKind, ProxyRequestContext } from "../types";
import { buildGenericRequest, normalizeOpenAiMaxTokenField } from "./generic";

function provider(kind: ProviderKind = "openai-compatible"): ProviderConfig {
  return {
    id: "provider-1",
    name: "Provider",
    kind,
    base_url: "https://upstream.test/v1",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    endpoints: {},
    auth: { header: "authorization", prefix: "Bearer " },
    headers: {},
    options: {},
  };
}

function credential(): Credential {
  return {
    id: "credential-1",
    provider_id: "provider-1",
    label: "Credential",
    auth_type: "api_key",
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
    secret: "secret",
    metadata: {},
  };
}

function context(
  body: Record<string, unknown>,
  useMaxCompletionTokens: boolean | undefined,
  kind: ProviderKind = "openai-compatible",
): ProxyRequestContext {
  return {
    requestId: "request-1",
    endpoint: "chat",
    publicModel: "public-model",
    upstreamModel: "upstream-model",
    useMaxCompletionTokens,
    body,
    originalRequest: new Request("https://gateway.test/v1/chat/completions"),
    provider: provider(kind),
    credential: credential(),
  };
}

async function builtBody(
  body: Record<string, unknown>,
  useMaxCompletionTokens: boolean | undefined,
  kind: ProviderKind = "openai-compatible",
): Promise<Record<string, unknown>> {
  const built = await buildGenericRequest(context(body, useMaxCompletionTokens, kind));
  return JSON.parse(String(built.init.body)) as Record<string, unknown>;
}

describe("OpenAI-compatible max token field preference", () => {
  it("parses the capability aliases", () => {
    expect(normalizeCapabilities({ "use-max-completion-tokens": true }).useMaxCompletionTokens).toBe(true);
    expect(normalizeCapabilities({ use_max_completion_tokens: false }).useMaxCompletionTokens).toBe(false);
    expect(normalizeCapabilities({ useMaxCompletionTokens: true }).useMaxCompletionTokens).toBe(true);
  });

  it("prefers the resolved upstream model name before the requested alias", () => {
    const capabilities = configuredModelCapabilities({
      models: [
        {
          name: "UPSTREAM-MODEL",
          alias: "public-model",
          capabilities: { "use-max-completion-tokens": true },
        },
        {
          name: "other-model",
          alias: "PUBLIC-MODEL",
          capabilities: { "use-max-completion-tokens": false },
        },
      ],
    }, "upstream-model(high)", "public-model(low)");

    expect(capabilities.useMaxCompletionTokens).toBe(true);
  });

  it("falls back to a case-insensitive requested alias without its thinking suffix", () => {
    const capabilities = configuredModelCapabilities({
      models: [{
        name: "different-upstream",
        alias: "Public-Model",
        capabilities: { "use-max-completion-tokens": true },
      }],
    }, "missing-upstream(max)", "PUBLIC-MODEL(high)");

    expect(capabilities.useMaxCompletionTokens).toBe(true);
  });

  it("moves max_tokens to max_completion_tokens when enabled", async () => {
    expect(await builtBody({ max_tokens: 512 }, true)).toMatchObject({
      model: "upstream-model",
      max_completion_tokens: 512,
    });
    expect(await builtBody({ max_tokens: 512 }, true)).not.toHaveProperty("max_tokens");
  });

  it("keeps the preferred field when both token fields are present", () => {
    const enabled = { max_tokens: 111, max_completion_tokens: 222 };
    normalizeOpenAiMaxTokenField(enabled, true);
    expect(enabled).toEqual({ max_completion_tokens: 222 });

    const legacy = { max_tokens: 111, max_completion_tokens: 222 };
    normalizeOpenAiMaxTokenField(legacy, false);
    expect(legacy).toEqual({ max_tokens: 111 });
  });

  it("moves max_completion_tokens to legacy max_tokens by default", async () => {
    const body = await builtBody({ max_completion_tokens: 256 }, undefined);
    expect(body.max_tokens).toBe(256);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("preserves null and leaves a payload with neither field unchanged", () => {
    const enabled: Record<string, unknown> = { max_tokens: null };
    normalizeOpenAiMaxTokenField(enabled, true);
    expect(enabled).toEqual({ max_completion_tokens: null });

    const legacy: Record<string, unknown> = { max_completion_tokens: null };
    normalizeOpenAiMaxTokenField(legacy, false);
    expect(legacy).toEqual({ max_tokens: null });

    const neither: Record<string, unknown> = { temperature: 0.5 };
    normalizeOpenAiMaxTokenField(neither, true);
    expect(neither).toEqual({ temperature: 0.5 });
  });

  it("does not normalize custom/native provider request bodies", async () => {
    const body = await builtBody({ max_tokens: 123, max_completion_tokens: 456 }, true, "custom");
    expect(body.max_tokens).toBe(123);
    expect(body.max_completion_tokens).toBe(456);
  });
});
