import { describe, expect, it } from "vitest";
import { chatToResponses, normalizeCodexInputMessageIds } from "./codex";

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

  it("recursively parses nested stringified image content", () => {
    expect(toolOutput({
      content: JSON.stringify([
        { type: "input_text", text: "Nested screenshot" },
        { type: "input_image", image_url: "data:image/png;base64,BB==" },
      ]),
    })).toEqual([
      { type: "input_text", text: "Nested screenshot" },
      { type: "input_image", image_url: "data:image/png;base64,BB==" },
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

describe("Codex Responses input item IDs", () => {
  it("normalizes every upstream-supported item ID and leaves other item types unchanged", () => {
    const input = [
      { type: "message", id: "item_message", role: "user" },
      { type: "reasoning", id: "item_reasoning" },
      { type: "function_call", id: "item_function_call", call_id: "call_1" },
      { type: "function_call_output", id: "item_function_call_output", call_id: "call_1" },
      { type: "custom_tool_call", id: "item_custom_tool_call", call_id: "call_2" },
      { type: "custom_tool_call_output", id: "item_custom_tool_call_output", call_id: "call_2" },
      { type: "message", id: "msg-existing" },
      { type: "reasoning", id: "rs-existing" },
      { type: "function_call", id: "fc-existing", call_id: "call_3" },
      { type: "custom_tool_call", id: "ctc-existing", call_id: "call_4" },
      { type: "custom_tool_call_output", id: "ctco-existing", call_id: "call_4" },
    ];
    const once = normalizeCodexInputMessageIds(input) as Array<Record<string, unknown>>;

    expect(once.map((item) => item.id)).toEqual([
      "msg_item_message",
      "rs_item_reasoning",
      "fc_item_function_call",
      "item_function_call_output",
      "ctc_item_custom_tool_call",
      "ctco_item_custom_tool_call_output",
      "msg-existing",
      "rs-existing",
      "fc-existing",
      "ctc-existing",
      "ctco-existing",
    ]);
    expect(normalizeCodexInputMessageIds(once)).toEqual(once);
  });

  it("prefixes supported IDs before applying the 64 character limit", () => {
    const longId = `item_${"x".repeat(80)}`;
    const normalized = normalizeCodexInputMessageIds([
      { type: "message", id: longId },
      { type: "reasoning", id: longId },
      { type: "function_call", id: longId },
      { type: "custom_tool_call", id: longId },
      { type: "custom_tool_call_output", id: longId },
    ]) as Array<Record<string, unknown>>;

    expect(normalized.map((item) => item.id)).toEqual([
      `msg_${longId}`.slice(0, 64),
      `rs_${longId}`.slice(0, 64),
      `fc_${longId}`.slice(0, 64),
      `ctc_${longId}`.slice(0, 64),
      `ctco_${longId}`.slice(0, 64),
    ]);
    expect(normalized.every((item) => String(item.id).length === 64)).toBe(true);
  });

  it("preserves already valid prefixes and is idempotent", () => {
    const input = [
      { type: "message", id: `msg_${"m".repeat(80)}` },
      { type: "reasoning", id: `rs_${"r".repeat(80)}` },
      { type: "function_call", id: `fc_${"f".repeat(80)}` },
      { type: "custom_tool_call", id: `ctc_${"c".repeat(80)}` },
      { type: "custom_tool_call_output", id: `ctco_${"o".repeat(80)}` },
    ];
    const once = normalizeCodexInputMessageIds(input) as Array<Record<string, unknown>>;
    const twice = normalizeCodexInputMessageIds(once);

    expect(once.every((item) => String(item.id).length === 64)).toBe(true);
    expect(String(once[0]?.id).startsWith("msg_")).toBe(true);
    expect(String(once[1]?.id).startsWith("rs_")).toBe(true);
    expect(String(once[2]?.id).startsWith("fc_")).toBe(true);
    expect(String(once[3]?.id).startsWith("ctc_")).toBe(true);
    expect(String(once[4]?.id).startsWith("ctco_")).toBe(true);
    expect(twice).toEqual(once);
  });

  it("keeps duplicate message IDs stable instead of inventing request-local suffixes", () => {
    const normalized = normalizeCodexInputMessageIds([
      { type: "message", id: "duplicate" },
      { type: "message", id: "duplicate" },
    ]) as Array<Record<string, unknown>>;
    expect(normalized.map((item) => item.id)).toEqual(["msg_duplicate", "msg_duplicate"]);
  });
});
