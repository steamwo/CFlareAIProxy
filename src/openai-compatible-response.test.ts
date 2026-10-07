import { describe, expect, it } from "vitest";
import { GatewayError } from "./errors";
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

function context(
  upstream: Response,
  providerKind: "openai-compatible" | "custom" = "openai-compatible",
  endpoint: "chat" | "completions" | "responses" = "chat",
) {
  return {
    upstream,
    mode: "passthrough" as const,
    requestedStream: true,
    model: "test-model",
    requestId: "request-openai-done",
    providerKind,
    endpoint,
  };
}

async function expectIncomplete(responsePromise: Promise<Response>): Promise<void> {
  const response = await responsePromise;
  let failure: unknown;
  try {
    await response.text();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(GatewayError);
  expect(failure).toMatchObject({ status: 502, code: "UPSTREAM_STREAM_INCOMPLETE" });
}

describe("OpenAI-compatible SSE terminal boundary", () => {
  it("forwards [DONE] once and drops trailing frames across chunk boundaries", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      ": keepalive\r\n\r\ndata: {\"id\":\"chunk_1\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DO",
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
      "data: {\"id\":\"chunk_1\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
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
      "data: {\"id\":\"chunk_1\",\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]",
    ])));

    const text = await response.text();
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("separates an unterminated final SSE frame before synthetic [DONE]", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      "data: {\"id\":\"chunk_partial\",\"choices\":[{\"finish_reason\":\"stop\"}]}",
    ])));

    const text = await response.text();
    expect(text).toBe("data: {\"id\":\"chunk_partial\",\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
  });

  it("does not treat multiline data containing [DONE] as a terminal frame", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      "data: [DONE]\ndata: still-data\n\ndata: {\"id\":\"after_multiline\",\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n",
    ])));

    const text = await response.text();
    expect(text).toContain("data: [DONE]\ndata: still-data\n\n");
    expect(text).toContain("\"id\":\"after_multiline\"");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("rejects clean EOF when Chat emitted content but never a non-empty finish_reason", async () => {
    await expectIncomplete(prepareProviderResponse(context(chunkedSse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
    ]))));
  });

  it("rejects upstream [DONE] when Chat only emitted null/empty finish_reason", async () => {
    await expectIncomplete(prepareProviderResponse(context(chunkedSse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"\"}]}\n\n",
      "data: [DONE]\n\n",
    ]))));
  });

  it("applies the same finish_reason contract to legacy Completions SSE", async () => {
    await expectIncomplete(prepareProviderResponse(context(chunkedSse([
      "data: {\"choices\":[{\"text\":\"partial\",\"finish_reason\":null}]}\n\n",
    ]), "openai-compatible", "completions")));
  });

  it("keeps Responses completion semantics separate from Chat finish_reason", async () => {
    const response = await prepareProviderResponse(context(chunkedSse([
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      "data: [DONE]\n\n",
    ]), "openai-compatible", "responses"));
    expect(await response.text()).toContain("response.completed");
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
