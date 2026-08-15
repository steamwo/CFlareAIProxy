import { describe, expect, it } from "vitest";
import { qoderChatRecordId, qoderRequestSetId, qoderSessionId } from "../src/providers/qoder-identity";

describe("Qoder request identity", () => {
  it("binds session identity to an explicit downstream conversation", async () => {
    const first = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "x-claude-code-session-id": "session-a" },
    });
    const same = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "x-claude-code-session-id": "session-a" },
    });
    const different = new Request("https://gateway.test/v1/chat/completions", {
      headers: { "x-claude-code-session-id": "session-b" },
    });
    const body = { model: "test", messages: [{ role: "user", content: "hello" }] };

    const firstId = await qoderSessionId(first, body, "qoder-model");
    expect(await qoderSessionId(same, body, "qoder-model")).toBe(firstId);
    expect(await qoderSessionId(different, body, "qoder-model")).not.toBe(firstId);
  });

  it("isolates requests when no client session signal exists", async () => {
    const request = new Request("https://gateway.test/v1/chat/completions");
    const body = { model: "test", messages: [{ role: "user", content: "hello" }] };
    expect(await qoderSessionId(request, body, "qoder-model"))
      .not.toBe(await qoderSessionId(request, body, "qoder-model"));
  });

  it("keeps request_set_id stable across tool turns while chat_record_id changes", async () => {
    const sessionId = "session";
    const initial = [{ role: "user", content: "inspect the repository" }];
    const toolTurn = [
      ...initial,
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "search", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ];
    const nextTask = [...toolTurn, { role: "user", content: "now fix it" }];
    const tools = [{ type: "function", function: { name: "search", parameters: { type: "object" } } }];

    const requestSet = await qoderRequestSetId(sessionId, "qoder-model", initial, 65536);
    expect(await qoderRequestSetId(sessionId, "qoder-model", toolTurn, 65536)).toBe(requestSet);
    expect(await qoderRequestSetId(sessionId, "qoder-model", nextTask, 65536)).not.toBe(requestSet);
    expect(await qoderRequestSetId(sessionId, "qoder-model", initial, 131072)).not.toBe(requestSet);

    const record = await qoderChatRecordId(sessionId, "qoder-model", toolTurn, tools, 4096, "high", 65536);
    expect(await qoderChatRecordId(sessionId, "qoder-model", initial, tools, 4096, "high", 65536)).not.toBe(record);
    expect(await qoderChatRecordId(sessionId, "qoder-model", toolTurn, tools, 4096, "low", 65536)).not.toBe(record);
    expect(await qoderChatRecordId(sessionId, "qoder-model", toolTurn, tools, 4096, "high", 131072)).not.toBe(record);
  });
});
