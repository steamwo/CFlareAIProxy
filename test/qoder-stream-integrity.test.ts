import { describe, expect, it } from "vitest";
import { prepareQoderResponse } from "../src/qoder-response";

function qoderEvent(inner: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(inner) })}\n\n`;
}

function upstream(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function context(response: Response, requestedStream: boolean) {
  return {
    upstream: response,
    mode: "qoder-chat" as const,
    requestedStream,
    model: "Qoder Test",
    requestId: "req-1",
    providerKind: "qoder" as const,
    endpoint: "chat" as const,
  };
}

describe("Qoder stream integrity", () => {
  it("preserves an initial full-message prefix and suppresses the final aggregate snapshot", async () => {
    const source =
      qoderEvent({ choices: [{ message: { role: "assistant", content: "prefix " }, finish_reason: null }] })
      + qoderEvent({ choices: [{ delta: { content: "suffix" }, finish_reason: null }] })
      + qoderEvent({ choices: [{ message: { role: "assistant", content: "prefix suffix" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 } })
      + "data: [DONE]\n\n";

    const response = await prepareQoderResponse(context(upstream(source), true));
    const text = await response.text();

    expect(text.match(/"content":"prefix "/g)?.length).toBe(1);
    expect(text.match(/"content":"suffix"/g)?.length).toBe(1);
    expect(text).not.toContain('"content":"prefix suffix"');
    expect(text).not.toContain('"message":');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("deduplicates the same mixed frames for buffered chat responses", async () => {
    const source =
      qoderEvent({ choices: [{ message: { role: "assistant", content: "prefix " }, finish_reason: null }] })
      + qoderEvent({ choices: [{ delta: { content: "suffix" }, finish_reason: null }] })
      + qoderEvent({ choices: [{ message: { role: "assistant", content: "prefix suffix" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 8, total_tokens: 11 } })
      + "data: [DONE]\n\n";

    const response = await prepareQoderResponse(context(upstream(source), false));
    const payload = await response.json() as Record<string, unknown>;
    const choices = payload.choices as Array<Record<string, unknown>>;
    expect(choices).toHaveLength(1);
    const firstChoice = choices[0];
    expect(firstChoice).toBeDefined();
    const message = firstChoice?.message as Record<string, unknown>;
    expect(message.content).toBe("prefix suffix");
    expect(payload.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 8,
      total_tokens: 11,
      prompt_tokens_details: { cached_tokens: 0 },
    });
  });

  it("adds stable indexes to full-message parallel tool calls", async () => {
    const source = qoderEvent({
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call-a", type: "function", function: { name: "alpha", arguments: "{}" } },
            { id: "call-b", type: "function", function: { name: "beta", arguments: "{\"x\":1}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    }) + "data: [DONE]\n\n";

    const response = await prepareQoderResponse(context(upstream(source), true));
    const text = await response.text();
    expect(text).toContain('"index":0');
    expect(text).toContain('"index":1');
    expect(text).toContain('"id":"call-a"');
    expect(text).toContain('"id":"call-b"');
  });
});
