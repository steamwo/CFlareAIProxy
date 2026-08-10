import { describe, expect, it } from "vitest";
import { prepareKimiResponse } from "../kimi-response";
import {
  rememberKimiResponseToolIdentities,
  responsesInputToMessages,
  responsesToolsToChat,
} from "./kimi-responses";

describe("Kimi Responses to Chat turns", () => {
  it("keeps reasoning, assistant content, and a following tool call in one assistant turn", () => {
    const messages = responsesInputToMessages({
      input: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "inspect the result" }, { type: "summary_text", text: "[reasoning unavailable]" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will inspect it." }] },
        { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{\"path\":\"a\"}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I will inspect it." }],
      reasoning_content: "inspect the result",
    });
    expect(messages[0]?.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{\"path\":\"a\"}" } }]);
    expect(messages[1]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "ok" });
  });

  it("resets mergeability across role and tool-output boundaries", () => {
    const messages = responsesInputToMessages({
      input: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "first" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
        { type: "function_call", call_id: "call_2", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_2", output: "done" },
        { type: "custom_tool_call", call_id: "call_3", name: "shell", input: "pwd" },
      ],
    });

    expect(messages).toHaveLength(5);
    expect(messages[0]?.tool_calls).toBeUndefined();
    expect(messages[2]).toMatchObject({ role: "assistant", content: null });
    expect(messages[4]).toMatchObject({ role: "assistant", content: null });
    expect((messages[4]?.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "call_3",
      function: { name: "shell", arguments: "pwd" },
    });
  });
});

describe("Kimi Responses tool declaration identity", () => {
  it("deduplicates top-level and additional tools with first declaration winning", () => {
    const translated = responsesToolsToChat({
      tools: [
        { type: "function", name: "shared", description: "top", parameters: { type: "object" } },
        { type: "custom", name: "collision", description: "custom wins" },
      ],
      input: [
        {
          type: "additional_tools",
          tools: [
            { type: "function", name: "shared", description: "later", parameters: { type: "object" } },
            { type: "function", name: "collision", description: "function loses", parameters: { type: "object" } },
            { type: "namespace", name: "editor", tools: [{ type: "custom", name: "apply_patch" }] },
            { type: "custom", name: "editor__apply_patch", description: "flat loses" },
          ],
        },
      ],
    });

    expect(translated.tools).toHaveLength(3);
    expect(translated.tools[0]).toMatchObject({ type: "function", function: { name: "shared", description: "top" } });
    expect(translated.identities.shared).toEqual({ kind: "function", name: "shared" });
    expect(translated.identities.collision).toEqual({ kind: "custom", name: "collision" });
    expect(translated.identities.editor__apply_patch).toEqual({ kind: "custom", name: "apply_patch", namespace: "editor" });
  });

  it("restores namespace custom-tool identity in non-streaming Responses output", async () => {
    const requestId = "kimi-tool-identity";
    rememberKimiResponseToolIdentities(requestId, {
      editor__apply_patch: { kind: "custom", name: "apply_patch", namespace: "editor" },
    });
    const upstream = Response.json({
      id: "chatcmpl_1",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "editor__apply_patch", arguments: "*** Begin Patch" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });

    const response = await prepareKimiResponse({
      upstream,
      requestedStream: false,
      model: "kimi-test",
      requestId,
      endpoint: "responses",
    });
    const payload = await response.json() as Record<string, unknown>;
    const output = payload.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({
      id: "call_1",
      type: "custom_tool_call",
      call_id: "call_1",
      name: "apply_patch",
      namespace: "editor",
      input: "*** Begin Patch",
      status: "completed",
    });
  });
});
