import { GatewayError } from "../errors";
import { QoderStreamOutputState } from "../qoder-response";
import type { UpstreamBuildResult, Usage } from "../types";
import type { QoderToolRoute } from "./qoder-protocol";
import {
  QODER_PROXY_TOOL_SEARCH_RESULT_MAX,
  qoderCandidateDisplayName,
  qoderSearchResultTools,
  searchDeferredQoderResponsesTools,
} from "./qoder-tool-virtualization";

const MAX_STATE_ENTRIES = 256;
const PROXY_TOOL_SEARCH_MAX_HOPS = 3;
export const QODER_DISCOVERY_HEADER = "x-cflare-qoder-discovery";

type JsonRecord = Record<string, unknown>;

export interface QoderDiscoveryAttempt {
  request: UpstreamBuildResult;
  routes: Map<string, QoderToolRoute>;
}

export interface QoderResponsesDiscoveryRegistration {
  originalBody: JsonRecord;
  currentBody: JsonRecord;
  currentRoutes: Map<string, QoderToolRoute>;
  buildAttempt: (body: JsonRecord) => Promise<QoderDiscoveryAttempt>;
}

interface DiscoveryToolState {
  index: number;
  id: string;
  name: string;
  args: string;
}

interface DiscoveryAggregate {
  text: string;
  usage: Usage;
  tools: Map<number, DiscoveryToolState>;
}

interface ProxySearchCall {
  callId: string;
  alias: string;
  args: string;
  query: string;
}

const discoveryStates = new Map<string, QoderResponsesDiscoveryRegistration>();
const priorUsageByRequest = new Map<string, Usage>();

function boundedSet<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_STATE_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (!oldest) break;
    map.delete(oldest);
  }
}

export function registerQoderResponsesDiscovery(requestId: string, state: QoderResponsesDiscoveryRegistration): void {
  boundedSet(discoveryStates, requestId, state);
}

export function takeQoderDiscoveryPriorUsage(requestId: string): Usage | undefined {
  const usage = priorUsageByRequest.get(requestId);
  priorUsageByRequest.delete(requestId);
  return usage;
}

function takeDiscoveryState(requestId: string): QoderResponsesDiscoveryRegistration | undefined {
  const state = discoveryStates.get(requestId);
  discoveryStates.delete(requestId);
  return state;
}

function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function mergeUsage(left: Usage, right: Usage): Usage {
  return {
    promptTokens: Math.max(left.promptTokens, right.promptTokens),
    completionTokens: Math.max(left.completionTokens, right.completionTokens),
    cachedTokens: Math.max(left.cachedTokens, right.cachedTokens),
    totalTokens: Math.max(left.totalTokens, right.totalTokens, right.promptTokens + right.completionTokens),
  };
}

function hasUsage(usage: Usage): boolean {
  return usage.promptTokens > 0 || usage.completionTokens > 0 || usage.cachedTokens > 0 || usage.totalTokens > 0;
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((raw) => {
    if (typeof raw === "string") return raw ? [raw] : [];
    const item = record(raw);
    if (!item) return [];
    const text = stringValue(item.text) || stringValue(item.content);
    return text ? [text] : [];
  }).join("\n");
}

