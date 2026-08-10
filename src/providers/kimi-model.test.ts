import { describe, expect, it } from "vitest";
import type { ProxyRequestContext } from "../types";
import { buildKimiRequest } from "./kimi";
import { normalizeKimiUpstreamModel } from "./kimi-model";

const cases: Array<[string, string]> = [
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

  it("keeps non-K2.7 route spelling while stripping [1m] before a thinking suffix", () => {
    expect(normalizeKimiUpstreamModel("kimi-k2.6[1m](high)")).toBe("kimi-k2.6(high)");
    expect(normalizeKimiUpstreamModel("My-Custom-Kimi[1m](1024)")).toBe("My-Custom-Kimi(1024)");
  });

  it("uses the canonical model in the actual Kimi request body", () => {
    const request = buildKimiRequest(context("kimi-k2.7-code-highspeed[1m](high)"));
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("kimi-for-coding-highspeed(high)");
  });
});
