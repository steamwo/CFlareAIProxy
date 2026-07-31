import type { ProxyRequestContext, UpstreamBuildResult } from "../types";
import { chatToResponses, buildCodexRequest } from "./codex";

type ToolKind = "function" | "custom";

interface ToolNameMetadata {
  shortByOriginal: Map<string, string>;
  originalByShort: Record<string, string>;
  customOnlyNames: Set<string>;
  usedNames: Set<string>;
}

interface ResolvedToolCall {
  kind: ToolKind;
  name: string;
  input: string;
  callId?: string;
}

interface StoredToolNames {
  names: Record<string, string>;
  expiresAt: number;
}

const responseToolNames = new Map<string, StoredToolNames>();
const TOOL_NAME_TTL_MS = 5 * 60_000;
const MAX_STORED_REQUESTS = 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function named(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function stableHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
}

function allocateToolName(metadata: ToolNameMetadata, original: string): string {
  const existing = metadata.shortByOriginal.get(original);
  if (existing) return existing;

  let candidate = original;
  const directlyAvailable = original.length <= 64
    && (!metadata.usedNames.has(original) || metadata.originalByShort[original] === original);
  if (!directlyAvailable) {
    const suffix = `_${stableHash(original)}`;
    candidate = `${original.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  }

  let collision = 0;
  while (metadata.usedNames.has(candidate) && metadata.originalByShort[candidate] !== original) {
    collision += 1;
    const suffix = `_${stableHash(original)}_${collision.toString(36)}`;
    candidate = `${original.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
  }

  metadata.usedNames.add(candidate);
  metadata.shortByOriginal.set(original, candidate);
  metadata.originalByShort[candidate] = original;
  return candidate;
}

function toolNameMetadata(tools: unknown): ToolNameMetadata {
  const functionNames = new Set<string>();
  const customNames = new Set<string>();
  if (Array.isArray(tools)) {
    for (const rawTool of tools) {
      const tool = record(rawTool);
      if (tool.type === "function") functionNames.add(named(record(tool.function).name));
      if (tool.type === "custom") customNames.add(named(tool.name));
    }
  }

  const metadata: ToolNameMetadata = {
    shortByOriginal: new Map(),
    originalByShort: {},
    customOnlyNames: new Set([...customNames].filter((name) => !functionNames.has(name))),
    usedNames: new Set(),
  };

  const names = [...new Set([...functionNames, ...customNames])].sort();
  for (const name of names.filter((entry) => entry.length <= 64)) allocateToolName(metadata, name);
  for (const name of names.filter((entry) => entry.length > 64)) allocateToolName(metadata, name);
  return metadata;
}

function resolveToolCall(rawCall: unknown, metadata: ToolNameMetadata): ResolvedToolCall {
  const call = record(rawCall);
  const callId = typeof call.id === "string" && call.id ? call.id : undefined;
  const custom = record(call.custom);
  if (call.type === "custom" || Object.keys(custom).length > 0) {
    const originalName = named(custom.name ?? call.name);
    return {
      kind: "custom",
      name: allocateToolName(metadata, originalName),
      input: typeof custom.input === "string" ? custom.input : typeof call.input === "string" ? call.input : "",
      callId,
    };
  }

  const fn = record(call.function);
  const originalName = named(fn.name);
  const kind: ToolKind = metadata.customOnlyNames.has(originalName) ? "custom" : "function";
  return {
    kind,
    name: allocateToolName(metadata, originalName),
    input: typeof fn.arguments === "string" ? fn.arguments : kind === "function" ? "{}" : "",
    callId,
  };
}

function collectToolCalls(body: Record<string, unknown>, metadata: ToolNameMetadata): {
  calls: ResolvedToolCall[];
  kindsById: Map<string, ToolKind>;
} {
  const calls: ResolvedToolCall[] = [];
  const kindsById = new Map<string, ToolKind>();
  for (const rawMessage of Array.isArray(body.messages) ? body.messages : []) {
    const message = record(rawMessage);
    if (!Array.isArray(message.tool_calls)) continue;
    for (const rawCall of message.tool_calls) {
      const call = resolveToolCall(rawCall, metadata);
      calls.push(call);
      if (call.callId) kindsById.set(call.callId, call.kind);
    }
  }
  return { calls, kindsById };
}

function translatedTools(tools: unknown, metadata: ToolNameMetadata): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((rawTool) => {
    const tool = record(rawTool);
    if (tool.type === "custom") {
      return { ...tool, name: allocateToolName(metadata, named(tool.name)) };
    }
    if (tool.type !== "function") return tool;
    const fn = record(tool.function);
    const output: Record<string, unknown> = {
      type: "function",
      name: allocateToolName(metadata, named(fn.name)),
      parameters: record(fn.parameters),
    };
    if (typeof fn.description === "string") output.description = fn.description;
    if (typeof fn.strict === "boolean") output.strict = fn.strict;
    return output;
  });
}

