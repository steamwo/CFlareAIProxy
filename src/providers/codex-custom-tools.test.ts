import { describe, expect, it } from "vitest";
import { translateCodexChatCustomTools } from "./codex-custom-tools";

function inputItems(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : [];
}

describe("Codex custom tool request translation", () => {
  it("shortens custom tool names consistently and preserves reverse mapping", () => {
    const longName = "apply_a_repository_patch_with_a_custom_tool_name_that_is_longer_than_sixty_four_characters";
    const translated = translateCodexChatCustomTools({
      messages: [
        { role: "user", content: "Apply the patch." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: longName, arguments: "diff" } }],
        },
        { role: "tool", tool_call_id: "call-1", content: "patched" },
      ],
      tools: [{ type: "custom", name: longName, description: "Apply a repository patch." }],
      tool_choice: { type: "custom", name: longName },
    }, "gpt-test");

    const tools = translated.body.tools as Array<Record<string, unknown>>;
    const shortName = tools[0]?.name;
    expect(typeof shortName).toBe("string");
    expect((shortName as string).length).toBeLessThanOrEqual(64);
    expect(shortName).not.toBe(longName);
    expect(translated.toolNames[shortName as string]).toBe(longName);
    expect(translated.body.tool_choice).toEqual({ type: "custom", name: shortName });

    expect(inputItems(translated.body).find((item) => item.type === "custom_tool_call")).toEqual({
      type: "custom_tool_call",
      call_id: "call-1",
      name: shortName,
      input: "diff",
    });
    expect(inputItems(translated.body).find((item) => item.type === "custom_tool_call_output")).toEqual({
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: "patched",
    });
  });

  it("keeps function semantics when function and custom declarations share a name", () => {
    const translated = translateCodexChatCustomTools({
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-shared", type: "function", function: { name: "shared", arguments: "{}" } }],
      }],
      tools: [
        { type: "function", function: { name: "shared", parameters: { type: "object" } } },
        { type: "custom", name: "shared", description: "Custom form." },
      ],
      tool_choice: { type: "function", function: { name: "shared" } },
    }, "gpt-test");

    expect(inputItems(translated.body).find((item) => item.call_id === "call-shared")?.type).toBe("function_call");
    expect(translated.body.tool_choice).toEqual({ type: "function", name: "shared" });
    expect(translated.body.tools).toEqual([
      { type: "function", name: "shared", parameters: { type: "object" } },
      { type: "custom", name: "shared", description: "Custom form." },
    ]);
  });

  it("preserves an explicitly custom call even when its name is ambiguous", () => {
    const translated = translateCodexChatCustomTools({
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-custom", type: "custom", custom: { name: "shared", input: "raw input" } }],
      }],
      tools: [
        { type: "function", function: { name: "shared", parameters: {} } },
        { type: "custom", name: "shared" },
      ],
    }, "gpt-test");

    expect(inputItems(translated.body).find((item) => item.call_id === "call-custom")).toEqual({
      type: "custom_tool_call",
      call_id: "call-custom",
      name: "shared",
      input: "raw input",
    });
  });
});
