import { isRememberedOfficialCodexClient } from "./codex-client-identity";
import { GatewayError } from "./errors";
import type { GatewayEndpoint } from "./types";
import { classifyUpstreamResponse, gatewayErrorFromClassification } from "./upstream-errors";
import {
  readResponseText, responseEncoder, responseFrameData, responseHeaders, responseRecord,
  responseUsage, rewriteResponseModelFields, transformResponseSse,
} from "./response-utils";

export interface CodexResponseContext {
  upstream: Response;
  requestedStream: boolean;
  model: string;
  requestId: string;
  endpoint: GatewayEndpoint;
  forceResponseModelMapping?: boolean;
}

interface CodexState {
  terminal: boolean;
  failed: boolean;
  items: Map<number, Record<string, unknown>>;
  fallbackItems: Record<string, unknown>[];
  nextSequenceNumber: number;
}

function eventErrorPayload(event: Record<string, unknown>): Record<string, unknown> {
  const type = typeof event.type === "string" ? event.type : "";
  const response = responseRecord(event.response);
  if (type === "response.failed") return responseRecord(response.error ?? event.error);
  if (type === "error") return responseRecord(event.error ?? response.error ?? event);
  return {};
}

function eventError(event: Record<string, unknown>): GatewayError | undefined {
  const type = typeof event.type === "string" ? event.type : "";
  if (type !== "error" && type !== "response.failed") return undefined;
  const payload = eventErrorPayload(event);
  const body = JSON.stringify({ error: Object.keys(payload).length ? payload : { message: "Upstream stream failed without details" } });
  const embedded = typeof payload.status_code === "number" ? payload.status_code : typeof payload.status === "number" ? payload.status : undefined;
  const errorType = typeof payload.type === "string" ? payload.type.toLowerCase() : "";
  const errorCode = typeof payload.code === "string" ? payload.code.toLowerCase() : "";
  const status = embedded && embedded >= 400 && embedded <= 599
    ? embedded
    : errorType === "rate_limit_error" || /rate_limit|quota|capacity/.test(errorCode)
      ? 429
      : errorType === "authentication_error" ? 401
        : errorType === "permission_error" ? 403
          : errorType === "invalid_request_error" || errorType === "bad_request_error" ? 400 : 502;
  return gatewayErrorFromClassification(classifyUpstreamResponse(status, body, new Headers(), "codex"));
}

function isSuccessfulTerminalType(type: unknown): boolean {
  return type === "response.completed" || type === "response.incomplete" || type === "response.done";
}

function trackSequence(event: Record<string, unknown>, state: CodexState): void {
  if (typeof event.sequence_number === "number" && Number.isFinite(event.sequence_number)) {
    state.nextSequenceNumber = Math.max(state.nextSequenceNumber, Math.floor(event.sequence_number) + 1);
  }
}

function responseFailedPayload(
  event: Record<string, unknown>,
  failure: GatewayError,
  sequenceNumber: number,
): Record<string, unknown> {
  const upstreamError = eventErrorPayload(event);
  const error = Object.keys(upstreamError).length
    ? upstreamError
    : {
        type: failure.status >= 500
          ? "server_error"
          : failure.status === 400
            ? "invalid_request_error"
            : failure.type,
        code: failure.code,
        message: failure.message,
      };
  const upstreamResponse = responseRecord(event.response);
  return {
    type: "response.failed",
    sequence_number: typeof event.sequence_number === "number" ? event.sequence_number : sequenceNumber,
    response: {
      ...upstreamResponse,
      status: "failed",
      error,
    },
  };
}

function rememberItem(event: Record<string, unknown>, state: CodexState): void {
  if (event.type !== "response.output_item.done") return;
  const item = responseRecord(event.item);
  if (!Object.keys(item).length) return;
  const index = typeof event.output_index === "number" ? event.output_index : undefined;
  if (index === undefined) state.fallbackItems.push(item);
  else state.items.set(index, item);
}

function patchTerminal(event: Record<string, unknown>, state: CodexState): Record<string, unknown> {
  const response = responseRecord(event.response);
  const current = Array.isArray(response.output) ? response.output : [];
  const collected = [...state.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item).concat(state.fallbackItems);
  if (current.length === 0 && collected.length > 0) event.response = { ...response, output: collected };
  return event;
}

function hydrateCompletedOutputItemIds(event: Record<string, unknown>, state: CodexState): Record<string, unknown> {
  const response = responseRecord(event.response);
  if (!Array.isArray(response.output) || response.output.length === 0) return event;
  let changed = false;
  const output = response.output.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const item = raw as Record<string, unknown>;
    const id = item.id;
    if (id !== undefined && id !== null && (typeof id !== "string" || id.trim() !== "")) return raw;
    const collectedId = state.items.get(index)?.id;
    if (typeof collectedId !== "string" || collectedId.trim() === "") return raw;
    changed = true;
    return { ...item, id: collectedId };
  });
  if (changed) event.response = { ...response, output };
  return event;
}

