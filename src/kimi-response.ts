import { GatewayError } from "./errors";
import { prepareDownstreamResponse } from "./stream";
import type { GatewayEndpoint } from "./types";
import { classifyUpstreamResponse, gatewayErrorFromClassification } from "./upstream-errors";
import {
  emptyResponseUsage, mergeResponseUsage, readResponseText, responseEncoder, responseHeaders,
  responseRecord, responseUsage, rewriteResponseModels, transformResponseSse,
} from "./response-utils";

export interface KimiResponseContext {
  upstream: Response;
  requestedStream: boolean;
  model: string;
  requestId: string;
  endpoint: GatewayEndpoint;
  forceResponseModelMapping?: boolean;
}

function chatToResponses(payload: Record<string, unknown>, model: string, requestId: string): Record<string, unknown> {
  const choice = responseRecord(Array.isArray(payload.choices) ? payload.choices[0] : undefined);
  const message = responseRecord(choice.message);
  const output: Record<string, unknown>[] = [];
  if (typeof message.content === "string" && message.content) {
    output.push({ id: `msg_${requestId}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: message.content, annotations: [] }] });
  }
  for (const rawCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = responseRecord(rawCall);
    const fn = responseRecord(call.function);
    const id = typeof call.id === "string" ? call.id : crypto.randomUUID();
    output.push({ id, type: "function_call", call_id: id, name: fn.name ?? "unknown", arguments: fn.arguments ?? "{}", status: "completed" });
  }
  const usage = responseUsage(payload);
  return {
    id: typeof payload.id === "string" ? payload.id : `resp_${requestId}`,
    object: "response", created_at: typeof payload.created === "number" ? payload.created : Math.floor(Date.now() / 1000),
    status: "completed", model, output,
    usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens, total_tokens: usage.totalTokens, input_tokens_details: { cached_tokens: usage.cachedTokens } },
  };
}

function chatToCompletion(payload: Record<string, unknown>, model: string, requestId: string): Record<string, unknown> {
  const choice = responseRecord(Array.isArray(payload.choices) ? payload.choices[0] : undefined);
  const message = responseRecord(choice.message);
  return {
    id: typeof payload.id === "string" ? payload.id : `cmpl-${requestId}`,
    object: "text_completion", created: typeof payload.created === "number" ? payload.created : Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, text: typeof message.content === "string" ? message.content : "", finish_reason: choice.finish_reason ?? "stop", logprobs: null }],
    usage: payload.usage,
  };
}

function responsesStream(context: KimiResponseContext): Response {
  if (!context.upstream.body) throw new GatewayError(502, "KIMI_STREAM_EMPTY", "Kimi returned an empty stream", "upstream_error");
  let completed = false;
  let started = false;
  let textItemStarted = false;
  const startedToolItems = new Set<number>();
  let text = "";
  let usage = emptyResponseUsage();
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  const responseId = `resp_${context.requestId}`;
  const body = transformResponseSse(context.upstream.body, (data, controller) => {
    if (data === "[DONE]") {
      completed = true;
      const output: Record<string, unknown>[] = [];
      if (text) output.push({ id: `msg_${context.requestId}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
      for (const [, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
        output.push({ type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.arguments || "{}", status: "completed" });
      }
      const frames: Record<string, unknown>[] = [];
      if (textItemStarted) {
        frames.push({ type: "response.output_text.done", item_id: `msg_${context.requestId}`, output_index: 0, content_index: 0, text });
        frames.push({ type: "response.output_item.done", output_index: 0, item: output[0] });
      }
      for (const [index, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
        const outputIndex = index + (textItemStarted ? 1 : 0);
        frames.push({ type: "response.function_call_arguments.done", item_id: call.id, output_index: outputIndex, arguments: call.arguments || "{}" });
        frames.push({ type: "response.output_item.done", output_index: outputIndex, item: output[outputIndex] });
      }
      const response = {
        id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: context.model, output,
        usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens, total_tokens: usage.totalTokens, input_tokens_details: { cached_tokens: usage.cachedTokens } },
      };
      frames.push({ type: "response.completed", response });
      controller.enqueue(responseEncoder.encode(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`));
      return;
    }
    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (chunk.error) {
      const failure = gatewayErrorFromClassification(classifyUpstreamResponse(400, JSON.stringify(chunk), context.upstream.headers, "kimi"));
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "error", error: { message: failure.message, type: failure.type, code: failure.code } })}\n\n`));
      controller.error(failure);
      return;
    }
    usage = mergeResponseUsage(usage, responseUsage(chunk));
    if (!started) {
      started = true;
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: context.model, output: [] } })}\n\n`));
    }
    const choice = responseRecord(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
    const delta = responseRecord(choice.delta);
    if (typeof delta.content === "string" && delta.content) {
      if (!textItemStarted) {
        textItemStarted = true;
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: `msg_${context.requestId}`, type: "message", status: "in_progress", role: "assistant", content: [] } })}\n\n`));
      }
      text += delta.content;
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: `msg_${context.requestId}`, output_index: 0, content_index: 0, delta: delta.content })}\n\n`));
    }
    for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const call = responseRecord(rawCall);
      const index = typeof call.index === "number" ? call.index : 0;
      const fn = responseRecord(call.function);
      const current = toolCalls.get(index) ?? { id: typeof call.id === "string" ? call.id : crypto.randomUUID(), name: "", arguments: "" };
      if (typeof call.id === "string") current.id = call.id;
      if (typeof fn.name === "string") current.name += fn.name;
      if (!startedToolItems.has(index)) {
        startedToolItems.add(index);
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: index + (textItemStarted ? 1 : 0), item: { id: current.id, type: "function_call", call_id: current.id, name: current.name || "unknown", arguments: "", status: "in_progress" } })}\n\n`));
      }
      if (typeof fn.arguments === "string") {
        current.arguments += fn.arguments;
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: current.id, output_index: index + (text ? 1 : 0), delta: fn.arguments })}\n\n`));
      }
      toolCalls.set(index, current);
    }
  }, (controller) => {
    if (!completed) controller.error(new GatewayError(502, "KIMI_STREAM_INCOMPLETE", "KIMI_STREAM_INCOMPLETE: Kimi stream closed before [DONE]", "upstream_error"));
  });
  return new Response(body, { status: context.upstream.status, headers: responseHeaders(context.upstream.headers, "text/event-stream; charset=utf-8") });
}

export async function prepareKimiResponse(context: KimiResponseContext): Promise<Response> {
  if (context.endpoint === "chat") {
    const response = await prepareDownstreamResponse(context.upstream, "passthrough", context.requestedStream, context.model, context.requestId);
    return context.forceResponseModelMapping ? await rewriteResponseModels(response, context.model) : response;
  }
  if (context.requestedStream) {
    if (context.endpoint === "responses") return responsesStream(context);
    return context.forceResponseModelMapping ? await rewriteResponseModels(context.upstream, context.model) : context.upstream;
  }
  const text = await readResponseText(context.upstream.body);
  const payload = responseRecord(JSON.parse(text));
  if (payload.error) throw gatewayErrorFromClassification(classifyUpstreamResponse(context.upstream.status >= 400 ? context.upstream.status : 400, text, context.upstream.headers, "kimi"));
  const output = context.endpoint === "responses" ? chatToResponses(payload, context.model, context.requestId) : chatToCompletion(payload, context.model, context.requestId);
  return Response.json(output, { status: context.upstream.status, headers: responseHeaders(context.upstream.headers, "application/json; charset=utf-8") });
}
