import { GatewayError } from "./errors";
import type { ProviderResponseContext } from "./provider-response";
import type { QoderToolRoute } from "./providers/qoder-protocol";
import { takeQoderToolRoutes } from "./providers/qoder-tool-routes";
import { readResponseText } from "./response-utils";
import { extractUsage } from "./stream";
import type { Usage } from "./types";

const encoder = new TextEncoder();
type JsonRecord = Record<string, unknown>;

interface QoderQueueInfo {
  code?: string;
  modelKey?: string;
  queueCount?: number;
  queueType?: string;
  retryAfterSeconds: number;
  waitTime?: number;
  serviceAvailable?: boolean;
  message: string;
}

interface ToolState {
  index: number;
  id: string;
  name: string;
  args: string;
  itemId?: string;
  outputIndex?: number;
  added?: boolean;
}

interface QoderAggregate {
  text: string;
  reasoning: string;
  usage: Usage;
  finishReason: string;
  tools: Map<number, ToolState>;
}

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

function envelopeBody(envelope: JsonRecord): string {
  if (typeof envelope.body === "string") return envelope.body;
  if (envelope.body !== undefined && envelope.body !== null) {
    try { return JSON.stringify(envelope.body); } catch { return String(envelope.body); }
  }
  return "";
}

function qoderFrame(data: string): { innerText: string; error?: string } | undefined {
  let envelope: JsonRecord;
  try { envelope = JSON.parse(data) as JsonRecord; } catch { return undefined; }
  const status = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
  const body = envelopeBody(envelope);
  if (status !== 200) return { innerText: "", error: body || `Qoder status ${status}` };
  return { innerText: body };
}

function nestedChunk(value: unknown, depth = 0): JsonRecord | undefined {
  if (depth > 5) return undefined;
  let object: JsonRecord | undefined;
  if (typeof value === "string") {
    try { object = record(JSON.parse(value)); } catch { return undefined; }
  } else object = record(value);
  if (!object) return undefined;
  if (Array.isArray(object.choices) || typeof object.type === "string" || object.error != null || object.usage != null) return object;
  for (const key of ["llm_model_result", "data", "result", "payload", "body"]) {
    if (object[key] == null) continue;
    const nested = nestedChunk(object[key], depth + 1);
    if (nested) return nested;
  }
  return object;
}

function normalizedChunk(data: string, state: QoderStreamOutputState, model: string): { chunk?: JsonRecord; raw?: string; error?: string } {
  const frame = qoderFrame(data);
  if (!frame) return {};
  if (frame.error) return { error: frame.error };
  if (!frame.innerText.trim()) return {};
  const chunk = nestedChunk(frame.innerText);
  if (!chunk) return { raw: frame.innerText };
  state.normalizeChunk(chunk);
  if (Array.isArray(chunk.choices) && model) chunk.model = model;
  return { chunk };
}

function isCompleteSseData(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "[DONE]") return true;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

function qoderSseTransform(
  body: ReadableStream<Uint8Array>,
  handleData: (data: string, controller: TransformStreamDefaultController<Uint8Array>) => void,
  flush?: (controller: TransformStreamDefaultController<Uint8Array>) => void,
  start?: (controller: TransformStreamDefaultController<Uint8Array>) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: string[] = [];
  const dispatch = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (!pending.length) return;
    const data = pending.join("\n");
    pending = [];
    if (data) handleData(data, controller);
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
      handleData(data, controller);
      return;
    }
    pending.push(data);
    if (isCompleteSseData(pending.join("\n"))) dispatch(controller);
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start(controller) { start?.(controller); },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        processLine(buffer.slice(0, newline), controller);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) processLine(buffer, controller);
      dispatch(controller);
      flush?.(controller);
    },
  }));
}

function qoderDataEvents(text: string): string[] {
  const output: string[] = [];
  let pending: string[] = [];
  const dispatch = (): void => {
    if (!pending.length) return;
    output.push(pending.join("\n"));
    pending = [];
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) { dispatch(); continue; }
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trimStart();
    if (!pending.length && isCompleteSseData(value)) output.push(value);
    else {
      pending.push(value);
      if (isCompleteSseData(pending.join("\n"))) dispatch();
    }
  }
  dispatch();
  return output;
}

function codeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value).toString();
  return "";
}

function nestedJsonMaps(input: string, maxDepth = 5): JsonRecord[] {
  const output: JsonRecord[] = [];
  let current = input.trim();
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    let object: JsonRecord | undefined;
    try { object = record(JSON.parse(current)); } catch { break; }
    if (!object) break;
    output.push(object);
    const next = [object.message, object.msg, object.body, object.data].find((value) => typeof value === "string" && value.trim());
    if (typeof next !== "string") break;
    current = next.trim();
  }
  return output;
}

