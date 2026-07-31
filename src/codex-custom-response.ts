import { prepareCodexResponse } from "./codex-response";
import type { CodexResponseContext } from "./codex-response";
import {
  readResponseText, responseEncoder, responseHeaders, responseRecord, transformResponseSse,
} from "./response-utils";
import { takeCodexToolNames } from "./providers/codex-custom-tools";

interface ToolCallStreamState {
  index: number;
  announced: boolean;
  argumentsEmitted: boolean;
  done: boolean;
  bufferedArguments: string;
}

interface ToolCallStreamTracker {
  nextIndex: number;
  states: Map<string, ToolCallStreamState>;
  current?: ToolCallStreamState;
}

function originalToolName(name: unknown, toolNames: Record<string, string>): unknown {
  return typeof name === "string" ? toolNames[name] ?? name : name;
}

function isToolCallItem(item: Record<string, unknown>): boolean {
  return item.type === "function_call" || item.type === "custom_tool_call";
}

function toolCallArguments(item: Record<string, unknown>): string {
  if (item.type === "custom_tool_call") return typeof item.input === "string" ? item.input : "";
  return typeof item.arguments === "string" ? item.arguments : "";
}

function normalizeToolCallItem(item: Record<string, unknown>, toolNames: Record<string, string>): Record<string, unknown> {
  if (!isToolCallItem(item)) return normalizePayload(item, toolNames) as Record<string, unknown>;
  const output: Record<string, unknown> = { ...item, type: "function_call" };
  output.name = originalToolName(item.name, toolNames);
  output.arguments = toolCallArguments(item);
  delete output.input;
  return output;
}

function normalizePayload(value: unknown, toolNames: Record<string, string>, depth = 0): unknown {
  if (depth > 16 || value == null) return value;
  if (Array.isArray(value)) return value.map((entry) => normalizePayload(entry, toolNames, depth + 1));
  if (typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) output[key] = normalizePayload(entry, toolNames, depth + 1);

  if (source.type === "custom_tool_call") {
    output.type = "function_call";
    output.arguments = typeof source.input === "string" ? source.input : "";
    delete output.input;
  } else if (source.type === "response.custom_tool_call_input.delta") {
    output.type = "response.function_call_arguments.delta";
  } else if (source.type === "response.custom_tool_call_input.done") {
    output.type = "response.function_call_arguments.done";
    output.arguments = typeof source.input === "string" ? source.input : "";
    delete output.input;
  }

  if (typeof source.name === "string") output.name = originalToolName(source.name, toolNames);
  return output;
}

function stateKeys(event: Record<string, unknown>, item: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (typeof event.item_id === "string" && event.item_id) keys.push(`item:${event.item_id}`);
  if (typeof item.id === "string" && item.id) keys.push(`item:${item.id}`);
  if (typeof item.call_id === "string" && item.call_id) keys.push(`call:${item.call_id}`);
  if (typeof event.output_index === "number") keys.push(`output:${event.output_index}`);
  return keys;
}

function findState(
  tracker: ToolCallStreamTracker,
  event: Record<string, unknown>,
  item: Record<string, unknown>,
): ToolCallStreamState | undefined {
  for (const key of stateKeys(event, item)) {
    const state = tracker.states.get(key);
    if (state) return state;
  }
  return tracker.current;
}

function ensureState(
  tracker: ToolCallStreamTracker,
  event: Record<string, unknown>,
  item: Record<string, unknown>,
): ToolCallStreamState {
  const existing = findState(tracker, event, item);
  if (existing) {
    for (const key of stateKeys(event, item)) tracker.states.set(key, existing);
    tracker.current = existing;
    return existing;
  }
  const state: ToolCallStreamState = {
    index: tracker.nextIndex++,
    announced: false,
    argumentsEmitted: false,
    done: false,
    bufferedArguments: "",
  };
  for (const key of stateKeys(event, item)) tracker.states.set(key, state);
  tracker.current = state;
  return state;
}

function argumentDeltaEvent(event: Record<string, unknown>, state: ToolCallStreamState, delta: string): Record<string, unknown> {
  return {
    ...event,
    type: "response.function_call_arguments.delta",
    output_index: state.index,
    delta,
  };
}

