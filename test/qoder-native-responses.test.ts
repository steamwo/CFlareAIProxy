import { describe, expect, it } from "vitest";
import type { ProviderResponseContext } from "../src/provider-response";
import { rememberQoderToolRoutes } from "../src/providers/qoder-tool-routes";
import { prepareQoderResponse, qoderQueueInfoFromEnvelope } from "../src/qoder-response";

function qoderEvent(inner: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}

function upstream(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function context(endpoint: ProviderResponseContext["endpoint"], response: Response, requestedStream: boolean, requestId: string): ProviderResponseContext {
  return {
    upstream: response,
    mode: "qoder-chat",
    requestedStream,
    model: "Qoder Test",
    requestId,
    providerKind: "qoder",
    endpoint,
  };
}

function toolSource(): string {
  return qoderEvent({
    choices: [{ delta: {
      content: "done",
      tool_calls: [
        { index: 0, id: "call-read", type: "function", function: { name: "mcp__read", arguments: "{\"path\":\"README.md\"}" } },
        { index: 1, id: "call-search", type: "function", function: { name: "tool_search", arguments: "{\"query\":\"git\"}" } },
      ],
    }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }) + "data: [DONE]\n\n";
}

describe("Qoder queue mapping", () => {
  it("recognizes nested queue code 10605 and returns Retry-After", async () => {
    const queueInner = JSON.stringify({
      code: 10605,
      message: "Qoder capacity queue",
      queueCount: 3,
      queueType: "model",
      retryAfterSeconds: 7,
      serviceAvailable: true,
    });
    const envelope = JSON.stringify({ statusCodeValue: 200, body: queueInner });
    expect(qoderQueueInfoFromEnvelope(envelope)).toEqual(expect.objectContaining({ code: "10605", retryAfterSeconds: 7, queueCount: 3 }));

    const response = await prepareQoderResponse(context("chat", upstream(`data: ${envelope}\n\n`), true, "req-queue"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    const payload = await response.json() as { error?: { code?: string; message?: string } };
    expect(payload.error?.code).toBe("QODER_QUEUED");
    expect(payload.error?.message).toContain("capacity queue");
  });

  it("uses Anthropic error shape for /v1/messages queue responses", async () => {
    const envelope = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ isQueued: true, retryAfterSeconds: 9, message: "queued" }) });
    const response = await prepareQoderResponse(context("messages", upstream(`data: ${envelope}\n\n`), true, "req-anthropic-queue"));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(expect.objectContaining({ type: "error", error: expect.objectContaining({ type: "rate_limit_error" }) }));
  });
});

describe("Qoder Responses compatibility", () => {
  it("restores namespaces and ToolSearch in buffered Responses output", async () => {
    rememberQoderToolRoutes("req-responses", new Map([
      ["mcp__read", { kind: "function", namespace: "mcp", name: "read" }],
      ["tool_search", { kind: "tool_search", name: "tool_search" }],
    ]));
    const response = await prepareQoderResponse(context("responses", upstream(toolSource()), false, "req-responses"));
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.object).toBe("response");
    expect(payload.status).toBe("completed");
    const output = payload.output as Array<Record<string, unknown>>;
    expect(output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call-read", name: "read", namespace: "mcp" }),
      expect.objectContaining({ type: "tool_search_call", call_id: "call-search", execution: "client" }),
    ]));
    expect(payload.usage).toEqual(expect.objectContaining({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }));
  });

  it("emits native Responses SSE lifecycle events", async () => {
    rememberQoderToolRoutes("req-responses-stream", new Map([["mcp__read", { kind: "function", namespace: "mcp", name: "read" }]]));
    const response = await prepareQoderResponse(context("responses", upstream(toolSource()), true, "req-responses-stream"));
    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.function_call_arguments.delta");
    expect(text).toContain("event: response.output_item.done");
    expect(text).toContain("event: response.completed");
  });
});

describe("Qoder Anthropic Messages compatibility", () => {
  it("returns Anthropic message blocks for text and tool use", async () => {
    const response = await prepareQoderResponse(context("messages", upstream(toolSource()), false, "req-messages"));
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.type).toBe("message");
    expect(payload.role).toBe("assistant");
    expect(payload.stop_reason).toBe("tool_use");
    const content = payload.content as Array<Record<string, unknown>>;
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "done" }),
      expect.objectContaining({ type: "tool_use", id: "call-read", name: "mcp__read", input: { path: "README.md" } }),
    ]));
    expect(payload.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("emits Anthropic message/content lifecycle events", async () => {
    const response = await prepareQoderResponse(context("messages", upstream(toolSource()), true, "req-messages-stream"));
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('"type":"input_json_delta"');
    expect(text).toContain("event: message_delta");
    expect(text).toContain("event: message_stop");
  });
});
