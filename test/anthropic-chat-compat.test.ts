import { describe, expect, it } from "vitest";
import {
  anthropicMessagesToChat, chatCompletionToAnthropic, chatResponseToAnthropic,
} from "../src/anthropic-downstream";

describe("Anthropic hardened Chat translation", () => {
  it("recursively normalizes tool schemas and preserves multimodal tool results", () => {
    const converted = anthropicMessagesToChat({
      model: "public-model",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "inspect", input: {} }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "screenshot" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
            ],
          }],
        },
      ],
      tools: [{
        name: "inspect",
        input_schema: {
          type: "object",
          properties: {
            options: { type: "object" },
            variants: { type: "array", items: { type: "object" } },
          },
        },
      }],
    });

    const schema = (converted.tools as any[])[0].function.parameters;
    expect(schema.properties.options.properties).toEqual({});
    expect(schema.properties.variants.items.properties).toEqual({});
    expect((converted.messages as any[])[1].content).toEqual([
      { type: "text", text: "screenshot" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ]);
  });

  it("reports cached tokens separately from Anthropic input_tokens", () => {
    const converted = chatCompletionToAnthropic({
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 8000 },
      },
    });
    expect(converted.usage).toEqual({
      input_tokens: 2000,
      output_tokens: 20,
      cache_read_input_tokens: 8000,
    });
  });

  it("reports cached tokens correctly in Anthropic streaming usage", async () => {
    const source = [
      `data: ${JSON.stringify({ id: "chatcmpl-s", model: "public-model", choices: [{ delta: { content: "ok" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-s", model: "public-model", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9 } } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const response = await chatResponseToAnthropic(new Response(source, {
      headers: { "content-type": "text/event-stream" },
    }), true, "public-model");
    const text = await response.text();
    expect(text).toContain('"input_tokens":3');
    expect(text).toContain('"cache_read_input_tokens":9');
    expect(text).toContain('"output_tokens":2');
  });

  it("keeps UTF-8 decoder state isolated across concurrent SSE responses", async () => {
    const encoder = new TextEncoder();
    const responseFor = async (character: string): Promise<Response> => {
      const frame = `data: ${JSON.stringify({ id: `chat-${character}`, model: "public-model", choices: [{ delta: { content: character }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`;
      const characterOffset = encoder.encode(frame.slice(0, frame.indexOf(character))).byteLength;
      const bytes = encoder.encode(frame);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, characterOffset + 1));
          queueMicrotask(() => {
            controller.enqueue(bytes.slice(characterOffset + 1));
            controller.close();
          });
        },
      });
      return chatResponseToAnthropic(new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }), true, "public-model");
    };

    const [left, right] = await Promise.all([(await responseFor("你")).text(), (await responseFor("好")).text()]);
    expect(left).toContain("你");
    expect(right).toContain("好");
    expect(left).not.toContain("�");
    expect(right).not.toContain("�");
  });
});
