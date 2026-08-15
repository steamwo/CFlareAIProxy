import { GatewayError } from "../errors";
import type { ModelCapabilities } from "../model-capabilities";
import type { ProxyRequestContext } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const QODER_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_TRANSLATION = new Map<string, string>([
  ...[...QODER_STD_ALPHABET].map((character, index) => [character, QODER_CUSTOM_ALPHABET[index]!] as const),
  ["=", "$"],
]);

export interface QoderToolRoute {
  kind: "function" | "tool_search";
  name: string;
  namespace?: string;
}

export interface QoderNormalizedRequest {
  system: string;
  messages: Array<Record<string, unknown>>;
  tools: unknown[];
  maxTokens: number;
  reasoningEffort: string;
  contextWindow: number;
  lastUser: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content == null) return "";
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return content.flatMap((part) => {
    if (typeof part === "string") return part ? [part] : [];
    const item = record(part);
    const text = stringValue(item.text) || stringValue(item.content);
    return text ? [text] : [];
  }).join("\n");
}

function normalizedMessages(messages: unknown): {
  messages: Array<Record<string, unknown>>;
  system: string;
  lastUser: string;
} {
  if (!Array.isArray(messages)) return { messages: [], system: "", lastUser: "" };
  const output: Array<Record<string, unknown>> = [];
  const systemParts: string[] = [];
  let lastUser = "";
  for (const raw of messages) {
    const message = record(raw);
    if (!Object.keys(message).length) continue;
    const role = stringValue(message.role) || "user";
    const text = contentToText(message.content);
    if (role === "system" || role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "user" && text) lastUser = text;
    output.push({ ...message, role, content: text });
  }
  return { messages: output, system: systemParts.join("\n\n"), lastUser };
}

function textContent(value: unknown, allowJson = false): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const raw of value) {
      const block = record(raw);
      const type = stringValue(block.type);
      if (type === "text" || type === "" || type === "input_text" || type === "output_text") {
        const text = stringValue(block.text) || stringValue(block.content);
        if (text) parts.push(text);
      } else if (allowJson) {
        try { parts.push(JSON.stringify(raw)); } catch { /* ignore malformed blocks */ }
      }
    }
    return parts.join("\n");
  }
  if (!allowJson) return "";
  try { return JSON.stringify(value); } catch { return ""; }
}

function intValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}

function maxOutputTokens(modelConfig: Record<string, unknown>): number {
  const value = intValue(modelConfig.max_output_tokens);
  return value > 0 ? value : 32768;
}

function thinkingConfig(modelConfig: Record<string, unknown>): Record<string, unknown> {
  return record(modelConfig.thinking_config);
}

