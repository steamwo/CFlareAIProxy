import { describe, expect, it } from "vitest";
import {
  buildPlaygroundRequest,
  extractPlaygroundText,
  gatewayKeyAllowedModelIds,
  parsePlaygroundAdvancedJson,
  playgroundEndpoints,
} from "./playground";
import type { PublicModel } from "../types";

const model: PublicModel = {
  id: "codex/gpt-5",
  display_name: "GPT-5",
  x_cflare_endpoints: ["chat", "responses"],
};

describe("model playground", () => {
  it("uses the endpoints declared by the public model", () => {
    expect(playgroundEndpoints(model)).toEqual(["responses", "chat"]);
  });

  it("parses a gateway key model allow-list without duplicates", () => {
    expect(gatewayKeyAllowedModelIds('["codex/gpt-5", " codex/gpt-5 ", "qoder/claude"]'))
      .toEqual(["codex/gpt-5", "qoder/claude"]);
    expect(gatewayKeyAllowedModelIds("not-json")).toEqual([]);
  });

  it("builds chat and responses requests without changing gateway semantics", () => {
    expect(buildPlaygroundRequest({
      endpoint: "chat",
      model: "codex/gpt-5",
      prompt: "hello",
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
      ],
    });

    expect(buildPlaygroundRequest({
      endpoint: "responses",
      model: "codex/gpt-5",
      prompt: "hello",
      systemPrompt: "be concise",
      maxTokens: 200,
    })).toEqual({
      model: "codex/gpt-5",
      stream: false,
      max_output_tokens: 200,
      input: "hello",
      instructions: "be concise",
    });
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
});
