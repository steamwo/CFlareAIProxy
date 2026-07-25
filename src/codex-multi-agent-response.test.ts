import { describe, expect, it } from "vitest";
import { restoreCodexMultiAgentResponse } from "./codex-multi-agent-response";

function functionCallEvent(): string {
  return JSON.stringify({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      namespace: "collaboration-optimize",
      name: "collaboration-optimize__spawn_agent",
      arguments: JSON.stringify({ name: "collaboration-optimize__literal" }),
    },
  });
}

describe("Codex multi-agent response restore", () => {
  it("preserves SSE event and id fields while restoring collaboration names", async () => {
    const source = [
      "event: response.output_item.done",
      "id: item-1",
      `data: ${functionCallEvent()}`,
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\"}",
      "",
    ].join("\n");
    const response = new Response(source, { headers: { "content-type": "text/event-stream" } });
    const restored = await restoreCodexMultiAgentResponse(response, true);
    const text = await restored.text();

    expect(text).toContain("event: response.output_item.done\n");
    expect(text).toContain("id: item-1\n");
    expect(text).toContain('"namespace":"collaboration"');
    expect(text).toContain('"name":"collaboration__spawn_agent"');
    expect(text).toContain('collaboration-optimize__literal');
    expect(text).toContain("event: response.completed\n");
  });

  it("keeps the original Response object when restoration is disabled", async () => {
    const response = new Response("unchanged", { headers: { "content-type": "text/plain" } });
    expect(await restoreCodexMultiAgentResponse(response, false)).toBe(response);
  });
});
