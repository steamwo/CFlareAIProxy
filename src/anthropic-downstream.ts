import { GatewayError } from "./errors";

const encoder = new TextEncoder();

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

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedSchema(value: unknown): JsonObject {
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (!isObject(node)) return node;
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(node)) result[key] = normalize(child);
    if (result.type === "object" && !isObject(result.properties)) result.properties = {};
    return result;
  };
  const normalized = normalize(value);
  return isObject(normalized) ? normalized : { type: "object", properties: {} };
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

function openAIImagePart(part: JsonObject): JsonObject | undefined {
  if (part.type !== "image" || !isObject(part.source)) return undefined;
  const source = part.source;
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

function openAIContentPart(part: JsonObject): JsonObject | undefined {
  if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
  return openAIImagePart(part);
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

/**
 * Keep text-only tool results as strings for broad OpenAI compatibility, while
 * retaining Anthropic image blocks for providers that support multimodal tool
 * messages. Other structured blocks are serialized as text instead of dropped.
 */
function openAIToolResultContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (isObject(value)) {
    const image = openAIImagePart(value);
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
    const image = openAIImagePart(rawPart);
    if (image) {
      hasImage = true;
      parts.push(image);
      continue;
    }
    parts.push({ type: "text", text: jsonText(rawPart) });
  }

  if (hasImage) return parts;
  return parts
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
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
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new GatewayError(400, "INVALID_REQUEST", `Unsupported message role: ${role ?? "unknown"}`, "invalid_request_error");
    }
    const content = rawMessage.content;

    if (role === "system") {
      const text = anthropicText(content);
      if (text) result.push({ role: "system", content: text });
      continue;
    }
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
      const converted = openAIContentPart(rawPart);
      if (converted) {
        contentParts.push(converted);
        continue;
      }
      if (rawPart.type === "thinking" && role === "assistant" && typeof rawPart.thinking === "string") {
        reasoning.push(rawPart.thinking);
        continue;
      }
      if (rawPart.type === "redacted_thinking") continue;
      if (rawPart.type === "tool_use" && role === "assistant") {
        const id = stringValue(rawPart.id) || `toolu_${crypto.randomUUID()}`;
        const name = stringValue(rawPart.name) || "unknown";
        const input = isObject(rawPart.input) ? rawPart.input : {};
        toolCalls.push({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
        continue;
      }
      if (rawPart.type === "tool_result" && role === "user") {
        const id = stringValue(rawPart.tool_use_id);
        if (!id) continue;
        toolResults.push({ role: "tool", tool_call_id: id, content: openAIToolResultContent(rawPart.content) });
        continue;
      }
      if (role === "user") contentParts.push({ type: "text", text: jsonText(rawPart) });
    }

    // Tool results answer the previous assistant tool_calls and therefore must
    // remain immediately adjacent to that assistant message in OpenAI formats.
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

  if (result.length === 0 || result.every((message) => message.role === "system")) {
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

interface NormalizedUsage {
  input: number;
  output: number;
  cached: number;
  cacheCreation: number;
}

function openAIUsage(value: unknown): NormalizedUsage {
  if (!isObject(value)) return { input: 0, output: 0, cached: 0, cacheCreation: 0 };
  const promptTotal = numberValue(value.prompt_tokens);
  const inputTotal = numberValue(value.input_tokens);
  const output = numberValue(value.completion_tokens) ?? numberValue(value.output_tokens) ?? 0;
  const details = isObject(value.prompt_tokens_details)
    ? value.prompt_tokens_details
    : isObject(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const detailCached = numberValue(details?.cached_tokens);
  const cached = detailCached ?? numberValue(value.cache_read_input_tokens) ?? 0;
  const detailCreation = numberValue(details?.cache_creation_tokens);
  const cacheCreation = detailCreation ?? numberValue(value.cache_creation_input_tokens) ?? 0;

  let input = promptTotal ?? inputTotal ?? 0;
  // OpenAI prompt/input totals include cached tokens. Anthropic reports cache
  // reads/writes beside input_tokens, so remove those portions when the source
  // is an OpenAI-shaped total. If an upstream already supplies Anthropic-style
  // input_tokens + cache_read_input_tokens without details, leave it untouched.
  if (promptTotal !== undefined) input = Math.max(0, promptTotal - cached - cacheCreation);
  else if (inputTotal !== undefined && (detailCached !== undefined || detailCreation !== undefined)) {
    input = Math.max(0, inputTotal - cached - cacheCreation);
  }

  return {
    input: Math.max(0, Math.floor(input)),
    output: Math.max(0, Math.floor(output)),
    cached: Math.max(0, Math.floor(cached)),
    cacheCreation: Math.max(0, Math.floor(cacheCreation)),
  };
}

function anthropicUsage(value: unknown): JsonObject {
  const usage = openAIUsage(value);
  const result: JsonObject = { input_tokens: usage.input, output_tokens: usage.output };
  if (usage.cached > 0) result.cache_read_input_tokens = usage.cached;
  if (usage.cacheCreation > 0) result.cache_creation_input_tokens = usage.cacheCreation;
  return result;
}

function messageId(value: unknown): string {
  const raw = stringValue(value) || crypto.randomUUID();
  if (raw.startsWith("msg_")) return raw;
  return `msg_${raw.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function toolUseId(value: unknown): string {
  const raw = stringValue(value) || `toolu_${crypto.randomUUID()}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
  return sanitized || `toolu_${crypto.randomUUID()}`;
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
      id: toolUseId(rawCall.id),
      name: stringValue(fn.name) || "unknown",
      input: parseToolInput(fn.arguments),
    });
  }

  return {
    id: messageId(payload.id),
    type: "message",
    role: "assistant",
    model: stringValue(payload.model) || fallbackModel || "unknown",
    content,
    stop_reason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: anthropicUsage(payload.usage),
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
  blockIndex?: number;
  startEmitted: boolean;
}

function chatSseToAnthropic(body: ReadableStream<Uint8Array>, fallbackModel: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
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
  let usage: NormalizedUsage = { input: 0, output: 0, cached: 0, cacheCreation: 0 };
  const tools = new Map<number, StreamToolCall>();

  const ensureStart = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (started) return;
    controller.enqueue(sseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId(id),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
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
        type: "content_block_start",
        index: thinkingIndex,
        content_block: { type: "thinking", thinking: "" },
      }));
      thinkingOpen = true;
    }
    controller.enqueue(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: thinkingIndex,
      delta: { type: "thinking_delta", thinking: text },
    }));
  };

  const emitText = (controller: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (!text) return;
    ensureStart(controller);
    if (!textOpen) {
      closeThinking(controller);
      textIndex = nextBlockIndex++;
      controller.enqueue(sseEvent("content_block_start", {
        type: "content_block_start",
        index: textIndex,
        content_block: { type: "text", text: "" },
      }));
      textOpen = true;
    }
    controller.enqueue(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: textIndex,
      delta: { type: "text_delta", text },
    }));
  };

  const ensureToolStart = (
    controller: TransformStreamDefaultController<Uint8Array>,
    toolIndex: number,
    tool: StreamToolCall,
    force = false,
  ): boolean => {
    if (tool.startEmitted) return true;
    if (!force && (!tool.id || !tool.name)) return false;
    ensureStart(controller);
    closeThinking(controller);
    closeText(controller);
    tool.blockIndex = nextBlockIndex++;
    controller.enqueue(sseEvent("content_block_start", {
      type: "content_block_start",
      index: tool.blockIndex,
      content_block: {
        type: "tool_use",
        id: toolUseId(tool.id || `toolu_${toolIndex}_${crypto.randomUUID()}`),
        name: tool.name || "unknown",
        input: {},
      },
    }));
    tool.startEmitted = true;
    return true;
  };

  const finalize = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    ensureStart(controller);
    closeThinking(controller);
    closeText(controller);
    for (const [toolIndex, tool] of [...tools.entries()].sort(([left], [right]) => left - right)) {
      if (!ensureToolStart(controller, toolIndex, tool, true)) continue;
      const blockIndex = tool.blockIndex!;
      const partialJson = JSON.stringify(parseToolInput(tool.arguments || "{}"));
      controller.enqueue(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: partialJson },
      }));
      controller.enqueue(sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    }
    const finalUsage: JsonObject = { input_tokens: usage.input, output_tokens: usage.output };
    if (usage.cached > 0) finalUsage.cache_read_input_tokens = usage.cached;
    if (usage.cacheCreation > 0) finalUsage.cache_creation_input_tokens = usage.cacheCreation;
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
        const toolIndex = Math.max(0, Math.floor(numberValue(rawCall.index) ?? 0));
        const current = tools.get(toolIndex) ?? { id: "", name: "", arguments: "", startEmitted: false };
        if (typeof rawCall.id === "string" && rawCall.id) current.id = rawCall.id;
        const fn = isObject(rawCall.function) ? rawCall.function : {};
        if (!current.startEmitted && typeof fn.name === "string" && fn.name) current.name = fn.name;
        if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        tools.set(toolIndex, current);
        ensureToolStart(controller, toolIndex, current);
      }
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/\r?\n\r?\n/)) && match.index !== undefined) {
        const boundary = match.index;
        const separator = match[0];
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) handleData(data, controller);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
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
  const startUsage: JsonObject = { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 };
  if (numberValue(usage.cache_read_input_tokens)) startUsage.cache_read_input_tokens = usage.cache_read_input_tokens;
  if (numberValue(usage.cache_creation_input_tokens)) startUsage.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  push("message_start", {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, usage: startUsage },
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
      push("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(isObject(rawBlock.input) ? rawBlock.input : {}) },
      });
    }
    push("content_block_stop", { type: "content_block_stop", index });
  });
  push("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason ?? "end_turn", stop_sequence: null },
    usage,
  });
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
  const converted = anthropicJsonError(
    response.status,
    message,
    sourceType,
    response.headers.get("x-request-id") ?? undefined,
  );
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
    return anthropicJsonError(
      502,
      "Upstream returned an invalid Chat Completions response",
      "api_error",
      response.headers.get("x-request-id") ?? undefined,
    );
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
