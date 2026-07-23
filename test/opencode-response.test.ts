import { describe, expect, it } from "vitest";
import { prepareDownstreamResponse } from "../src/stream";

describe("OpenCode Zen response conversion", () => {
  it("converts Anthropic Messages JSON to OpenAI Chat", async () => {
    const upstream = Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const downstream = await prepareDownstreamResponse(upstream, "anthropic-chat", false, "opencode/claude-haiku-4-5", "r1");
    const body = (await downstream.json()) as any;
    expect(body.choices[0].message.content).toBe("hello");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("lookup");
    expect(body.usage.total_tokens).toBe(18);
  });

  it("converts Google GenerateContent JSON to OpenAI Chat", async () => {
    const upstream = Response.json({
      candidates: [{
        content: { parts: [{ text: "world" }, { functionCall: { name: "search", args: { q: "y" } } }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    });
    const downstream = await prepareDownstreamResponse(upstream, "google-chat", false, "opencode/gemini-3.5-flash", "r2");
    const body = (await downstream.json()) as any;
    expect(body.choices[0].message.content).toBe("world");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("search");
    expect(body.usage.total_tokens).toBe(8);
  });

  it("converts Anthropic SSE text and emits OpenAI DONE", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stream" } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n\n");
    const upstream = new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const downstream = await prepareDownstreamResponse(upstream, "anthropic-chat", true, "opencode/claude-haiku-4-5", "r3");
    const output = await downstream.text();
    expect(output).toContain('"content":"stream"');
    expect(output).toContain("data: [DONE]");
  });
});
