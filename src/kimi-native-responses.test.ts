import { describe, expect, it } from "vitest";
import { prepareProviderResponse } from "./provider-response";
import { buildKimiRequest } from "./providers/kimi";
import type { ProxyRequestContext } from "./types";

function context(overrides: Partial<ProxyRequestContext> = {}): ProxyRequestContext {
  return {
    requestId: "request-native-kimi",
    endpoint: "responses",
    publicModel: "public-kimi",
    upstreamModel: "kimi-k2.8",
    body: {
      model: "public-kimi",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [{
        type: "function",
        name: "lookup",
        parameters: {
          $defs: { query: { type: "string" } },
          type: "object",
          properties: { query: { $ref: "#/$defs/query" } },
        },
      }],
      stream: false,
      max_output_tokens: 123,
    },
    originalRequest: new Request("https://gateway.example/v1/responses", { method: "POST" }),
    provider: {
      id: "provider-kimi",
      name: "Kimi",
      kind: "kimi",
      base_url: "https://api.kimi.example/v1",
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
    ...overrides,
  };
}

function bodyOf(request: ReturnType<typeof buildKimiRequest>): Record<string, unknown> {
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

describe("Kimi native Responses", () => {
  it("keeps the existing Responses-to-Chat bridge as the default", () => {
    const request = buildKimiRequest(context());
    expect(request.url).toBe("https://api.kimi.example/v1/chat/completions");
    expect(request.responseMode).toBe("codex-chat");
    const body = bodyOf(request);
    expect(body.messages).toBeDefined();
    expect(body.input).toBeUndefined();
    expect(body.max_tokens).toBe(123);
  });

  it("uses native Responses only when the provider explicitly opts in", () => {
    const value = context();
    value.provider.options.kimi_native_responses = true;
    const request = buildKimiRequest(value);
    expect(request.url).toBe("https://api.kimi.example/v1/responses");
    expect(request.responseMode).toBe("passthrough");
    const body = bodyOf(request);
    expect(body.input).toEqual(value.body.input);
    expect(body.messages).toBeUndefined();
    expect(body.max_output_tokens).toBe(123);
    expect(body.model).toBe("kimi-for-coding");
    const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool).toMatchObject({
      type: "function",
      name: "lookup",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    });
    expect((tool.parameters as Record<string, unknown>).$defs).toBeUndefined();
  });

  it("applies the /v1 Responses fallback only when the base URL does not already end in /v1", () => {
    const value = context();
    value.provider.base_url = "https://api.kimi.example/coding";
    value.provider.options.kimiNativeResponses = true;
    expect(buildKimiRequest(value).url).toBe("https://api.kimi.example/coding/v1/responses");
  });

  it("prefers an explicit Responses endpoint, including an absolute URL", () => {
    const value = context();
    value.provider.options.kimi_native_responses = true;
    value.provider.endpoints.responses = "https://responses.kimi.example/custom";
    expect(buildKimiRequest(value).url).toBe("https://responses.kimi.example/custom");
  });

  it("does not change Chat requests when native Responses is enabled", () => {
    const value = context({ endpoint: "chat", body: { model: "public-kimi", messages: [{ role: "user", content: "hello" }] } });
    value.provider.options.kimi_native_responses = true;
    const request = buildKimiRequest(value);
    expect(request.url).toBe("https://api.kimi.example/v1/chat/completions");
    expect(request.responseMode).toBe("passthrough");
  });

  it("passes a native Responses JSON response through instead of invoking Chat conversion", async () => {
    const upstream = Response.json({
      id: "resp_native",
      object: "response",
      status: "completed",
      model: "kimi-for-coding",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
    const response = await prepareProviderResponse({
      upstream,
      mode: "passthrough",
      requestedStream: false,
      model: "public-kimi",
      requestId: "request-native-kimi",
      providerKind: "kimi",
      endpoint: "responses",
    });
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.id).toBe("resp_native");
    expect(payload.object).toBe("response");
    expect(payload.output).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ]);
  });
});
