import { describe, expect, it } from "vitest";
import {
  routeRuntimeOptions,
  validateModelCapabilities,
  type ModelCapabilities,
} from "./model-capabilities";
import {
  OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT,
  markOpenAiTextOnlyToolResultNormalization,
  normalizeOpenAiToolResultsTextOnly,
  prepareOpenAiToolResultsForValidation,
} from "./openai-tool-results";
import type { Env, ModelRouteRow } from "./types";

function envForProviderKind(providerKind: string): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            provider_kind: providerKind,
            provider_options_json: "{}",
            capabilities_json: null,
            raw_json: null,
          }),
        }),
      }),
    },
  } as unknown as Env;
}

function textOnlyRoute(): ModelRouteRow {
  return {
    provider_id: "provider-1",
    upstream_model: "text-only-upstream",
    options_json: JSON.stringify({ capabilities: { input_modalities: ["text"] } }),
  } as ModelRouteRow;
}

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

  it("drops a relay-only synthetic user message and marks the preceding tool", () => {
    const normalized = normalizeOpenAiToolResultsTextOnly({
      messages: [
        { role: "tool", tool_call_id: "call_1", content: "image inspected" },
        {
          role: "user",
          content: [
            { type: "text", text: "Images returned by the preceding tool call(s):" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        },
      ],
    });
    const messages = normalized.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(`image inspected\n\n${OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT}`);
  });

  it("replaces the known relay placeholder without duplicating the omission marker", () => {
    const normalized = normalizeOpenAiToolResultsTextOnly({
      messages: [
        { role: "tool", tool_call_id: "call_1", content: "[Tool returned image content; the images follow in the next user message.]" },
        {
          role: "user",
          content: [
            { type: "text", text: "Images returned by the preceding tool call(s):" },
            { type: "image_url", image_url: { url: "https://example.com/tool.png" } },
          ],
        },
      ],
    });
    const messages = normalized.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT);
  });

  it("preserves real user parts while stripping the relay notice and relayed images", () => {
    const normalized = normalizeOpenAiToolResultsTextOnly({
      messages: [
        { role: "tool", tool_call_id: "call_1", content: "image inspected" },
        {
          role: "user",
          content: [
            { type: "text", text: "Images returned by the preceding tool call(s):" },
            { type: "image_url", image_url: { url: "https://example.com/tool.png" } },
            { type: "text", text: "What color is the car?" },
          ],
        },
      ],
    });
    const messages = normalized.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe(`image inspected\n\n${OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT}`);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "What color is the car?" }]);
  });

  it("marks only the nearest contiguous preceding tool when no placeholder was already marked", () => {
    const normalized = normalizeOpenAiToolResultsTextOnly({
      messages: [
        { role: "tool", tool_call_id: "call_1", content: "first result" },
        { role: "tool", tool_call_id: "call_2", content: "second result" },
        {
          role: "user",
          content: [
            { type: "text", text: "Images returned by the preceding tool call(s):" },
            { type: "input_image", image_url: "https://example.com/tool.png" },
          ],
        },
      ],
    });
    const messages = normalized.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("first result");
    expect(messages[1]?.content).toBe(`second result\n\n${OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT}`);
  });

  it("does not strip ordinary user images without the exact relay notice", () => {
    const userContent = [
      { type: "text", text: "Please inspect this image" },
      { type: "image_url", image_url: { url: "https://example.com/user.png" } },
    ];
    const normalized = normalizeOpenAiToolResultsTextOnly({
      messages: [{ role: "user", content: userContent }],
    });
    expect((normalized.messages as Array<Record<string, unknown>>)[0]?.content).toBe(userContent);
  });

  it("restores a stripped relay message before retrying an image-capable route", () => {
    const textOnly = { inputModalities: ["text"] } satisfies ModelCapabilities;
    const imageCapable = { inputModalities: ["text", "image"] } satisfies ModelCapabilities;
    markOpenAiTextOnlyToolResultNormalization(textOnly);
    markOpenAiTextOnlyToolResultNormalization(imageCapable);

    const originalMessages = [
      { role: "tool", tool_call_id: "call_1", content: "image inspected" },
      {
        role: "user",
        content: [
          { type: "text", text: "Images returned by the preceding tool call(s):" },
          { type: "image_url", image_url: { url: "https://example.com/tool.png" } },
        ],
      },
    ];
    const body: Record<string, unknown> = { messages: originalMessages };

    prepareOpenAiToolResultsForValidation(body, textOnly);
    expect(body.messages).not.toBe(originalMessages);
    expect(body.messages as unknown[]).toHaveLength(1);

    prepareOpenAiToolResultsForValidation(body, imageCapable);
    expect(body.messages).toBe(originalMessages);
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

  it("activates only for OpenAI-compatible routes and still rejects ordinary image input", async () => {
    const route = textOnlyRoute();
    const openAi = await routeRuntimeOptions(envForProviderKind("openai-compatible"), route, "chat");
    const toolOnly: Record<string, unknown> = {
      messages: [{ role: "tool", content: [{ type: "image_url", image_url: { url: "https://example.com/tool.png" } }] }],
    };
    expect(() => validateModelCapabilities(toolOnly, openAi.capabilities)).not.toThrow();
    expect((toolOnly.messages as Array<Record<string, unknown>>)[0]?.content).toBe(OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT);

    const userImage: Record<string, unknown> = {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/user.png" } }] }],
    };
    expect(() => validateModelCapabilities(userImage, openAi.capabilities)).toThrow(/does not support image input/i);

    const custom = await routeRuntimeOptions(envForProviderKind("custom"), route, "chat");
    const customTool: Record<string, unknown> = {
      messages: [{ role: "tool", content: [{ type: "image_url", image_url: { url: "https://example.com/tool.png" } }] }],
    };
    expect(() => validateModelCapabilities(customTool, custom.capabilities)).toThrow(/does not support image input/i);
    expect(Array.isArray((customTool.messages as Array<Record<string, unknown>>)[0]?.content)).toBe(true);
  });
});
