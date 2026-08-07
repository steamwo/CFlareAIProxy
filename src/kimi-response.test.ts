import { describe, expect, it } from "vitest";
import { prepareKimiResponse } from "./kimi-response";

function sse(...events: Array<Record<string, unknown> | "[DONE]">): Response {
  const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function prepare(upstream: Response): Promise<Response> {
  return prepareKimiResponse({
    upstream,
    requestedStream: true,
    model: "kimi-test",
    requestId: "request-1",
    endpoint: "responses",
  });
}

function parsedEvents(text: string): Array<Record<string, unknown>> {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data) as Record<string, unknown>];
  });
}

describe("Kimi Chat to Responses stream completion", () => {
  it("treats explicit DONE as terminal without finish_reason and suppresses duplicates", async () => {
    const response = await prepare(sse(
      { choices: [{ delta: { content: "hello" } }] },
      "[DONE]",
      "[DONE]",
    ));
    const text = await response.text();
    const events = parsedEvents(text);
    const completed = events.filter((event) => event.type === "response.completed");

    expect(completed).toHaveLength(1);
    expect((completed[0]?.response as Record<string, unknown>).output).toEqual([
      {
        id: "msg_request-1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ]);
    expect(completed[0]?.response).not.toHaveProperty("usage");
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("forwards usage only when the upstream supplied it", async () => {
    const response = await prepare(sse(
      {
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 1 },
        },
      },
      "[DONE]",
    ));
    const completed = parsedEvents(await response.text()).find((event) => event.type === "response.completed");
    expect(completed?.response).toMatchObject({
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        total_tokens: 7,
        input_tokens_details: { cached_tokens: 1 },
      },
    });
  });

  it("keeps EOF without DONE as an incomplete stream failure", async () => {
    const response = await prepare(sse({ choices: [{ delta: { content: "partial" } }] }));
    await expect(response.text()).rejects.toThrow(/KIMI_STREAM_INCOMPLETE/);
  });
});
