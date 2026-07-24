import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialProxyUrl, providerFetchForCredential } from "../src/credential-fetch";
import { normalizeCapabilities, validateModelCapabilities } from "../src/model-capabilities";
import { prepareProviderResponse } from "../src/provider-response";
import { chatToResponses } from "../src/providers/codex";
import { buildKimiRequest, normalizeKimiMessages } from "../src/providers/kimi";
import type { Credential, Env, ProviderConfig, ProxyRequestContext } from "../src/types";
import { classifyUpstreamResponse } from "../src/upstream-errors";

function sse(...events: Array<Record<string, unknown> | "[DONE]">): Response {
  const text = events.map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("P0/P1 provider runtime", () => {
  it("repairs Kimi tool messages and routes Responses through chat completions", () => {
    const messages = normalizeKimiMessages([
      { role: "assistant", content: "" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      { role: "tool", call_id: "call_1", content: "ok" },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.reasoning_content).toBe("[reasoning unavailable]");
    expect(messages[1]?.tool_call_id).toBe("call_1");

    const context = {
      requestId: "request-1", endpoint: "responses", publicModel: "kimi-fast", upstreamModel: "kimi-k2.5[1m]",
      body: {
        model: "kimi-fast",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        tool_choice: { type: "function", name: "lookup" },
        stream: true,
      },
      originalRequest: new Request("https://gateway.example/v1/responses", { method: "POST" }),
      provider: { id: "kimi", name: "Kimi", kind: "kimi", base_url: "https://api.kimi.com/coding/v1", endpoints: { chat: "/chat/completions" }, auth: {}, headers: {}, options: {} },
      credential: { id: "credential-1", secret: "token", metadata: { device_id: "device-1" } },
    } as unknown as ProxyRequestContext;
    const request = buildKimiRequest(context);
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    expect(request.url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(body.model).toBe("kimi-k2.5");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
    expect(body.stream_options).toEqual({ include_usage: true });

    const codex = chatToResponses({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup", description: "Lookup", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
    }, "gpt-codex");
    expect(codex.tools).toEqual([{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object" } }]);
    expect(codex.tool_choice).toEqual({ type: "function", name: "lookup" });
  });

  it("reconstructs Codex output and rejects incomplete or failed terminal streams", async () => {
    const response = await prepareProviderResponse({
      upstream: sse(
        { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
        { type: "response.completed", response: { id: "resp_1", model: "gpt-upstream", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
        "[DONE]",
      ),
      mode: "passthrough", requestedStream: false, model: "codex-public", requestId: "request-2",
      providerKind: "codex", endpoint: "responses", forceResponseModelMapping: true,
    });
    const payload = await response.json() as { model: string; output: Array<Record<string, unknown>> };
    expect(payload.model).toBe("codex-public");
    expect(payload.output).toHaveLength(1);

    const incomplete = await prepareProviderResponse({
      upstream: sse({ type: "response.output_text.delta", delta: "partial" }),
      mode: "codex-chat", requestedStream: true, model: "codex-public", requestId: "request-3",
      providerKind: "codex", endpoint: "chat",
    });
    await expect(incomplete.text()).rejects.toThrow("CODEX_STREAM_INCOMPLETE");

    await expect(prepareProviderResponse({
      upstream: sse({ type: "response.failed", response: { error: { type: "rate_limit_error", message: "usage limit reached" } } }),
      mode: "codex-chat", requestedStream: false, model: "codex-public", requestId: "request-4",
      providerKind: "codex", endpoint: "chat",
    })).rejects.toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });

    await expect(prepareProviderResponse({
      upstream: sse({ type: "response.failed", response: { error: { type: "server_error", message: "upstream failed" } } }),
      mode: "codex-chat", requestedStream: false, model: "codex-public", requestId: "request-5",
      providerKind: "codex", endpoint: "chat",
    })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", status: 502 });
  });

  it("classifies upstream failures with retry and cooldown semantics", () => {
    expect(classifyUpstreamResponse(400, JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }), new Headers(), "codex"))
      .toMatchObject({ code: "CONTEXT_TOO_LARGE", retryable: false, credentialFailure: false, providerFailure: false });
    expect(classifyUpstreamResponse(429, JSON.stringify({ error: { message: "quota exceeded" } }), new Headers({ "retry-after": "12" }), "kimi"))
      .toMatchObject({ code: "RATE_LIMIT_EXCEEDED", retryable: true, credentialFailure: true, retryAfterMs: 12_000 });
    expect(classifyUpstreamResponse(503, "overloaded", new Headers(), "openai-compatible"))
      .toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true, providerFailure: true });
  });

  it("validates model capabilities before upstream execution", () => {
    expect(normalizeCapabilities({ input_modalities: ["text", "image"], reasoning_levels: ["low", "high"], supports_tools: true }))
      .toMatchObject({ inputModalities: ["text", "image"], reasoningLevels: ["low", "high"], supportsTools: true });
    expect(() => validateModelCapabilities({ tools: [{ type: "function" }] }, { supportsTools: false })).toThrow(/tool calls/i);
    expect(() => validateModelCapabilities({ messages: [{ content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] }, { inputModalities: ["text"] })).toThrow(/image input/i);
  });

  it("supports credential proxy override and explicit direct bypass", async () => {
    expect(credentialProxyUrl({ metadata: { proxy_url: "socks5://127.0.0.1:1080" } } as Credential)).toBe("socks5://127.0.0.1:1080");
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const provider = { id: "provider", name: "Provider", kind: "openai-compatible", base_url: "https://example.com/v1", endpoints: {}, auth: {}, headers: {}, options: {} } as unknown as ProviderConfig;
    const response = await providerFetchForCredential({} as Env, provider, { metadata: { proxy_url: "none" } } as Credential, "https://example.com/v1/models", { method: "GET" }, { timeoutMs: 5000 });
    expect(await response.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
