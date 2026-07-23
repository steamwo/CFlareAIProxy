import type { UpstreamResponseMode, Usage } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ResponseMetrics {
  usage: Usage;
  firstTokenMs?: number;
  streamError?: string;
}

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

function numberField(object: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  }
  return 0;
}

export function extractUsage(value: unknown): Usage {
  if (!value || typeof value !== "object") return emptyUsage();
  const record = value as Record<string, unknown>;
  const raw = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : record;
  const promptTokens = numberField(raw, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens");
  const completionTokens = numberField(raw, "completion_tokens", "output_tokens", "completionTokens", "outputTokens");
  const promptDetails = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object"
    ? raw.prompt_tokens_details as Record<string, unknown>
    : raw.input_tokens_details && typeof raw.input_tokens_details === "object"
      ? raw.input_tokens_details as Record<string, unknown>
      : {};
  const cachedTokens = Math.min(promptTokens, numberField(promptDetails, "cached_tokens", "cachedTokens"));
  const totalTokens = numberField(raw, "total_tokens", "totalTokens") || promptTokens + completionTokens;
  return { promptTokens, completionTokens, cachedTokens, totalTokens };
}

function mergeUsage(left: Usage, right: Usage): Usage {
  return {
    promptTokens: Math.max(left.promptTokens, right.promptTokens),
    completionTokens: Math.max(left.completionTokens, right.completionTokens),
    cachedTokens: Math.max(left.cachedTokens, right.cachedTokens),
    totalTokens: Math.max(left.totalTokens, right.totalTokens, right.promptTokens + right.completionTokens),
  };
}

function parseUsageFromText(text: string): Usage {
  let usage = emptyUsage();
  try {
    usage = mergeUsage(usage, extractUsage(JSON.parse(text)));
  } catch {
    // SSE or a partial body.
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      usage = mergeUsage(usage, extractUsage(parsed));
      if (parsed && typeof parsed === "object") {
        const body = (parsed as Record<string, unknown>).body;
        if (typeof body === "string") {
          try { usage = mergeUsage(usage, extractUsage(JSON.parse(body))); } catch { /* ignore */ }
        }
      }
    } catch {
      // Ignore malformed event fragments.
    }
  }
  return usage;
}

function responseHeaders(source: Headers, contentType?: string): Headers {
  const headers = new Headers(source);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-cache, no-store");
  return headers;
}

function chatChunk(requestId: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return JSON.stringify({
    id: requestId.startsWith("chatcmpl-") ? requestId : `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function codexResponseToChat(payload: Record<string, unknown>, model: string, requestId: string): Record<string, unknown> {
  let content = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const rawItem of output) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as Record<string, unknown>;
        if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") content += part.text;
      }
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : crypto.randomUUID(),
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "unknown",
          arguments: typeof item.arguments === "string" ? item.arguments : "{}",
        },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = extractUsage(payload);
  return {
    id: typeof payload.id === "string" ? payload.id : `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: typeof payload.created_at === "number" ? payload.created_at : Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedTokens },
    },
  };
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

function codexChatStream(body: ReadableStream<Uint8Array>, model: string, requestId: string): ReadableStream<Uint8Array> {
  let roleSent = false;
  let doneSent = false;
  let finishReason = "stop";
  return sseTransform(
    body,
    (data, controller) => {
      if (data === "[DONE]") {
        if (!doneSent) {
          controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, {}, finishReason)}\n\ndata: [DONE]\n\n`));
          doneSent = true;
        }
        return;
      }
      let event: Record<string, unknown>;
      try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        const delta: Record<string, unknown> = { content: event.delta };
        if (!roleSent) { delta.role = "assistant"; roleSent = true; }
        controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, delta)}\n\n`));
        return;
      }
      if (type === "response.output_item.added" && event.item && typeof event.item === "object") {
        const item = event.item as Record<string, unknown>;
        if (item.type === "function_call") {
          finishReason = "tool_calls";
          const delta: Record<string, unknown> = {
            tool_calls: [{
              index: typeof event.output_index === "number" ? event.output_index : 0,
              id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : crypto.randomUUID(),
              type: "function",
              function: { name: typeof item.name === "string" ? item.name : "unknown", arguments: "" },
            }],
          };
          if (!roleSent) { delta.role = "assistant"; roleSent = true; }
          controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, delta)}\n\n`));
        }
        return;
      }
      if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const index = typeof event.output_index === "number" ? event.output_index : 0;
        controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, {
          tool_calls: [{ index, function: { arguments: event.delta } }],
        })}\n\n`));
        return;
      }
      if (type === "response.completed") {
        const response = event.response && typeof event.response === "object" ? event.response as Record<string, unknown> : undefined;
        const usage = response ? extractUsage(response) : emptyUsage();
        const final = JSON.parse(chatChunk(requestId, model, {}, finishReason)) as Record<string, unknown>;
        final.usage = { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`));
        doneSent = true;
      }
    },
    (controller) => {
      if (!doneSent) controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, {}, finishReason)}\n\ndata: [DONE]\n\n`));
    },
  );
}

function qoderChatStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let doneSent = false;
  return sseTransform(
    body,
    (data, controller) => {
      if (data === "[DONE]") {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneSent = true;
        return;
      }
      try {
        const envelope = JSON.parse(data) as Record<string, unknown>;
        const status = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
        const inner = typeof envelope.body === "string" ? envelope.body : "";
        if (status !== 200) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: inner || `Qoder status ${status}`, type: "upstream_error", code: "QODER_STREAM_ERROR" } })}\n\n`));
          return;
        }
        if (inner) controller.enqueue(encoder.encode(`data: ${inner}\n\n`));
      } catch {
        // Ignore upstream keepalive/malformed lines.
      }
    },
    (controller) => {
      if (!doneSent) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  );
}

async function readTextLimited(body: ReadableStream<Uint8Array> | null, maxBytes = 32 * 1024 * 1024): Promise<string> {
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
      throw new Error(`Buffered upstream response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return decoder.decode(output);
}

function collectCodexSse(text: string, model: string, requestId: string): Record<string, unknown> {
  let content = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage = emptyUsage();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") content += event.delta;
    if (event.type === "response.output_item.added" && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>;
      if (item.type === "function_call") {
        const index = typeof event.output_index === "number" ? event.output_index : toolCalls.size;
        toolCalls.set(index, {
          id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : crypto.randomUUID(),
          name: typeof item.name === "string" ? item.name : "unknown",
          arguments: typeof item.arguments === "string" ? item.arguments : "",
        });
      }
    }
    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const index = typeof event.output_index === "number" ? event.output_index : 0;
      const current = toolCalls.get(index) ?? { id: crypto.randomUUID(), name: "unknown", arguments: "" };
      current.arguments += event.delta;
      toolCalls.set(index, current);
    }
    if (event.response && typeof event.response === "object") usage = mergeUsage(usage, extractUsage(event.response));
    usage = mergeUsage(usage, extractUsage(event));
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  }
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.size ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
  };
}

function collectQoderSse(text: string, model: string, requestId: string): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  let usage = emptyUsage();
  let finishReason = "stop";
  const toolCalls = new Map<number, Record<string, unknown>>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
    const innerText = typeof envelope.body === "string" ? envelope.body : data;
    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(innerText) as Record<string, unknown>; } catch { continue; }
    usage = mergeUsage(usage, extractUsage(chunk));
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : {};
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!raw || typeof raw !== "object") continue;
        const call = raw as Record<string, unknown>;
        const index = typeof call.index === "number" ? call.index : 0;
        const current = toolCalls.get(index) ?? { id: call.id ?? crypto.randomUUID(), type: "function", function: { name: "", arguments: "" } };
        const currentFn = current.function && typeof current.function === "object" ? current.function as Record<string, unknown> : {};
        const nextFn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
        if (typeof nextFn.name === "string") currentFn.name = `${typeof currentFn.name === "string" ? currentFn.name : ""}${nextFn.name}`;
        if (typeof nextFn.arguments === "string") currentFn.arguments = `${typeof currentFn.arguments === "string" ? currentFn.arguments : ""}${nextFn.arguments}`;
        current.function = currentFn;
        if (typeof call.id === "string") current.id = call.id;
        toolCalls.set(index, current);
      }
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
  };
}


function mapAnthropicFinishReason(value: unknown): string {
  if (value === "tool_use") return "tool_calls";
  if (value === "max_tokens") return "length";
  if (value === "refusal") return "content_filter";
  return "stop";
}

