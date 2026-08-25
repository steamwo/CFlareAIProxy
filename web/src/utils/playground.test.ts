import { describe, expect, it } from "vitest";
import {
  buildPlaygroundRequest,
  extractPlaygroundText,
  gatewayKeyAllowedModelIds,
  parsePlaygroundAdvancedJson,
  parsePlaygroundResponsesStreamData,
  playgroundEndpoints,
  playgroundSseFrameData,
} from "./playground";
import type { PublicModel } from "../types";

const model: PublicModel = {
  id: "codex/gpt-5",
  display_name: "GPT-5",
  x_cflare_endpoints: ["chat", "responses"],
};

const messages = [
  { role: "user" as const, content: "hello" },
  { role: "assistant" as const, content: "hi" },
  { role: "user" as const, content: "continue" },
];

describe("model playground", () => {
  it("uses the endpoints declared by the public model", () => {
    expect(playgroundEndpoints(model)).toEqual(["responses", "chat"]);
  });

  it("parses a gateway key model allow-list without duplicates", () => {
    expect(gatewayKeyAllowedModelIds('["codex/gpt-5", " codex/gpt-5 ", "qoder/claude"]'))
      .toEqual(["codex/gpt-5", "qoder/claude"]);
    expect(gatewayKeyAllowedModelIds("not-json")).toEqual([]);
  });

  it("builds chat requests with the full conversation", () => {
    expect(buildPlaygroundRequest({
      endpoint: "chat",
      model: "codex/gpt-5",
      messages,
      systemPrompt: "be concise",
      maxTokens: 200,
      advanced: { top_p: 0.9 },
    })).toEqual({
      top_p: 0.9,
      model: "codex/gpt-5",
      stream: false,
      max_tokens: 200,
      messages: [
        { role: "system", content: "be concise" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "continue" },
      ],
    });
  });

  it("builds responses requests with structured conversation history", () => {
    expect(buildPlaygroundRequest({
      endpoint: "responses",
      model: "codex/gpt-5",
      messages,
      systemPrompt: "be concise",
      maxTokens: 200,
    })).toEqual({
      model: "codex/gpt-5",
      stream: false,
      max_output_tokens: 200,
      input: messages,
      instructions: "be concise",
    });
  });

  it("allows Responses streaming to override advanced stream values", () => {
    expect(buildPlaygroundRequest({
      endpoint: "responses",
      model: "codex/gpt-5",
      messages,
      stream: true,
      advanced: { stream: false },
    }).stream).toBe(true);
  });

  it("turns conversation history into a completions transcript", () => {
    expect(buildPlaygroundRequest({
      endpoint: "completions",
      model: "legacy-model",
      messages: messages.slice(0, 2),
      systemPrompt: "be concise",
    }).prompt).toBe("System: be concise\n\nUser: hello\n\nAssistant: hi\n\nAssistant:");
  });

  it("requires advanced parameters to be a JSON object", () => {
    expect(parsePlaygroundAdvancedJson('{"reasoning":{"effort":"high"}}')).toEqual({ reasoning: { effort: "high" } });
    expect(() => parsePlaygroundAdvancedJson("[]")).toThrow("高级参数必须是 JSON 对象");
  });

  it("extracts text from chat and responses payloads", () => {
    expect(extractPlaygroundText({ choices: [{ message: { content: "chat answer" } }] })).toBe("chat answer");
    expect(extractPlaygroundText({ output: [{ content: [{ type: "output_text", text: "response answer" }] }] }))
      .toBe("response answer");
  });

  it("extracts data and deltas from Responses SSE frames", () => {
    const frame = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}';
    expect(playgroundSseFrameData(frame)).toBe('{"type":"response.output_text.delta","delta":"hello"}');
    expect(parsePlaygroundResponsesStreamData(playgroundSseFrameData(frame))).toEqual({ delta: "hello" });
    expect(parsePlaygroundResponsesStreamData("[DONE]")).toEqual({ done: true });
  });

  it("uses completed Responses payload text as a streaming fallback", () => {
    expect(parsePlaygroundResponsesStreamData(JSON.stringify({
      type: "response.completed",
      response: { output: [{ content: [{ type: "output_text", text: "finished" }] }] },
    }))).toEqual({ completedText: "finished", done: true });
  });
});
