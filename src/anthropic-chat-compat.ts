type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchemaNode);
  if (!isObject(value)) return value;
  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) normalized[key] = normalizeSchemaNode(child);
  if (normalized.type === "object" && !isObject(normalized.properties)) normalized.properties = {};
  return normalized;
}

function imageContentPart(block: JsonObject): JsonObject | undefined {
  if (block.type !== "image" || !isObject(block.source)) return undefined;
  const source = block.source;
  if (source.type === "base64" && typeof source.data === "string" && source.data) {
    const mediaType = typeof source.media_type === "string" && source.media_type
      ? source.media_type
      : "application/octet-stream";
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  if (source.type === "url" && typeof source.url === "string" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return undefined;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

/**
 * Preserve structured/image tool results for Chat-compatible providers that
 * accept multimodal tool messages. Text-only tool results remain simple strings
 * for maximum compatibility with older OpenAI-compatible backends.
 */
function toolResultContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (isObject(value)) {
    const image = imageContentPart(value);
    return image ? [image] : jsonText(value);
  }
  if (!Array.isArray(value)) return value === undefined ? "" : jsonText(value);

  const parts: JsonObject[] = [];
  let hasImage = false;
  for (const rawPart of value) {
    if (typeof rawPart === "string") {
      parts.push({ type: "text", text: rawPart });
      continue;
    }
    if (!isObject(rawPart)) {
      parts.push({ type: "text", text: jsonText(rawPart) });
      continue;
    }
    if (rawPart.type === "text" && typeof rawPart.text === "string") {
      parts.push({ type: "text", text: rawPart.text });
      continue;
    }
    const image = imageContentPart(rawPart);
    if (image) {
      hasImage = true;
      parts.push(image);
      continue;
    }
    parts.push({ type: "text", text: jsonText(rawPart) });
  }

  if (!hasImage) {
    return parts
      .map((part) => typeof part.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n");
  }
  return parts;
}

function collectToolResults(sourceBody: JsonObject): Map<string, unknown> {
  const results = new Map<string, unknown>();
  if (!Array.isArray(sourceBody.messages)) return results;
  for (const rawMessage of sourceBody.messages) {
    if (!isObject(rawMessage) || !Array.isArray(rawMessage.content)) continue;
    for (const rawPart of rawMessage.content) {
      if (!isObject(rawPart) || rawPart.type !== "tool_result") continue;
      const id = stringValue(rawPart.tool_use_id);
      if (id) results.set(id, toolResultContent(rawPart.content));
    }
  }
  return results;
}

/**
 * Applies compatibility details that are easier to express after the generic
 * Anthropic -> Chat conversion: recursively normalize nested object schemas and
 * restore rich tool_result content that the text-oriented generic converter
 * intentionally flattens.
 */
export function prepareAnthropicChatBody(sourceBody: JsonObject, chatBody: JsonObject): JsonObject {
  if (Array.isArray(chatBody.tools)) {
    for (const rawTool of chatBody.tools) {
      if (!isObject(rawTool) || !isObject(rawTool.function)) continue;
      rawTool.function.parameters = normalizeSchemaNode(rawTool.function.parameters);
    }
  }

  const toolResults = collectToolResults(sourceBody);
  if (toolResults.size > 0 && Array.isArray(chatBody.messages)) {
    for (const rawMessage of chatBody.messages) {
      if (!isObject(rawMessage) || rawMessage.role !== "tool") continue;
      const id = stringValue(rawMessage.tool_call_id);
      if (id && toolResults.has(id)) rawMessage.content = toolResults.get(id);
    }
  }
  return chatBody;
}

function normalizeRawUsage(value: unknown): boolean {
  if (!isObject(value)) return false;
  const details = isObject(value.prompt_tokens_details)
    ? value.prompt_tokens_details
    : isObject(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const detailCached = numberValue(details?.cached_tokens);
  const cached = detailCached ?? numberValue(value.cache_read_input_tokens);
  if (cached === undefined || cached <= 0) return false;

  const promptTokens = numberValue(value.prompt_tokens);
  if (promptTokens !== undefined) {
    value.prompt_tokens = Math.max(0, Math.floor(promptTokens) - Math.floor(cached));
    return true;
  }

  // OpenAI Responses-style input_tokens, when accompanied by cached_tokens in
  // input_tokens_details, also includes the cached portion in the total.
  const inputTokens = numberValue(value.input_tokens);
  if (inputTokens !== undefined && detailCached !== undefined) {
    value.input_tokens = Math.max(0, Math.floor(inputTokens) - Math.floor(detailCached));
    return true;
  }
  return false;
}

function normalizeUsagePayload(payload: unknown): boolean {
  if (!isObject(payload)) return false;
  return normalizeRawUsage(payload.usage);
}

function rewriteSseFrame(frame: string): string {
  const lines = frame.split(/\r?\n/);
  const dataIndexes: number[] = [];
  const dataParts: string[] = [];
  lines.forEach((line, index) => {
    if (!line.startsWith("data:")) return;
    dataIndexes.push(index);
    dataParts.push(line.slice(5).trimStart());
  });
  if (!dataIndexes.length) return frame;
  const data = dataParts.join("\n");
  if (!data || data === "[DONE]") return frame;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return frame;
  }
  if (!normalizeUsagePayload(payload)) return frame;

  const first = dataIndexes[0]!;
  const rewritten: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index === first) rewritten.push(`data: ${JSON.stringify(payload)}`);
    else if (!dataIndexes.includes(index)) rewritten.push(lines[index]!);
  }
  return rewritten.join("\n");
}

function normalizeSseUsage(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let buffer = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/)) && match.index !== undefined) {
        const boundary = match.index;
        const separator = match[0];
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        controller.enqueue(encoder.encode(`${rewriteSseFrame(frame)}${separator}`));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewriteSseFrame(buffer)));
    },
  }));
}

function rewrittenHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return headers;
}

/**
 * OpenAI prompt_tokens/input_tokens totals include cached tokens, while Anthropic
 * reports cache_read_input_tokens separately from input_tokens. Normalize the raw
 * Chat usage before the existing Anthropic response translator sees it so cached
 * tokens are not double-counted in both JSON and SSE responses.
 */
export async function normalizeChatUsageForAnthropic(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    return new Response(normalizeSseUsage(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: rewrittenHeaders(response.headers),
    });
  }
  if (!contentType.includes("json")) return response;

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: rewrittenHeaders(response.headers),
    });
  }
  if (!normalizeUsagePayload(payload)) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: rewrittenHeaders(response.headers),
    });
  }
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers: rewrittenHeaders(response.headers),
  });
}
