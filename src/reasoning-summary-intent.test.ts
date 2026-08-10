import { describe, expect, it } from "vitest";
import { normalizeCapabilities, validateModelCapabilities } from "./model-capabilities";
import {
  applyReasoningSummaryIntent,
  reasoningSummaryIntent,
} from "./reasoning-summary-intent";
import { buildUpstreamRequest } from "./providers";
import type { Credential, Env, ProviderConfig, ProviderKind, ProxyRequestContext } from "./types";

function provider(kind: ProviderKind, options: Record<string, unknown> = {}): ProviderConfig {
  return {
    id: `provider-${kind}`,
    name: kind,
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
    endpoints: kind === "kimi" ? { chat: "/chat/completions" } : kind === "codex" ? { responses: "/responses" } : {},
    auth: {},
    headers: {},
    options,
  };
}

function credential(providerId: string): Credential {
  return {
    id: "credential-summary",
    provider_id: providerId,
    label: "summary",
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

function context(
  kind: ProviderKind,
  body: Record<string, unknown>,
  options: Record<string, unknown> = {},
): ProxyRequestContext {
  const selectedProvider = provider(kind, options);
  return {
    requestId: `request-${kind}-summary`,
    endpoint: "responses",
    publicModel: "public-model",
    upstreamModel: "upstream-model",
    body,
    originalRequest: new Request("https://gateway.example/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer gateway-key" },
    }),
    provider: selectedProvider,
    credential: credential(selectedProvider.id),
  };
}

async function upstreamBody(value: ProxyRequestContext): Promise<Record<string, unknown>> {
  const request = await buildUpstreamRequest(value, {} as Env);
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

describe("reasoning summary intent parsing", () => {
  it("distinguishes unspecified, disabled, and explicit visibility", () => {
    expect(reasoningSummaryIntent({})).toBe("unspecified");
    expect(reasoningSummaryIntent({ reasoning: { effort: "high" } })).toBe("unspecified");
    for (const summary of [null, false, "none", "disabled", "OFF"]) {
      expect(reasoningSummaryIntent({ reasoning: { summary } })).toBe("disabled");
    }
    expect(reasoningSummaryIntent({ reasoning: { summary: "AUTO" } })).toBe("auto");
    expect(reasoningSummaryIntent({ reasoning: { summary: "concise" } })).toBe("concise");
    expect(reasoningSummaryIntent({ reasoning: { summary: "detailed" } })).toBe("detailed");
    expect(reasoningSummaryIntent({ reasoning: { summary: "unknown-value" } })).toBe("unspecified");
  });

  it("removes invented summary without disturbing effort", () => {
    const outgoing = { reasoning: { effort: "medium", summary: "auto" } };
    applyReasoningSummaryIntent(outgoing, { body: { reasoning: { effort: "high" } } });
    expect(outgoing.reasoning).toEqual({ effort: "medium" });
  });

  it("lets capability support replace cleanly across route fallback", () => {
    const body = { reasoning: { summary: "detailed", effort: "high" } };
    validateModelCapabilities(body, { supportsReasoningSummary: false });
    const blocked = { reasoning: { summary: "auto", effort: "medium" } };
    applyReasoningSummaryIntent(blocked, { body });
    expect(blocked.reasoning).toEqual({ effort: "medium" });

    validateModelCapabilities(body, { supportsReasoningSummary: true });
    const allowed = { reasoning: { summary: "auto", effort: "medium" } };
    applyReasoningSummaryIntent(allowed, { body });
    expect(allowed.reasoning).toEqual({ effort: "medium", summary: "detailed" });
  });

  it("accepts capability aliases without coupling them to reasoning effort", () => {
    expect(normalizeCapabilities({ "support-reasoning-summary": true }).supportsReasoningSummary).toBe(true);
    expect(normalizeCapabilities({ supports_reasoning_summaries: false }).supportsReasoningSummary).toBe(false);
    expect(normalizeCapabilities({ supports_reasoning_summary_parameter: true }).supportsReasoningSummary).toBe(true);
    expect(normalizeCapabilities({ reasoning_levels: ["high"] }).supportsReasoningSummary).toBeUndefined();
  });
});

describe("provider dispatch reasoning summary policy", () => {
  it("does not let OpenAI-compatible defaults invent summary", async () => {
    const value = context(
      "openai-compatible",
      { model: "public-model", input: "hello" },
      { request_defaults: { reasoning: { summary: "auto", effort: "low" } } },
    );
    validateModelCapabilities(value.body, { supportsReasoningSummary: true });
    expect((await upstreamBody(value)).reasoning).toEqual({ effort: "low" });
  });

  it("restores the caller's explicit summary after OpenAI-compatible overrides", async () => {
    const value = context(
      "openai-compatible",
      { model: "public-model", input: "hello", reasoning: { summary: "concise", effort: "high" } },
      { request_overrides: { reasoning: { summary: "auto", effort: "medium" } } },
    );
    validateModelCapabilities(value.body, { supportsReasoningSummary: true });
    expect((await upstreamBody(value)).reasoning).toEqual({ effort: "medium", summary: "concise" });
  });

  it("preserves explicit Responses summary through Kimi translation", async () => {
    const value = context(
      "kimi",
      { model: "public-model", input: "hello", reasoning: { summary: "detailed", effort: "high" } },
      { request_overrides: { reasoning: { summary: "auto", effort: "medium" } } },
    );
    validateModelCapabilities(value.body, { supportsReasoningSummary: true });
    expect((await upstreamBody(value)).reasoning).toEqual({ effort: "medium", summary: "detailed" });
  });

  it("removes Codex summary when the selected model explicitly does not support it", async () => {
    const value = context(
      "codex",
      { model: "public-model", input: "hello", reasoning: { summary: "auto", effort: "high" } },
    );
    validateModelCapabilities(value.body, { supportsReasoningSummary: false });
    expect((await upstreamBody(value)).reasoning).toEqual({ effort: "high" });
  });

  it("does not alter custom-provider passthrough defaults", async () => {
    const value = context(
      "custom",
      { model: "public-model", input: "hello" },
      { request_defaults: { reasoning: { summary: "auto", effort: "low" } } },
    );
    validateModelCapabilities(value.body, { supportsReasoningSummary: false });
    expect((await upstreamBody(value)).reasoning).toEqual({ summary: "auto", effort: "low" });
  });
});
