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
  items: Map<number, Record<string, unknown>>;
  fallbackItems: Record<string, unknown>[];
}

function eventError(event: Record<string, unknown>): GatewayError | undefined {
  const type = typeof event.type === "string" ? event.type : "";
  if (type !== "error" && type !== "response.failed") return undefined;
  const payload = type === "response.failed"
    ? responseRecord(responseRecord(event.response).error ?? event.error)
    : responseRecord(event.error ?? event);
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

function strictResponsesStream(context: CodexResponseContext): Response {
  if (!context.upstream.body) throw new GatewayError(502, "CODEX_STREAM_EMPTY", "Codex returned an empty stream", "upstream_error");
  const state: CodexState = { terminal: false, items: new Map(), fallbackItems: [] };
  const body = transformResponseSse(context.upstream.body, (data, controller) => {
    if (data === "[DONE]") {
      if (state.terminal) controller.enqueue(responseEncoder.encode("data: [DONE]\n\n"));
      return;
    }
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const failure = eventError(event);
    if (failure) {
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ error: { message: failure.message, type: failure.type, code: failure.code } })}\n\n`));
      controller.error(failure);
      return;
    }
    rememberItem(event, state);
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      state.terminal = true;
      event = patchTerminal(event, state);
    }
    const output = context.forceResponseModelMapping ? rewriteResponseModelFields(event, context.model) : event;
    controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(output)}\n\n`));
  }, (controller) => {
    if (!state.terminal) controller.error(new GatewayError(502, "CODEX_STREAM_INCOMPLETE", "CODEX_STREAM_INCOMPLETE: Codex stream closed before response.completed", "upstream_error"));
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
  const state: CodexState = { terminal: false, items: new Map(), fallbackItems: [] };
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
    rememberItem(event, state);
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
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      state.terminal = true;
      const usage = responseUsage(responseRecord(event.response));
      const final = chatChunk(context.requestId, context.model, {}, event.type === "response.incomplete" ? "length" : finishReason);
      final.usage = { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } };
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`));
    }
  }, (controller) => {
    if (!state.terminal) controller.error(new GatewayError(502, "CODEX_STREAM_INCOMPLETE", "CODEX_STREAM_INCOMPLETE: Codex stream closed before response.completed", "upstream_error"));
  });
  return new Response(body, { status: context.upstream.status, headers: responseHeaders(context.upstream.headers, "text/event-stream; charset=utf-8") });
}

function chatFromResponse(payload: Record<string, unknown>, model: string, requestId: string): Record<string, unknown> {
  let content = "";
  const toolCalls: Record<string, unknown>[] = [];
  for (const rawItem of Array.isArray(payload.output) ? payload.output : []) {
    const item = responseRecord(rawItem);
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
  const state: CodexState = { terminal: false, items: new Map(), fallbackItems: [] };
  let terminal: Record<string, unknown> | undefined;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = responseFrameData(frame);
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
    const failure = eventError(event);
    if (failure) throw failure;
    rememberItem(event, state);
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      state.terminal = true;
      terminal = patchTerminal(event, state);
    }
  }
  if (!state.terminal || !terminal) throw new GatewayError(502, "CODEX_STREAM_INCOMPLETE", "CODEX_STREAM_INCOMPLETE: Codex stream closed before response.completed", "upstream_error");
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
