import { describe, expect, it } from "vitest";
import { buildCodexClientModels } from "../src/codex-client-models";
import { prepareKimiResponse } from "../src/kimi-response";
import { normalizeCapabilities } from "../src/model-capabilities";
import { stopOpenAiCompatibleSseAfterDone } from "../src/openai-compatible-response";
import { buildCodexRequest, normalizeCodexInputMessageIds } from "../src/providers/codex";
import { providerAuthHeaders } from "../src/providers/headers";
import { normalizeKimiMessages } from "../src/providers/kimi";
import { responsesToolOutputToChatContent } from "../src/providers/responses-tool-output";
import { normalizeResponsesUsageDetails } from "../src/response-utils";
import type { Credential, ProviderConfig, ProxyRequestContext } from "../src/types";
import { classifyUpstreamResponse } from "../src/upstream-errors";
import { sanitizeHeaders } from "../src/utils";

function provider(kind: ProviderConfig["kind"] = "codex"): ProviderConfig {
  return {
    id: kind,
    name: kind,
    kind,
    base_url: "https://example.com",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    endpoints: { responses: "/responses", chat: "/chat/completions" },
    auth: { type: "bearer", header: "authorization", prefix: "Bearer " },
    headers: {},
    options: { disable_codex_cloaking: true },
  } as ProviderConfig;
}

function credential(secret = "token", metadata: Record<string, unknown> = {}): Credential {
  return {
    id: "cred",
    provider_id: "codex",
    label: "test",
    auth_type: "token",
    secret_ciphertext: "",
    refresh_ciphertext: null,
    expires_at: null,
    enabled: 1,
    priority: 100,
    weight: 1,
    max_concurrency: 4,
    metadata_json: JSON.stringify(metadata),
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    secret,
    metadata,
  } as Credential;
}

function sse(...events: Array<Record<string, unknown> | "[DONE]">): Response {
  const payload = events.map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(payload, { headers: { "content-type": "text/event-stream" } });
}

