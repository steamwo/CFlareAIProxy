import { describe, expect, it } from "vitest";
import type { Credential, ProviderConfig, ProxyRequestContext } from "../src/types";
import {
  normalizeQoderContextWindow,
  normalizeQoderReasoningEffort,
  normalizeQoderRequest,
  qoderContextWindows,
  qoderEncodeBody,
  qoderEncodedUrl,
  qoderResponseToolRoutes,
} from "../src/providers/qoder-protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function modelConfig(): Record<string, unknown> {
  return {
    key: "model-1",
    display_name: "Qoder Test",
    max_output_tokens: 8192,
    max_input_tokens: 131072,
    context_config: {
      standard: { token_count: 65536, is_default: true },
      large: { token_count: 131072 },
    },
    thinking_config: {
      enabled: { efforts: { low: {}, medium: {}, high: {} } },
      disabled: {},
    },
  };
}

function provider(): ProviderConfig {
  return {
    id: "qoder", name: "Qoder", kind: "qoder", base_url: "https://api3.qoder.sh", enabled: 1,
    pool_strategy: "round_robin", endpoints_json: "{}", auth_json: "{}", headers_json: "{}", options_json: "{}",
    created_at: 0, updated_at: 0, endpoints: {}, auth: {}, headers: {}, options: {},
  };
}

function credential(): Credential {
  return {
    id: "credential-1", provider_id: "qoder", label: "Qoder", auth_type: "oauth", secret_ciphertext: "",
    refresh_ciphertext: null, expires_at: null, enabled: 1, priority: 100, weight: 1, max_concurrency: 4,
    metadata_json: "{}", last_error: null, last_used_at: null, created_at: 0, updated_at: 0,
    secret: "token", metadata: { user_id: "user-1" },
  };
}

function context(endpoint: ProxyRequestContext["endpoint"], body: Record<string, unknown>): ProxyRequestContext {
  return {
    requestId: "request-1", endpoint, publicModel: "Qoder Test", upstreamModel: "model-1", body,
    originalRequest: new Request(`https://gateway.example/v1/${endpoint}`), provider: provider(), credential: credential(),
  };
}

describe("Qoder encoded protocol", () => {
  it("encodes deterministically and hides JSON/tool schema plaintext", () => {
    const plain = encoder.encode(JSON.stringify({ messages: [{ role: "user", content: "inspect project" }], tools: [{ type: "function", function: { name: "Read" } }] }));
    const first = qoderEncodeBody(plain);
    const second = qoderEncodeBody(plain);
    expect([...first]).toEqual([...second]);
    const encoded = decoder.decode(first);
    expect(() => JSON.parse(encoded)).toThrow();
    expect(encoded).not.toContain('"tools"');
    expect(encoded).not.toContain("function");
    expect(encoded).not.toContain("Read");
  });

  it("adds Encode=1 without losing the agent query", () => {
    const url = new URL(qoderEncodedUrl("https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common"));
    expect(url.searchParams.get("FetchKeys")).toBe("llm_model_result");
    expect(url.searchParams.get("AgentId")).toBe("agent_common");
    expect(url.searchParams.get("Encode")).toBe("1");
  });
});

describe("Qoder live model options", () => {
  it("normalizes reasoning effort and context-window tiers", () => {
    expect(normalizeQoderReasoningEffort(modelConfig(), "off")).toBe("none");
    expect(normalizeQoderReasoningEffort(modelConfig(), "HIGH")).toBe("high");
    expect(normalizeQoderReasoningEffort(modelConfig(), "auto")).toBe("");
    expect(() => normalizeQoderReasoningEffort(modelConfig(), "ultra")).toThrow(/supported efforts/i);
    const withoutDisabled = { ...modelConfig(), thinking_config: { enabled: { efforts: { low: {}, high: {} } }, disabled: null } };
    expect(() => normalizeQoderReasoningEffort(withoutDisabled, "none")).toThrow(/does not support disabling/i);
    expect(qoderContextWindows(modelConfig()).map((entry) => entry.tokenCount)).toEqual([65536, 131072]);
    expect(normalizeQoderContextWindow(modelConfig(), 131072)).toBe(131072);
    expect(() => normalizeQoderContextWindow(modelConfig(), 100000)).toThrow(/supported/i);
  });

  it("normalizes Responses namespaces, ToolSearch and tool history", async () => {
    const discovered = [{ type: "function", name: "git_status", parameters: { type: "object" } }];
    const body = {
      model: "Qoder Test",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }] },
        { type: "function_call", call_id: "call-1", namespace: "mcp", name: "read", arguments: "{\"path\":\"README.md\"}" },
        { type: "function_call_output", call_id: "call-1", output: { ok: true, files: ["README.md"] } },
        { type: "tool_search_call", call_id: "search-1", arguments: { query: "git" } },
        { type: "tool_search_output", call_id: "search-1", tools: discovered },
      ],
      tools: [
        { type: "tool_search", description: "discover tools" },
        { type: "namespace", name: "mcp", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
      ],
      reasoning: { effort: "medium" },
      context_window: 65536,
      max_output_tokens: 4096,
    };
    const normalized = await normalizeQoderRequest(context("responses", body), modelConfig());
    const routes = await qoderResponseToolRoutes(body);
    expect(normalized.reasoningEffort).toBe("medium");
    expect(normalized.contextWindow).toBe(65536);
    expect(normalized.maxTokens).toBe(4096);
    expect(normalized.tools).toHaveLength(3);
    expect(routes.get("tool_search")).toEqual({ kind: "tool_search", name: "tool_search" });
    expect(routes.get("mcp__read")).toEqual({ kind: "function", name: "read", namespace: "mcp" });
    expect(routes.get("git_status")).toEqual({ kind: "function", name: "git_status" });
    expect(normalized.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ function: expect.objectContaining({ name: "mcp__read" }) })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "call-1", content: JSON.stringify({ ok: true, files: ["README.md"] }) }),
      expect.objectContaining({ role: "tool", tool_call_id: "search-1", content: JSON.stringify(discovered) }),
    ]));
  });

  it("normalizes Anthropic tool_use/tool_result history into Qoder tool messages", async () => {
    const normalized = await normalizeQoderRequest(context("messages", {
      model: "Qoder Test",
      max_tokens: 2048,
      system: [{ type: "text", text: "Be concise" }],
      output_config: { effort: "low" },
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "contents" }, { type: "text", text: "continue" }] },
      ],
      tools: [{ name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    }), modelConfig());
    expect(normalized.system).toBe("Be concise");
    expect(normalized.reasoningEffort).toBe("low");
    expect(normalized.messages[0]).toEqual(expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "toolu_1" })] }));
    expect(normalized.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "toolu_1", content: "contents" }),
      expect.objectContaining({ role: "user", content: "continue" }),
    ]));
    expect(normalized.tools[0]).toEqual(expect.objectContaining({ type: "function", function: expect.objectContaining({ name: "Read" }) }));
  });
});
