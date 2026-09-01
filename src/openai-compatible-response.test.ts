import { describe, expect, it } from "vitest";
import { prepareProviderResponse } from "./provider-response";

function chunkedSse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++] ?? ""));
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function context(upstream: Response, providerKind: "openai-compatible" | "custom" = "openai-compatible") {
  return {
    upstream,
    mode: "passthrough" as const,
    requestedStream: true,
    model: "test-model",
    requestId: "request-openai-done",
    providerKind,
    endpoint: "chat" as const,
  };
}

describe("OpenAI-compatible SSE terminal boundary", () => {
  it("forwards [DONE] once and drops trailing frames across chunk boundaries", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      ": keepalive\r\n\r\ndata: {\"id\":\"chunk_1\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\r\n\r\ndata: [DO",
      "NE]\r\n\r\ndata: {\"choices\":[],\"cost\":\"0\"}\r\n\r\n",
    ])));

    const text = await response.text();
    expect(text).toContain(": keepalive\r\n\r\n");
    expect(text).toContain("\"id\":\"chunk_1\"");
    expect(text).toContain("data: [DONE]\r\n\r\n");
    expect(text).not.toContain("\"cost\"");
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("synthesizes one [DONE] on clean EOF when upstream omitted it", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      "data: {\"id\":\"chunk_1\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
      "data: {\"id\":\"chunk_2\",\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n",
    ])));

    const text = await response.text();
    expect(text).toContain("\"id\":\"chunk_1\"");
    expect(text).toContain("\"id\":\"chunk_2\"");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("recognizes an unterminated final [DONE] frame without duplicating it", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      "data: {\"id\":\"chunk_1\",\"choices\":[]}\n\ndata: [DONE]",
    ])));

    const text = await response.text();
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("separates an unterminated final SSE frame before synthetic [DONE]", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      "data: {\"id\":\"chunk_partial\",\"choices\":[]}",
    ])));

    const text = await response.text();
    expect(text).toBe("data: {\"id\":\"chunk_partial\",\"choices\":[]}\n\ndata: [DONE]\n\n");
  });

  it("does not treat multiline data containing [DONE] as a terminal frame", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      "data: [DONE]\ndata: still-data\n\ndata: {\"id\":\"after_multiline\",\"choices\":[]}\n\n",
    ])));

    const text = await response.text();
    expect(text).toContain("data: [DONE]\ndata: still-data\n\n");
    expect(text).toContain("\"id\":\"after_multiline\"");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("leaves non-OpenAI passthrough streams unchanged", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      "data: {\"id\":\"chunk_1\",\"choices\":[]}\n\ndata: [DONE]\n\ndata: {\"meta\":\"trailing\"}\n\n",
    ]), "custom"));

    const text = await response.text();
    expect(text).toContain("data: [DONE]\n\n");
    expect(text).toContain("\"meta\":\"trailing\"");
  });
});
