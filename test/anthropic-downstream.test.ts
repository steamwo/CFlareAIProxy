import { describe, expect, it } from "vitest";
import {
  anthropicMessagesToChat, chatCompletionToAnthropic, chatResponseToAnthropic,
} from "../src/anthropic-downstream";

describe("Anthropic downstream compatibility", () => {
  it("converts Anthropic messages, tools, images and tool results to Chat Completions", () => {
    const converted = anthropicMessagesToChat({
      model: "qoder/qwen3-coder",
      system: [{ type: "text", text: "You are a coding agent." }],
      max_tokens: 4096,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 4096 },
      tools: [{
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", required: ["path"] },
      }],
      tool_choice: { type: "tool", name: "read_file", disable_parallel_tool_use: true },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need the file." },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "contents" },
            { type: "text", text: "continue" },
          ],
        },
      ],
    });

    expect(converted.model).toBe("qoder/qwen3-coder");
    expect(converted.stream).toBe(true);
    expect(converted.stream_options).toEqual({ include_usage: true });
    expect(converted.reasoning_effort).toBe("medium");
    expect((converted.messages as any[])[0]).toEqual({ role: "system", content: "You are a coding agent." });
    expect((converted.messages as any[])[1].content[1].image_url.url).toBe("data:image/png;base64,aGVsbG8=");
    expect((converted.messages as any[])[2].tool_calls[0].function.arguments).toBe('{"path":"README.md"}');
    expect((converted.messages as any[])[3]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "contents" });
    expect((converted.messages as any[])[4].role).toBe("user");
    expect((converted.tools as any[])[0].function.parameters.properties).toEqual({});
    expect(converted.tool_choice).toEqual({ type: "function", function: { name: "read_file" } });
    expect(converted.parallel_tool_calls).toBe(false);
  });

  it("converts a Chat Completions response to an Anthropic message", () => {
    const converted = chatCompletionToAnthropic({
      id: "chatcmpl-1",
      model: "public-model",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "I'll inspect it.",
          reasoning_content: "Need a tool.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
    });

    expect(converted.type).toBe("message");
    expect(converted.id).toBe("msg_chatcmpl-1");
    expect(converted.stop_reason).toBe("tool_use");
    expect((converted.content as any[])[0]).toEqual({ type: "thinking", thinking: "Need a tool." });
    expect((converted.content as any[])[1]).toEqual({ type: "text", text: "I'll inspect it." });
    expect((converted.content as any[])[2]).toEqual({ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } });
    expect(converted.usage).toEqual({ input_tokens: 9, output_tokens: 7, cache_read_input_tokens: 3 });
  });

  it("converts Chat Completions SSE into Anthropic Messages SSE", async () => {
    const source = [
      `data: ${JSON.stringify({ id: "chatcmpl-s", model: "public-model", choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-s", model: "public-model", choices: [{ delta: { content: "hello" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-s", model: "public-model", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "lookup", arguments: '{"q":' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-s", model: "public-model", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl-s", model: "public-model", choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const response = new Response(source, { headers: { "content-type": "text/event-stream" } });
    const converted = await chatResponseToAnthropic(response, true, "public-model");
    const text = await converted.text();

    expect(converted.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta","text":"hello"');
    expect(text).toContain('"type":"tool_use","id":"call_9","name":"lookup"');
    expect(text).toContain('"partial_json":"{\\"q\\":\\"x\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).toContain('"input_tokens":5');
    expect(text).toContain('"output_tokens":4');
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("data: [DONE]");
  });
});
