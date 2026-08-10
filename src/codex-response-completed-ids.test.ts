import { describe, expect, it } from "vitest";
import { prepareCodexResponse } from "./codex-response";

function sse(...events: Array<Record<string, unknown> | "[DONE]">): Response {
  const text = events.map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function context(upstream: Response, requestedStream: boolean) {
  return {
    upstream,
    requestedStream,
    model: "gpt-codex",
    requestId: "request-completed-ids",
    endpoint: "responses" as const,
  };
}

describe("Codex response.completed output item IDs", () => {
  it("hydrates only missing or empty IDs in non-streamed SSE aggregation", async () => {
    const response = await prepareCodexResponse(context(sse(
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_123", type: "function_call", name: "weather-done", arguments: "{\"source\":\"done\"}" } },
      { type: "response.output_item.done", output_index: 1, item: { id: "fc_done_existing", type: "function_call", name: "other", arguments: "{}" } },
      { type: "response.output_item.done", output_index: 2, item: { id: "", type: "message", content: [] } },
      { type: "response.output_item.done", output_index: 4, item: { id: "msg_4", type: "message", content: [] } },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [
            { id: null, type: "function_call", name: "weather-terminal", arguments: "{\"source\":\"terminal\"}" },
            { id: "fc_existing", type: "function_call", name: "preserved", arguments: "{}" },
            { id: null, type: "message", content: [] },
            { id: "", type: "message", content: [] },
            { type: "message", content: [] },
          ],
        },
      },
      "[DONE]",
    ), false));

    const payload = await response.json() as { output: Array<Record<string, unknown>> };
    expect(payload.output[0]).toEqual({
      id: "fc_123",
      type: "function_call",
      name: "weather-terminal",
      arguments: "{\"source\":\"terminal\"}",
    });
    expect(payload.output[1]?.id).toBe("fc_existing");
    expect(payload.output[2]?.id).toBeNull();
    expect(payload.output[3]?.id).toBe("");
    expect(payload.output[4]?.id).toBe("msg_4");
  });

  it("does not rewrite non-empty response.completed output in streaming passthrough", async () => {
    const response = await prepareCodexResponse(context(sse(
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_123", type: "function_call", name: "weather", arguments: "{}" } },
      { type: "response.completed", response: { id: "resp_1", output: [{ id: null, type: "function_call", name: "weather-terminal", arguments: "{}" }] } },
      "[DONE]",
    ), true));

    const text = await response.text();
    const completed = text
      .split(/\r?\n\r?\n/)
      .map((frame) => frame.startsWith("data: ") ? frame.slice(6) : "")
      .filter((data) => data && data !== "[DONE]")
      .map((data) => JSON.parse(data) as Record<string, unknown>)
      .find((event) => event.type === "response.completed");
    const output = ((completed?.response as Record<string, unknown>)?.output ?? []) as Array<Record<string, unknown>>;
    expect(output[0]?.id).toBeNull();
    expect(output[0]?.name).toBe("weather-terminal");
  });
});
