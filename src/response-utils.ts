import { GatewayError } from "./errors";
import type { Usage } from "./types";

export const responseEncoder = new TextEncoder();
const decoder = new TextDecoder();

export function responseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function emptyResponseUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

function numberField(object: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  }
  return 0;
}

export function responseUsage(value: unknown): Usage {
  const root = responseRecord(value);
  const raw = responseRecord(root.usage ?? root);
  const promptTokens = numberField(raw, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens");
  const completionTokens = numberField(raw, "completion_tokens", "output_tokens", "completionTokens", "outputTokens");
  const details = responseRecord(raw.prompt_tokens_details ?? raw.input_tokens_details);
  const cachedTokens = Math.min(promptTokens, numberField(details, "cached_tokens", "cachedTokens"));
  const totalTokens = numberField(raw, "total_tokens", "totalTokens") || promptTokens + completionTokens;
  return { promptTokens, completionTokens, cachedTokens, totalTokens };
}

export function mergeResponseUsage(left: Usage, right: Usage): Usage {
  return {
    promptTokens: Math.max(left.promptTokens, right.promptTokens),
    completionTokens: Math.max(left.completionTokens, right.completionTokens),
    cachedTokens: Math.max(left.cachedTokens, right.cachedTokens),
    totalTokens: Math.max(left.totalTokens, right.totalTokens, right.promptTokens + right.completionTokens),
  };
}

export function responseHeaders(source: Headers, contentType?: string): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-cache, no-store");
  return headers;
}

export function rewriteResponseModelFields(value: unknown, model: string, depth = 0): unknown {
  if (depth > 16 || value == null) return value;
  if (Array.isArray(value)) return value.map((entry) => rewriteResponseModelFields(entry, model, depth + 1));
  if (typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = key === "model" ? model : rewriteResponseModelFields(entry, model, depth + 1);
  }
  return output;
}

function frameData(frame: string): string {
  return frame.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

export function transformResponseSse(
  source: ReadableStream<Uint8Array>,
  handle: (data: string, controller: TransformStreamDefaultController<Uint8Array>) => void,
  flush: (controller: TransformStreamDefaultController<Uint8Array>) => void,
): ReadableStream<Uint8Array> {
  let buffer = "";
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const boundary = match.index ?? -1;
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + match[0].length);
        const data = frameData(frame);
        if (data) handle(data, controller);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      const data = frameData(buffer);
      if (data) handle(data, controller);
      flush(controller);
    },
  }));
}

export function responseFrameData(frame: string): string {
  return frameData(frame);
}

export async function readResponseText(body: ReadableStream<Uint8Array> | null, maxBytes = 32 * 1024 * 1024): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response too large");
      throw new GatewayError(502, "UPSTREAM_RESPONSE_TOO_LARGE", `Buffered upstream response exceeded ${maxBytes} bytes`, "upstream_error");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return decoder.decode(output);
}

export async function rewriteResponseModels(response: Response, model: string): Promise<Response> {
  if (!response.body) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const body = transformResponseSse(response.body, (data, controller) => {
      if (data === "[DONE]") { controller.enqueue(responseEncoder.encode("data: [DONE]\n\n")); return; }
      try {
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(rewriteResponseModelFields(JSON.parse(data), model))}\n\n`));
      } catch {
        controller.enqueue(responseEncoder.encode(`data: ${data}\n\n`));
      }
    }, () => undefined);
    return new Response(body, { status: response.status, headers: responseHeaders(response.headers, contentType) });
  }
  const text = await response.text();
  if (!contentType.includes("json")) {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers, contentType || undefined) });
  }
  try {
    return Response.json(rewriteResponseModelFields(JSON.parse(text), model), { status: response.status, headers: responseHeaders(response.headers, "application/json; charset=utf-8") });
  } catch {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers, contentType) });
  }
}
