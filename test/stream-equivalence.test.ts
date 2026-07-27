import { describe, expect, it } from "vitest";
import { prepareDownstreamResponse } from "../src/stream";
import type { UpstreamResponseMode } from "../src/types";

/**
 * Each upstream protocol is implemented twice in stream.ts: an incremental transform for
 * `stream: true` and a buffered collector for `stream: false`. The two are separate state
 * machines over the same wire format, so they can and do drift — the mid-stream error
 * handling was missing from one side of three of them.
 *
 * These tests pin the property that matters: for one SSE body, both paths must report the
 * same content, tool calls, finish reason and usage. They exist to make the collector/stream
 * merge refactor safe, and to fail loudly if only one side of a pair is ever updated again.
 */

function sse(...frames: string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join("") + "data: [DONE]\n\n";
}

function upstream(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Normalized {
  content: string;
  reasoning: string;
  toolCalls: Array<{ name: string; args: string }>;
  finishReason: string | null;
  usage: { prompt: number; completion: number; total: number };
}

function emptyNormalized(): Normalized {
  return { content: "", reasoning: "", toolCalls: [], finishReason: null, usage: { prompt: 0, completion: 0, total: 0 } };
}

function readUsage(source: Record<string, unknown> | undefined, into: Normalized): void {
  if (!source) return;
  const prompt = source.prompt_tokens;
  const completion = source.completion_tokens;
  const total = source.total_tokens;
  if (typeof prompt === "number") into.usage.prompt = prompt;
  if (typeof completion === "number") into.usage.completion = completion;
  if (typeof total === "number") into.usage.total = total;
}

/** Folds a non-streaming chat.completion body into the comparable shape. */
function fromBuffered(payload: Record<string, unknown>): Normalized {
  const result = emptyNormalized();
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === "string") result.content = message.content;
  if (typeof message?.reasoning_content === "string") result.reasoning = message.reasoning_content;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const entry of calls) {
    const call = entry as Record<string, unknown>;
    const fn = call.function as Record<string, unknown> | undefined;
    result.toolCalls.push({
      name: typeof fn?.name === "string" ? fn.name : "",
      args: typeof fn?.arguments === "string" ? fn.arguments : "",
    });
  }
  if (typeof choice?.finish_reason === "string") result.finishReason = choice.finish_reason;
  readUsage(payload.usage as Record<string, unknown> | undefined, result);
  return result;
}

/** Replays an SSE response and folds its deltas into the same shape. */
async function fromStreamed(response: Response): Promise<Normalized> {
  const result = emptyNormalized();
  const text = await response.text();
  const pending = new Map<number, { name: string; args: string }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") continue;
    const chunk = parsed as Record<string, unknown>;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string") result.content += delta.content;
    if (typeof delta?.reasoning_content === "string") result.reasoning += delta.reasoning_content;
    const calls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const entry of calls) {
      const call = entry as Record<string, unknown>;
      const index = typeof call.index === "number" ? call.index : 0;
      const fn = call.function as Record<string, unknown> | undefined;
      const slot = pending.get(index) ?? { name: "", args: "" };
      if (typeof fn?.name === "string" && fn.name) slot.name = fn.name;
      if (typeof fn?.arguments === "string") slot.args += fn.arguments;
      pending.set(index, slot);
    }
    if (typeof choice?.finish_reason === "string") result.finishReason = choice.finish_reason;
    readUsage(chunk.usage as Record<string, unknown> | undefined, result);
  }
  result.toolCalls = [...pending.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
  return result;
}

async function bothPaths(mode: UpstreamResponseMode, body: string): Promise<{ streamed: Normalized; buffered: Normalized }> {
  const streamedResponse = await prepareDownstreamResponse(upstream(body), mode, true, "test-model", "req-1");
  const bufferedResponse = await prepareDownstreamResponse(upstream(body), mode, false, "test-model", "req-1");
  return {
    streamed: await fromStreamed(streamedResponse),
    buffered: fromBuffered(await bufferedResponse.json() as Record<string, unknown>),
  };
}

describe("anthropic streaming and buffered paths agree", () => {
  const body = sse(
    JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 0 } } }),
    JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
    JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
    JSON.stringify({ type: "message_stop" }),
  );

  it("reports the same text, finish reason and usage", async () => {
    const { streamed, buffered } = await bothPaths("anthropic-chat", body);
    expect(streamed.content).toBe("Hello world");
    expect(buffered.content).toBe(streamed.content);
    expect(buffered.finishReason).toBe(streamed.finishReason);
    expect(buffered.usage).toEqual(streamed.usage);
  });

  it("reports the same tool call across both paths", async () => {
    const toolBody = sse(
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "lookup" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"q\":" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"x\"}" } }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      JSON.stringify({ type: "message_stop" }),
    );
    const { streamed, buffered } = await bothPaths("anthropic-chat", toolBody);
    expect(streamed.toolCalls).toEqual([{ name: "lookup", args: "{\"q\":\"x\"}" }]);
    expect(buffered.toolCalls).toEqual(streamed.toolCalls);
    expect(buffered.finishReason).toBe(streamed.finishReason);
  });

  it("carries thinking deltas through both paths", async () => {
    const thinkingBody = sse(
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "step one" } }),
      JSON.stringify({ type: "message_stop" }),
    );
    const { streamed, buffered } = await bothPaths("anthropic-chat", thinkingBody);
    expect(streamed.reasoning).toBe("step one");
    expect(buffered.reasoning).toBe(streamed.reasoning);
  });
});

describe("google streaming and buffered paths agree", () => {
  it("reports the same text, finish reason and usage", async () => {
    const body = sse(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: " there" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 } }),
    );
    const { streamed, buffered } = await bothPaths("google-chat", body);
    expect(streamed.content).toBe("Hi there");
    expect(buffered.content).toBe(streamed.content);
    expect(buffered.finishReason).toBe(streamed.finishReason);
    expect(buffered.usage).toEqual(streamed.usage);
  });

  it("reports the same function call across both paths", async () => {
    const body = sse(
      JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "search", args: { q: "x" } } }] }, finishReason: "STOP" }] }),
    );
    const { streamed, buffered } = await bothPaths("google-chat", body);
    expect(streamed.toolCalls).toHaveLength(1);
    expect(streamed.toolCalls[0]?.name).toBe("search");
    expect(buffered.toolCalls).toEqual(streamed.toolCalls);
  });
});