function translatedToolChoice(value: unknown, metadata: ToolNameMetadata): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const choice = record(value);
  if (choice.type === "custom") {
    return { type: "custom", name: allocateToolName(metadata, named(choice.name ?? record(choice.custom).name)) };
  }
  if (choice.type !== "function") return value;
  const originalName = named(record(choice.function).name);
  return {
    type: metadata.customOnlyNames.has(originalName) ? "custom" : "function",
    name: allocateToolName(metadata, originalName),
  };
}

function patchTranslatedBody(
  translated: Record<string, unknown>,
  original: Record<string, unknown>,
  metadata: ToolNameMetadata,
): Record<string, unknown> {
  const { calls, kindsById } = collectToolCalls(original, metadata);
  let callIndex = 0;
  if (Array.isArray(translated.input)) {
    translated.input = translated.input.map((rawItem) => {
      const item = record(rawItem);
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const call = calls[callIndex++];
        if (!call) return rawItem;
        const callId = call.callId ?? (typeof item.call_id === "string" ? item.call_id : crypto.randomUUID());
        return call.kind === "custom"
          ? { type: "custom_tool_call", call_id: callId, name: call.name, input: call.input }
          : { type: "function_call", call_id: callId, name: call.name, arguments: call.input };
      }
      if ((item.type === "function_call_output" || item.type === "custom_tool_call_output")
        && typeof item.call_id === "string" && kindsById.get(item.call_id) === "custom") {
        return { ...item, type: "custom_tool_call_output" };
      }
      return rawItem;
    });
  }

  const tools = translatedTools(original.tools, metadata);
  if (tools) translated.tools = tools;
  if (original.tool_choice !== undefined) translated.tool_choice = translatedToolChoice(original.tool_choice, metadata);
  return translated;
}

function cleanupStoredToolNames(now: number): void {
  for (const [requestId, entry] of responseToolNames) {
    if (entry.expiresAt <= now) responseToolNames.delete(requestId);
  }
  while (responseToolNames.size >= MAX_STORED_REQUESTS) {
    const oldest = responseToolNames.keys().next().value as string | undefined;
    if (!oldest) break;
    responseToolNames.delete(oldest);
  }
}

function rememberToolNames(requestId: string, names: Record<string, string>): void {
  const now = Date.now();
  cleanupStoredToolNames(now);
  responseToolNames.set(requestId, { names, expiresAt: now + TOOL_NAME_TTL_MS });
}

export function takeCodexToolNames(requestId: string): Record<string, string> {
  cleanupStoredToolNames(Date.now());
  const entry = responseToolNames.get(requestId);
  responseToolNames.delete(requestId);
  return entry?.names ?? {};
}

export function translateCodexChatCustomTools(
  body: Record<string, unknown>,
  model: string,
): { body: Record<string, unknown>; toolNames: Record<string, string> } {
  const metadata = toolNameMetadata(body.tools);
  const translated = patchTranslatedBody(chatToResponses(body, model), body, metadata);
  return { body: translated, toolNames: metadata.originalByShort };
}

export async function buildCodexCustomToolRequest(context: ProxyRequestContext): Promise<UpstreamBuildResult> {
  const result = await buildCodexRequest(context);
  if (context.endpoint === "responses" || typeof result.init.body !== "string") return result;

  const metadata = toolNameMetadata(context.body.tools);
  const translated = patchTranslatedBody(JSON.parse(result.init.body) as Record<string, unknown>, context.body, metadata);
  rememberToolNames(context.requestId, metadata.originalByShort);
  return {
    ...result,
    init: { ...result.init, body: JSON.stringify(translated) },
  };
}