describe("upstream compatibility regression batch", () => {
  it("resolves request-scoped configured headers without cross-request state", () => {
    const first = sanitizeHeaders(new Headers({ "X-Client-Session": "one" }), { "X-Upstream-Session": "$X-Client-Session" });
    const second = sanitizeHeaders(new Headers({ "X-Client-Session": "two" }), { "X-Upstream-Session": "$X-Client-Session" });
    const missing = sanitizeHeaders(new Headers(), { "X-Upstream-Session": "$X-Client-Session", "X-Static": "yes" });
    expect(first.get("x-upstream-session")).toBe("one");
    expect(second.get("x-upstream-session")).toBe("two");
    expect(missing.has("x-upstream-session")).toBe(false);
    expect(missing.get("x-static")).toBe("yes");
  });

  it("treats dynamic header names case-insensitively and omits an empty $ reference", () => {
    const headers = sanitizeHeaders(
      new Headers({ "x-client-session": "mixed-case" }),
      { "X-Upstream-Session": "$X-CLIENT-SESSION", "X-Empty-Reference": "$" },
    );
    expect(headers.get("x-upstream-session")).toBe("mixed-case");
    expect(headers.has("x-empty-reference")).toBe(false);
  });

  it("keeps Codex credential identity protected from dynamic provider and metadata headers", () => {
    const p = provider("codex");
    p.headers.authorization = "$X-Forward-Authorization";
    p.headers["Chatgpt-Account-Id"] = "$X-Forward-Account";
    const incoming = new Headers({
      "X-Forward-Authorization": "Bearer attacker-token",
      "X-Forward-Account": "attacker-account",
      "X-Metadata-Trace": "trace-42",
    });
    const headers = providerAuthHeaders(
      p,
      credential("real-token", {
        account_id: "real-account",
        headers: {
          authorization: "$X-Forward-Authorization",
          "Chatgpt-Account-Id": "$X-Forward-Account",
          "X-Upstream-Trace": "$X-Metadata-Trace",
        },
      }),
      incoming,
    );
    expect(headers.get("authorization")).toBe("Bearer real-token");
    expect(headers.get("chatgpt-account-id")).toBe("real-account");
    expect(headers.get("x-upstream-trace")).toBe("trace-42");
  });

  it("clears Codex authorization for an empty config credential and resolves metadata headers", () => {
    const p = provider("codex");
    p.headers.authorization = "Bearer stale";
    const incoming = new Headers({ "X-Client-Trace": "trace-1" });
    const headers = providerAuthHeaders(p, credential("", { headers: { "X-Upstream-Trace": "$X-Client-Trace" } }), incoming);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("x-upstream-trace")).toBe("trace-1");
    expect(headers.has("chatgpt-account-id")).toBe(false);
  });

  it("keeps legal Codex IDs and deterministically avoids normalized collisions", () => {
    const input = [
      { type: "message", id: "foo" },
      { type: "message", id: "msg_foo" },
      { type: "function_call", id: "x".repeat(90) },
      { type: "function_call", id: "x".repeat(89) + "y" },
    ];
    const first = normalizeCodexInputMessageIds(input) as Array<Record<string, unknown>>;
    const second = normalizeCodexInputMessageIds(first) as Array<Record<string, unknown>>;
    expect(first[1]!.id).toBe("msg_foo");
    expect(new Set(first.map((entry) => entry.id)).size).toBe(first.length);
    expect(first.every((entry) => String(entry.id).length <= 64)).toBe(true);
    expect(second).toEqual(first);
  });

  it("cleans Codex nested cache breakpoints and uses canonical scoped session headers", async () => {
    const p = provider("codex");
    const request = new Request("https://gateway.example/v1/responses", { headers: { "Session-Id": "session-1", "X-Codex-Window-Id": "window-1" } });
    const context: ProxyRequestContext = {
      requestId: "req-1",
      endpoint: "responses",
      publicModel: "gpt-test",
      upstreamModel: "gpt-test",
      body: {
        prompt_cache_options: { retention: "24h" },
        input: [{ role: "user", content: [{ type: "input_text", text: "hello", prompt_cache_breakpoint: { type: "ephemeral" } }] }],
      },
      originalRequest: request,
      provider: p,
      credential: credential(),
    };
    const built = await buildCodexRequest(context);
    const body = JSON.parse(String(built.init.body)) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    const content = input[0]!.content as Array<Record<string, unknown>>;
    const headers = built.init.headers as Headers;
    expect(body).not.toHaveProperty("prompt_cache_options");
    expect(content[0]).not.toHaveProperty("prompt_cache_breakpoint");
    expect(headers.get("session-id")).toBe(body.prompt_cache_key);
    expect(headers.get("session-id")).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(headers.has("session_id")).toBe(false);
    expect(headers.get("x-codex-window-id")).toBe("window-1");
  });

  it("treats Kimi reasoning-unavailable as a fallback marker, not remembered reasoning", () => {
    const messages = normalizeKimiMessages([
      { role: "assistant", content: "", reasoning_content: "valid reasoning" },
      { role: "assistant", content: "", reasoning_content: "[reasoning unavailable]", tool_calls: [{ id: "call-1", function: { name: "tool", arguments: "{}" } }] },
    ]);
    expect(messages[1]!.reasoning_content).toBe("valid reasoning");
  });

  it("folds structured text-only tool outputs while preserving image conversion", () => {
    expect(responsesToolOutputToChatContent([{ type: "input_text", text: "done" }, { type: "output_text", text: "!" }])).toBe("done!");
    expect(responsesToolOutputToChatContent(JSON.stringify([{ type: "input_image", image_url: "https://example.com/a.png", detail: "original" }]))).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/a.png", detail: "high" } },
    ]);
  });

  it("preserves reasoning and incomplete semantics in non-stream Kimi Responses conversion", async () => {
    const upstream = Response.json({
      id: "chat-1",
      choices: [{ finish_reason: "length", message: { reasoning_content: "", reasoning: "fallback reasoning", content: "partial" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
    const response = await prepareKimiResponse({ upstream, requestedStream: false, model: "kimi", requestId: "r1", endpoint: "responses" });
    const body = await response.json() as Record<string, unknown>;
    const output = body.output as Array<Record<string, unknown>>;
    expect(body.status).toBe("incomplete");
    expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
    expect(output[0]).toMatchObject({ type: "reasoning", status: "incomplete", summary: [{ type: "summary_text", text: "fallback reasoning" }] });
    expect(output[1]).toMatchObject({ type: "message", status: "incomplete" });
  });

  it("does not let empty tool_calls interrupt streaming reasoning and emits response.incomplete", async () => {
    const upstream = sse(
      { choices: [{ delta: { reasoning_content: "think", tool_calls: [] }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: " more", tool_calls: [] }, finish_reason: null }] },
      { choices: [{ delta: { content: "partial", tool_calls: [] }, finish_reason: "content_filter" }] },
      "[DONE]",
    );
    const response = await prepareKimiResponse({ upstream, requestedStream: true, model: "kimi", requestId: "r2", endpoint: "responses" });
    const text = await response.text();
    expect(text.match(/response\.output_item\.added/g)?.length).toBe(2);
    expect(text).toContain("response.reasoning_summary_text.delta");
    expect(text).toContain("\"type\":\"response.incomplete\"");
    expect(text).toContain("\"reason\":\"content_filter\"");
    expect(text).not.toContain("response.function_call_arguments.delta");
  });

  it("adds missing Responses usage details without overwriting existing values or compaction", () => {
    expect(normalizeResponsesUsageDetails({ usage: { input_tokens: 2, output_tokens: 3 } })).toEqual({
      usage: { input_tokens: 2, output_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    });
    expect(normalizeResponsesUsageDetails({ usage: { input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 2 } } })).toMatchObject({
      usage: { input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 2 } },
    });
    const compaction = { type: "response.compaction", usage: { input_tokens: 1 } };
    expect(normalizeResponsesUsageDetails(compaction)).toBe(compaction);
  });

  it("keeps request-scoped 401 invalid_request_error availability-neutral", () => {
    expect(classifyUpstreamResponse(401, JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid parameter: foo" } }), new Headers(), "codex"))
      .toMatchObject({ credentialFailure: false, retryable: false, type: "invalid_request_error" });
    expect(classifyUpstreamResponse(401, JSON.stringify({ error: { type: "authentication_error", message: "invalid API key" } }), new Headers(), "codex"))
      .toMatchObject({ credentialFailure: true, retryable: true, code: "AUTH_UNAVAILABLE" });
  });

  it("filters max/ultra only for known old Codex clients and maps new catalog fields", () => {
    const capabilities = normalizeCapabilities({
      reasoning_levels: ["low", "max", "ultra"],
      max_completion_tokens: 4096,
      multi_agent_reasoning_effort: null,
      requires_sandboxed_review: false,
      persistent_instructions: { mode: "persist" },
      guardian_v2: { enabled: true },
      confirmation_policies: [{ kind: "shell" }],
    });
    const model = { id: "gpt-test", x_cflare_endpoints: ["responses"], x_cflare_capabilities: capabilities };
    const [oldEntry] = buildCodexClientModels([model], undefined, "0.143.99");
    const [newEntry] = buildCodexClientModels([model], undefined, "0.144.0");
    const [unknownEntry] = buildCodexClientModels([model], undefined, "future-build");
    expect((oldEntry!.supported_reasoning_levels as Array<{ effort: string }>).map((entry) => entry.effort)).toEqual(["low"]);
    expect((newEntry!.supported_reasoning_levels as Array<{ effort: string }>).map((entry) => entry.effort)).toEqual(["low", "max", "ultra"]);
    expect((unknownEntry!.supported_reasoning_levels as Array<{ effort: string }>).map((entry) => entry.effort)).toEqual(["low", "max", "ultra"]);
    expect(newEntry).toMatchObject({
      max_tokens: 4096,
      multi_agent_reasoning_effort: null,
      requires_sandboxed_review: false,
      model_messages: {
        persistent_instructions: { mode: "persist" },
        guardian_v2: { enabled: true },
        confirmation_policies: [{ kind: "shell" }],
      },
    });
  });

  it("requires [DONE] for strict OpenAI-compatible Responses SSE", async () => {
    const response = stopOpenAiCompatibleSseAfterDone(sse({ type: "response.completed", response: { status: "completed" } }), true);
    await expect(response.text()).rejects.toThrow(/closed before \[DONE\]/);
  });
});
