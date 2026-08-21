import { GatewayError } from "./errors";
import { asInt, readJsonBody } from "./utils";
import type { Env } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type JsonObject = Record<string, unknown>;

type BaseWorker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedSchema(value: unknown): JsonObject {
  if (!isObject(value)) return { type: "object", properties: {} };
  const schema = structuredClone(value) as JsonObject;
  if (schema.type === "object" && !isObject(schema.properties)) schema.properties = {};
  return schema;
}

function anthropicText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!isObject(part)) return "";
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
    if (part.type === "tool_result") return anthropicText(part.content);
    return "";
  }).filter(Boolean).join("\n");
}

function openAIContentPart(part: JsonObject): JsonObject | undefined {
  if (part.type === "text" && typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  if (part.type !== "image" || !isObject(part.source)) return undefined;
  const source = part.source;
  let url = "";
  if (source.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" && source.media_type ? source.media_type : "application/octet-stream";
    url = `data:${mediaType};base64,${source.data}`;
  } else if (source.type === "url" && typeof source.url === "string") {
    url = source.url;
  }
  return url ? { type: "image_url", image_url: { url } } : undefined;
}

function reasoningEffort(body: JsonObject): string | undefined {
  const thinking = isObject(body.thinking) ? body.thinking : undefined;
  if (!thinking) return undefined;
  const type = stringValue(thinking.type)?.toLowerCase();
  if (type === "disabled") return undefined;
  if (type === "adaptive" || type === "auto") {
    const output = isObject(body.output_config) ? body.output_config : undefined;
    const effort = stringValue(output?.effort)?.toLowerCase();
    if (effort === "low" || effort === "medium" || effort === "high") return effort;
    if (effort === "minimal") return "low";
    if (effort === "max" || effort === "xhigh") return "high";
    return "high";
  }
  if (type !== "enabled") return undefined;
  const budget = numberValue(thinking.budget_tokens);
  if (budget === undefined) return "high";
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  return "high";
}

function convertMessages(body: JsonObject): JsonObject[] {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError(400, "INVALID_REQUEST", "messages must be a non-empty array", "invalid_request_error");
  }

  const result: JsonObject[] = [];
  const system = anthropicText(body.system);
  if (system) result.push({ role: "system", content: system });

  for (const rawMessage of body.messages) {
    if (!isObject(rawMessage)) {
      throw new GatewayError(400, "INVALID_REQUEST", "Each message must be an object", "invalid_request_error");
    }
    const role = stringValue(rawMessage.role);
    if (role !== "user" && role !== "assistant") {
      throw new GatewayError(400, "INVALID_REQUEST", `Unsupported message role: ${role ?? "unknown"}`, "invalid_request_error");
    }
    const content = rawMessage.content;
    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      throw new GatewayError(400, "INVALID_REQUEST", "message.content must be a string or array", "invalid_request_error");
    }

    const contentParts: JsonObject[] = [];
    const toolCalls: JsonObject[] = [];
    const toolResults: JsonObject[] = [];
    const reasoning: string[] = [];

    for (const rawPart of content) {
      if (!isObject(rawPart)) continue;
      const part = rawPart;
      const converted = openAIContentPart(part);
      if (converted) {
        contentParts.push(converted);
        continue;
      }
      if (part.type === "thinking" && role === "assistant" && typeof part.thinking === "string") {
        reasoning.push(part.thinking);
        continue;
      }
      if (part.type === "tool_use" && role === "assistant") {
        const id = stringValue(part.id) || `toolu_${crypto.randomUUID()}`;
        const name = stringValue(part.name) || "unknown";
        const input = isObject(part.input) ? part.input : {};
        toolCalls.push({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
        continue;
      }
      if (part.type === "tool_result" && role === "user") {
        const id = stringValue(part.tool_use_id);
        if (!id) continue;
        let toolContent = anthropicText(part.content);
        if (!toolContent && part.content !== undefined) {
          try { toolContent = JSON.stringify(part.content); } catch { toolContent = String(part.content); }
        }
        toolResults.push({ role: "tool", tool_call_id: id, content: toolContent });
      }
    }

    // OpenAI-compatible APIs require tool results immediately after the assistant tool_calls
    // they answer, so emit them before any ordinary user text in the same Anthropic message.
    result.push(...toolResults);

    if (role === "assistant") {
      if (contentParts.length || toolCalls.length || reasoning.length) {
        const message: JsonObject = { role: "assistant", content: contentParts.length ? contentParts : "" };
        if (toolCalls.length) message.tool_calls = toolCalls;
        if (reasoning.length) message.reasoning_content = reasoning.join("\n\n");
        result.push(message);
      }
    } else if (contentParts.length) {
      result.push({ role: "user", content: contentParts });
    }
  }

  if (result.length === 0 || (result.length === 1 && result[0]?.role === "system")) {
    throw new GatewayError(400, "INVALID_REQUEST", "messages do not contain any usable content", "invalid_request_error");
  }
  return result;
}

export function anthropicMessagesToChat(body: JsonObject): JsonObject {
  const model = stringValue(body.model)?.trim();
  if (!model) throw new GatewayError(400, "INVALID_REQUEST", "The model field is required", "invalid_request_error");

  const out: JsonObject = { model, messages: convertMessages(body) };
  const maxTokens = numberValue(body.max_tokens);
  if (maxTokens !== undefined) out.max_tokens = Math.max(1, Math.floor(maxTokens));
  const temperature = numberValue(body.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const topP = numberValue(body.top_p);
  if (topP !== undefined) out.top_p = topP;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.every((value) => typeof value === "string")) {
    out.stop = body.stop_sequences;
  }
  out.stream = body.stream === true;
  if (out.stream) out.stream_options = { include_usage: true };

  const effort = reasoningEffort(body);
  if (effort) out.reasoning_effort = effort;

  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter(isObject).map((tool) => ({
      type: "function",
      function: {
        name: stringValue(tool.name) || "unknown",
        description: stringValue(tool.description) || "",
        parameters: normalizedSchema(tool.input_schema),
      },
    }));
    if (tools.length) out.tools = tools;
  }

  if (isObject(body.tool_choice)) {
    const type = stringValue(body.tool_choice.type);
    if (type === "auto") out.tool_choice = "auto";
    else if (type === "any") out.tool_choice = "required";
    else if (type === "none") out.tool_choice = "none";
    else if (type === "tool" && typeof body.tool_choice.name === "string") {
      out.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }
    if (typeof body.tool_choice.disable_parallel_tool_use === "boolean") {
      out.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
    }
  }

  if (isObject(body.metadata) && typeof body.metadata.user_id === "string") out.user = body.metadata.user_id;
  return out;
}

