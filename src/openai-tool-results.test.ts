import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "./model-capabilities";
import {
  OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT,
  markOpenAiTextOnlyToolResultNormalization,
  normalizeOpenAiToolResultsTextOnly,
  prepareOpenAiToolResultsForValidation,
} from "./openai-tool-results";

describe("OpenAI-compatible text-only tool results", () => {
  it("flattens only tool message content and preserves ordinary multimodal messages", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "before" }] },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "image inspected" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        },
        { role: "tool", tool_call_id: "call_2", content: "already text" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/user.png" } }] },
      ],
    };

    const normalized = normalizeOpenAiToolResultsTextOnly(body);
    const messages = normalized.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.content).toBe(`image inspected\n\n${OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT}`);
    expect(messages[2]?.content).toBe("already text");
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    expect(Array.isArray(messages[3]?.content)).toBe(true);
    expect(body.messages[1]?.content).toBeInstanceOf(Array);
  });

  it("serializes unknown JSON content and replaces image-shaped objects", () => {
    const normalized = normalizeOpenAiToolResultsTextOnly({
      messages: [
        { role: "tool", content: [{ type: "custom", value: 1 }, 7, true, null] },
        { role: "tool", content: { type: "image", source: { type: "base64", data: "AA==" } } },
        { role: "tool", content: { text: "plain object text", extra: true } },
      ],
    });
    const messages = normalized.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.content).toBe('{"type":"custom","value":1}\n\n7\n\ntrue\n\nnull');
    expect(messages[1]?.content).toBe(OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT);
    expect(messages[2]?.content).toBe("plain object text");
  });

  it("restores original tool content before evaluating a different route", () => {
    const textOnly = { inputModalities: ["text"] } satisfies ModelCapabilities;
    const imageCapable = { inputModalities: ["text", "image"] } satisfies ModelCapabilities;
    markOpenAiTextOnlyToolResultNormalization(textOnly);
    markOpenAiTextOnlyToolResultNormalization(imageCapable);

    const originalToolContent = [{ type: "image_url", image_url: { url: "https://example.com/tool.png" } }];
    const body: Record<string, unknown> = {
      messages: [
        { role: "tool", content: originalToolContent },
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/user.png" } }] },
      ],
    };

    prepareOpenAiToolResultsForValidation(body, textOnly);
    const normalizedMessages = body.messages as Array<Record<string, unknown>>;
    expect(normalizedMessages[0]?.content).toBe(OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT);
    expect(Array.isArray(normalizedMessages[1]?.content)).toBe(true);

    prepareOpenAiToolResultsForValidation(body, imageCapable);
    const restoredMessages = body.messages as Array<Record<string, unknown>>;
    expect(restoredMessages[0]?.content).toBe(originalToolContent);
    expect(Array.isArray(restoredMessages[1]?.content)).toBe(true);
  });

  it("does not enable normalization for unspecified modalities", () => {
    const capabilities = {} satisfies ModelCapabilities;
    markOpenAiTextOnlyToolResultNormalization(capabilities);
    const body: Record<string, unknown> = {
      messages: [{ role: "tool", content: [{ type: "image_url", image_url: { url: "https://example.com/tool.png" } }] }],
    };
    prepareOpenAiToolResultsForValidation(body, capabilities);
    expect(Array.isArray((body.messages as Array<Record<string, unknown>>)[0]?.content)).toBe(true);
  });
});