function appendFragment(previous: string, next: string): string {
  if (!next) return previous;
  if (!previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return previous + next;
}

function envelopeBody(envelope: JsonRecord): string {
  if (typeof envelope.body === "string") return envelope.body;
  if (envelope.body == null) return "";
  try { return JSON.stringify(envelope.body); } catch { return String(envelope.body); }
}

function isCompleteSseData(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "[DONE]") return true;
  try { JSON.parse(trimmed); return true; } catch { return false; }
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

function nestedError(value: unknown, depth = 0): unknown {
  if (depth > 5 || value == null) return undefined;
  let object: JsonRecord | undefined;
  if (typeof value === "string") {
    try { object = record(JSON.parse(value)); } catch { return undefined; }
  } else object = record(value);
  if (!object) return undefined;
  if (object.error != null) return object.error;
  for (const key of ["llm_model_result", "data", "result", "payload", "body"]) {
    const found = nestedError(object[key], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function nestedChunk(value: unknown, depth = 0): JsonRecord | undefined {
  if (depth > 5 || value == null) return undefined;
  let object: JsonRecord | undefined;
  if (typeof value === "string") {
    try { object = record(JSON.parse(value)); } catch { return undefined; }
  } else object = record(value);
  if (!object) return undefined;
  if (Array.isArray(object.choices) || typeof object.type === "string" || object.usage != null || object.error != null) return object;
  for (const key of ["llm_model_result", "data", "result", "payload", "body"]) {
    const nested = nestedChunk(object[key], depth + 1);
    if (nested) return nested;
  }
  return object;
}

function chunkUsage(chunk: JsonRecord): Usage | undefined {
  const raw = record(chunk.usage);
  if (!raw) return undefined;
  const promptTokens = numberValue(raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.inputTokens);
  const completionTokens = numberValue(raw.completion_tokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.outputTokens);
  const totalTokens = numberValue(raw.total_tokens ?? raw.totalTokens) || promptTokens + completionTokens;
  const promptDetails = record(raw.prompt_tokens_details) ?? record(raw.input_tokens_details);
  const cachedTokens = numberValue(promptDetails?.cached_tokens ?? promptDetails?.cachedTokens);
  return { promptTokens, completionTokens, cachedTokens, totalTokens };
}

function parseDiscoveryAggregate(text: string): DiscoveryAggregate {
  const aggregate: DiscoveryAggregate = { text: "", usage: emptyUsage(), tools: new Map() };
  const outputState = new QoderStreamOutputState();
  for (const data of qoderDataEvents(text)) {
    if (!data || data === "[DONE]") continue;
    let envelope: JsonRecord | undefined;
    try { envelope = record(JSON.parse(data)); } catch { continue; }
    if (!envelope) continue;
    const status = numberValue(envelope.statusCodeValue) || 200;
    const innerText = envelopeBody(envelope);
    if (status !== 200) {
      throw new GatewayError(502, "UPSTREAM_STREAM_ERROR", innerText || `Qoder status ${status}`, "upstream_error");
    }
    const innerError = nestedError(innerText);
    if (innerError !== undefined) {
      let message: string;
      try { message = JSON.stringify(innerError); } catch { message = String(innerError); }
      throw new GatewayError(502, "UPSTREAM_STREAM_ERROR", `Qoder stream error: ${message}`, "upstream_error");
    }
    if (!innerText.trim()) continue;
    const chunk = nestedChunk(innerText);
    if (!chunk) continue;
    outputState.normalizeChunk(chunk);
    const usage = chunkUsage(chunk);
    if (usage) aggregate.usage = mergeUsage(aggregate.usage, usage);
    if (!Array.isArray(chunk.choices)) continue;
    for (const rawChoice of chunk.choices) {
      const choice = record(rawChoice);
      if (!choice) continue;
      const payload = record(choice.delta) ?? record(choice.message);
      if (!payload) continue;
      const textDelta = contentText(payload.content);
      if (textDelta) aggregate.text += textDelta;
      if (!Array.isArray(payload.tool_calls)) continue;
      payload.tool_calls.forEach((rawCall, position) => {
        const call = record(rawCall);
        if (!call) return;
        const rawIndex = numberValue(call.index);
        const index = call.index === undefined ? position : rawIndex;
        const fn = record(call.function);
        const current = aggregate.tools.get(index) ?? { index, id: "", name: "", args: "" };
        if (stringValue(call.id)) current.id = stringValue(call.id);
        if (fn && stringValue(fn.name)) current.name = appendFragment(current.name, stringValue(fn.name));
        if (fn && stringValue(fn.arguments)) current.args += stringValue(fn.arguments);
        aggregate.tools.set(index, current);
      });
    }
  }
  return aggregate;
}

function parseSearchQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "all available tools";
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value === "string" && value.trim()) return value.trim();
    const object = record(value);
    if (object) {
      for (const key of ["query", "search", "capability", "tool", "name"]) {
        const candidate = stringValue(object[key]).trim();
        if (candidate) return candidate;
      }
    }
  } catch { /* use raw arguments below */ }
  return trimmed;
}

function proxySearchCalls(aggregate: DiscoveryAggregate, routes: Map<string, QoderToolRoute>): { calls: ProxySearchCall[]; otherToolCalls: number } {
  const calls: ProxySearchCall[] = [];
  let otherToolCalls = 0;
  for (const tool of [...aggregate.tools.values()].sort((left, right) => left.index - right.index)) {
    const route = routes.get(tool.name);
    if (!route || route.kind !== "tool_search") {
      otherToolCalls += 1;
      continue;
    }
    calls.push({
      callId: tool.id.trim() || `call_${crypto.randomUUID().replace(/-/g, "")}`,
      alias: tool.name,
      args: tool.args,
      query: parseSearchQuery(tool.args),
    });
  }
  return { calls, otherToolCalls };
}

function responseInputItems(body: JsonRecord): unknown[] {
  if (Array.isArray(body.input)) return cloneJson(body.input);
  if (typeof body.input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }];
  }
  return [];
}

