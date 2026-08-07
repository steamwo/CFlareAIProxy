import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../types";
import { supportsOpenAiPromptCacheKey } from "./openai-prompt-cache";

function provider(options: Record<string, unknown>): ProviderConfig {
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
    options_json: JSON.stringify(options),
    created_at: 0,
    updated_at: 0,
    endpoints: {},
    auth: {},
    headers: {},
    options,
  };
}

describe("OpenAI prompt cache configured-model lookup", () => {
  it("reads map-style model_capabilities overrides", () => {
    const value = provider({
      supportPromptCacheKey: false,
      model_capabilities: {
        "model-a": { support_prompt_cache_key: true },
      },
    });
    expect(supportsOpenAiPromptCacheKey(value, "model-a")).toBe(true);
    expect(supportsOpenAiPromptCacheKey(value, "model-b")).toBe(false);
  });

  it("reads map-style models overrides", () => {
    const value = provider({
      "support-prompt-cache-key": true,
      models: {
        "model-a": { capabilities: { "support-prompt-cache-key": false } },
      },
    });
    expect(supportsOpenAiPromptCacheKey(value, "model-a")).toBe(false);
    expect(supportsOpenAiPromptCacheKey(value, "model-b")).toBe(true);
  });
});
