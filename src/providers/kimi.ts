import type { ProxyRequestContext, UpstreamBuildResult } from "../types";
import { normalizeBaseUrl, sanitizeHeaders } from "../utils";
import { providerAuthHeaders } from "./headers";
import { normalizeKimiUpstreamModel } from "./kimi-model";
import {
  rememberKimiResponseToolIdentities,
  responsesInputToMessages,
  responsesToolChoiceToChat,
  responsesToolsToChat,
} from "./kimi-responses";

const REASONING_UNAVAILABLE = "[reasoning unavailable]";
const KIMI_SCHEMA_MAX_DEPTH = 32;
const KIMI_SCHEMA_MAX_NODES = 4096;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : String(value);
  return value.map((entry) => typeof entry === "string" ? entry : typeof record(entry).text === "string" ? String(record(entry).text) : "").filter(Boolean).join("\n");
}

function isEmptyAssistantContent(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (entry == null) return true;
    if (typeof entry === "string") return entry.trim() === "";
    const row = record(entry);
    return typeof row.text === "string" ? row.text.trim() === "" : Object.keys(row).length === 0;
  });
}

function isUsableKimiReasoning(value: string): boolean {
  return value.length > 0 && value !== REASONING_UNAVAILABLE;
}

function decodeJsonPointerSegment(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalSchemaRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!isPlainObject(current)) return undefined;
    const segment = decodeJsonPointerSegment(rawSegment);
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

interface SchemaNormalizationState {
  nodes: number;
  activeRefs: Set<string>;
}

function normalizeSchemaNode(
  root: Record<string, unknown>,
  value: unknown,
  depth: number,
  state: SchemaNormalizationState,
): unknown {
  if (depth > KIMI_SCHEMA_MAX_DEPTH || state.nodes >= KIMI_SCHEMA_MAX_NODES) return value;
  state.nodes += 1;
  if (Array.isArray(value)) return value.map((entry) => normalizeSchemaNode(root, entry, depth + 1, state));
  if (!isPlainObject(value)) return value;

  const ref = typeof value.$ref === "string" ? value.$ref : "";
  if (ref.startsWith("#/") && !state.activeRefs.has(ref)) {
    const target = resolveLocalSchemaRef(root, ref);
    if (isPlainObject(target)) {
      state.activeRefs.add(ref);
      const normalizedTarget = normalizeSchemaNode(root, target, depth + 1, state);
      state.activeRefs.delete(ref);
      if (isPlainObject(normalizedTarget)) {
        const siblings: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
          if (key === "$ref") continue;
          siblings[key] = normalizeSchemaNode(root, child, depth + 1, state);
        }
        return { ...normalizedTarget, ...siblings };
      }
    }
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) output[key] = normalizeSchemaNode(root, child, depth + 1, state);
  return output;
}

function containsDefinitionRef(value: unknown, prefix: "#/$defs/" | "#/definitions/", depth = 0): boolean {
  if (depth > KIMI_SCHEMA_MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((entry) => containsDefinitionRef(entry, prefix, depth + 1));
  if (!isPlainObject(value)) return false;
  if (typeof value.$ref === "string" && value.$ref.startsWith(prefix)) return true;
  return Object.values(value).some((entry) => containsDefinitionRef(entry, prefix, depth + 1));
}

function normalizeKimiParameters(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const normalized = normalizeSchemaNode(value, value, 0, { nodes: 0, activeRefs: new Set() });
  if (!isPlainObject(normalized)) return value;
  const output = { ...normalized };
  if (!containsDefinitionRef(output, "#/$defs/")) delete output.$defs;
  if (!containsDefinitionRef(output, "#/definitions/")) delete output.definitions;
  if (output.type === undefined) output.type = "object";
  return output;
}

export function normalizeKimiToolSchemas(body: Record<string, unknown>): Record<string, unknown> {
  const output = { ...body };
  if (Array.isArray(output.tools)) {
    output.tools = output.tools.map((rawTool) => {
      if (!isPlainObject(rawTool)) return rawTool;
      const fn = rawTool.function;
      if (!isPlainObject(fn) || !isPlainObject(fn.parameters)) return rawTool;
      return { ...rawTool, function: { ...fn, parameters: normalizeKimiParameters(fn.parameters) } };
    });
  }
  if (Array.isArray(output.functions)) {
    output.functions = output.functions.map((rawFunction) => {
      if (!isPlainObject(rawFunction) || !isPlainObject(rawFunction.parameters)) return rawFunction;
      return { ...rawFunction, parameters: normalizeKimiParameters(rawFunction.parameters) };
    });
  }
  return output;
}

export function normalizeKimiMessages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  const output: Array<Record<string, unknown>> = [];
  const pending: string[] = [];
  let latestReasoning = "";

  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const message = { ...(raw as Record<string, unknown>) };
    const role = typeof message.role === "string" ? message.role.trim() : "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const functionCall = record(message.function_call);
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    const usableReasoning = isUsableKimiReasoning(reasoning);

    if (role === "assistant" && isEmptyAssistantContent(message.content) && toolCalls.length === 0
      && Object.keys(functionCall).length === 0 && !usableReasoning) continue;

    if (role === "assistant") {
      if (usableReasoning) latestReasoning = reasoning;
      if (toolCalls.length > 0) {
        if (!usableReasoning) message.reasoning_content = latestReasoning || contentText(message.content).trim() || REASONING_UNAVAILABLE;
        for (const rawCall of toolCalls) {
          const id = typeof record(rawCall).id === "string" ? String(record(rawCall).id).trim() : "";
          if (id) pending.push(id);
        }
      }
    } else {
      latestReasoning = "";
      if (role === "tool") {
        let id = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
        if (!id && typeof message.call_id === "string") id = message.call_id.trim();
        if (!id && pending.length === 1) id = pending[0]!;
        if (id) {
          message.tool_call_id = id;
          const index = pending.indexOf(id);
          if (index >= 0) pending.splice(index, 1);
        }
      }
    }
    output.push(message);
  }
  return output;
}