function openAIUsage(value: unknown): { input: number; output: number; cached: number } {
  if (!isObject(value)) return { input: 0, output: 0, cached: 0 };
  const input = numberValue(value.prompt_tokens) ?? numberValue(value.input_tokens) ?? 0;
  const output = numberValue(value.completion_tokens) ?? numberValue(value.output_tokens) ?? 0;
  const details = isObject(value.prompt_tokens_details) ? value.prompt_tokens_details
    : isObject(value.input_tokens_details) ? value.input_tokens_details : {};
  const cached = numberValue(details.cached_tokens) ?? numberValue(value.cache_read_input_tokens) ?? 0;
  return { input: Math.max(0, Math.floor(input)), output: Math.max(0, Math.floor(output)), cached: Math.max(0, Math.floor(cached)) };
}

function messageId(value: unknown): string {
  const raw = stringValue(value) || crypto.randomUUID();
  if (raw.startsWith("msg_")) return raw;
  return `msg_${raw.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function parseToolInput(value: unknown): JsonObject {
  if (isObject(value)) return value;
  if (typeof value !== "string") return {};
  return parseJsonObject(value);
}

function reasoningTexts(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item) result.push(item);
    else if (isObject(item) && typeof item.text === "string" && item.text) result.push(item.text);
  }
  return result;
}

function textFromChatContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => isObject(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
}

function mapStopReason(value: unknown, hasTools: boolean): string {
  if (hasTools) return "tool_use";
  switch (value) {
    case "length": return "max_tokens";
    case "tool_calls":
    case "function_call": return "tool_use";
    case "stop":
    case "content_filter":
    default: return "end_turn";
  }
}

export function chatCompletionToAnthropic(payload: JsonObject, fallbackModel?: string): JsonObject {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = isObject(choices[0]) ? choices[0] : {};
  const message = isObject(choice.message) ? choice.message : {};
  const content: JsonObject[] = [];

  for (const text of reasoningTexts(message.reasoning_content)) content.push({ type: "thinking", thinking: text });
  const text = textFromChatContent(message.content);
  if (text) content.push({ type: "text", text });

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const rawCall of toolCalls) {
    if (!isObject(rawCall)) continue;
    const fn = isObject(rawCall.function) ? rawCall.function : {};
    content.push({
      type: "tool_use",
      id: stringValue(rawCall.id) || `toolu_${crypto.randomUUID()}`,
      name: stringValue(fn.name) || "unknown",
      input: parseToolInput(fn.arguments),
    });
  }

  const usage = openAIUsage(payload.usage);
  const anthropicUsage: JsonObject = { input_tokens: usage.input, output_tokens: usage.output };
  if (usage.cached > 0) anthropicUsage.cache_read_input_tokens = usage.cached;
  return {
    id: messageId(payload.id),
    type: "message",
    role: "assistant",
    model: stringValue(payload.model) || fallbackModel || "unknown",
    content,
    stop_reason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: anthropicUsage,
  };
}

function responseHeaders(source: Headers, contentType: string): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-type", contentType);
  headers.set("cache-control", contentType.startsWith("text/event-stream") ? "no-cache, no-transform" : "no-store");
  return headers;
}

function sseEvent(type: string, payload: unknown): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

function chatSseToAnthropic(body: ReadableStream<Uint8Array>, fallbackModel: string): ReadableStream<Uint8Array> {
  let buffer = "";
  let started = false;
  let finished = false;
  let id = "";
  let model = fallbackModel;
  let nextBlockIndex = 0;
  let textIndex = -1;
  let textOpen = false;
  let thinkingIndex = -1;
  let thinkingOpen = false;
  let finishReason: unknown = "stop";
  let usage = { input: 0, output: 0, cached: 0 };
  const tools = new Map<number, StreamToolCall>();

  const ensureStart = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (started) return;
    controller.enqueue(sseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId(id), type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
    started = true;
  };

  const closeThinking = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!thinkingOpen) return;
    controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: thinkingIndex }));
    thinkingOpen = false;
  };

  const closeText = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!textOpen) return;
    controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: textIndex }));
    textOpen = false;
  };

  const emitThinking = (controller: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (!text) return;
    ensureStart(controller);
    if (!thinkingOpen) {
      closeText(controller);
      thinkingIndex = nextBlockIndex++;
      controller.enqueue(sseEvent("content_block_start", {
        type: "content_block_start", index: thinkingIndex, content_block: { type: "thinking", thinking: "" },
      }));
      thinkingOpen = true;
    }
    controller.enqueue(sseEvent("content_block_delta", {
      type: "content_block_delta", index: thinkingIndex, delta: { type: "thinking_delta", thinking: text },
    }));
  };

  const emitText = (controller: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (!text) return;
    ensureStart(controller);
    if (!textOpen) {
      closeThinking(controller);
      textIndex = nextBlockIndex++;
      controller.enqueue(sseEvent("content_block_start", {
        type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" },
      }));
      textOpen = true;
    }
    controller.enqueue(sseEvent("content_block_delta", {
      type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text },
    }));
  };

  const finalize = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    ensureStart(controller);
    closeThinking(controller);
    closeText(controller);
    for (const [toolIndex, tool] of [...tools.entries()].sort(([a], [b]) => a - b)) {
      const index = nextBlockIndex++;
      const toolId = tool.id || `toolu_${toolIndex}_${crypto.randomUUID()}`;
      const name = tool.name || "unknown";
      controller.enqueue(sseEvent("content_block_start", {
        type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name, input: {} },
      }));
      const partialJson = JSON.stringify(parseToolInput(tool.arguments || "{}"));
      controller.enqueue(sseEvent("content_block_delta", {
        type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson },
      }));
      controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    }
    const finalUsage: JsonObject = { input_tokens: usage.input, output_tokens: usage.output };
    if (usage.cached > 0) finalUsage.cache_read_input_tokens = usage.cached;
    controller.enqueue(sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapStopReason(finishReason, tools.size > 0), stop_sequence: null },
      usage: finalUsage,
    }));
    controller.enqueue(sseEvent("message_stop", { type: "message_stop" }));
    finished = true;
  };

  const handleData = (data: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!data || finished) return;
    if (data === "[DONE]") {
      finalize(controller);
      return;
    }
    let payload: JsonObject;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!isObject(parsed)) return;
      payload = parsed;
    } catch {
      return;
    }

    if (isObject(payload.error) || payload.type === "error") {
      const error = isObject(payload.error) ? payload.error : payload;
      ensureStart(controller);
      controller.enqueue(sseEvent("error", {
        type: "error",
        error: {
          type: stringValue(error.type) || "api_error",
          message: stringValue(error.message) || "Upstream stream error",
        },
      }));
      finished = true;
      return;
    }

    if (!id && typeof payload.id === "string") id = payload.id;
    if (typeof payload.model === "string") model = payload.model;
    if (isObject(payload.usage)) usage = openAIUsage(payload.usage);

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = isObject(choices[0]) ? choices[0] : undefined;
    if (!choice) return;
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
    const delta = isObject(choice.delta) ? choice.delta : {};
    for (const text of reasoningTexts(delta.reasoning_content)) emitThinking(controller, text);
    if (typeof delta.content === "string") emitText(controller, delta.content);

    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        if (!isObject(rawCall)) continue;
        const index = Math.max(0, Math.floor(numberValue(rawCall.index) ?? 0));
        const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof rawCall.id === "string" && rawCall.id) current.id = rawCall.id;
        const fn = isObject(rawCall.function) ? rawCall.function : {};
        if (typeof fn.name === "string" && fn.name) current.name = fn.name;
        if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        tools.set(index, current);
      }
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
        buffer = buffer.slice(boundary + separator.length);
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) handleData(data, controller);
      }
    },
    flush(controller) {
      const data = buffer.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) handleData(data, controller);
      finalize(controller);
    },
  });
  return body.pipeThrough(transform);
}

function anthropicMessageSse(message: JsonObject): string {
  const lines: string[] = [];
  const push = (type: string, payload: unknown) => lines.push(`event: ${type}\ndata: ${JSON.stringify(payload)}\n`);
  const content = Array.isArray(message.content) ? message.content : [];
  const usage = isObject(message.usage) ? message.usage : {};
  push("message_start", {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 } },
  });
  content.forEach((rawBlock, index) => {
    if (!isObject(rawBlock)) return;
    if (rawBlock.type === "text") {
      push("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      push("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: rawBlock.text ?? "" } });
    } else if (rawBlock.type === "thinking") {
      push("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      push("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: rawBlock.thinking ?? "" } });
    } else if (rawBlock.type === "tool_use") {
      push("content_block_start", { type: "content_block_start", index, content_block: { ...rawBlock, input: {} } });
      push("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(isObject(rawBlock.input) ? rawBlock.input : {}) } });
    }
    push("content_block_stop", { type: "content_block_stop", index });
  });
  push("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason ?? "end_turn", stop_sequence: null }, usage });
  push("message_stop", { type: "message_stop" });
  return lines.join("\n");
}

function anthropicErrorType(status: number, sourceType?: string): string {
  if (status === 400 || status === 413 || sourceType === "invalid_request_error") return "invalid_request_error";
  if (status === 401 || sourceType === "authentication_error") return "authentication_error";
  if (status === 403 || sourceType === "permission_error") return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429 || sourceType === "rate_limit_error") return "rate_limit_error";
  if (status === 503 || status === 529) return "overloaded_error";
  return "api_error";
}

export function anthropicJsonError(status: number, message: string, sourceType?: string, requestId?: string): Response {
  return Response.json({
    type: "error",
    error: { type: anthropicErrorType(status, sourceType), message },
  }, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}

async function convertErrorResponse(response: Response): Promise<Response> {
  let sourceType: string | undefined;
  let message = `Request failed with status ${response.status}`;
  try {
    const payload = await response.json() as unknown;
    if (isObject(payload) && isObject(payload.error)) {
      sourceType = stringValue(payload.error.type);
      message = stringValue(payload.error.message) || message;
    }
  } catch {
    // Keep the generic status-based message.
  }
  const converted = anthropicJsonError(response.status, message, sourceType, response.headers.get("x-request-id") ?? undefined);
  const headers = new Headers(converted.headers);
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(converted.body, { status: converted.status, headers });
}

export async function chatResponseToAnthropic(response: Response, requestedStream: boolean, model: string): Promise<Response> {
  if (!response.ok) return convertErrorResponse(response);
  const isSse = response.headers.get("content-type")?.includes("text/event-stream") === true;
  if (requestedStream && isSse && response.body) {
    return new Response(chatSseToAnthropic(response.body, model), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers, "text/event-stream; charset=utf-8"),
    });
  }

  let payload: JsonObject;
  try {
    const parsed = await response.json() as unknown;
    if (!isObject(parsed)) throw new Error("not an object");
    payload = parsed;
  } catch {
    return anthropicJsonError(502, "Upstream returned an invalid Chat Completions response", "api_error", response.headers.get("x-request-id") ?? undefined);
  }
  const message = chatCompletionToAnthropic(payload, model);
  if (requestedStream) {
    return new Response(anthropicMessageSse(message), {
      status: response.status,
      headers: responseHeaders(response.headers, "text/event-stream; charset=utf-8"),
    });
  }
  return Response.json(message, {
    status: response.status,
    headers: responseHeaders(response.headers, "application/json; charset=utf-8"),
  });
}

function withGatewayAuthorization(headers: Headers): Headers {
  const result = new Headers(headers);
  const authorization = result.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authorization)) {
    const apiKey = result.get("x-api-key")?.trim();
    if (apiKey) result.set("authorization", `Bearer ${apiKey}`);
  }
  result.delete("x-api-key");
  result.delete("anthropic-version");
  result.delete("anthropic-beta");
  result.delete("content-length");
  result.set("content-type", "application/json");
  return result;
}

function rewrittenRequest(request: Request, path: string, body?: unknown): Request {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const headers = withGatewayAuthorization(request.headers);
  return new Request(url, {
    method: body === undefined ? request.method : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: request.signal,
  });
}

function anthropicCors(request: Request): Response {
  const origin = request.headers.get("origin") || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin === "null" ? "*" : origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-request-id, x-session-id, x-conversation-id",
      "access-control-expose-headers": "x-request-id, request-id",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}

function estimateInputTokens(body: JsonObject): number {
  const parts: string[] = [];
  parts.push(anthropicText(body.system));
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isObject(message)) parts.push(anthropicText(message.content));
    }
  }
  if (Array.isArray(body.tools)) {
    try { parts.push(JSON.stringify(body.tools)); } catch { /* ignore */ }
  }
  return Math.max(1, Math.ceil(parts.join("\n").length / 4));
}

export async function handleAnthropicDownstream(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  worker: BaseWorker,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const isMessages = url.pathname === "/v1/messages" || url.pathname === "/v1/messages/";
  const isCountTokens = url.pathname === "/v1/messages/count_tokens" || url.pathname === "/v1/messages/count_tokens/";
  if (!isMessages && !isCountTokens) return undefined;
  if (request.method === "OPTIONS") return anthropicCors(request);
  if (request.method !== "POST") return anthropicJsonError(405, "Method not allowed", "invalid_request_error");

  try {
    const body = await readJsonBody(request, asInt(env.MAX_BODY_BYTES, 8 * 1024 * 1024));
    if (isCountTokens) {
      // Reuse the existing gateway authentication path without creating a separate auth implementation.
      const authCheck = await worker.fetch(rewrittenRequest(request, "/v1/models"), env, ctx);
      if (!authCheck.ok) return convertErrorResponse(authCheck);
      return Response.json({ input_tokens: estimateInputTokens(body) }, {
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      });
    }

    const chatBody = anthropicMessagesToChat(body);
    const model = stringValue(body.model) || "unknown";
    const upstream = await worker.fetch(rewrittenRequest(request, "/v1/chat/completions", chatBody), env, ctx);
    return chatResponseToAnthropic(upstream, body.stream === true, model);
  } catch (error) {
    if (error instanceof GatewayError) return anthropicJsonError(error.status, error.message, error.type);
    const message = error instanceof Error ? error.message : "Internal gateway error";
    return anthropicJsonError(500, message, "api_error");
  }
}
