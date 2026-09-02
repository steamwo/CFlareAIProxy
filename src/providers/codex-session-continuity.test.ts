import { describe, expect, it } from "vitest";
import type { Credential, GatewayEndpoint, ProviderConfig, ProxyRequestContext } from "../types";
import { buildCodexRequest } from "./codex";
import { resolveCodexHttpSessionId } from "./codex-session-continuity";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://gateway.test/v1/responses", {
    headers: { authorization: "Bearer gateway-a", ...headers },
  });
}

function provider(id = "codex"): ProviderConfig {
  return {
    id,
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

function context(
  body: Record<string, unknown>,
  originalRequest: Request,
  endpoint: GatewayEndpoint = "responses",
  providerId = "codex",
): ProxyRequestContext {
  return {
    requestId: "request-1",
    endpoint,
    publicModel: "public-model",
    upstreamModel: "gpt-test",
    body,
    originalRequest,
    provider: provider(providerId),
    credential: credential(),
  };
}

describe("Codex HTTP session continuity", () => {
  it("preserves an explicit prompt_cache_key before every other signal", async () => {
    expect(await resolveCodexHttpSessionId(
      { prompt_cache_key: " explicit-cache ", session_id: "body-session" },
      request({ "session-id": "header-session" }),
      "codex",
    )).toBe("explicit-cache");
  });

  it("derives a stable provider and gateway-scoped UUID from explicit sessions", async () => {
    const body = { session_id: "session-one" };
    const first = await resolveCodexHttpSessionId(body, request(), "codex");
    const second = await resolveCodexHttpSessionId(body, request(), "codex");
    const otherGateway = await resolveCodexHttpSessionId(
      body,
      new Request("https://gateway.test/v1/responses", { headers: { authorization: "Bearer gateway-b" } }),
      "codex",
    );
    const otherProvider = await resolveCodexHttpSessionId(body, request(), "codex-secondary");
    const otherSession = await resolveCodexHttpSessionId({ session_id: "session-two" }, request(), "codex");

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(new Set([first, otherGateway, otherProvider, otherSession]).size).toBe(4);
  });

  it("does not derive an identifier from prompts, API keys, or request correlation ids alone", async () => {
    expect(await resolveCodexHttpSessionId(
      { instructions: "Private prompt", input: "Sensitive content" },
      request(),
      "codex",
    )).toBeUndefined();
    expect(await resolveCodexHttpSessionId(
      { input: "Sensitive content" },
      request({ "x-client-request-id": "one-request-only" }),
      "codex",
    )).toBeUndefined();
  });

  it("applies one final session id to prompt cache and canonical HTTP identity headers", async () => {
    const result = await buildCodexRequest(context(
      { model: "public-model", stream: true, messages: [{ role: "user", content: "Hello" }] },
      request({ "x-session-id": "client-session" }),
      "chat",
    ));
    const body = JSON.parse(String(result.init.body)) as Record<string, unknown>;
    const headers = new Headers(result.init.headers);

    expect(body.prompt_cache_key).toMatch(/^[a-f0-9-]{36}$/);
    expect(headers.get("session-id")).toBe(body.prompt_cache_key);
    expect(headers.has("session_id")).toBe(false);
    expect(headers.get("conversation_id")).toBe(body.prompt_cache_key);
    expect(body.stream).toBe(true);
  });

  it("leaves HTTP session fields unset when the caller supplies no session signal", async () => {
    const result = await buildCodexRequest(context(
      { model: "public-model", input: "Prompt-only request" },
      request(),
    ));
    const body = JSON.parse(String(result.init.body)) as Record<string, unknown>;
    const headers = new Headers(result.init.headers);

    expect(body.prompt_cache_key).toBeUndefined();
    expect(headers.get("session-id")).toBeNull();
    expect(headers.get("session_id")).toBeNull();
    expect(headers.get("conversation_id")).toBeNull();
  });

  it("rejects unsafe or oversized explicit identifiers", async () => {
    expect(await resolveCodexHttpSessionId(
      { prompt_cache_key: "unsafe\u0000cache" },
      request(),
      "codex",
    )).toBeUndefined();
    expect(await resolveCodexHttpSessionId(
      {},
      request({ "session-id": "x".repeat(257) }),
      "codex",
    )).toBeUndefined();
  });
});