export function qoderReasoningEfforts(modelConfig: Record<string, unknown>): string[] {
  const enabled = record(thinkingConfig(modelConfig).enabled);
  const efforts = record(enabled.efforts);
  return Object.keys(efforts).map((value) => value.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function qoderSupportsReasoningDisabled(modelConfig: Record<string, unknown>): boolean {
  const config = thinkingConfig(modelConfig);
  return Object.prototype.hasOwnProperty.call(config, "disabled") && config.disabled != null;
}

export function normalizeQoderReasoningEffort(modelConfig: Record<string, unknown>, value: unknown): string {
  let requested = stringValue(value).trim().toLowerCase();
  if (requested === "" || requested === "auto" || requested === "default") return "";
  if (requested === "off") requested = "none";
  const efforts = qoderReasoningEfforts(modelConfig);
  const supportsDisabled = qoderSupportsReasoningDisabled(modelConfig);
  if (!efforts.length && !supportsDisabled) return "";
  if (requested === "none") {
    if (supportsDisabled) return "none";
    throw new GatewayError(400, "QODER_REASONING_UNSUPPORTED", "The selected Qoder model does not support disabling thinking", "invalid_request_error");
  }
  if (!efforts.length) return "";
  const match = efforts.find((effort) => effort.toLowerCase() === requested);
  if (match) return match;
  throw new GatewayError(
    400,
    "QODER_REASONING_UNSUPPORTED",
    `The selected Qoder model does not support reasoning effort ${requested}; supported efforts: ${efforts.join(", ")}`,
    "invalid_request_error",
  );
}

export interface QoderContextWindowOption {
  label: string;
  tokenCount: number;
  isDefault: boolean;
}

export function qoderContextWindows(modelConfig: Record<string, unknown>): QoderContextWindowOption[] {
  const config = record(modelConfig.context_config);
  return Object.entries(config).flatMap(([label, raw]) => {
    const entry = record(raw);
    const tokenCount = intValue(entry.token_count);
    return tokenCount > 0 ? [{ label: label.trim(), tokenCount, isDefault: entry.is_default === true }] : [];
  }).sort((left, right) => left.tokenCount - right.tokenCount || left.label.localeCompare(right.label));
}

export function normalizeQoderContextWindow(modelConfig: Record<string, unknown>, value: unknown): number {
  const requested = intValue(value);
  if (requested <= 0) return 0;
  const options = qoderContextWindows(modelConfig);
  if (!options.length) {
    throw new GatewayError(400, "QODER_CONTEXT_WINDOW_UNSUPPORTED", "The selected Qoder model does not support a configurable context window", "invalid_request_error");
  }
  if (options.some((option) => option.tokenCount === requested)) return requested;
  const supported = options.map((option) => option.label ? `${option.label} (${option.tokenCount})` : String(option.tokenCount)).join(", ");
  throw new GatewayError(400, "QODER_CONTEXT_WINDOW_UNSUPPORTED", `Unsupported Qoder context window ${requested}; supported: ${supported}`, "invalid_request_error");
}

export function qoderModelCapabilities(modelConfig: Record<string, unknown>): ModelCapabilities {
  const windows = qoderContextWindows(modelConfig);
  const legacyContext = intValue(modelConfig.max_input_tokens);
  const efforts = qoderReasoningEfforts(modelConfig);
  const reasoningLevels = [...efforts];
  if (qoderSupportsReasoningDisabled(modelConfig)) reasoningLevels.unshift("none");
  const isVl = modelConfig.is_vl === true;
  return {
    contextWindow: windows.length ? windows[windows.length - 1]!.tokenCount : legacyContext > 0 ? legacyContext : undefined,
    reasoningLevels: reasoningLevels.length ? [...new Set(reasoningLevels.map((value) => value.toLowerCase()))] : undefined,
    supportsTools: true,
    supportsImages: isVl,
    inputModalities: isVl ? ["text", "image"] : ["text"],
    outputModalities: ["text"],
  };
}

export function qoderEncodeBody(plaintext: Uint8Array): Uint8Array {
  let binary = "";
  for (const byte of plaintext) binary += String.fromCharCode(byte);
  const standard = btoa(binary);
  const length = standard.length;
  const third = Math.floor(length / 3);
  const rearranged = `${standard.slice(length - third)}${standard.slice(third, length - third)}${standard.slice(0, third)}`;
  return encoder.encode([...rearranged].map((character) => QODER_TRANSLATION.get(character) ?? character).join(""));
}

export function qoderEncodedUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("Encode", "1");
  return url.toString();
}

function requestedReasoning(body: Record<string, unknown>): unknown {
  if (body.reasoning_effort !== undefined) return body.reasoning_effort;
  const reasoning = record(body.reasoning);
  if (reasoning.effort !== undefined) return reasoning.effort;
  const outputConfig = record(body.output_config);
  if (outputConfig.effort !== undefined) return outputConfig.effort;
  return undefined;
}

function requestedContextWindow(body: Record<string, unknown>): unknown {
  return body.context_window ?? body.contextWindow;
}

function chatRequest(body: Record<string, unknown>, modelConfig: Record<string, unknown>): QoderNormalizedRequest {
  const normalized = normalizedMessages(body.messages);
  const maxOutput = maxOutputTokens(modelConfig);
  const requested = intValue(body.max_completion_tokens) || intValue(body.max_tokens) || maxOutput;
  return {
    ...normalized,
    tools: Array.isArray(body.tools) ? body.tools : [],
    maxTokens: Math.max(1, Math.min(maxOutput, requested)),
    reasoningEffort: normalizeQoderReasoningEffort(modelConfig, requestedReasoning(body)),
    contextWindow: normalizeQoderContextWindow(modelConfig, requestedContextWindow(body)),
  };
}

function argumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "{}";
  try { return JSON.stringify(value); } catch { return "{}"; }
}

function canonicalToolCallMessage(callId: string, name: string, args: unknown): Record<string, unknown> {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: callId || "call_unknown", type: "function", function: { name, arguments: argumentsText(args) } }],
  };
}

function sanitizeToolAlias(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
}