function patchStartResponseModel(event: Record<string, unknown>, model: string): Record<string, unknown> {
  if (event.type !== "response.created" && event.type !== "response.in_progress") return event;
  const response = responseRecord(event.response);
  const current = response.model;
  if (current !== undefined && current !== null && (typeof current !== "string" || current.trim() !== "")) return event;
  const fallback = model.trim();
  if (!fallback) return event;
  event.response = { ...response, model: fallback };
  return event;
}

function strictResponsesStream(context: CodexResponseContext): Response {
  if (!context.upstream.body) throw new GatewayError(502, "CODEX_STREAM_EMPTY", "Codex returned an empty stream", "upstream_error");
  const state: CodexState = { terminal: false, failed: false, items: new Map(), fallbackItems: [], nextSequenceNumber: 0 };
  const officialCodexClient = isRememberedOfficialCodexClient(context.requestId);
  const body = transformResponseSse(context.upstream.body, (data, controller) => {
    if (state.failed) return;
    if (data === "[DONE]") {
      if (state.terminal) controller.enqueue(responseEncoder.encode("data: [DONE]\n\n"));
      return;
    }
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const failure = eventError(event);
    if (failure) {
      if (officialCodexClient) {
        state.failed = true;
        state.terminal = true;
        const payload = responseFailedPayload(event, failure, state.nextSequenceNumber);
        controller.enqueue(responseEncoder.encode(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`));
      } else {
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ error: { message: failure.message, type: failure.type, code: failure.code } })}\n\n`));
        controller.error(failure);
      }
      return;
    }
    trackSequence(event, state);
    rememberItem(event, state);
    event = patchStartResponseModel(event, context.model);
    if (isSuccessfulTerminalType(event.type)) {
      state.terminal = true;
      event = patchTerminal(event, state);
    }
    const output = context.forceResponseModelMapping ? rewriteResponseModelFields(event, context.model) : event;
    controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(output)}\n\n`));
  }, (controller) => {
    if (!state.terminal) controller.error(new GatewayError(502, "CODEX_STREAM_INCOMPLETE", "CODEX_STREAM_INCOMPLETE: Codex stream closed before a successful terminal event", "upstream_error"));
  });
  return new Response(body, { status: context.upstream.status, headers: responseHeaders(context.upstream.headers, "text/event-stream; charset=utf-8") });
}

function chatChunk(requestId: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: requestId.startsWith("chatcmpl-") ? requestId : `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function strictChatStream(context: CodexResponseContext): Response {
  if (!context.upstream.body) throw new GatewayError(502, "CODEX_STREAM_EMPTY", "Codex returned an empty stream", "upstream_error");
  const state: CodexState = { terminal: false, failed: false, items: new Map(), fallbackItems: [], nextSequenceNumber: 0 };
  let roleSent = false;
  let finishReason = "stop";
  const emittedToolItems = new Set<number>();
  const body = transformResponseSse(context.upstream.body, (data, controller) => {
    if (data === "[DONE]") return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const failure = eventError(event);
    if (failure) {
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ error: { message: failure.message, type: failure.type, code: failure.code } })}\n\n`));
      controller.error(failure);
      return;
    }
    trackSequence(event, state);
    rememberItem(event, state);
    if ((event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") && typeof event.delta === "string") {
      const delta: Record<string, unknown> = { reasoning_content: event.delta };
      if (!roleSent) { delta.role = "assistant"; roleSent = true; }
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(chatChunk(context.requestId, context.model, delta))}\n\n`));
      return;
    }
    if (event.type === "response.reasoning_summary_text.done" || event.type === "response.reasoning_text.done") {
      const delta: Record<string, unknown> = { reasoning_content: "\n\n" };
      if (!roleSent) { delta.role = "assistant"; roleSent = true; }
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(chatChunk(context.requestId, context.model, delta))}\n\n`));
      return;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      const delta: Record<string, unknown> = { content: event.delta };
      if (!roleSent) { delta.role = "assistant"; roleSent = true; }
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(chatChunk(context.requestId, context.model, delta))}\n\n`));
      return;
    }
    if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && responseRecord(event.item).type === "function_call") {
      const item = responseRecord(event.item);
      const index = typeof event.output_index === "number" ? event.output_index : 0;
      if (event.type === "response.output_item.done" && emittedToolItems.has(index)) return;
      emittedToolItems.add(index);
      finishReason = "tool_calls";
      const delta: Record<string, unknown> = { tool_calls: [{
        index,
        id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : crypto.randomUUID(),
        type: "function",
        function: { name: typeof item.name === "string" ? item.name : "unknown", arguments: event.type === "response.output_item.done" && typeof item.arguments === "string" ? item.arguments : "" },
      }] };
      if (!roleSent) { delta.role = "assistant"; roleSent = true; }
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(chatChunk(context.requestId, context.model, delta))}\n\n`));
      return;
    }
    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(chatChunk(context.requestId, context.model, {
        tool_calls: [{ index: typeof event.output_index === "number" ? event.output_index : 0, function: { arguments: event.delta } }],
      }))}\n\n`));
      return;
    }
    if (isSuccessfulTerminalType(event.type)) {
      state.terminal = true;
      const usage = responseUsage(responseRecord(event.response));
      const final = chatChunk(context.requestId, context.model, {}, event.type === "response.incomplete" ? "length" : finishReason);
      final.usage = { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } };
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`));
    }
  }, (controller) => {
    if (!state.terminal) controller.error(new GatewayError(502, "CODEX_STREAM_INCOMPLETE", "CODEX_STREAM_INCOMPLETE: Codex stream closed before a successful terminal event", "upstream_error"));
  });
  return new Response(body, { status: context.upstream.status, headers: responseHeaders(context.upstream.headers, "text/event-stream; charset=utf-8") });
}

function chatFromResponse(payload: Record<string, unknown>, model: string, requestId: string): Record<string, unknown> {
  let content = "";
  let reasoningContent = "";
  const toolCalls: Record<string, unknown>[] = [];
  for (const rawItem of Array.isArray(payload.output) ? payload.output : []) {
    const item = responseRecord(rawItem);
    if (item.type === "reasoning") {
      for (const rawSummary of Array.isArray(item.summary) ? item.summary : []) {
        const summary = responseRecord(rawSummary);
        if (typeof summary.text === "string" && summary.text.length > 0) reasoningContent += summary.text;
      }
      for (const rawPart of Array.isArray(item.content) ? item.content : []) {
        const part = responseRecord(rawPart);
        if (part.type === "reasoning_text" && typeof part.text === "string" && part.text.length > 0) reasoningContent += part.text;
      }
    }
    if (item.type === "message") {
      for (const rawPart of Array.isArray(item.content) ? item.content : []) {
        const part = responseRecord(rawPart);
        if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") content += part.text;
      }
    }
    if (item.type === "function_call") toolCalls.push({
      id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : crypto.randomUUID(),
      type: "function",
      function: { name: typeof item.name === "string" ? item.name : "unknown", arguments: typeof item.arguments === "string" ? item.arguments : "{}" },
    });
  }
  const usage = responseUsage(payload);
  const message: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoningContent.length > 0) message.reasoning_content = reasoningContent;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: typeof payload.id === "string" ? payload.id : `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: typeof payload.created_at === "number" ? payload.created_at : Math.floor(Date.now() / 1000),
    model, choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
  };
}