export function qoderQueueInfoFromEnvelope(data: string): QoderQueueInfo | undefined {
  let envelope: JsonRecord;
  try { envelope = JSON.parse(data) as JsonRecord; } catch { return undefined; }
  const inner = envelopeBody(envelope);
  const info: QoderQueueInfo = { retryAfterSeconds: 30, message: inner.trim() || "Qoder request is queued" };
  let queued = false;
  for (const object of nestedJsonMaps(inner)) {
    const code = codeString(object.code);
    if (code) info.code = code;
    const modelKey = typeof object.modelKey === "string" ? object.modelKey : typeof object.model_key === "string" ? object.model_key : undefined;
    if (modelKey) info.modelKey = modelKey;
    if (typeof object.queueCount === "number") info.queueCount = Math.floor(object.queueCount);
    if (typeof object.queueType === "string") info.queueType = object.queueType;
    if (typeof object.retryAfterSeconds === "number" && object.retryAfterSeconds > 0) info.retryAfterSeconds = Math.floor(object.retryAfterSeconds);
    if (typeof object.waitTime === "number") info.waitTime = Math.floor(object.waitTime);
    if (typeof object.serviceAvailable === "boolean") info.serviceAvailable = object.serviceAvailable;
    const message = typeof object.message === "string" && object.message.trim() ? object.message : typeof object.msg === "string" ? object.msg : "";
    if (message) info.message = message;
    if (object.isQueued === true || code === "10605") queued = true;
  }
  return queued ? info : undefined;
}

async function firstQoderData(response: Response, maxBytes = 128 * 1024): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  let pending: string[] = [];
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line) {
          if (pending.length) return pending.join("\n");
          newline = buffer.indexOf("\n");
          continue;
        }
        if (line.startsWith("data:")) {
          const data = line.slice(5).trimStart();
          if (!pending.length && isCompleteSseData(data)) return data;
          pending.push(data);
          if (isCompleteSseData(pending.join("\n"))) return pending.join("\n");
        }
        newline = buffer.indexOf("\n");
      }
    }
    return pending.length ? pending.join("\n") : undefined;
  } finally {
    await reader.cancel("qoder queue inspection complete").catch(() => undefined);
  }
}

async function inspectQoderQueue(response: Response): Promise<QoderQueueInfo | undefined> {
  if (!response.body) return undefined;
  const data = await firstQoderData(response.clone()).catch(() => undefined);
  return data ? qoderQueueInfoFromEnvelope(data) : undefined;
}

function qoderQueueResponse(context: ProviderResponseContext, info: QoderQueueInfo): Response {
  const headers = responseHeaders(context.upstream.headers, "application/json; charset=utf-8");
  headers.set("retry-after", Math.max(1, info.retryAfterSeconds).toString());
  const message = info.message || "Qoder request is queued";
  const detail = {
    code: info.code,
    model_key: info.modelKey,
    queue_count: info.queueCount,
    queue_type: info.queueType,
    wait_time: info.waitTime,
    service_available: info.serviceAvailable,
  };
  if (context.endpoint === "messages") {
    return Response.json({ type: "error", error: { type: "rate_limit_error", message, qoder_queue: detail } }, { status: 429, headers });
  }
  return Response.json({ error: { message, type: "rate_limit_error", code: "QODER_QUEUED", qoder_queue: detail } }, { status: 429, headers });
}

function newAggregate(): QoderAggregate {
  return { text: "", reasoning: "", usage: emptyUsage(), finishReason: "stop", tools: new Map() };
}

function appendToolName(current: string, next: string): string {
  if (!next) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next) || current.endsWith(next)) return current;
  return current + next;
}

function applyChunk(aggregate: QoderAggregate, chunk: JsonRecord): void {
  aggregate.usage = mergeUsage(aggregate.usage, extractUsage(chunk));
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const choice = record(choices[0]) ?? {};
  if (typeof choice.finish_reason === "string" && choice.finish_reason) aggregate.finishReason = choice.finish_reason;
  const delta = record(choice.delta) ?? {};
  if (typeof delta.content === "string") aggregate.text += delta.content;
  if (typeof delta.reasoning_content === "string") aggregate.reasoning += delta.reasoning_content;
  if (!Array.isArray(delta.tool_calls)) return;
  delta.tool_calls.forEach((rawCall, position) => {
    const call = record(rawCall);
    if (!call) return;
    const index = toolCallIndex(call, position);
    const current = aggregate.tools.get(index) ?? { index, id: "", name: "", args: "" };
    const fn = record(call.function) ?? {};
    if (typeof call.id === "string" && call.id) current.id = call.id;
    if (typeof fn.name === "string") current.name = appendToolName(current.name, fn.name);
    if (typeof fn.arguments === "string") current.args += fn.arguments;
    aggregate.tools.set(index, current);
  });
}