function requestBody(context: ProxyRequestContext): Record<string, unknown> {
  const source = context.body;
  let body: Record<string, unknown>;
  if (context.endpoint === "responses") {
    body = {
      messages: responsesInputToMessages(source),
      stream: source.stream === true,
    };
    const translatedTools = responsesToolsToChat(source);
    if (translatedTools.tools.length > 0) body.tools = translatedTools.tools;
    rememberKimiResponseToolIdentities(context.requestId, translatedTools.identities);
    if (source.tool_choice !== undefined) body.tool_choice = responsesToolChoiceToChat(source.tool_choice);
    if (source.temperature !== undefined) body.temperature = source.temperature;
    if (source.top_p !== undefined) body.top_p = source.top_p;
    if (source.max_output_tokens !== undefined) body.max_tokens = source.max_output_tokens;
    if (source.reasoning !== undefined) body.reasoning = source.reasoning;
  } else if (context.endpoint === "completions") {
    const prompt = Array.isArray(source.prompt) ? source.prompt.map(String).join("\n") : String(source.prompt ?? "");
    body = { ...source, messages: [{ role: "user", content: prompt }] };
    delete body.prompt;
  } else {
    body = { ...source };
  }
  const defaults = record(context.provider.options.request_defaults);
  const overrides = record(context.provider.options.request_overrides);
  for (const [key, value] of Object.entries(defaults)) if (body[key] === undefined) body[key] = value;
  Object.assign(body, overrides);
  body = normalizeKimiToolSchemas(body);
  body.model = normalizeKimiUpstreamModel(context.upstreamModel);
  body.messages = normalizeKimiMessages(body.messages);
  if (body.stream === true) {
    const streamOptions = record(body.stream_options);
    body.stream_options = { ...streamOptions, include_usage: true };
  }
  return body;
}

export function buildKimiRequest(context: ProxyRequestContext): UpstreamBuildResult {
  const baseUrl = normalizeBaseUrl(context.provider.base_url);
  const endpoint = context.provider.endpoints.chat ?? "/chat/completions";
  const headers = sanitizeHeaders(context.originalRequest.headers, context.provider.headers);
  providerAuthHeaders(context.provider, context.credential, context.originalRequest.headers).forEach((value, key) => headers.set(key, value));
  headers.set("content-type", "application/json");
  headers.set("accept", context.body.stream === true ? "text/event-stream" : "application/json");
  headers.set("x-msh-platform", headers.get("x-msh-platform") ?? "CFlareAIProxy");
  headers.set("x-msh-version", headers.get("x-msh-version") ?? "0.5.3");
  headers.set("x-msh-device-name", headers.get("x-msh-device-name") ?? "cloudflare-worker");
  headers.set("x-msh-device-model", headers.get("x-msh-device-model") ?? "Cloudflare Workers");
  const deviceId = typeof context.credential.metadata.device_id === "string" ? context.credential.metadata.device_id : context.credential.id;
  headers.set("x-msh-device-id", headers.get("x-msh-device-id") ?? deviceId);
  const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  return {
    url,
    init: { method: "POST", headers, body: JSON.stringify(requestBody(context)), redirect: "manual" },
    responseMode: context.endpoint === "chat" ? "passthrough" : "codex-chat",
  };
}
