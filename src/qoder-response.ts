import { GatewayError } from "./errors";
import type { ProviderResponseContext } from "./provider-response";
import { readResponseText } from "./response-utils";
import { extractUsage } from "./stream";
import type { Usage } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

function mergeUsage(left: Usage, right: Usage): Usage {
  return {
    promptTokens: Math.max(left.promptTokens, right.promptTokens),
    completionTokens: Math.max(left.completionTokens, right.completionTokens),
    cachedTokens: Math.max(left.cachedTokens, right.cachedTokens),
    totalTokens: Math.max(left.totalTokens, right.totalTokens, right.promptTokens + right.completionTokens),
  };
}

function responseHeaders(source: Headers, contentType: string): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-cache, no-store");
  return headers;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return part ? [part] : [];
    const item = record(part);
    if (!item) return [];
    const text = typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
    return text ? [text] : [];
  }).join("\n");
}

export function unseenQoderSnapshotSuffix(emitted: string, snapshot: string): string {
  if (!snapshot) return "";
  if (!emitted) return snapshot;
  if (snapshot.startsWith(emitted)) return snapshot.slice(emitted.length);
  if (emitted.startsWith(snapshot)) return "";
  const max = Math.min(emitted.length, snapshot.length);
  for (let length = max; length > 0; length -= 1) {
    if (emitted.endsWith(snapshot.slice(0, length))) return snapshot.slice(length);
  }
  return snapshot;
}

function toolCallIndex(call: JsonRecord, position: number): number {
  const value = call.index;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : position;
}

function ensureToolCallIndexes(payload: JsonRecord): void {
  if (!Array.isArray(payload.tool_calls)) return;
  payload.tool_calls.forEach((rawCall, position) => {
    const call = record(rawCall);
    if (call && call.index === undefined) call.index = position;
  });
}

/** Reconciles Qoder's mixed full-message snapshots and incremental delta frames. */
export class QoderStreamOutputState {
  private text = "";
  private readonly toolArgs = new Map<number, string>();

  normalizeChunk(chunk: JsonRecord): void {
    if (!Array.isArray(chunk.choices)) return;
    for (const rawChoice of chunk.choices) {
      const choice = record(rawChoice);
      if (!choice) continue;

      if (Object.prototype.hasOwnProperty.call(choice, "delta")) {
        const delta = record(choice.delta);
        if (delta) {
          const text = contentText(delta.content);
          if (text) this.text += text;
          this.recordToolPayload(delta, false);
        }
        continue;
      }

      const message = record(choice.message);
      if (message) {
        ensureToolCallIndexes(message);
        const text = contentText(message.content);
        if (text) {
          const suffix = unseenQoderSnapshotSuffix(this.text, text);
          message.content = suffix;
          if (suffix) this.text += suffix;
        }
        this.recordToolPayload(message, true);
        choice.delta = message;
        delete choice.message;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(choice, "text")) {
        const text = contentText(choice.text);
        const suffix = unseenQoderSnapshotSuffix(this.text, text);
        if (suffix) this.text += suffix;
        choice.delta = { content: suffix };
        delete choice.text;
      }
    }
  }

  private recordToolPayload(payload: JsonRecord, snapshot: boolean): void {
    if (!Array.isArray(payload.tool_calls)) return;
    payload.tool_calls.forEach((rawCall, position) => {
      const call = record(rawCall);
      if (!call) return;
      const index = toolCallIndex(call, position);
      const fn = record(call.function);
      if (!fn || typeof fn.arguments !== "string" || !fn.arguments) return;
      const previous = this.toolArgs.get(index) ?? "";
      const next = snapshot ? unseenQoderSnapshotSuffix(previous, fn.arguments) : fn.arguments;
      if (snapshot) fn.arguments = next;
      if (next) this.toolArgs.set(index, previous + next);
    });
  }
}

