import { describe, expect, it } from "vitest";
import { prepareCodexResponse } from "../src/codex-response";

function sseResponse(frames: Array<Record<string, unknown> | "[DONE]">): Response {
  const body = frames.map((frame) => `data: ${frame === "[DONE]" ? frame : JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function context(upstream: Response, endpoint: "responses" | "chat", requestedStream: boolean) {
  return {
    upstream,
    endpoint,
    requestedStream,
    model: "gpt-test",
    requestId: "req-test",
  } as const;
}

describe("Codex successful terminal events", () => {
  it("accepts response.done for Responses streaming", async () => {
    const response = await prepareCodexResponse(context(sseResponse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.done", response: { id: "resp_1", output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
      "[DONE]",
    ]), "responses", true));

    const text = await response.text();
    expect(text).toContain('"type":"response.done"');
    expect(text).toContain("data: [DONE]");
  });

  it("accepts response.done when parsing an SSE body for a non-stream request", async () => {
    const response = await prepareCodexResponse(context(sseResponse([
      { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "ok" }] } },
      { type: "response.done", response: { id: "resp_2", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]), "chat", false));

    const payload = await response.json() as Record<string, any>;
    expect(payload.choices[0].message.content).toBe("ok");
    expect(payload.choices[0].finish_reason).toBe("stop");
  });
});

describe("Codex reasoning_text to Chat conversion", () => {
  it("emits reasoning_content for reasoning text and summary stream events", async () => {
    const response = await prepareCodexResponse(context(sseResponse([
      { type: "response.reasoning_summary_text.delta", delta: "summary" },
      { type: "response.reasoning_summary_text.done" },
      { type: "response.reasoning_text.delta", delta: "detail" },
      { type: "response.reasoning_text.done" },
      { type: "response.done", response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ]), "chat", true));

    const text = await response.text();
    const chunks = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
    const deltas = chunks.map((chunk) => chunk.choices?.[0]?.delta).filter(Boolean);

    expect(deltas[0]).toMatchObject({ role: "assistant", reasoning_content: "summary" });
    expect(deltas.some((delta) => delta.reasoning_content === "detail")).toBe(true);
    expect(deltas.filter((delta) => delta.reasoning_content === "\n\n")).toHaveLength(2);
    expect(text).toContain("data: [DONE]");
  });

  it("concatenates reasoning summary before reasoning_text content in non-stream responses", async () => {
    const upstream = Response.json({
      id: "resp_3",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "summary:" }],
          content: [{ type: "reasoning_text", text: "detail" }],
        },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });

    const response = await prepareCodexResponse(context(upstream, "chat", false));
    const payload = await response.json() as Record<string, any>;
    expect(payload.choices[0].message).toMatchObject({
      role: "assistant",
      content: "answer",
      reasoning_content: "summary:detail",
    });
  });

  it("does not add reasoning_content for empty reasoning entries", async () => {
    const upstream = Response.json({
      id: "resp_4",
      output: [{ type: "reasoning", summary: [{ text: "" }], content: [{ type: "reasoning_text", text: "" }] }],
      usage: {},
    });

    const response = await prepareCodexResponse(context(upstream, "chat", false));
    const payload = await response.json() as Record<string, any>;
    expect(payload.choices[0].message).not.toHaveProperty("reasoning_content");
  });
});
