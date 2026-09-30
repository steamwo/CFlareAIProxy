import { describe, expect, it } from "vitest";
import type { ProxyRequestContext } from "../types";
import { buildKimiRequest, normalizeKimiTemperature } from "./kimi";
import { kimiKnownModelCapabilities, normalizeKimiUpstreamModel } from "./kimi-model";

const cases: Array<[string, string]> = [
  ["kimi-k2.8", "kimi-for-coding"],
  ["k2.8", "kimi-for-coding"],
  ["kimi-k2.8-code", "kimi-for-coding"],
  ["k2.8-code", "kimi-for-coding"],
  ["kimi-k2.8-preview", "kimi-for-coding"],
  ["k2.8-preview", "kimi-for-coding"],
  ["kimi-k2.8-code[1m](max)", "kimi-for-coding(max)"],
  ["kimi-k2.7-code", "kimi-for-coding"],
  ["kimi-k2.7-code-highspeed", "kimi-for-coding-highspeed"],
  ["Kimi-K2.7-Code", "kimi-for-coding"],
  ["kimi-k2.7-code-highspeed(high)", "kimi-for-coding-highspeed(high)"],
  ["kimi-k2.7-code[1m](high)", "kimi-for-coding(high)"],
  ["k2.7-code", "kimi-for-coding"],
  ["k2.7-code-highspeed", "kimi-for-coding-highspeed"],
  ["kimi-for-coding", "kimi-for-coding"],
  ["kimi-for-coding-highspeed", "kimi-for-coding-highspeed"],
  ["Kimi-For-Coding", "kimi-for-coding"],
  ["kimi-for-coding-highspeed(high)", "kimi-for-coding-highspeed(high)"],
  ["kimi-for-coding[1m]", "kimi-for-coding"],
  ["for-coding", "kimi-for-coding"],
  ["for-coding-highspeed", "kimi-for-coding-highspeed"],
];

function context(upstreamModel: string): ProxyRequestContext {
  return {
    requestId: "request-kimi-model",
    endpoint: "responses",
    publicModel: "public-kimi",
    upstreamModel,
    body: { model: "public-kimi", input: "hello", stream: false },
    originalRequest: new Request("https://gateway.example/v1/responses", { method: "POST" }),
    provider: {
      id: "provider-kimi",
      name: "Kimi",
      kind: "kimi",
      base_url: "https://kimi.example",
      enabled: 1,
      pool_strategy: "round_robin",
      endpoints_json: "{}",
      auth_json: "{}",
      headers_json: "{}",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
      endpoints: { chat: "/chat/completions" },
      auth: {},
      headers: {},
      options: {},
    },
    credential: {
      id: "credential-kimi",
      provider_id: "provider-kimi",
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
      secret: "test-token",
      metadata: {},
    },
  };
}

describe("Kimi upstream model canonicalization", () => {
  it.each(cases)("normalizes %s to %s", (input, expected) => {
    expect(normalizeKimiUpstreamModel(input)).toBe(expected);
  });

  it("keeps unrelated route spelling while stripping [1m] before a thinking suffix", () => {
    expect(normalizeKimiUpstreamModel("kimi-k2.6[1m](high)")).toBe("kimi-k2.6(high)");
    expect(normalizeKimiUpstreamModel("My-Custom-Kimi[1m](1024)")).toBe("My-Custom-Kimi(1024)");
  });


  it("guards Kimi temperature according to thinking mode", () => {
    expect(normalizeKimiTemperature({ model: "kimi", temperature: 1 })).toEqual({ model: "kimi", temperature: 1 });
    expect(normalizeKimiTemperature({ model: "kimi", temperature: 0.6 })).toEqual({ model: "kimi" });
    expect(normalizeKimiTemperature({ model: "kimi", thinking: { type: "enabled" }, temperature: 1 })).toEqual({
      model: "kimi", thinking: { type: "enabled" }, temperature: 1,
    });
    expect(normalizeKimiTemperature({ model: "kimi", thinking: { type: "enabled" }, temperature: 0.7 })).toEqual({
      model: "kimi", thinking: { type: "enabled" },
    });
    expect(normalizeKimiTemperature({ model: "kimi", thinking: { type: "disabled" }, temperature: 0.6 })).toEqual({
      model: "kimi", thinking: { type: "disabled" }, temperature: 0.6,
    });
    expect(normalizeKimiTemperature({ model: "kimi", thinking: { type: "disabled" }, temperature: 1 })).toEqual({
      model: "kimi", thinking: { type: "disabled" },
    });
    expect(normalizeKimiTemperature({ model: "kimi", thinking: { type: "disabled" }, temperature: "0.6" })).toEqual({
      model: "kimi", thinking: { type: "disabled" },
    });
  });

  it("applies the safety guard after request overrides", () => {
    const value = context("kimi-k2.8");
    value.endpoint = "chat";
    value.body = {
      model: "public-kimi",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
    };
    value.provider.options.request_overrides = { temperature: 0.7 };
    const request = buildKimiRequest(value);
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
  });

  it("enriches known discovered K2.8/K3 models without inventing unknown models", () => {
    expect(kimiKnownModelCapabilities("kimi-k2.8")).toMatchObject({
      context_window: 1048576,
      max_completion_tokens: 65536,
      reasoning_levels: ["low", "high", "max"],
      reasoning_zero_allowed: true,
      input_modalities: ["text", "image", "video"],
      output_modalities: ["text"],
    });
    expect(kimiKnownModelCapabilities("kimi-k3-256k")).toMatchObject({
      context_window: 262144,
      reasoning_zero_allowed: true,
    });
    expect(kimiKnownModelCapabilities("custom-model")).toEqual({});
  });

  it("uses the canonical K2.8 model in the actual Kimi request body", () => {
    const request = buildKimiRequest(context("kimi-k2.8-code[1m](max)"));
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("kimi-for-coding(max)");
  });
});
