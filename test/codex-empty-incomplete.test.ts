import { describe, expect, it } from "vitest";
import { prepareCodexResponse } from "../src/codex-response";
import type { GatewayEndpoint } from "../src/types";

function sse(...events: Array<Record<string, unknown> | "[DONE]">): Response {
  const body = events
    .map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function context(upstream: Response, requestedStream = false, endpoint: GatewayEndpoint = "responses") {
  return {
    upstream,
    requestedStream,
    endpoint,
    model: "gpt-codex",
    requestId: "request-empty-incomplete",
  };
}

function emptyIncomplete(outputTokens: unknown = 0): Record<string, unknown> {
  return {
    type: "response.incomplete",
    response: {
      id: "resp_incomplete",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
      usage: { input_tokens: 10, output_tokens: outputTokens, total_tokens: 10 },
    },
  };
}

describe("Codex empty incomplete responses", () => {
  it("rejects a buffered zero-token incomplete terminal with no output", async () => {
    await expect(prepareCodexResponse(context(sse(emptyIncomplete()))))
      .rejects.toMatchObject({ status: 502, code: "CODEX_EMPTY_INCOMPLETE" });
  });

  it("rejects empty and whitespace-only deltas before a zero-token incomplete terminal", async () => {
    for (const delta of ["", "   "]) {
      await expect(prepareCodexResponse(context(sse(
        { type: "response.output_text.delta", delta },
        emptyIncomplete(),
      )))).rejects.toMatchObject({ code: "CODEX_EMPTY_INCOMPLETE" });
    }
  });

  it("preserves a partial incomplete response after meaningful text output", async () => {
    const response = await prepareCodexResponse(context(sse(
      { type: "response.output_text.delta", delta: "partial" },
      emptyIncomplete(),
    )));
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.status).toBe("incomplete");
  });

  it("preserves a partial incomplete response after meaningful reasoning or tool argument output", async () => {
    for (const event of [
      { type: "response.reasoning_summary_text.delta", delta: "reasoning" },
      { type: "response.function_call_arguments.delta", delta: "{\"q\":" },
    ]) {
      const response = await prepareCodexResponse(context(sse(event, emptyIncomplete())));
      const payload = await response.json() as Record<string, unknown>;
      expect(payload.status).toBe("incomplete");
    }
  });

  it("preserves incomplete responses that already contain completed output items", async () => {
    const response = await prepareCodexResponse(context(sse(
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "partial" }],
        },
      },
      emptyIncomplete(),
    )));
    const payload = await response.json() as { output?: unknown[] };
    expect(payload.output).toHaveLength(1);
  });

  it("does not classify nonzero or missing output-token usage as the empty-incomplete failure", async () => {
    for (const event of [
      emptyIncomplete(1),
      {
        type: "response.incomplete",
        response: { id: "resp_missing", status: "incomplete", output: [], usage: { input_tokens: 10 } },
      },
    ]) {
      const response = await prepareCodexResponse(context(sse(event)));
      expect(response.status).toBe(200);
    }
  });

  it("surfaces the failure from streaming responses instead of emitting a successful terminal", async () => {
    const response = await prepareCodexResponse(context(sse(emptyIncomplete()), true, "responses"));
    await expect(response.text()).rejects.toMatchObject({ code: "CODEX_EMPTY_INCOMPLETE" });
  });

  it("surfaces the same failure through the streaming chat conversion path", async () => {
    const response = await prepareCodexResponse(context(sse(emptyIncomplete()), true, "chat"));
    await expect(response.text()).rejects.toMatchObject({ code: "CODEX_EMPTY_INCOMPLETE" });
  });

  it("rejects an application/json response.incomplete event with explicit zero output tokens", async () => {
    const upstream = Response.json(emptyIncomplete());
    await expect(prepareCodexResponse(context(upstream)))
      .rejects.toMatchObject({ code: "CODEX_EMPTY_INCOMPLETE" });
  });
});