function anthropicResponseToChat(payload: Record<string, unknown>, model: string, requestId: string): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  for (const rawBlock of blocks) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") content += block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") reasoning += block.thinking;
    if (block.type === "tool_use") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : crypto.randomUUID(),
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "unknown",
          arguments: JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}),
        },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = extractUsage(payload);
  return {
    id: typeof payload.id === "string" ? payload.id : `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : mapAnthropicFinishReason(payload.stop_reason) }],
    usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
  };
}

function anthropicChatStream(body: ReadableStream<Uint8Array>, model: string, requestId: string): ReadableStream<Uint8Array> {
  let roleSent = false;
  let doneSent = false;
  let finishReason = "stop";
  let usage = emptyUsage();
  const blockTypes = new Map<number, string>();
  return sseTransform(
    body,
    (data, controller) => {
      if (data === "[DONE]") {
        if (!doneSent) {
          controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, {}, finishReason)}\n\ndata: [DONE]\n\n`));
          doneSent = true;
        }
        return;
      }
      let event: Record<string, unknown>;
      try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "message_start" && event.message && typeof event.message === "object") {
        usage = mergeUsage(usage, extractUsage(event.message));
        return;
      }
      if (type === "content_block_start" && event.content_block && typeof event.content_block === "object") {
        const index = typeof event.index === "number" ? event.index : blockTypes.size;
        const block = event.content_block as Record<string, unknown>;
        const blockType = typeof block.type === "string" ? block.type : "";
        blockTypes.set(index, blockType);
        if (blockType === "tool_use") {
          finishReason = "tool_calls";
          const delta: Record<string, unknown> = {
            tool_calls: [{
              index,
              id: typeof block.id === "string" ? block.id : crypto.randomUUID(),
              type: "function",
              function: { name: typeof block.name === "string" ? block.name : "unknown", arguments: "" },
            }],
          };
          if (!roleSent) { delta.role = "assistant"; roleSent = true; }
          controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, delta)}\n\n`));
        }
        return;
      }
      if (type === "content_block_delta" && event.delta && typeof event.delta === "object") {
        const index = typeof event.index === "number" ? event.index : 0;
        const deltaEvent = event.delta as Record<string, unknown>;
        const delta: Record<string, unknown> = {};
        if (deltaEvent.type === "text_delta" && typeof deltaEvent.text === "string") delta.content = deltaEvent.text;
        if (deltaEvent.type === "thinking_delta" && typeof deltaEvent.thinking === "string") delta.reasoning_content = deltaEvent.thinking;
        if (deltaEvent.type === "input_json_delta" && typeof deltaEvent.partial_json === "string") {
          delta.tool_calls = [{ index, function: { arguments: deltaEvent.partial_json } }];
        }
        if (!Object.keys(delta).length) return;
        if (!roleSent) { delta.role = "assistant"; roleSent = true; }
        controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, delta)}\n\n`));
        return;
      }
      if (type === "message_delta") {
        const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : {};
        if (delta.stop_reason) finishReason = mapAnthropicFinishReason(delta.stop_reason);
        usage = mergeUsage(usage, extractUsage(event));
        return;
      }
      if (type === "message_stop") {
        const final = JSON.parse(chatChunk(requestId, model, {}, finishReason)) as Record<string, unknown>;
        final.usage = { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`));
        doneSent = true;
      }
    },
    (controller) => {
      if (!doneSent) controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, {}, finishReason)}\n\ndata: [DONE]\n\n`));
    },
  );
}

function collectAnthropicSse(text: string, model: string, requestId: string): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = emptyUsage();
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
    if (event.type === "message_start" && event.message && typeof event.message === "object") usage = mergeUsage(usage, extractUsage(event.message));
    if (event.type === "content_block_start" && event.content_block && typeof event.content_block === "object") {
      const index = typeof event.index === "number" ? event.index : toolCalls.size;
      const block = event.content_block as Record<string, unknown>;
      if (block.type === "tool_use") toolCalls.set(index, {
        id: typeof block.id === "string" ? block.id : crypto.randomUUID(),
        name: typeof block.name === "string" ? block.name : "unknown",
        arguments: "",
      });
    }
    if (event.type === "content_block_delta" && event.delta && typeof event.delta === "object") {
      const index = typeof event.index === "number" ? event.index : 0;
      const delta = event.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") content += delta.text;
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") reasoning += delta.thinking;
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const current = toolCalls.get(index) ?? { id: crypto.randomUUID(), name: "unknown", arguments: "" };
        current.arguments += delta.partial_json;
        toolCalls.set(index, current);
      }
    }
    if (event.type === "message_delta") {
      const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : {};
      if (delta.stop_reason) finishReason = mapAnthropicFinishReason(delta.stop_reason);
      usage = mergeUsage(usage, extractUsage(event));
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
    id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" },
  }));
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.size ? "tool_calls" : finishReason }],
    usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
  };
}

