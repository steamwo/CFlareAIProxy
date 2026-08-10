import { describe, expect, it } from "vitest";
import type { Credential, ProviderConfig, ProxyRequestContext } from "../types";
import { buildCodexRequest } from "./codex";

function provider(): ProviderConfig {
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
    endpoints: { responses: "/responses" },
    auth: {},
    headers: {},
    options: {},
  };
}

function credential(): Credential {
  return {
    id: "credential-1",
    provider_id: "codex",
    label: "one",
    auth_type: "oauth",
    secret_ciphertext: "ciphertext",
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
    secret: "upstream-access-token",
    metadata: {},
  };
}

function context(body: Record<string, unknown>): ProxyRequestContext {
  return {
    requestId: "request-stream-options",
    endpoint: "responses",
    publicModel: "public-model",
    upstreamModel: "gpt-test",
    body,
    originalRequest: new Request("https://gateway.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer gateway-key" },
    }),
    provider: provider(),
    credential: credential(),
  };
}

async function upstreamBody(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await buildCodexRequest(context(body));
  return JSON.parse(String(result.init.body)) as Record<string, unknown>;
}

describe("Codex stream_options normalization", () => {
  it("preserves reasoning_summary_delivery while removing unsupported options", async () => {
    const body = await upstreamBody({
      model: "public-model",
      stream: true,
      input: "hello",
      stream_options: {
        reasoning_summary_delivery: "sequential_cutoff",
        include_usage: true,
        extra: "drop-me",
      },
    });

    expect(body.stream_options).toEqual({ reasoning_summary_delivery: "sequential_cutoff" });
  });

  it("removes stream_options when no supported member is present", async () => {
    const body = await upstreamBody({
      model: "public-model",
      stream: true,
      input: "hello",
      stream_options: { include_usage: true },
    });

    expect(body.stream_options).toBeUndefined();
  });
});
