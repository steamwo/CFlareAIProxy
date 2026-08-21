import type { ProviderResponseContext } from "./provider-response";
import { takeQoderDiscoveryPriorUsage } from "./providers/qoder-discovery";
import { prepareQoderResponse as prepareBaseQoderResponse } from "./qoder-response";
import type { Usage } from "./types";

const encoder = new TextEncoder();
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function hasUsage(usage: Usage | undefined): usage is Usage {
  return !!usage && (usage.promptTokens > 0 || usage.completionTokens > 0 || usage.cachedTokens > 0 || usage.totalTokens > 0);
}

function addPriorResponsesUsage(usage: JsonRecord, prior: Usage): void {
  const inputTokens = numeric(usage.input_tokens);
  const outputTokens = numeric(usage.output_tokens);
  const totalTokens = numeric(usage.total_tokens) || inputTokens + outputTokens;
  usage.input_tokens = inputTokens + prior.promptTokens;
  usage.output_tokens = outputTokens + prior.completionTokens;
  usage.total_tokens = totalTokens + prior.totalTokens;
  const details = record(usage.input_tokens_details) ?? {};
  details.cached_tokens = numeric(details.cached_tokens) + prior.cachedTokens;
  usage.input_tokens_details = details;
}

function isCompleteSseData(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "[DONE]") return true;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

function nestedQoderError(value: unknown, depth = 0): unknown {
  if (depth > 5 || value == null) return undefined;
  let object: JsonRecord | undefined;
  if (typeof value === "string") {
    try { object = record(JSON.parse(value)); } catch { return undefined; }
  } else object = record(value);
  if (!object) return undefined;
  if (object.error != null) return object.error;
  for (const key of ["llm_model_result", "data", "result", "payload", "body"]) {
    const nested = nestedQoderError(object[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function errorText(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * qoder-proxy's ParseStream treats an inner `error` object as a terminal stream
 * error even when Qoder's outer SSE envelope still reports HTTP/status 200.
 * Preserve that semantic before handing the stream to the existing CFlare
 * response adapters, which already know how to render protocol-native errors.
 */
function rewriteInnerQoderErrors(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: string[] = [];
  let terminated = false;

  const emitData = (data: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (terminated) return;
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return;
    }
    let envelope: JsonRecord | undefined;
    try { envelope = record(JSON.parse(data)); } catch { /* preserve malformed/keepalive data */ }
    if (envelope) {
      const status = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
      if (status === 200) {
        const innerError = nestedQoderError(envelope.body);
        if (innerError !== undefined) {
          terminated = true;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            ...envelope,
            statusCodeValue: 502,
            body: errorText(innerError),
          })}\n\n`));
          return;
        }
      }
    }
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  };

  const dispatch = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (!pending.length) return;
    const data = pending.join("\n");
    pending = [];
    if (data) emitData(data, controller);
  };

  const processLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    const value = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (value === "") {
      dispatch(controller);
      return;
    }
    if (!value.startsWith("data:")) return;
    const data = value.slice(5).trimStart();
    if (!pending.length && isCompleteSseData(data)) {
      emitData(data, controller);
      return;
    }
    pending.push(data);
    if (isCompleteSseData(pending.join("\n"))) dispatch(controller);
  };

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (terminated) return;
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        processLine(buffer.slice(0, newline), controller);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      if (terminated) return;
      buffer += decoder.decode();
      if (buffer) processLine(buffer, controller);
      dispatch(controller);
    },
  }));
}

function withQoderErrorParity(response: Response): Response {
  if (!response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(rewriteInnerQoderErrors(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function eventPayload(block: string): { event: string; payload: JsonRecord } | undefined {
  let event = "";
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!event || !data.length) return undefined;
  try {
    const payload = record(JSON.parse(data.join("\n")));
    return payload ? { event, payload } : undefined;
  } catch {
    return undefined;
  }
}

function transformSseBlocks(
  response: Response,
  rewriteBlock: (block: string) => string,
): Response {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let buffer = "";
  const transformed = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        controller.enqueue(encoder.encode(`${rewriteBlock(block)}\n\n`));
        boundary = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewriteBlock(buffer)));
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(transformed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function includePriorResponsesUsage(response: Response, prior: Usage): Promise<Response> {
  if (!hasUsage(prior)) return response;
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return transformSseBlocks(response, (block) => {
      const parsed = eventPayload(block);
      if (!parsed || parsed.event !== "response.completed") return block;
      const completed = record(parsed.payload.response);
      const usage = completed ? record(completed.usage) : undefined;
      if (!usage) return block;
      addPriorResponsesUsage(usage, prior);
      return `event: ${parsed.event}\ndata: ${JSON.stringify(parsed.payload)}`;
    });
  }

  const text = await response.text();
  let payload: JsonRecord | undefined;
  try { payload = record(JSON.parse(text)); } catch { /* preserve non-JSON body */ }
  const usage = payload ? record(payload.usage) : undefined;
  if (usage) addPriorResponsesUsage(usage, prior);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(payload ? JSON.stringify(payload) : text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Match qoder-proxy's responseState: one text output item keeps the same ID for
 * its added/delta/done lifecycle and the final response.completed snapshot. */
function stabilizeResponsesTextId(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  let textItemId = "";
  return transformSseBlocks(response, (block) => {
    const parsed = eventPayload(block);
    if (!parsed) return block;
    const { event, payload } = parsed;
    if (event === "response.output_item.added" || event === "response.output_item.done") {
      const item = record(payload.item);
      if (item?.type === "message" && typeof item.id === "string" && item.id) textItemId = item.id;
    } else if (
      event === "response.output_text.delta"
      || event === "response.output_text.done"
      || event === "response.content_part.added"
      || event === "response.content_part.done"
    ) {
      if (!textItemId && typeof payload.item_id === "string" && payload.item_id) textItemId = payload.item_id;
    } else if (event === "response.completed" && textItemId) {
      const completed = record(payload.response);
      if (completed && Array.isArray(completed.output)) {
        for (const rawItem of completed.output) {
          const item = record(rawItem);
          if (item?.type === "message") item.id = textItemId;
        }
        return `event: ${event}\ndata: ${JSON.stringify(payload)}`;
      }
    }
    return block;
  });
}

export async function prepareQoderResponse(context: ProviderResponseContext): Promise<Response> {
  const priorUsage = context.endpoint === "responses" ? takeQoderDiscoveryPriorUsage(context.requestId) : undefined;
  const upstream = withQoderErrorParity(context.upstream);
  let response = await prepareBaseQoderResponse({ ...context, upstream });
  if (context.endpoint === "responses" && hasUsage(priorUsage)) response = await includePriorResponsesUsage(response, priorUsage);
  if (context.endpoint === "responses" && context.requestedStream) response = stabilizeResponsesTextId(response);
  return response;
}