function googleUsage(value: unknown): Usage {
  if (!value || typeof value !== "object") return emptyUsage();
  const record = value as Record<string, unknown>;
  const raw = record.usageMetadata && typeof record.usageMetadata === "object"
    ? record.usageMetadata as Record<string, unknown>
    : record;
  const promptTokens = numberField(raw, "promptTokenCount", "prompt_tokens", "input_tokens");
  const completionTokens = numberField(raw, "candidatesTokenCount", "completion_tokens", "output_tokens");
  const totalTokens = numberField(raw, "totalTokenCount", "total_tokens") || promptTokens + completionTokens;
  return { promptTokens, completionTokens, cachedTokens: 0, totalTokens };
}

function mapGoogleFinishReason(value: unknown): string {
  const reason = typeof value === "string" ? value.toUpperCase() : "";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || reason === "BLOCKLIST") return "content_filter";
  return "stop";
}

function googleResponseToChat(payload: Record<string, unknown>, model: string, requestId: string): Record<string, unknown> {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = candidates[0] && typeof candidates[0] === "object" ? candidates[0] as Record<string, unknown> : {};
  const contentValue = candidate.content && typeof candidate.content === "object" ? candidate.content as Record<string, unknown> : {};
  const parts = Array.isArray(contentValue.parts) ? contentValue.parts : [];
  let content = "";
  let reasoning = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const rawPart of parts) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as Record<string, unknown>;
    if (typeof part.text === "string") {
      if (part.thought === true) reasoning += part.text;
      else content += part.text;
    }
    if (part.functionCall && typeof part.functionCall === "object") {
      const call = part.functionCall as Record<string, unknown>;
      toolCalls.push({
        id: typeof call.id === "string" ? call.id : crypto.randomUUID(),
        type: "function",
        function: {
          name: typeof call.name === "string" ? call.name : "unknown",
          arguments: JSON.stringify(call.args && typeof call.args === "object" ? call.args : {}),
        },
      });
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = googleUsage(payload);
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : mapGoogleFinishReason(candidate.finishReason) }],
    usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
  };
}