function normalizeStreamEvent(
  event: Record<string, unknown>,
  tracker: ToolCallStreamTracker,
  toolNames: Record<string, string>,
): Record<string, unknown>[] {
  const type = typeof event.type === "string" ? event.type : "";
  const item = responseRecord(event.item);

  if (type === "response.output_item.added" && isToolCallItem(item)) {
    const state = ensureState(tracker, event, item);
    if (state.done || state.announced) return [];
    state.announced = true;
    const added = {
      ...event,
      output_index: state.index,
      item: normalizeToolCallItem(item, toolNames),
    };
    if (!state.bufferedArguments || state.argumentsEmitted) return [added];
    state.argumentsEmitted = true;
    return [added, argumentDeltaEvent(event, state, state.bufferedArguments)];
  }

  if (type === "response.function_call_arguments.delta" || type === "response.custom_tool_call_input.delta") {
    const state = ensureState(tracker, event, item);
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (state.done || !delta) return [];
    state.bufferedArguments += delta;
    if (!state.announced) return [];
    state.argumentsEmitted = true;
    return [argumentDeltaEvent(event, state, delta)];
  }

  if (type === "response.function_call_arguments.done" || type === "response.custom_tool_call_input.done") {
    const state = ensureState(tracker, event, item);
    if (state.done || state.argumentsEmitted) return [];
    const fullArguments = type === "response.custom_tool_call_input.done"
      ? typeof event.input === "string" ? event.input : ""
      : typeof event.arguments === "string" ? event.arguments : "";
    if (fullArguments) state.bufferedArguments = fullArguments;
    if (!state.announced || !state.bufferedArguments) return [];
    state.argumentsEmitted = true;
    return [argumentDeltaEvent(event, state, state.bufferedArguments)];
  }

  if (type === "response.output_item.done" && isToolCallItem(item)) {
    const state = ensureState(tracker, event, item);
    if (state.done) return [];
    state.done = true;
    const normalizedItem = normalizeToolCallItem(item, toolNames);
    const itemArguments = typeof normalizedItem.arguments === "string" ? normalizedItem.arguments : "";
    const fullArguments = itemArguments || state.bufferedArguments;
    normalizedItem.arguments = fullArguments;
    const done = { ...event, output_index: state.index, item: normalizedItem };
    if (!state.announced) {
      state.argumentsEmitted = fullArguments.length > 0;
      return [done];
    }
    if (state.argumentsEmitted || !fullArguments) return [done];
    state.argumentsEmitted = true;
    return [argumentDeltaEvent(event, state, fullArguments), done];
  }

  return [normalizePayload(event, toolNames) as Record<string, unknown>];
}

function normalizeSseResponse(response: Response, toolNames: Record<string, string>): Response {
  if (!response.body) return response;
  const tracker: ToolCallStreamTracker = { nextIndex: 0, states: new Map() };
  const contentType = response.headers.get("content-type") ?? "text/event-stream";
  const body = transformResponseSse(response.body, (data, controller) => {
    if (data === "[DONE]") {
      controller.enqueue(responseEncoder.encode("data: [DONE]\n\n"));
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      controller.enqueue(responseEncoder.encode(`data: ${data}\n\n`));
      return;
    }
    for (const normalized of normalizeStreamEvent(event, tracker, toolNames)) {
      controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(normalized)}\n\n`));
    }
  }, () => undefined);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers, contentType),
  });
}

async function normalizeCodexChatUpstream(response: Response, toolNames: Record<string, string>): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) return normalizeSseResponse(response, toolNames);
  if (!contentType.includes("json")) return response;

  const text = await readResponseText(response.body);
  try {
    return Response.json(normalizePayload(JSON.parse(text), toolNames), {
      status: response.status,
      headers: responseHeaders(response.headers, "application/json; charset=utf-8"),
    });
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response.headers, contentType),
    });
  }
}

export async function prepareCodexCustomToolResponse(context: CodexResponseContext): Promise<Response> {
  if (context.endpoint === "responses") return prepareCodexResponse(context);
  const toolNames = takeCodexToolNames(context.requestId);
  const upstream = await normalizeCodexChatUpstream(context.upstream, toolNames);
  return prepareCodexResponse({ ...context, upstream });
}
