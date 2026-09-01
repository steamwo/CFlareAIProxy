import { GatewayError } from "./errors";
import { prepareDownstreamResponse } from "./stream";
import type { GatewayEndpoint } from "./types";
import { classifyUpstreamResponse, gatewayErrorFromClassification } from "./upstream-errors";
import {
  emptyResponseUsage, mergeResponseUsage, readResponseText, responseEncoder, responseHeaders,
  responseRecord, responseUsage, rewriteResponseModels, transformResponseSse,
} from "./response-utils";
import {
  takeKimiResponseToolIdentities,
  type KimiResponseToolIdentity,
} from "./providers/kimi-responses";

export interface KimiResponseContext {
  upstream: Response;
  requestedStream: boolean;
  model: string;
  requestId: string;
  endpoint: GatewayEndpoint;
  forceResponseModelMapping?: boolean;
}

interface KimiToolCall {
  id: string;
  name: string;
  arguments: string;
}

type ItemStatus = "in_progress" | "completed" | "incomplete";

function toolIdentity(
  name: string,
  identities: Record<string, KimiResponseToolIdentity>,
): KimiResponseToolIdentity | undefined {
  const exact = identities[name];
  if (exact) return exact;
  if (!name) return undefined;
  const candidates = Object.entries(identities).filter(([key]) => key.startsWith(name));
  return candidates.length === 1 ? candidates[0]![1] : undefined;
}

function responseToolItem(
  call: KimiToolCall,
  identities: Record<string, KimiResponseToolIdentity>,
  status: ItemStatus,
): Record<string, unknown> {
  const identity = toolIdentity(call.name, identities);
  const common: Record<string, unknown> = {
    id: call.id,
    call_id: call.id,
    name: identity?.name ?? (call.name || "unknown"),
    status,
  };
  if (identity?.namespace) common.namespace = identity.namespace;
  if (identity?.kind === "custom") return { ...common, type: "custom_tool_call", input: call.arguments };
  return { ...common, type: "function_call", arguments: call.arguments };
}

function responseToolDelta(
  call: KimiToolCall,
  identities: Record<string, KimiResponseToolIdentity>,
  outputIndex: number,
  delta: string,
): Record<string, unknown> {
  const identity = toolIdentity(call.name, identities);
  return identity?.kind === "custom"
    ? { type: "response.custom_tool_call_input.delta", item_id: call.id, output_index: outputIndex, delta }
    : { type: "response.function_call_arguments.delta", item_id: call.id, output_index: outputIndex, delta };
}

function responseToolDone(
  call: KimiToolCall,
  identities: Record<string, KimiResponseToolIdentity>,
  outputIndex: number,
): Record<string, unknown> {
  const identity = toolIdentity(call.name, identities);
  return identity?.kind === "custom"
    ? { type: "response.custom_tool_call_input.done", item_id: call.id, output_index: outputIndex, input: call.arguments || "" }
    : { type: "response.function_call_arguments.done", item_id: call.id, output_index: outputIndex, arguments: call.arguments || "{}" };
}

function finishReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function incompleteReason(reason: string | undefined): "max_output_tokens" | "content_filter" | undefined {
  if (reason === "length" || reason === "max_tokens") return "max_output_tokens";
  if (reason === "content_filter") return "content_filter";
  return undefined;
}

function reasoningText(message: Record<string, unknown>): string {
  const primary = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  if (primary) return primary;
  return typeof message.reasoning === "string" ? message.reasoning.trim() : "";
}

function reasoningItem(id: string, text: string, status: ItemStatus): Record<string, unknown> {
  return {
    id,
    type: "reasoning",
    status,
    summary: text ? [{ type: "summary_text", text }] : [],
  };
}

