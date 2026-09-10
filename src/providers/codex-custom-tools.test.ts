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
      { type: "function", name: "shared", parameters: { type: "object" }, strict: false },
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

  it("defaults omitted function strict to false while preserving explicit values", () => {
    const translated = translateCodexChatCustomTools({
      messages: [{ role: "user", content: "Search." }],
      tools: [
        { type: "function", function: { name: "omitted", parameters: { type: "object" } } },
        { type: "function", function: { name: "explicit_true", strict: true, parameters: { type: "object" } } },
        { type: "function", function: { name: "explicit_false", strict: false, parameters: { type: "object" } } },
      ],
    }, "gpt-test");

    expect(translated.body.tools).toEqual([
      { type: "function", name: "omitted", parameters: { type: "object" }, strict: false },
      { type: "function", name: "explicit_true", parameters: { type: "object" }, strict: true },
      { type: "function", name: "explicit_false", parameters: { type: "object" }, strict: false },
    ]);
  });

  it("sanitizes invalid tool name characters consistently across declarations, choices, and history", () => {
    const originalName = "mcp.repo:read/file";
    const translated = translateCodexChatCustomTools({
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-sanitized", type: "function", function: { name: originalName, arguments: "{}" } }],
      }],
      tools: [{ type: "function", function: { name: originalName, parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: originalName } },
    }, "gpt-test");

    const tools = translated.body.tools as Array<Record<string, unknown>>;
    const sanitizedName = tools[0]?.name as string;
    expect(sanitizedName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(sanitizedName).toBe("mcp_repo_read_file");
    expect(translated.toolNames[sanitizedName]).toBe(originalName);
    expect(translated.body.tool_choice).toEqual({ type: "function", name: sanitizedName });
    expect(inputItems(translated.body).find((item) => item.call_id === "call-sanitized")?.name).toBe(sanitizedName);
  });

  it("keeps sanitized-name collisions distinct and reversible", () => {
    const translated = translateCodexChatCustomTools({
      messages: [],
      tools: [
        { type: "function", function: { name: "repo.read", parameters: {} } },
        { type: "function", function: { name: "repo:read", parameters: {} } },
      ],
    }, "gpt-test");

    const tools = translated.body.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name as string);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
    expect(names.map((name) => translated.toolNames[name]).sort()).toEqual(["repo.read", "repo:read"]);
  });

  it("normalizes unsupported Unicode property escapes after custom-tool translation", () => {
    const translated = translateCodexChatCustomTools({
      messages: [],
      tools: [{
        type: "function",
        function: {
          name: "artifact",
          parameters: {
            type: "object",
            properties: {
              field: { type: "string", pattern: "\\p{L}+" },
              id: { type: "string", pattern: "^[0-9]+$" },
            },
          },
        },
      }],
    }, "gpt-test");

    const tools = translated.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.parameters).toEqual({
      type: "object",
      properties: {
        field: { type: "string" },
        id: { type: "string", pattern: "^[0-9]+$" },
      },
    });
  });
});
