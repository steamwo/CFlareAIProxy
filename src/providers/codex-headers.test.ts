import { describe, expect, it } from "vitest";
import type { CredentialRecord, ProviderRecord, ProxyRequestContext } from "../types";
import { buildCodexRequest } from "./codex";

const provider: ProviderRecord = {
  id: "provider-codex-headers",
  name: "codex-headers",
  kind: "codex",
  base_url: "https://codex.test",
  endpoints: { responses: "/responses" },
  models: [],
  headers: {},
  options: {},
  auth_type: "oauth",
  enabled: 1,
  created_at: 0,
  updated_at: 0,
};

const credential: CredentialRecord = {
  id: "credential-codex-headers",
  provider_id: provider.id,
  name: "codex-headers",
  auth_type: "oauth",
  priority: 0,
  weight: 1,
  enabled: 1,
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
    expect(headers.get("x-codex-turn-state")).toBeNull();
  });
});
