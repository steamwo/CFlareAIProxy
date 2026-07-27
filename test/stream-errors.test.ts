import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors";
import { readResponseText } from "../src/response-utils";
import { prepareDownstreamResponse } from "../src/stream";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const text = frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseResponse(frames: unknown[]): Response {
  return new Response(sseStream(frames), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

async function drain(response: Response): Promise<{ text: string; error?: unknown }> {
  const body = response.body;
  if (!body) return { text: "" };
  const reader = body.getReader();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
  return { text };
}

describe("mid-stream upstream error detection", () => {
  it("terminates the Anthropic stream instead of forging a stop chunk", async () => {
    const upstream = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ]);
    const downstream = await prepareDownstreamResponse(upstream, "anthropic-chat", true, "opencode/claude-haiku-4-5", "r-anthropic");
    const { text, error } = await drain(downstream);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Overloaded");
    expect(text).toContain("partial");
    expect(text).not.toContain("\"finish_reason\":\"stop\"");
    expect(text).not.toContain("[DONE]");
  });

  it("terminates the Google stream instead of forging a stop chunk", async () => {
    const upstream = sseResponse([
      { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
      { error: { code: 503, status: "UNAVAILABLE", message: "The model is overloaded" } },
    ]);
    const downstream = await prepareDownstreamResponse(upstream, "google-chat", true, "opencode/gemini-3.5-flash", "r-google");
    const { text, error } = await drain(downstream);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("The model is overloaded");
    expect(text).toContain("partial");
    expect(text).not.toContain("\"finish_reason\":\"stop\"");
    expect(text).not.toContain("[DONE]");
  });

  it("still completes a healthy Anthropic stream", async () => {
    const upstream = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_stop" },
    ]);
    const downstream = await prepareDownstreamResponse(upstream, "anthropic-chat", true, "m", "r-ok");
    const { text, error } = await drain(downstream);
    expect(error).toBeUndefined();
    expect(text).toContain("[DONE]");
  });
});

describe("buffered upstream error detection", () => {
  it("rejects a buffered Anthropic SSE body carrying an error frame", async () => {
    const upstream = sseResponse([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "error", error: { type: "api_error", message: "Internal server error" } },
    ]);
    const failure = await prepareDownstreamResponse(upstream, "anthropic-chat", false, "m", "r1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayError);
    if (!(failure instanceof GatewayError)) throw failure;
    expect(failure.status).toBe(502);
    expect(failure.code).toBe("UPSTREAM_STREAM_ERROR");
    expect(failure.message).toContain("Internal server error");
  });

  it("rejects a buffered Google SSE body carrying an error field", async () => {
    const upstream = sseResponse([
      { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
      { error: { code: 500, status: "INTERNAL", message: "internal failure" } },
    ]);
    const failure = await prepareDownstreamResponse(upstream, "google-chat", false, "m", "r2").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayError);
    if (!(failure instanceof GatewayError)) throw failure;
    expect(failure.status).toBe(502);
    expect(failure.code).toBe("UPSTREAM_STREAM_ERROR");
    expect(failure.message).toContain("internal failure");
  });

  it("rejects a buffered Qoder envelope whose statusCodeValue is not 200", async () => {
    const upstream = sseResponse([
      { statusCodeValue: 429, body: "{\"error\":{\"message\":\"rate limited\"}}" },
    ]);
    const failure = await prepareDownstreamResponse(upstream, "qoder-chat", false, "m", "r3").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayError);
    if (!(failure instanceof GatewayError)) throw failure;
    expect(failure.status).toBe(502);
    expect(failure.code).toBe("UPSTREAM_STREAM_ERROR");
    expect(failure.message).toContain("rate limited");
  });

  it("still collects a healthy Qoder envelope", async () => {
    const chunk = JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] });
    const upstream = sseResponse([{ statusCodeValue: 200, body: chunk }]);
    const downstream = await prepareDownstreamResponse(upstream, "qoder-chat", false, "m", "r4");
    const payload = (await downstream.json()) as { choices: Array<{ message: { content: string | null } }> };
    expect(payload.choices[0]?.message.content).toBe("hi");
  });
});

describe("oversized buffered responses", () => {
  it("readResponseText throws a 502 GatewayError past the byte limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    const failure = await readResponseText(body, 100).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayError);
    if (!(failure instanceof GatewayError)) throw failure;
    expect(failure.status).toBe(502);
    expect(failure.code).toBe("UPSTREAM_RESPONSE_TOO_LARGE");
  });

  it("prepareDownstreamResponse surfaces the 502 rather than a plain Error", async () => {
    const megabyte = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 33) { controller.close(); return; }
        emitted += 1;
        controller.enqueue(megabyte);
      },
    });
    const upstream = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    const failure = await prepareDownstreamResponse(upstream, "anthropic-chat", false, "m", "r5").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayError);
    if (!(failure instanceof GatewayError)) throw failure;
    expect(failure.status).toBe(502);
    expect(failure.code).toBe("UPSTREAM_RESPONSE_TOO_LARGE");
  });
});
