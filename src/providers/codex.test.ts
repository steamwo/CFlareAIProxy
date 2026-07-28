import { describe, expect, it } from "vitest";
import { chatToResponses } from "./codex";

function toolOutput(content: unknown): unknown {
  const converted = chatToResponses({
    messages: [
      { role: "user", content: "Inspect the tool output." },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content },
    ],
  }, "gpt-test");
  const input = converted.input as Array<Record<string, unknown>>;
  return input.find((item) => item.type === "function_call_output")?.output;
}

describe("Codex Chat Completions tool output conversion", () => {
  it("preserves text and input_image order", () => {
    expect(toolOutput([
      { type: "input_text", text: "Captured screenshot." },
      { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "original" },
      { type: "output_text", text: "End." },
    ])).toEqual([
      { type: "input_text", text: "Captured screenshot." },
      { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "original" },
      { type: "input_text", text: "End." },
    ]);
  });

  it("normalizes OpenAI image_url parts", () => {
    expect(toolOutput([{ type: "image_url", image_url: { url: "https://example.com/image.png", detail: "high" } }])).toEqual([
      { type: "input_image", image_url: "https://example.com/image.png", detail: "high" },
    ]);
  });

  it("recursively parses stringified image content", () => {
    expect(toolOutput(JSON.stringify([
      { type: "text", text: "Screenshot" },
      { type: "input_image", file_id: "file_123", detail: "low" },
    ]))).toEqual([
      { type: "input_text", text: "Screenshot" },
      { type: "input_image", file_id: "file_123", detail: "low" },
    ]);
  });

  it("keeps plain and text-only string outputs backward compatible", () => {
    expect(toolOutput("plain output")).toBe("plain output");
    const textOnly = JSON.stringify([{ type: "input_text", text: "still text" }]);
    expect(toolOutput(textOnly)).toBe(textOnly);
  });

  it("does not treat invalid image-shaped objects as images", () => {
    const invalid = JSON.stringify([{ type: "input_image", detail: "low" }]);
    expect(toolOutput(invalid)).toBe(invalid);
  });
});