async function shortToolAlias(base: string, target: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(target));
  const suffix = `__${[...new Uint8Array(digest).slice(0, 5)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const prefix = sanitizeToolAlias(base) || "tool";
  return `${prefix.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
}

async function reserveToolAlias(base: string, target: string, used: Map<string, string>): Promise<string> {
  let alias = sanitizeToolAlias(base) || "tool";
  if (alias.length > 64) alias = await shortToolAlias(alias, target);
  const previous = used.get(alias);
  if (!previous || previous === target) {
    used.set(alias, target);
    return alias;
  }
  alias = await shortToolAlias(alias, target);
  used.set(alias, target);
  return alias;
}

async function appendResponseTool(
  output: unknown[],
  routes: Map<string, QoderToolRoute>,
  used: Map<string, string>,
  seen: Set<string>,
  rawTool: Record<string, unknown>,
  namespace = "",
  namespaceDescription = "",
): Promise<void> {
  const type = stringValue(rawTool.type);
  if (type === "namespace") {
    const name = stringValue(rawTool.name).trim();
    if (!name) return;
    const description = stringValue(rawTool.description).trim();
    if (!Array.isArray(rawTool.tools)) return;
    for (const child of rawTool.tools) await appendResponseTool(output, routes, used, seen, record(child), name, description);
    return;
  }
  if (type === "tool_search") {
    const target = "tool_search\u0000client";
    if (seen.has(target)) return;
    seen.add(target);
    const alias = await reserveToolAlias("tool_search", target, used);
    const parameters = rawTool.parameters ?? { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
    const fn: Record<string, unknown> = { name: alias, parameters };
    if (stringValue(rawTool.description).trim()) fn.description = stringValue(rawTool.description).trim();
    output.push({ type: "function", function: fn });
    routes.set(alias, { kind: "tool_search", name: "tool_search" });
    return;
  }
  if (type !== "function") return;
  const name = stringValue(rawTool.name).trim();
  if (!name) return;
  const target = `function\u0000${namespace}\u0000${name}`;
  if (seen.has(target)) return;
  seen.add(target);
  const alias = await reserveToolAlias(namespace ? `${namespace}__${name}` : name, target, used);
  const fn: Record<string, unknown> = {
    name: alias,
    parameters: rawTool.parameters ?? { type: "object", properties: {} },
  };
  let description = stringValue(rawTool.description).trim();
  if (namespaceDescription) description = description ? `${namespaceDescription}\n\n${description}` : namespaceDescription;
  if (description) fn.description = description;
  if (typeof rawTool.strict === "boolean") fn.strict = rawTool.strict;
  output.push({ type: "function", function: fn });
  routes.set(alias, { kind: "function", name, ...(namespace ? { namespace } : {}) });
}

export async function normalizeQoderResponseTools(tools: unknown): Promise<{ tools: unknown[]; routes: Map<string, QoderToolRoute> }> {
  const input = Array.isArray(tools) ? tools.map(record) : [];
  const output: unknown[] = [];
  const routes = new Map<string, QoderToolRoute>();
  const used = new Map<string, string>();
  const seen = new Set<string>();
  for (const tool of input) if (tool.type === "tool_search") await appendResponseTool(output, routes, used, seen, tool);
  for (const tool of input) if (tool.type !== "tool_search") await appendResponseTool(output, routes, used, seen, tool);
  return { tools: output, routes };
}

function responseRouteAlias(routes: Map<string, QoderToolRoute>, kind: QoderToolRoute["kind"], namespace: string, name: string): string {
  for (const [alias, route] of routes) {
    if (route.kind === kind && (route.namespace ?? "") === namespace && route.name === name) return alias;
  }
  return sanitizeToolAlias(namespace ? `${namespace}__${name}` : name) || name;
}

async function responsesRequest(body: Record<string, unknown>, modelConfig: Record<string, unknown>): Promise<QoderNormalizedRequest> {
  const rawInput = body.input;
  if (rawInput === undefined || rawInput === null) throw new GatewayError(400, "INVALID_REQUEST", "input is required", "invalid_request_error");
  const items = Array.isArray(rawInput) ? rawInput.map(record) : [];
  const discoveredTools: Record<string, unknown>[] = [];
  for (const item of items) {
    if ((item.type === "tool_search_output" || item.type === "additional_tools") && Array.isArray(item.tools)) {
      discoveredTools.push(...item.tools.map(record));
    }
  }
  const declaredTools = Array.isArray(body.tools) ? body.tools.map(record) : [];
  const { tools, routes } = await normalizeQoderResponseTools([...declaredTools, ...discoveredTools]);
  const rawMessages: Array<Record<string, unknown>> = [];
  if (typeof rawInput === "string") {
    rawMessages.push({ role: "user", content: rawInput });
  } else if (!Array.isArray(rawInput)) {
    throw new GatewayError(400, "INVALID_REQUEST", "responses input must be a string or item array", "invalid_request_error");
  } else {
    for (const item of items) {
      const type = stringValue(item.type);
      let role = stringValue(item.role);
      if (type === "function_call") {
        const name = stringValue(item.name);
        const namespace = stringValue(item.namespace);
        rawMessages.push(canonicalToolCallMessage(stringValue(item.call_id) || stringValue(item.id), responseRouteAlias(routes, "function", namespace, name), item.arguments));
        continue;
      }
      if (type === "function_call_output") {
        rawMessages.push({ role: "tool", tool_call_id: stringValue(item.call_id), content: contentToText(item.output) });
        continue;
      }
      if (type === "tool_search_call") {
        rawMessages.push(canonicalToolCallMessage(stringValue(item.call_id) || stringValue(item.id), responseRouteAlias(routes, "tool_search", "", "tool_search"), item.arguments));
        continue;
      }
      if (type === "tool_search_output") {
        rawMessages.push({ role: "tool", tool_call_id: stringValue(item.call_id), content: contentToText(item.tools) });
        continue;
      }
      if (type === "additional_tools") continue;
      if (!role && type === "message") role = "user";
      if (!role) continue;
      rawMessages.push({ role, content: item.content });
    }
  }
  const normalized = normalizedMessages(rawMessages);
  const instructionText = textContent(body.instructions);
  const system = [instructionText, normalized.system].filter(Boolean).join("\n\n");
  const maxOutput = maxOutputTokens(modelConfig);
  const requested = intValue(body.max_output_tokens) || maxOutput;
  return {
    ...normalized,
    system,
    tools,
    maxTokens: Math.max(1, Math.min(maxOutput, requested)),
    reasoningEffort: normalizeQoderReasoningEffort(modelConfig, requestedReasoning(body)),
    contextWindow: normalizeQoderContextWindow(modelConfig, requestedContextWindow(body)),
  };
}

function anthropicMessageBlocks(role: string, content: unknown): { messages: Array<Record<string, unknown>>; userText: string } {
  if (typeof content === "string") return { messages: [{ role, content }], userText: role === "user" ? content : "" };
  if (!Array.isArray(content)) throw new GatewayError(400, "INVALID_REQUEST", "Anthropic message content must be a string or content-block array", "invalid_request_error");
  if (role === "assistant") {
    const texts: string[] = [];
    const calls: unknown[] = [];
    for (const raw of content) {
      const block = record(raw);
      const type = stringValue(block.type);
      if (type === "text") {
        if (stringValue(block.text)) texts.push(stringValue(block.text));
      } else if (type === "tool_use") {
        const name = stringValue(block.name);
        if (!name) throw new GatewayError(400, "INVALID_REQUEST", "Anthropic tool_use.name is required", "invalid_request_error");
        calls.push({
          id: stringValue(block.id) || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "function",
          function: { name, arguments: argumentsText(block.input ?? {}) },
        });
      } else if (type === "thinking" || type === "redacted_thinking" || !type) {
        continue;
      } else {
        throw new GatewayError(400, "INVALID_REQUEST", `Unsupported Anthropic assistant content block type ${type}`, "invalid_request_error");
      }
    }
    const message: Record<string, unknown> = { role: "assistant", content: texts.join("\n") };
    if (calls.length) message.tool_calls = calls;
    return { messages: [message], userText: "" };
  }

  const output: Array<Record<string, unknown>> = [];
  let textParts: string[] = [];
  let lastUser = "";
  const flushText = (): void => {
    if (!textParts.length) return;
    const text = textParts.join("\n");
    output.push({ role: "user", content: text });
    lastUser = text;
    textParts = [];
  };
  for (const raw of content) {
    const block = record(raw);
    const type = stringValue(block.type);
    if (type === "text") {
      if (stringValue(block.text)) textParts.push(stringValue(block.text));
    } else if (type === "tool_result") {
      flushText();
      const toolId = stringValue(block.tool_use_id);
      if (!toolId) throw new GatewayError(400, "INVALID_REQUEST", "Anthropic tool_result.tool_use_id is required", "invalid_request_error");
      output.push({ role: "tool", tool_call_id: toolId, content: textContent(block.content, true) });
    } else if (!type) {
      continue;
    } else {
      throw new GatewayError(400, "INVALID_REQUEST", `Unsupported Anthropic user content block type ${type}`, "invalid_request_error");
    }
  }
  flushText();
  if (!output.length) output.push({ role: "user", content: "" });
  return { messages: output, userText: lastUser };
}

function anthropicRequest(body: Record<string, unknown>, modelConfig: Record<string, unknown>): QoderNormalizedRequest {
  const maxTokensRaw = intValue(body.max_tokens);
  if (maxTokensRaw <= 0) throw new GatewayError(400, "INVALID_REQUEST", "max_tokens must be greater than 0", "invalid_request_error");
  if (!Array.isArray(body.messages) || !body.messages.length) throw new GatewayError(400, "INVALID_REQUEST", "messages is required", "invalid_request_error");
  const outputConfig = record(body.output_config);
  const thinking = record(body.thinking);
  let effort: unknown = outputConfig.effort;
  const thinkingType = stringValue(thinking.type).trim().toLowerCase();
  if (thinkingType === "disabled" && effort !== undefined && stringValue(effort).trim()) {
    throw new GatewayError(400, "INVALID_REQUEST", "output_config.effort cannot be combined with thinking.type=disabled when proxying to Qoder", "invalid_request_error");
  }
  if (thinkingType === "disabled") effort = "none";
  const messages: Array<Record<string, unknown>> = [];
  let lastUser = "";
  for (const raw of body.messages) {
    const message = record(raw);
    const role = stringValue(message.role).trim().toLowerCase();
    if (role !== "user" && role !== "assistant") throw new GatewayError(400, "INVALID_REQUEST", "Anthropic message role must be user or assistant", "invalid_request_error");
    const converted = anthropicMessageBlocks(role, message.content);
    messages.push(...converted.messages);
    if (converted.userText) lastUser = converted.userText;
  }
  const tools: unknown[] = [];
  if (Array.isArray(body.tools)) {
    body.tools.forEach((rawTool, index) => {
      const tool = record(rawTool);
      const name = stringValue(tool.name).trim();
      if (!name) throw new GatewayError(400, "INVALID_REQUEST", `tools[${index}].name is required`, "invalid_request_error");
      const fn: Record<string, unknown> = { name, parameters: tool.input_schema ?? { type: "object", properties: {} } };
      if (stringValue(tool.description).trim()) fn.description = stringValue(tool.description).trim();
      tools.push({ type: "function", function: fn });
    });
  }
  const maxOutput = maxOutputTokens(modelConfig);
  return {
    system: textContent(body.system),
    messages,
    tools,
    maxTokens: Math.max(1, Math.min(maxOutput, maxTokensRaw)),
    reasoningEffort: normalizeQoderReasoningEffort(modelConfig, effort),
    contextWindow: normalizeQoderContextWindow(modelConfig, requestedContextWindow(body)),
    lastUser,
  };
}

export async function normalizeQoderRequest(
  context: ProxyRequestContext,
  modelConfig: Record<string, unknown>,
): Promise<QoderNormalizedRequest> {
  if (context.endpoint === "chat") return chatRequest(context.body, modelConfig);
  if (context.endpoint === "responses") return responsesRequest(context.body, modelConfig);
  if (context.endpoint === "messages") return anthropicRequest(context.body, modelConfig);
  throw new GatewayError(400, "QODER_ENDPOINT_UNSUPPORTED", `Qoder does not support endpoint ${context.endpoint}`, "invalid_request_error");
}

export async function qoderResponseToolRoutes(body: Record<string, unknown>): Promise<Map<string, QoderToolRoute>> {
  const items = Array.isArray(body.input) ? body.input.map(record) : [];
  const discovered: Record<string, unknown>[] = [];
  for (const item of items) {
    if ((item.type === "tool_search_output" || item.type === "additional_tools") && Array.isArray(item.tools)) discovered.push(...item.tools.map(record));
  }
  const declared = Array.isArray(body.tools) ? body.tools.map(record) : [];
  return (await normalizeQoderResponseTools([...declared, ...discovered])).routes;
}

export function qoderDecodeForTest(encoded: Uint8Array): string {
  return decoder.decode(encoded);
}
