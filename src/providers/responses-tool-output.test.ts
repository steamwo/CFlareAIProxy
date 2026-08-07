import { describe, expect, it } from "vitest";
import type { ProxyRequestContext } from "../types";
import { buildKimiRequest } from "./kimi";
import { responsesToolOutputToChatContent } from "./responses-tool-output";

describe("Responses structured tool output to Chat content", () => {
  it("keeps plain and text-only structured outputs as strings", () => {
    expect(responsesToolOutputToChatContent("plain output")).toBe("plain output");
    expect(responsesToolOutputToChatContent([{ type: "input_text", text: "still text" }]))
      .toBe('[{"type":"input_text","text":"still text"}]');
    expect(responsesToolOutputToChatContent([])).toBe("[]");
  });

  it("converts input_text and input_image while normalizing detail", () => {
    expect(responsesToolOutputToChatContent([
      { type: "input_text", text: "Captured screenshot." },
      { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "original" },
    ])).toEqual([
      { type: "text", text: "Captured screenshot." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
    ]);
  });

  it("converts stringified image_url output and preserves supported detail", () => {
    const output = JSON.stringify([
      { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "LOW" } },
    ]);
    expect(responsesToolOutputToChatContent(output)).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "low" } },
    ]);
  });

  it("omits unknown string detail and serializes unknown parts beside valid images", () => {
    expect(responsesToolOutputToChatContent([
      { type: "custom", value: 1 },
      { type: "input_image", image_url: "https://example.com/image.png", detail: "unsupported" },
    ])).toEqual([
      { type: "text", text: '{"type":"custom","value":1}' },
      { type: "image_url", image_url: { url: "https://example.com/image.png" } },
    ]);
  });

  it("falls back to the original JSON string when a known image part is invalid", () => {
    const invalidDetail = [
      { type: "input_image", image_url: "https://example.com/image.png", detail: 123 },
    ];
    const missingUrl = [{ type: "input_image", detail: "low" }];
    const invalidText = [
      { type: "input_text", text: 123 },
      { type: "input_image", image_url: "https://example.com/image.png" },
    ];

    expect(responsesToolOutputToChatContent(invalidDetail)).toBe(JSON.stringify(invalidDetail));
    expect(responsesToolOutputToChatContent(missingUrl)).toBe(JSON.stringify(missingUrl));
    expect(responsesToolOutputToChatContent(invalidText)).toBe(JSON.stringify(invalidText));
  });
});

function kimiContext(output: unknown): ProxyRequestContext {
  return {
    requestId: "request-structured-tool-output",
    endpoint: "responses",
    publicModel: "public-kimi",
    upstreamModel: "kimi-k2",
    body: {
      stream: false,
      input: [
        { type: "function_call", call_id: "call_image", name: "inspect", arguments: "{}" },
        { type: "function_call_output", call_id: "call_image", output },
      ],
    },
    originalRequest: new Request("https://gateway.example/v1/responses", { method: "POST" }),
    provider: {
      id: "provider-kimi",
      name: "Kimi",
      kind: "kimi",
      base_url: "https://kimi.example",
      enabled: 1,
      pool_strategy: "round_robin",
      endpoints_json: "{}",
      auth_json: "{}",
      headers_json: "{}",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
      endpoints: { chat: "/chat/completions" },
      auth: {},
      headers: {},
      options: {},
    },
    credential: {
      id: "credential-kimi",
      provider_id: "provider-kimi",
      label: "test",
      auth_type: "bearer",
      secret_ciphertext: "",
      refresh_ciphertext: null,
      expires_at: null,
      enabled: 1,
      priority: 0,
      weight: 1,
      max_concurrency: 1,
      metadata_json: "{}",
      last_error: null,
      last_used_at: null,
      created_at: 0,
      updated_at: 0,
      secret: "test-token",
      metadata: {},
    },
  };
}

describe("Kimi Responses request translation", () => {
  it("normalizes structured function_call_output before sending Chat messages", () => {
    const request = buildKimiRequest(kimiContext([
      { type: "input_text", text: "Screenshot" },
      { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "original" },
    ]));
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    const tool = messages.find((message) => message.role === "tool");

    expect(tool?.tool_call_id).toBe("call_image");
    expect(tool?.content).toEqual([
      { type: "text", text: "Screenshot" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
    ]);
  });
});
