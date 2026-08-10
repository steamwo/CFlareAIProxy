import { describe, expect, it } from "vitest";
import type { ProxyRequestContext } from "../types";
import { buildKimiRequest } from "./kimi";

function context(input: unknown[]): ProxyRequestContext {
  return {
    requestId: "request-kimi-responses-turns",
    endpoint: "responses",
    publicModel: "public-kimi",
    upstreamModel: "kimi-k2",
    body: { stream: false, input },
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

function messages(input: unknown[]): Array<Record<string, unknown>> {
  const request = buildKimiRequest(context(input));
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  return body.messages as Array<Record<string, unknown>>;
}

describe("Kimi Responses assistant-turn reconstruction", () => {
  it("keeps assistant text, reasoning, and tool calls in one assistant message", () => {
    const result = messages([
      { type: "reasoning", summary: [{ type: "summary_text", text: "Inspect the data." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will inspect it." }] },
      { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I will inspect it." }],
      reasoning_content: "Inspect the data.",
    });
    expect((result[0]?.tool_calls as unknown[])).toHaveLength(1);
    expect(result[1]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "done" });
  });

  it("merges distinct reasoning segments and ignores unavailable placeholders", () => {
    const result = messages([
      { type: "reasoning", summary: [{ type: "summary_text", text: "First step" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "[reasoning unavailable]" }, { type: "summary_text", text: "Second step" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Working" }] },
      { type: "custom_tool_call", call_id: "call_custom", name: "editor", arguments: "{}" },
      { type: "custom_tool_call_output", call_id: "call_custom", output: "ok" },
    ]);

    expect(result[0]?.reasoning_content).toBe("First step\nSecond step");
    expect(String(result[0]?.reasoning_content)).not.toContain("reasoning unavailable");
    expect((result[0]?.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "call_custom" });
  });

  it("does not merge a tool call across a role boundary", () => {
    const result = messages([
      { type: "reasoning", summary: [{ type: "summary_text", text: "Assistant A reasoning" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Assistant A" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "new turn" }] },
      { type: "function_call", call_id: "call_2", name: "lookup", arguments: "{}" },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]?.tool_calls).toBeUndefined();
    expect(result[1]).toMatchObject({ role: "user" });
    expect(result[2]).toMatchObject({ role: "assistant", content: null, reasoning_content: "[reasoning unavailable]" });
    expect((result[2]?.tool_calls as unknown[])).toHaveLength(1);
  });

  it("does not merge a later tool call across a tool-output boundary", () => {
    const result = messages([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "first" }] },
      { type: "function_call", call_id: "call_1", name: "first_tool", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
      { type: "function_call", call_id: "call_2", name: "second_tool", arguments: "{}" },
    ]);

    expect(result).toHaveLength(3);
    expect((result[0]?.tool_calls as unknown[])).toHaveLength(1);
    expect(result[1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect((result[2]?.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "call_2" });
  });

  it("resets the mergeable assistant across an unknown item boundary", () => {
    const result = messages([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "before boundary" }] },
      { type: "future_item", content: "opaque boundary" },
      { type: "function_call", call_id: "call_after_unknown", name: "lookup", arguments: "{}" },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "before boundary" }] });
    expect(result[0]?.tool_calls).toBeUndefined();
    expect(result[1]).toMatchObject({ role: "user", content: "opaque boundary" });
    expect(result[2]).toMatchObject({ role: "assistant", content: null, reasoning_content: "[reasoning unavailable]" });
    expect((result[2]?.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "call_after_unknown" });
  });
});