function parseSse(text: string): Record<string, unknown> {
  const state: CodexState = { terminal: false, failed: false, items: new Map(), fallbackItems: [], nextSequenceNumber: 0 };
  let terminal: Record<string, unknown> | undefined;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = responseFrameData(frame);
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
    const failure = eventError(event);
    if (failure) throw failure;
    trackSequence(event, state);
    rememberItem(event, state);
    if (isSuccessfulTerminalType(event.type)) {
      state.terminal = true;
      const patched = patchTerminal(event, state);
      terminal = event.type === "response.incomplete" ? patched : hydrateCompletedOutputItemIds(patched, state);
    }
  }
  if (!state.terminal || !terminal) throw new GatewayError(502, "CODEX_STREAM_INCOMPLETE", "CODEX_STREAM_INCOMPLETE: Codex stream closed before a successful terminal event", "upstream_error");
  return responseRecord(terminal.response);
}

export async function prepareCodexResponse(context: CodexResponseContext): Promise<Response> {
  if (context.requestedStream) return context.endpoint === "responses" ? strictResponsesStream(context) : strictChatStream(context);
  const text = await readResponseText(context.upstream.body);
  let payload: Record<string, unknown>;
  if (context.upstream.headers.get("content-type")?.includes("application/json")) {
    const parsed = responseRecord(JSON.parse(text));
    const failure = eventError(parsed) ?? (parsed.error
      ? gatewayErrorFromClassification(classifyUpstreamResponse(context.upstream.status >= 400 ? context.upstream.status : 400, JSON.stringify(parsed), context.upstream.headers, "codex"))
      : undefined);
    if (failure) throw failure;
    payload = parsed.response && typeof parsed.response === "object" ? responseRecord(parsed.response) : parsed;
  } else payload = parseSse(text);
  const output = context.endpoint === "responses" ? payload : chatFromResponse(payload, context.model, context.requestId);
  const mapped = context.forceResponseModelMapping ? rewriteResponseModelFields(output, context.model) : output;
  return Response.json(mapped, { status: context.upstream.status, headers: responseHeaders(context.upstream.headers, "application/json; charset=utf-8") });
}