function googleChatStream(body: ReadableStream<Uint8Array>, model: string, requestId: string): ReadableStream<Uint8Array> {
  let roleSent = false;
  let doneSent = false;
  let finishReason = "stop";
  let usage = emptyUsage();
  let toolIndex = 0;
  return sseTransform(
    body,
    (data, controller) => {
      if (data === "[DONE]") {
        if (!doneSent) {
          controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, {}, finishReason)}\n\ndata: [DONE]\n\n`));
          doneSent = true;
        }
        return;
      }
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(data) as Record<string, unknown>; } catch { return; }
      usage = mergeUsage(usage, googleUsage(payload));
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
      const candidate = candidates[0] && typeof candidates[0] === "object" ? candidates[0] as Record<string, unknown> : {};
      if (candidate.finishReason) finishReason = mapGoogleFinishReason(candidate.finishReason);
      const contentValue = candidate.content && typeof candidate.content === "object" ? candidate.content as Record<string, unknown> : {};
      const parts = Array.isArray(contentValue.parts) ? contentValue.parts : [];
      for (const rawPart of parts) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as Record<string, unknown>;
        const delta: Record<string, unknown> = {};
        if (typeof part.text === "string") {
          if (part.thought === true) delta.reasoning_content = part.text;
          else delta.content = part.text;
        }
        if (part.functionCall && typeof part.functionCall === "object") {
          const call = part.functionCall as Record<string, unknown>;
          delta.tool_calls = [{
            index: toolIndex++,
            id: typeof call.id === "string" ? call.id : crypto.randomUUID(),
            type: "function",
            function: {
              name: typeof call.name === "string" ? call.name : "unknown",
              arguments: JSON.stringify(call.args && typeof call.args === "object" ? call.args : {}),
            },
          }];
          finishReason = "tool_calls";
        }
        if (!Object.keys(delta).length) continue;
        if (!roleSent) { delta.role = "assistant"; roleSent = true; }
        controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, delta)}\n\n`));
      }
      if (candidate.finishReason) {
        const final = JSON.parse(chatChunk(requestId, model, {}, finishReason)) as Record<string, unknown>;
        final.usage = { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`));
        doneSent = true;
      }
    },
    (controller) => {
      if (!doneSent) controller.enqueue(encoder.encode(`data: ${chatChunk(requestId, model, {}, finishReason)}\n\ndata: [DONE]\n\n`));
    },
  );
}

function collectGoogleSse(text: string, model: string, requestId: string): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = emptyUsage();
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
    usage = mergeUsage(usage, googleUsage(payload));
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const candidate = candidates[0] && typeof candidates[0] === "object" ? candidates[0] as Record<string, unknown> : {};
    if (candidate.finishReason) finishReason = mapGoogleFinishReason(candidate.finishReason);
    const contentValue = candidate.content && typeof candidate.content === "object" ? candidate.content as Record<string, unknown> : {};
    const parts = Array.isArray(contentValue.parts) ? contentValue.parts : [];
    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (typeof part.text === "string") {
        if (part.thought === true) reasoning += part.text;
        else content += part.text;
      }
      if (part.functionCall && typeof part.functionCall === "object") {
        const call = part.functionCall as Record<string, unknown>;
        toolCalls.push({
          id: typeof call.id === "string" ? call.id : crypto.randomUUID(), type: "function",
          function: { name: typeof call.name === "string" ? call.name : "unknown", arguments: JSON.stringify(call.args && typeof call.args === "object" ? call.args : {}) },
        });
      }
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : finishReason }],
    usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
  };
}

export async function prepareDownstreamResponse(
  upstream: Response,
  mode: UpstreamResponseMode,
  requestedStream: boolean,
  model: string,
  requestId: string,
): Promise<Response> {
  if (mode === "passthrough") {
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders(upstream.headers) });
  }
  if (requestedStream) {
    if (!upstream.body) return new Response(null, { status: upstream.status, headers: responseHeaders(upstream.headers, "text/event-stream; charset=utf-8") });
    const body = mode === "codex-chat"
      ? codexChatStream(upstream.body, model, requestId)
      : mode === "qoder-chat"
        ? qoderChatStream(upstream.body)
        : mode === "anthropic-chat"
          ? anthropicChatStream(upstream.body, model, requestId)
          : googleChatStream(upstream.body, model, requestId);
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders(upstream.headers, "text/event-stream; charset=utf-8") });
  }

  const text = await readTextLimited(upstream.body);
  let payload: Record<string, unknown>;
  if (mode === "codex-chat") {
    if (upstream.headers.get("content-type")?.includes("application/json")) {
      payload = codexResponseToChat(JSON.parse(text) as Record<string, unknown>, model, requestId);
    } else {
      payload = collectCodexSse(text, model, requestId);
    }
  } else if (mode === "qoder-chat") {
    payload = collectQoderSse(text, model, requestId);
  } else if (mode === "anthropic-chat") {
    payload = upstream.headers.get("content-type")?.includes("application/json")
      ? anthropicResponseToChat(JSON.parse(text) as Record<string, unknown>, model, requestId)
      : collectAnthropicSse(text, model, requestId);
  } else {
    payload = upstream.headers.get("content-type")?.includes("application/json")
      ? googleResponseToChat(JSON.parse(text) as Record<string, unknown>, model, requestId)
      : collectGoogleSse(text, model, requestId);
  }
  return Response.json(payload, { status: upstream.status, headers: responseHeaders(upstream.headers, "application/json; charset=utf-8") });
}

export function trackResponse(
  response: Response,
  startedAt: number,
  finalize: (metrics: ResponseMetrics) => Promise<void> | void,
): Response {
  if (!response.body) {
    void finalize({ usage: emptyUsage() });
    return response;
  }
  const reader = response.body.getReader();
  const captured: Uint8Array[] = [];
  let capturedBytes = 0;
  let firstTokenMs: number | undefined;
  let finalized = false;
  const finish = async (streamError?: unknown): Promise<void> => {
    if (finalized) return;
    finalized = true;
    const merged = new Uint8Array(capturedBytes);
    let offset = 0;
    for (const chunk of captured) { merged.set(chunk, offset); offset += chunk.byteLength; }
    await finalize({
      usage: parseUsageFromText(decoder.decode(merged)),
      firstTokenMs,
      streamError: streamError === undefined ? undefined : streamError instanceof Error ? streamError.message : String(streamError),
    });
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await finish();
          return;
        }
        if (firstTokenMs === undefined && value.byteLength > 0) firstTokenMs = Date.now() - startedAt;
        if (capturedBytes < 2 * 1024 * 1024) {
          const remaining = 2 * 1024 * 1024 - capturedBytes;
          const slice = value.byteLength <= remaining ? value : value.slice(0, remaining);
          captured.push(slice);
          capturedBytes += slice.byteLength;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await finish(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await finish();
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
