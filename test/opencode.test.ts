import { describe, expect, it } from "vitest";
import { buildOpenCodeRequest, classifyOpenCodeModel, openCodeGatewayEndpoints } from "../src/providers/opencode";
import { isOpenCodeAnonymousModel, openCodeAnonymousCredential } from "../src/providers/opencode-anonymous";
import type { Credential, ProviderConfig, ProxyRequestContext } from "../src/types";

const provider: ProviderConfig = {
  id: "opencode",
  name: "OpenCode Zen",
  kind: "opencode",
  base_url: "https://opencode.ai/zen/v1",
  enabled: 1,
  pool_strategy: "round_robin",
  endpoints_json: "{}",
  auth_json: "{}",
  headers_json: "{}",
  options_json: "{}",
  endpoints: {
    responses: "/responses",
    chat: "/chat/completions",
    messages: "/messages",
    google: "/models/{model}:{action}",
    models: "/models",
  },
  auth: { header: "Authorization", prefix: "Bearer " },
  headers: {},
  options: {
    model_protocol_prefixes: {
      "gpt-": "responses",
      "claude-": "anthropic",
      qwen: "anthropic",
      "gemini-": "google",
    },
  },
  created_at: 0,
  updated_at: 0,
};

const credential: Credential = {
  id: "cred",
  provider_id: "opencode",
  label: "Zen",
  auth_type: "api_key",
  secret_ciphertext: "",
  refresh_ciphertext: null,
  expires_at: null,
  enabled: 1,
  priority: 100,
  weight: 1,
  max_concurrency: 4,
  metadata_json: "{}",
  last_error: null,
  last_used_at: null,
  created_at: 0,
  updated_at: 0,
  secret: "zen-key",
  metadata: {},
};

function context(model: string, stream = false): ProxyRequestContext {
  return {
    requestId: "request",
    endpoint: "chat",
    publicModel: `opencode/${model}`,
    upstreamModel: model,
    body: { model: `opencode/${model}`, messages: [{ role: "user", content: "hello" }], stream },
    originalRequest: new Request("https://gateway.example/v1/chat/completions", { method: "POST" }),
    provider,
    credential,
  };
}

describe("OpenCode Zen upstream", () => {
  it("allows only the live anonymous-free model markers", () => {
    expect(isOpenCodeAnonymousModel("big-pickle")).toBe(true);
    expect(isOpenCodeAnonymousModel("deepseek-v4-flash-free")).toBe(true);
    expect(isOpenCodeAnonymousModel("gpt-5.6-sol")).toBe(false);
    const anonymous = openCodeAnonymousCredential();
    expect(anonymous.secret).toBe("");
    expect(anonymous.auth_type).toBe("anonymous");
  });

  it("classifies model protocols and advertised endpoints", () => {
    expect(classifyOpenCodeModel(provider, "gpt-5.1-codex")).toBe("responses");
    expect(classifyOpenCodeModel(provider, "claude-sonnet-4-5")).toBe("anthropic");
    expect(classifyOpenCodeModel(provider, "qwen3-coder")).toBe("anthropic");
    expect(classifyOpenCodeModel(provider, "gemini-2.5-pro")).toBe("google");
    expect(classifyOpenCodeModel(provider, "minimax-m2.1")).toBe("chat");
    expect(openCodeGatewayEndpoints(provider, "gpt-5.1-codex")).toEqual(["chat", "responses"]);
    expect(openCodeGatewayEndpoints(provider, "gemini-2.5-pro")).toEqual(["chat"]);
  });

  it("builds each protocol against the real Zen path", async () => {
    const responses = buildOpenCodeRequest(context("gpt-5.1-codex"));
    expect(responses.url).toBe("https://opencode.ai/zen/v1/responses");
    expect(responses.responseMode).toBe("codex-chat");

    const anthropic = buildOpenCodeRequest(context("claude-sonnet-4-5"));
    expect(anthropic.url).toBe("https://opencode.ai/zen/v1/messages");
    expect(anthropic.responseMode).toBe("anthropic-chat");

    const google = buildOpenCodeRequest(context("gemini-2.5-pro", true));
    expect(google.url).toBe("https://opencode.ai/zen/v1/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
    expect(google.responseMode).toBe("google-chat");

    const chat = buildOpenCodeRequest(context("minimax-m2.1"));
    expect(chat.url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(chat.responseMode).toBe("passthrough");

    const headers = new Headers(responses.init.headers);
    expect(headers.get("authorization")).toBe("Bearer zen-key");
  });
});
