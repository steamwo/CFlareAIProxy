import { describe, expect, it } from "vitest";
import { normalizeChatUsageForAnthropic, prepareAnthropicChatBody } from "../src/anthropic-chat-compat";

describe("Anthropic Chat fallback compatibility", () => {
  it("recursively normalizes tool schemas and restores multimodal tool results", () => {
    const source = {
      model: "public-model",
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "text", text: "screenshot" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          ],
        }],
      }],
    };
    const chat = {
      model: "public-model",
      tools: [{
        type: "function",
        function: {
          name: "inspect",
          parameters: {
            type: "object",
            properties: {
              options: { type: "object" },
              variants: { type: "array", items: { type: "object" } },
            },
          },
        },
      }],
      messages: [{ role: "tool", tool_call_id: "toolu_1", content: "screenshot" }],
    };

    const prepared = prepareAnthropicChatBody(source, chat);
    const schema = (prepared.tools as any[])[0].function.parameters;
    expect(schema.properties.options.properties).toEqual({});
    expect(schema.properties.variants.items.properties).toEqual({});
    expect((prepared.messages as any[])[0].content).toEqual([
      { type: "text", text: "screenshot" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ]);
  });

  it("subtracts cached tokens from OpenAI prompt token totals in JSON", async () => {
    const response = await normalizeChatUsageForAnthropic(Response.json({
      id: "chatcmpl-1",
      choices: [],
      usage: {
        prompt_tokens: 10000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 8000 },
      },
    }));
    const payload = await response.json() as any;
    expect(payload.usage.prompt_tokens).toBe(2000);
    expect(payload.usage.prompt_tokens_details.cached_tokens).toBe(8000);
  });

  it("subtracts cached tokens from streaming usage frames without buffering the stream", async () => {
    const source = [
      `data: ${JSON.stringify({ id: "chatcmpl-s", choices: [{ delta: { content: "ok" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-s", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9 } } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const response = await normalizeChatUsageForAnthropic(new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }));
    const text = await response.text();
    expect(text).toContain('"prompt_tokens":3');
    expect(text).toContain('"cached_tokens":9');
    expect(text).toContain("data: [DONE]");
  });
});