function parseQoderAggregate(text: string, model: string): QoderAggregate {
  const aggregate = newAggregate();
  const state = new QoderStreamOutputState();
  for (const data of qoderDataEvents(text)) {
    if (!data || data === "[DONE]") continue;
    const parsed = normalizedChunk(data, state, model);
    if (parsed.error) throw new GatewayError(502, "UPSTREAM_STREAM_ERROR", `Qoder stream error: ${parsed.error}`, "upstream_error");
    if (parsed.chunk) applyChunk(aggregate, parsed.chunk);
  }
  return aggregate;
}

function orderedTools(aggregate: QoderAggregate): ToolState[] {
  return [...aggregate.tools.values()].sort((left, right) => left.index - right.index);
}

function chatPayload(aggregate: QoderAggregate, model: string, requestId: string): JsonRecord {
  const message: JsonRecord = { role: "assistant", content: aggregate.text || null };
  if (aggregate.reasoning) message.reasoning_content = aggregate.reasoning;
  if (aggregate.tools.size) message.tool_calls = orderedTools(aggregate).map((tool) => ({
    id: tool.id || crypto.randomUUID(), type: "function", function: { name: tool.name || "unknown", arguments: tool.args || "{}" },
  }));
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: aggregate.tools.size ? "tool_calls" : aggregate.finishReason }],
    usage: {
      prompt_tokens: aggregate.usage.promptTokens,
      completion_tokens: aggregate.usage.completionTokens,
      total_tokens: aggregate.usage.totalTokens,
      prompt_tokens_details: { cached_tokens: aggregate.usage.cachedTokens },
    },
  };
}

function responsesUsage(usage: Usage): JsonRecord {
  return {
    input_tokens: usage.promptTokens,
    input_tokens_details: { cached_tokens: usage.cachedTokens },
    output_tokens: usage.completionTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.totalTokens,
  };
}

function parseToolArguments(raw: string): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { query: raw }; }
}

function routeFor(tool: ToolState, routes: Map<string, QoderToolRoute>): QoderToolRoute {
  return routes.get(tool.name) ?? { kind: tool.name === "tool_search" ? "tool_search" : "function", name: tool.name || "unknown" };
}

function responseToolItem(tool: ToolState, routes: Map<string, QoderToolRoute>, status: "in_progress" | "completed"): JsonRecord {
  const route = routeFor(tool, routes);
  const itemId = tool.itemId ?? `fc_${crypto.randomUUID().replace(/-/g, "")}`;
  const callId = tool.id || `call_${crypto.randomUUID().replace(/-/g, "")}`;
  tool.itemId = itemId;
  tool.id = callId;
  if (route.kind === "tool_search") {
    return { id: itemId, type: "tool_search_call", status, call_id: callId, execution: "client", arguments: parseToolArguments(tool.args) };
  }
  const item: JsonRecord = { id: itemId, type: "function_call", status, call_id: callId, name: route.name, arguments: tool.args };
  if (route.namespace) item.namespace = route.namespace;
  return item;
}

function responseOutput(aggregate: QoderAggregate, routes: Map<string, QoderToolRoute>): unknown[] {
  const output: unknown[] = [];
  if (aggregate.text) {
    output.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: aggregate.text, annotations: [] }],
    });
  }
  for (const tool of orderedTools(aggregate)) output.push(responseToolItem(tool, routes, "completed"));
  return output;
}

function responsesPayload(aggregate: QoderAggregate, model: string, routes: Map<string, QoderToolRoute>): JsonRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: now,
    completed_at: now,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    model,
    output: responseOutput(aggregate, routes),
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: responsesUsage(aggregate.usage),
    user: null,
    metadata: {},
  };
}

function anthropicStopReason(finish: string, hasTools: boolean): string {
  if (hasTools || finish === "tool_calls") return "tool_use";
  if (finish === "length" || finish === "max_tokens") return "max_tokens";
  if (finish === "stop_sequence") return "stop_sequence";
  if (finish === "refusal" || finish === "content_filter") return "refusal";
  return "end_turn";
}

function anthropicUsage(usage: Usage): JsonRecord {
  const output: JsonRecord = { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens };
  if (usage.cachedTokens > 0) output.cache_read_input_tokens = usage.cachedTokens;
  return output;
}