function searchArguments(call: ProxySearchCall): unknown {
  if (!call.args.trim()) return { query: call.query };
  try { return JSON.parse(call.args); } catch { return { query: call.query }; }
}

function appendSearchResults(
  currentBody: JsonRecord,
  originalTools: unknown,
  aggregate: DiscoveryAggregate,
  calls: ProxySearchCall[],
  hop: number,
): JsonRecord {
  const input = responseInputItems(currentBody);
  if (aggregate.text.trim()) {
    input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: aggregate.text }] });
  }
  for (const call of calls) {
    const matches = searchDeferredQoderResponsesTools(originalTools, call.query, QODER_PROXY_TOOL_SEARCH_RESULT_MAX);
    const tools = qoderSearchResultTools(matches);
    input.push(
      { type: "tool_search_call", call_id: call.callId, arguments: searchArguments(call) },
      { type: "tool_search_output", call_id: call.callId, tools },
    );
    console.info(JSON.stringify({
      event: "qoder_responses_proxy_tool_search",
      hop,
      query: call.query,
      matches: matches.length,
      matched_tools: matches.map(qoderCandidateDisplayName),
    }));
  }
  return { ...currentBody, input };
}

function restoreFullRegistry(currentBody: JsonRecord, originalBody: JsonRecord): JsonRecord {
  return {
    ...currentBody,
    tools: Array.isArray(originalBody.tools) ? cloneJson(originalBody.tools) : [],
  };
}

function restoredResponse(response: Response, text: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}

async function fetchAttempt(
  state: QoderResponsesDiscoveryRegistration,
  body: JsonRecord,
  fetcher: (target: string | URL, init: RequestInit) => Promise<Response>,
): Promise<{ response: Response; attempt: QoderDiscoveryAttempt }> {
  const attempt = await state.buildAttempt(body);
  const response = await fetcher(attempt.request.url, attempt.request.init);
  return { response, attempt };
}

function rememberPriorUsage(requestId: string, usage: Usage, response: Response): void {
  if (response.ok && hasUsage(usage)) boundedSet(priorUsageByRequest, requestId, usage);
}

export async function runRegisteredQoderResponsesDiscovery(
  requestId: string,
  initialTarget: string | URL,
  initialInit: RequestInit,
  fetcher: (target: string | URL, init: RequestInit) => Promise<Response>,
): Promise<Response> {
  const state = takeDiscoveryState(requestId);
  if (!state) return fetcher(initialTarget, initialInit);

  let currentBody = state.currentBody;
  let currentRoutes = state.currentRoutes;
  let priorUsage = emptyUsage();
  let response = await fetcher(initialTarget, initialInit);

  for (let hop = 0; hop < PROXY_TOOL_SEARCH_MAX_HOPS; hop += 1) {
    if (!response.ok) return response;
    const text = await response.text();
    const aggregate = parseDiscoveryAggregate(text);
    const { calls, otherToolCalls } = proxySearchCalls(aggregate, currentRoutes);
    if (!calls.length) {
      const restored = restoredResponse(response, text);
      rememberPriorUsage(requestId, priorUsage, restored);
      return restored;
    }

    priorUsage = addUsage(priorUsage, aggregate.usage);

    if (otherToolCalls > 0) {
      const fullBody = restoreFullRegistry(currentBody, state.originalBody);
      console.warn(JSON.stringify({
        event: "qoder_responses_proxy_tool_search_fail_open",
        reason: "mixed_search_and_function_calls",
        search_calls: calls.length,
        function_calls: otherToolCalls,
      }));
      const next = await fetchAttempt(state, fullBody, fetcher);
      rememberPriorUsage(requestId, priorUsage, next.response);
      return next.response;
    }

    currentBody = appendSearchResults(currentBody, state.originalBody.tools, aggregate, calls, hop + 1);
    if (hop + 1 >= PROXY_TOOL_SEARCH_MAX_HOPS) break;
    const next = await fetchAttempt(state, currentBody, fetcher);
    response = next.response;
    currentRoutes = next.attempt.routes;
  }

  const fullBody = restoreFullRegistry(currentBody, state.originalBody);
  console.warn(JSON.stringify({
    event: "qoder_responses_proxy_tool_search_fail_open",
    reason: "search_hop_limit",
    hops: PROXY_TOOL_SEARCH_MAX_HOPS,
  }));
  const final = await fetchAttempt(state, fullBody, fetcher);
  rememberPriorUsage(requestId, priorUsage, final.response);
  return final.response;
}
