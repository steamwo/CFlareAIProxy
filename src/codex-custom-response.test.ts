import { describe, expect, it } from "vitest";
import { prepareCodexCustomToolResponse } from "./codex-custom-response";
import { buildCodexCustomToolRequest } from "./providers/codex-custom-tools";
import type { ProxyRequestContext } from "./types";

function seedToolName(requestId: string, longName: string): string {
  const result = buildCodexCustomToolRequest({
    requestId,
    endpoint: "chat",
    publicModel: "public-model",
    upstreamModel: "gpt-test",
    body: {
      messages: [{ role: "user", content: "Use the tool." }],
      tools: [{ type: "custom", name: longName }],
    },
    originalRequest: new Request("https://gateway.test/v1/chat/completions"),
    provider: {
      kind: "codex",
      base_url: "https://api.openai.com",
      endpoints: { responses: "/responses" },
      headers: {},
      auth: {},
      options: {},
    },
    credential: { secret: "test-token", metadata: {} },
  } as unknown as ProxyRequestContext);
  const payload = JSON.parse(result.init.body as string) as { tools: Array<{ name: string }> };
  return payload.tools[0]!.name;
}

function sseResponse(events: Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function completedEvent(): Record<string, unknown> {
  return {
    type: "response.completed",
    response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
  };
}

async function streamChunks(requestId: string, events: Record<string, unknown>[]): Promise<Array<Record<string, unknown>>> {
  const response = await prepareCodexCustomToolResponse({
    upstream: sseResponse([...events, completedEvent()]),
    requestedStream: true,
    model: "public-model",
    requestId,
    endpoint: "chat",
  });
  const text = await response.text();
  return text.split(/\r?\n\r?\n/).flatMap((frame) => {
    const line = frame.split(/\r?\n/).find((entry) => entry.startsWith("data:"));
    const data = line?.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data) as Record<string, unknown>];
  });
}

function emittedToolCalls(chunks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return chunks.flatMap((chunk) => {
    const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
    const delta = choices[0]?.delta && typeof choices[0].delta === "object"
      ? choices[0].delta as Record<string, unknown>
      : {};
    return Array.isArray(delta.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : [];
  });
}

describe("Codex custom tool response translation", () => {
  it("restores long names and emits done-only arguments once", async () => {
    const requestId = "done-only";
    const longName = "apply_a_repository_patch_with_a_custom_tool_name_that_is_longer_than_sixty_four_characters";
    const shortName = seedToolName(requestId, longName);
    const item = { id: "item-1", type: "custom_tool_call", call_id: "call-1", name: shortName, input: "payload" };
    const chunks = await streamChunks(requestId, [
      { type: "response.output_item.added", output_index: 4, item },
      { type: "response.custom_tool_call_input.done", output_index: 4, item_id: "item-1", input: "payload" },
      { type: "response.output_item.done", output_index: 4, item },
      { type: "response.output_item.done", output_index: 4, item },
      { type: "response.custom_tool_call_input.delta", output_index: 4, item_id: "item-1", delta: "late" },
    ]);

    expect(emittedToolCalls(chunks)).toEqual([
      { index: 0, id: "call-1", type: "function", function: { name: longName, arguments: "" } },
      { index: 0, function: { arguments: "payload" } },
    ]);
  });

  it("tracks interleaved function and custom calls independently", async () => {
    const chunks = await streamChunks("interleaved", [
      {
        type: "response.output_item.added",
        output_index: 3,
        item: { id: "item-a", type: "function_call", call_id: "call-a", name: "first", arguments: "" },
      },
      {
        type: "response.output_item.added",
        output_index: 7,
        item: { id: "item-b", type: "custom_tool_call", call_id: "call-b", name: "second", input: "" },
      },
      { type: "response.custom_tool_call_input.delta", output_index: 7, item_id: "item-b", delta: "B" },
      { type: "response.function_call_arguments.delta", output_index: 3, item_id: "item-a", delta: "A" },
      {
        type: "response.output_item.done",
        output_index: 7,
        item: { id: "item-b", type: "custom_tool_call", call_id: "call-b", name: "second", input: "B" },
      },
      {
        type: "response.output_item.done",
        output_index: 3,
        item: { id: "item-a", type: "function_call", call_id: "call-a", name: "first", arguments: "A" },
      },
    ]);

    expect(emittedToolCalls(chunks)).toEqual([
      { index: 0, id: "call-a", type: "function", function: { name: "first", arguments: "" } },
      { index: 1, id: "call-b", type: "function", function: { name: "second", arguments: "" } },
      { index: 1, function: { arguments: "B" } },
      { index: 0, function: { arguments: "A" } },
    ]);
  });

  it("falls back to a complete call when only output_item.done arrives", async () => {
    const chunks = await streamChunks("output-only", [{
      type: "response.output_item.done",
      output_index: 9,
      item: { id: "item-only", type: "custom_tool_call", call_id: "call-only", name: "apply_patch", input: "diff" },
    }]);

    expect(emittedToolCalls(chunks)).toEqual([{
      index: 0,
      id: "call-only",
      type: "function",
      function: { name: "apply_patch", arguments: "diff" },
    }]);
  });

  it("converts non-streaming custom calls and restores their names", async () => {
    const requestId = "non-stream";
    const longName = "run_a_custom_repository_operation_with_a_name_that_exceeds_the_codex_tool_name_limit";
    const shortName = seedToolName(requestId, longName);
    const upstream = Response.json({
      id: "response-1",
      created_at: 1,
      output: [{ type: "custom_tool_call", call_id: "call-1", name: shortName, input: "payload" }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    const response = await prepareCodexCustomToolResponse({
      upstream,
      requestedStream: false,
      model: "public-model",
      requestId,
      endpoint: "chat",
    });
    const payload = await response.json() as Record<string, unknown>;
    const choices = payload.choices as Array<Record<string, unknown>>;
    const message = choices[0]!.message as Record<string, unknown>;

    expect(message.tool_calls).toEqual([{
      id: "call-1",
      type: "function",
      function: { name: longName, arguments: "payload" },
    }]);
  });
});