function anthropicPayload(aggregate: QoderAggregate, model: string): JsonRecord {
  const content: unknown[] = [];
  if (aggregate.text) content.push({ type: "text", text: aggregate.text });
  for (const tool of orderedTools(aggregate)) {
    let input: unknown = {};
    if (tool.args.trim()) {
      try { input = JSON.parse(tool.args); } catch { input = {}; }
    }
    content.push({ type: "tool_use", id: tool.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`, name: tool.name || "unknown", input });
  }
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: anthropicStopReason(aggregate.finishReason, aggregate.tools.size > 0),
    stop_sequence: null,
    usage: anthropicUsage(aggregate.usage),
  };
}

function qoderChatStream(body: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const state = new QoderStreamOutputState();
  let doneSent = false;
  return qoderSseTransform(body, (data, controller) => {
    if (data === "[DONE]") {
      if (!doneSent) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneSent = true;
      return;
    }
    const parsed = normalizedChunk(data, state, model);
    if (parsed.error) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: parsed.error, type: "upstream_error", code: "QODER_STREAM_ERROR" } })}\n\n`));
      return;
    }
    if (parsed.chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed.chunk)}\n\n`));
    else if (parsed.raw) controller.enqueue(encoder.encode(`data: ${parsed.raw}\n\n`));
  }, (controller) => {
    if (!doneSent) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  });
}

function qoderResponsesStream(body: ReadableStream<Uint8Array>, model: string, routes: Map<string, QoderToolRoute>): ReadableStream<Uint8Array> {
  const outputState = new QoderStreamOutputState();
  const aggregate = newAggregate();
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const textId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  let sequence = 0;
  let nextOutput = 0;
  let textIndex = -1;
  let textStarted = false;
  let finalized = false;
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, type: string, payload: JsonRecord): void => {
    payload.type = type;
    payload.sequence_number = ++sequence;
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
  };
  const responseObject = (status: "in_progress" | "completed"): JsonRecord => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    model,
    output: status === "completed" ? responseOutput(aggregate, routes) : [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: status === "completed" ? responsesUsage(aggregate.usage) : null,
    user: null,
    metadata: {},
  });
  const finalize = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (finalized) return;
    finalized = true;
    if (textStarted) {
      const part = { type: "output_text", text: aggregate.text, annotations: [] };
      emit(controller, "response.output_text.done", { item_id: textId, output_index: textIndex, content_index: 0, text: aggregate.text, logprobs: [] });
      emit(controller, "response.content_part.done", { item_id: textId, output_index: textIndex, content_index: 0, part });
      emit(controller, "response.output_item.done", { output_index: textIndex, item: { id: textId, type: "message", status: "completed", role: "assistant", content: [part] } });
    }
    for (const tool of orderedTools(aggregate)) {
      if (tool.outputIndex === undefined) tool.outputIndex = nextOutput++;
      if (!tool.added) {
        tool.added = true;
        emit(controller, "response.output_item.added", { output_index: tool.outputIndex, item: responseToolItem(tool, routes, "in_progress") });
      }
      const route = routeFor(tool, routes);
      if (route.kind !== "tool_search") {
        const done: JsonRecord = { item_id: tool.itemId, output_index: tool.outputIndex, name: route.name, arguments: tool.args };
        if (route.namespace) done.namespace = route.namespace;
        emit(controller, "response.function_call_arguments.done", done);
      }
      emit(controller, "response.output_item.done", { output_index: tool.outputIndex, item: responseToolItem(tool, routes, "completed") });
    }
    emit(controller, "response.completed", { response: responseObject("completed") });
  };
  return qoderSseTransform(body, (data, controller) => {
    if (data === "[DONE]") { finalize(controller); return; }
    const parsed = normalizedChunk(data, outputState, model);
    if (parsed.error) {
      emit(controller, "error", { code: "QODER_STREAM_ERROR", message: parsed.error, param: null });
      finalized = true;
      return;
    }
    if (!parsed.chunk) return;
    const beforeText = aggregate.text;
    const beforeTools = new Map([...aggregate.tools.entries()].map(([index, tool]) => [index, { ...tool }]));
    applyChunk(aggregate, parsed.chunk);
    if (aggregate.text.length > beforeText.length) {
      const delta = aggregate.text.slice(beforeText.length);
      if (!textStarted) {
        textStarted = true;
        textIndex = nextOutput++;
        emit(controller, "response.output_item.added", { output_index: textIndex, item: { id: textId, type: "message", status: "in_progress", role: "assistant", content: [] } });
        emit(controller, "response.content_part.added", { item_id: textId, output_index: textIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      }
      emit(controller, "response.output_text.delta", { item_id: textId, output_index: textIndex, content_index: 0, delta, logprobs: [] });
    }
    for (const tool of orderedTools(aggregate)) {
      const previous = beforeTools.get(tool.index);
      if (tool.outputIndex === undefined) tool.outputIndex = previous?.outputIndex ?? nextOutput++;
      if (tool.itemId === undefined) tool.itemId = previous?.itemId;
      if (tool.added === undefined) tool.added = previous?.added;
      if (!tool.added && tool.name) {
        tool.added = true;
        emit(controller, "response.output_item.added", { output_index: tool.outputIndex, item: responseToolItem(tool, routes, "in_progress") });
      }
      const argsDelta = tool.args.slice(previous?.args.length ?? 0);
      if (argsDelta && routeFor(tool, routes).kind !== "tool_search") {
        emit(controller, "response.function_call_arguments.delta", { item_id: tool.itemId, output_index: tool.outputIndex, delta: argsDelta });
      }
    }
  }, finalize, (controller) => {
    emit(controller, "response.created", { response: responseObject("in_progress") });
    emit(controller, "response.in_progress", { response: responseObject("in_progress") });
  });
}

function qoderAnthropicStream(body: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const outputState = new QoderStreamOutputState();
  const aggregate = newAggregate();
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  let textBlock = -1;
  let nextBlock = 0;
  let finalized = false;
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, type: string, payload: JsonRecord): void => {
    payload.type = type;
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
  };
  const finalize = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (finalized) return;
    finalized = true;
    if (textBlock >= 0) emit(controller, "content_block_stop", { index: textBlock });
    for (const tool of orderedTools(aggregate)) {
      const index = nextBlock++;
      const id = tool.id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
      emit(controller, "content_block_start", { index, content_block: { type: "tool_use", id, name: tool.name || "unknown", input: {} } });
      if (tool.args) emit(controller, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: tool.args } });
      emit(controller, "content_block_stop", { index });
    }
    emit(controller, "message_delta", {
      delta: { stop_reason: anthropicStopReason(aggregate.finishReason, aggregate.tools.size > 0), stop_sequence: null },
      usage: { output_tokens: aggregate.usage.completionTokens },
    });
    emit(controller, "message_stop", {});
  };
  return qoderSseTransform(body, (data, controller) => {
    if (data === "[DONE]") { finalize(controller); return; }
    const parsed = normalizedChunk(data, outputState, model);
    if (parsed.error) {
      emit(controller, "error", { error: { type: "api_error", message: parsed.error } });
      finalized = true;
      return;
    }
    if (!parsed.chunk) return;
    const beforeText = aggregate.text;
    applyChunk(aggregate, parsed.chunk);
    if (aggregate.text.length > beforeText.length) {
      if (textBlock < 0) {
        textBlock = nextBlock++;
        emit(controller, "content_block_start", { index: textBlock, content_block: { type: "text", text: "" } });
      }
      emit(controller, "content_block_delta", { index: textBlock, delta: { type: "text_delta", text: aggregate.text.slice(beforeText.length) } });
    }
  }, finalize, (controller) => {
    emit(controller, "message_start", { message: {
      id: messageId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } });
  });
}

export async function prepareQoderResponse(context: ProviderResponseContext): Promise<Response> {
  const queued = await inspectQoderQueue(context.upstream);
  if (queued) return qoderQueueResponse(context, queued);

  const { upstream, requestedStream, model, requestId } = context;
  const routes = context.endpoint === "responses" ? takeQoderToolRoutes(requestId) : new Map<string, QoderToolRoute>();
  if (requestedStream) {
    if (!upstream.body) {
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers, "text/event-stream; charset=utf-8"),
      });
    }
    const body = context.endpoint === "responses"
      ? qoderResponsesStream(upstream.body, model, routes)
      : context.endpoint === "messages"
        ? qoderAnthropicStream(upstream.body, model)
        : qoderChatStream(upstream.body, model);
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream.headers, "text/event-stream; charset=utf-8"),
    });
  }

  const text = await readResponseText(upstream.body);
  const aggregate = parseQoderAggregate(text, model);
  const payload = context.endpoint === "responses"
    ? responsesPayload(aggregate, model, routes)
    : context.endpoint === "messages"
      ? anthropicPayload(aggregate, model)
      : chatPayload(aggregate, model, requestId);
  return Response.json(payload, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers, "application/json; charset=utf-8"),
  });
}
