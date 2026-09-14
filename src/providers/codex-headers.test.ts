import { describe, expect, it } from "vitest";
import type { Credential, ProviderConfig, ProxyRequestContext } from "../types";
import { buildCodexRequest } from "./codex";

const provider: ProviderConfig = {
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

const credential: Credential = {
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

function context(headers?: HeadersInit): ProxyRequestContext {
  const forwardedHeaders: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    forwardedHeaders[key] = value;
  });
  return {
    requestId: "request-codex-headers",
    endpoint: "responses",
    publicModel: "public-model",
    upstreamModel: "gpt-test",
    body: { model: "public-model", input: "hello" },
    originalRequest: new Request("https://gateway.test/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer gateway-key", ...forwardedHeaders },
    }),
    provider,
    credential,
  };
}

describe("Codex client header forwarding", () => {
  it("forwards X-Codex-Turn-State when supplied by the client", async () => {
    const result = await buildCodexRequest(context({ "x-codex-turn-state": "opaque-turn-state" }));
    const headers = new Headers(result.init.headers);
    expect(headers.get("x-codex-turn-state")).toBe("opaque-turn-state");
  });

  it("does not inject X-Codex-Turn-State when absent", async () => {
    const result = await buildCodexRequest(context());
    const headers = new Headers(result.init.headers);
    expect(headers.has("x-codex-turn-state")).toBe(false);
  });
});