function qoderFrame(data: string): { innerText: string; error?: string } | undefined {
  let envelope: JsonRecord;
  try { envelope = JSON.parse(data) as JsonRecord; } catch { return undefined; }
  const status = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
  const body = typeof envelope.body === "string"
    ? envelope.body
    : record(envelope.body)
      ? JSON.stringify(envelope.body)
      : data;
  if (status !== 200) return { innerText: "", error: body || `Qoder status ${status}` };
  return { innerText: body };
}

function sseTransform(
  body: ReadableStream<Uint8Array>,
  handleData: (data: string, controller: TransformStreamDefaultController<Uint8Array>) => void,
  flush?: (controller: TransformStreamDefaultController<Uint8Array>) => void,
): ReadableStream<Uint8Array> {
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(boundary + (match?.[0].length ?? 2));
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) handleData(data, controller);
      }
    },
    flush(controller) {
      const data = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) handleData(data, controller);
      flush?.(controller);
    },
  });
  return body.pipeThrough(transform);
}

function qoderChatStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const state = new QoderStreamOutputState();
  let doneSent = false;
  return sseTransform(
    body,
    (data, controller) => {
      if (data === "[DONE]") {
        if (!doneSent) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneSent = true;
        return;
      }
      const frame = qoderFrame(data);
      if (!frame) return;
      if (frame.error) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: frame.error, type: "upstream_error", code: "QODER_STREAM_ERROR" } })}\n\n`));
        return;
      }
      if (!frame.innerText) return;
      try {
        const chunk = JSON.parse(frame.innerText) as JsonRecord;
        state.normalizeChunk(chunk);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      } catch {
        controller.enqueue(encoder.encode(`data: ${frame.innerText}\n\n`));
      }
    },
    (controller) => {
      if (!doneSent) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  );
}

function collectQoderSse(text: string, model: string, requestId: string): JsonRecord {
  const state = new QoderStreamOutputState();
  let content = "";
  let reasoning = "";
  let usage = emptyUsage();
  let finishReason = "stop";
  const toolCalls = new Map<number, JsonRecord>();

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const frame = qoderFrame(data);
    if (!frame) continue;
    if (frame.error) {
      throw new GatewayError(502, "UPSTREAM_STREAM_ERROR", `Qoder stream error: ${frame.error}`, "upstream_error");
    }

    let chunk: JsonRecord;
    try { chunk = JSON.parse(frame.innerText) as JsonRecord; } catch { continue; }
    state.normalizeChunk(chunk);
    usage = mergeUsage(usage, extractUsage(chunk));
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = record(choices[0]) ?? {};
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
    const delta = record(choice.delta) ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (!Array.isArray(delta.tool_calls)) continue;

    delta.tool_calls.forEach((rawCall, position) => {
      const call = record(rawCall);
      if (!call) return;
      const index = toolCallIndex(call, position);
      const current = toolCalls.get(index) ?? {
        id: call.id ?? crypto.randomUUID(),
        type: "function",
        function: { name: "", arguments: "" },
      };
      const currentFn = record(current.function) ?? {};
      const nextFn = record(call.function) ?? {};
      if (typeof nextFn.name === "string") currentFn.name = `${typeof currentFn.name === "string" ? currentFn.name : ""}${nextFn.name}`;
      if (typeof nextFn.arguments === "string") currentFn.arguments = `${typeof currentFn.arguments === "string" ? currentFn.arguments : ""}${nextFn.arguments}`;
      current.function = currentFn;
      if (typeof call.id === "string") current.id = call.id;
      toolCalls.set(index, current);
    });
  }

  const message: JsonRecord = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedTokens },
    },
  };
}

export async function prepareQoderResponse(context: ProviderResponseContext): Promise<Response> {
  const { upstream, requestedStream, model, requestId } = context;
  if (requestedStream) {
    if (!upstream.body) {
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers, "text/event-stream; charset=utf-8"),
      });
    }
    return new Response(qoderChatStream(upstream.body), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers, "text/event-stream; charset=utf-8"),
    });
  }

  const text = await readResponseText(upstream.body);
  const payload = collectQoderSse(text, model, requestId);
  return Response.json(payload, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers, "application/json; charset=utf-8"),
  });
}