function chatToResponses(
  payload: Record<string, unknown>,
  model: string,
  requestId: string,
  identities: Record<string, KimiResponseToolIdentity>,
): Record<string, unknown> {
  const choice = responseRecord(Array.isArray(payload.choices) ? payload.choices[0] : undefined);
  const message = responseRecord(choice.message);
  const reason = finishReason(choice.finish_reason);
  const partialReason = incompleteReason(reason);
  const terminalStatus: ItemStatus = partialReason ? "incomplete" : "completed";
  const output: Record<string, unknown>[] = [];
  const reasoning = reasoningText(message);
  if (reasoning) output.push(reasoningItem(`rs_${requestId}`, reasoning, terminalStatus));
  if (typeof message.content === "string" && message.content) {
    output.push({ id: `msg_${requestId}`, type: "message", status: terminalStatus, role: "assistant", content: [{ type: "output_text", text: message.content, annotations: [] }] });
  }
  for (const rawCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const call = responseRecord(rawCall);
    const fn = responseRecord(call.function);
    const id = typeof call.id === "string" ? call.id : crypto.randomUUID();
    output.push(responseToolItem({
      id,
      name: typeof fn.name === "string" ? fn.name : "unknown",
      arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
    }, identities, terminalStatus));
  }
  const usage = responseUsage(payload);
  const response: Record<string, unknown> = {
    id: typeof payload.id === "string" ? payload.id : `resp_${requestId}`,
    object: "response", created_at: typeof payload.created === "number" ? payload.created : Math.floor(Date.now() / 1000),
    status: partialReason ? "incomplete" : "completed", model, output,
    usage: {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      input_tokens_details: { cached_tokens: usage.cachedTokens },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  if (partialReason) response.incomplete_details = { reason: partialReason };
  return response;
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

function responsesStream(
  context: KimiResponseContext,
  identities: Record<string, KimiResponseToolIdentity>,
): Response {
  if (!context.upstream.body) throw new GatewayError(502, "KIMI_STREAM_EMPTY", "Kimi returned an empty stream", "upstream_error");
  let completed = false;
  let started = false;
  let nextOutputIndex = 0;
  let reasoningIndex: number | undefined;
  let textIndex: number | undefined;
  let reasoning = "";
  let text = "";
  let terminalFinishReason: string | undefined;
  let usage: ReturnType<typeof emptyResponseUsage> | undefined;
  const toolCalls = new Map<number, KimiToolCall>();
  const toolOutputIndices = new Map<number, number>();
  const responseId = `resp_${context.requestId}`;
  const reasoningId = `rs_${context.requestId}`;
  const messageId = `msg_${context.requestId}`;

  const body = transformResponseSse(context.upstream.body, (data, controller) => {
    if (data === "[DONE]") {
      if (completed) return;
      completed = true;
      const partialReason = incompleteReason(terminalFinishReason);
      const responseStatus = partialReason ? "incomplete" : "completed";
      const regularStatus: ItemStatus = partialReason ? "incomplete" : "completed";
      const reliableToolTerminal = terminalFinishReason !== undefined;
      const toolStatus: ItemStatus = partialReason ? "incomplete" : reliableToolTerminal ? "completed" : "in_progress";
      const indexedOutput: Array<{ index: number; item: Record<string, unknown> }> = [];
      if (reasoningIndex !== undefined) indexedOutput.push({ index: reasoningIndex, item: reasoningItem(reasoningId, reasoning, regularStatus) });
      if (textIndex !== undefined) indexedOutput.push({ index: textIndex, item: { id: messageId, type: "message", status: regularStatus, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } });
      for (const [callIndex, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
        const outputIndex = toolOutputIndices.get(callIndex);
        if (outputIndex !== undefined) indexedOutput.push({ index: outputIndex, item: responseToolItem(call, identities, toolStatus) });
      }
      indexedOutput.sort((a, b) => a.index - b.index);
      const frames: Record<string, unknown>[] = [];
      if (reasoningIndex !== undefined) {
        frames.push({ type: "response.reasoning_summary_text.done", item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, text: reasoning });
        frames.push({ type: "response.output_item.done", output_index: reasoningIndex, item: reasoningItem(reasoningId, reasoning, regularStatus) });
      }
      if (textIndex !== undefined) {
        frames.push({ type: "response.output_text.done", item_id: messageId, output_index: textIndex, content_index: 0, text });
        frames.push({ type: "response.output_item.done", output_index: textIndex, item: indexedOutput.find((entry) => entry.index === textIndex)!.item });
      }
      if (reliableToolTerminal) {
        for (const [callIndex, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
          const outputIndex = toolOutputIndices.get(callIndex);
          if (outputIndex === undefined) continue;
          frames.push(responseToolDone(call, identities, outputIndex));
          frames.push({ type: "response.output_item.done", output_index: outputIndex, item: responseToolItem(call, identities, toolStatus) });
        }
      }
      const response: Record<string, unknown> = {
        id: responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: responseStatus,
        model: context.model,
        output: indexedOutput.map((entry) => entry.item),
      };
      if (partialReason) response.incomplete_details = { reason: partialReason };
      if (usage) {
        response.usage = {
          input_tokens: usage.promptTokens,
          output_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
          input_tokens_details: { cached_tokens: usage.cachedTokens },
          output_tokens_details: { reasoning_tokens: 0 },
        };
      }
      frames.push({ type: partialReason ? "response.incomplete" : "response.completed", response });
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
    if (chunk.usage && typeof chunk.usage === "object") usage = mergeResponseUsage(usage ?? emptyResponseUsage(), responseUsage(chunk));
    if (!started) {
      started = true;
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: context.model, output: [] } })}\n\n`));
    }
    const choice = responseRecord(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
    const currentFinishReason = finishReason(choice.finish_reason);
    if (currentFinishReason) terminalFinishReason = currentFinishReason;
    const delta = responseRecord(choice.delta);
    const reasoningDelta = typeof delta.reasoning_content === "string" && delta.reasoning_content
      ? delta.reasoning_content
      : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (reasoningDelta) {
      if (reasoningIndex === undefined) {
        reasoningIndex = nextOutputIndex++;
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: reasoningIndex, item: reasoningItem(reasoningId, "", "in_progress") })}\n\n`));
      }
      reasoning += reasoningDelta;
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, delta: reasoningDelta })}\n\n`));
    }
    if (typeof delta.content === "string" && delta.content) {
      if (textIndex === undefined) {
        textIndex = nextOutputIndex++;
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: textIndex, item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] } })}\n\n`));
      }
      text += delta.content;
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: messageId, output_index: textIndex, content_index: 0, delta: delta.content })}\n\n`));
    }
    // Empty tool_calls arrays are intentionally a no-op. Only actual tool-call deltas
    // may allocate or advance a tool output item.
    for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const call = responseRecord(rawCall);
      const index = typeof call.index === "number" ? call.index : 0;
      const fn = responseRecord(call.function);
      const current = toolCalls.get(index) ?? { id: typeof call.id === "string" ? call.id : crypto.randomUUID(), name: "", arguments: "" };
      if (typeof call.id === "string") current.id = call.id;
      if (typeof fn.name === "string") current.name += fn.name;
      let outputIndex = toolOutputIndices.get(index);
      if (outputIndex === undefined && (current.name || typeof fn.arguments === "string")) {
        outputIndex = nextOutputIndex++;
        toolOutputIndices.set(index, outputIndex);
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: outputIndex, item: responseToolItem({ ...current, arguments: "" }, identities, "in_progress") })}\n\n`));
      }
      if (typeof fn.arguments === "string") {
        current.arguments += fn.arguments;
        if (outputIndex !== undefined) controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(responseToolDelta(current, identities, outputIndex, fn.arguments))}\n\n`));
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
  const identities = context.endpoint === "responses" ? takeKimiResponseToolIdentities(context.requestId) : {};
  if (context.requestedStream) {
    if (context.endpoint === "responses") return responsesStream(context, identities);
    return context.forceResponseModelMapping ? await rewriteResponseModels(context.upstream, context.model) : context.upstream;
  }
  const text = await readResponseText(context.upstream.body);
  const payload = responseRecord(JSON.parse(text));
  if (payload.error) throw gatewayErrorFromClassification(classifyUpstreamResponse(context.upstream.status >= 400 ? context.upstream.status : 400, text, context.upstream.headers, "kimi"));
  const output = context.endpoint === "responses"
    ? chatToResponses(payload, context.model, context.requestId, identities)
    : chatToCompletion(payload, context.model, context.requestId);
  return Response.json(output, { status: context.upstream.status, headers: responseHeaders(context.upstream.headers, "application/json; charset=utf-8") });
}
