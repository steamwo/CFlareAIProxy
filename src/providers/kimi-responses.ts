import { responsesToolOutputToChatContent } from "./responses-tool-output";

export type KimiResponseToolKind = "function" | "custom";

export interface KimiResponseToolIdentity {
  kind: KimiResponseToolKind;
  name: string;
  namespace?: string;
}

export interface KimiResponseToolsTranslation {
  tools: unknown[];
  identities: Record<string, KimiResponseToolIdentity>;
}

interface StoredToolIdentities {
  identities: Record<string, KimiResponseToolIdentity>;
  expiresAt: number;
}

const responseToolIdentities = new Map<string, StoredToolIdentities>();
const TOOL_IDENTITY_TTL_MS = 5 * 60_000;
const MAX_STORED_REQUESTS = 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanupStoredToolIdentities(now: number): void {
  for (const [requestId, entry] of responseToolIdentities) {
    if (entry.expiresAt <= now) responseToolIdentities.delete(requestId);
  }
  while (responseToolIdentities.size >= MAX_STORED_REQUESTS) {
    const oldest = responseToolIdentities.keys().next().value as string | undefined;
    if (!oldest) break;
    responseToolIdentities.delete(oldest);
  }
}

export function rememberKimiResponseToolIdentities(
  requestId: string,
  identities: Record<string, KimiResponseToolIdentity>,
): void {
  const now = Date.now();
  cleanupStoredToolIdentities(now);
  responseToolIdentities.set(requestId, { identities, expiresAt: now + TOOL_IDENTITY_TTL_MS });
}

export function takeKimiResponseToolIdentities(requestId: string): Record<string, KimiResponseToolIdentity> {
  cleanupStoredToolIdentities(Date.now());
  const entry = responseToolIdentities.get(requestId);
  responseToolIdentities.delete(requestId);
  return entry?.identities ?? {};
}

function responseContentToChat(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((raw) => {
    const part = record(raw);
    const type = typeof part.type === "string" ? part.type : "";
    if ((type === "input_text" || type === "output_text") && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (type === "input_image") {
      const image = part.image_url ?? part.image;
      if (typeof image === "string") return { type: "image_url", image_url: { url: image } };
      if (image && typeof image === "object" && !Array.isArray(image)) return { type: "image_url", image_url: image };
    }
    return part;
  });
}

function reasoningParts(item: Record<string, unknown>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const text = value.trim();
    if (!text || text.toLowerCase() === "[reasoning unavailable]" || seen.has(text)) return;
    seen.add(text);
    output.push(text);
  };
  add(item.reasoning_content);
  add(item.text);
  const collect = (value: unknown): void => {
    if (typeof value === "string") { add(value); return; }
    if (!Array.isArray(value)) {
      const row = record(value);
      add(row.text);
      return;
    }
    for (const raw of value) {
      if (typeof raw === "string") add(raw);
      else add(record(raw).text);
    }
  };
  collect(item.summary);
  collect(item.content);
  return output;
}

function appendReasoning(message: Record<string, unknown>, parts: string[]): void {
  const existing = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  const merged = [...(existing && existing.toLowerCase() !== "[reasoning unavailable]" ? [existing] : []), ...parts]
    .filter((value, index, values) => values.indexOf(value) === index);
  if (merged.length > 0) message.reasoning_content = merged.join("\n");
}

function responseCallName(item: Record<string, unknown>): string {
  const name = stringValue(item.name) ?? "unknown";
  const namespace = stringValue(item.namespace);
  return namespace ? `${namespace}__${name}` : name;
}

export function responsesInputToMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) messages.push({ role: "system", content: body.instructions });
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  const pendingReasoning: string[] = [];
  let mergeableAssistantIndex: number | undefined;
  const attachPendingReasoning = (message: Record<string, unknown>): void => {
    appendReasoning(message, pendingReasoning);
    pendingReasoning.length = 0;
  };

  for (const raw of input) {
    if (typeof raw === "string") {
      pendingReasoning.length = 0;
      mergeableAssistantIndex = undefined;
      messages.push({ role: "user", content: raw });
      continue;
    }
    const item = record(raw);
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "additional_tools") continue;
    if (type === "reasoning") {
      const parts = reasoningParts(item);
      if (mergeableAssistantIndex !== undefined) appendReasoning(messages[mergeableAssistantIndex]!, parts);
      else pendingReasoning.push(...parts);
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      pendingReasoning.length = 0;
      mergeableAssistantIndex = undefined;
      messages.push({ role: "tool", tool_call_id: item.call_id, content: responsesToolOutputToChatContent(item.output ?? "") });
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      let assistant: Record<string, unknown>;
      if (mergeableAssistantIndex === undefined) {
        assistant = { role: "assistant", content: null, tool_calls: [] };
        attachPendingReasoning(assistant);
        messages.push(assistant);
        mergeableAssistantIndex = messages.length - 1;
      } else {
        assistant = messages[mergeableAssistantIndex]!;
        attachPendingReasoning(assistant);
      }
      const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: {
          name: responseCallName(item),
          arguments: item.arguments ?? item.input ?? "{}",
        },
      });
      assistant.tool_calls = toolCalls;
      continue;
    }

    const role = typeof item.role === "string" ? item.role : "user";
    const message: Record<string, unknown> = { role, content: responseContentToChat(item.content ?? item.text ?? "") };
    if (role === "assistant") {
      attachPendingReasoning(message);
      messages.push(message);
      mergeableAssistantIndex = messages.length - 1;
    } else {
      pendingReasoning.length = 0;
      mergeableAssistantIndex = undefined;
      messages.push(message);
    }
  }
  return messages;
}

export function responsesToolChoiceToChat(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const choice = record(value);
  if (choice.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  if (choice.type === "custom" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return value;
}

function declarationCollections(body: Record<string, unknown>): unknown[][] {
  const output: unknown[][] = [];
  if (Array.isArray(body.tools)) output.push(body.tools);
  if (Array.isArray(body.input)) {
    for (const raw of body.input) {
      const item = record(raw);
      if (item.type === "additional_tools" && Array.isArray(item.tools)) output.push(item.tools);
    }
  }
  return output;
}

function functionDeclaration(tool: Record<string, unknown>, finalName: string): Record<string, unknown> {
  const nested = record(tool.function);
  const source = Object.keys(nested).length ? nested : tool;
  const fn: Record<string, unknown> = {
    name: finalName,
    parameters: record(source.parameters),
  };
  if (typeof source.description === "string") fn.description = source.description;
  if (typeof source.strict === "boolean") fn.strict = source.strict;
  return { type: "function", function: fn };
}

function addToolDeclaration(
  raw: unknown,
  namespaces: string[],
  output: unknown[],
  identities: Record<string, KimiResponseToolIdentity>,
  seen: Set<string>,
): void {
  const tool = record(raw);
  if (tool.type === "namespace") {
    const namespace = stringValue(tool.name);
    if (!namespace || !Array.isArray(tool.tools)) return;
    for (const child of tool.tools) addToolDeclaration(child, [...namespaces, namespace], output, identities, seen);
    return;
  }
  const nested = record(tool.function);
  const kind: KimiResponseToolKind | undefined = tool.type === "custom" ? "custom" : tool.type === "function" ? "function" : undefined;
  if (!kind) {
    output.push(raw);
    return;
  }
  const name = kind === "function" ? stringValue(nested.name ?? tool.name) : stringValue(tool.name);
  if (!name) return;
  const namespace = namespaces.length > 0 ? namespaces.join("__") : undefined;
  const finalName = namespace ? `${namespace}__${name}` : name;
  if (seen.has(finalName)) return;
  seen.add(finalName);
  identities[finalName] = { kind, name, ...(namespace ? { namespace } : {}) };
  if (kind === "function") output.push(functionDeclaration(tool, finalName));
  else output.push({ ...tool, name: finalName });
}

export function responsesToolsToChat(body: Record<string, unknown>): KimiResponseToolsTranslation {
  const tools: unknown[] = [];
  const identities: Record<string, KimiResponseToolIdentity> = {};
  const seen = new Set<string>();
  for (const collection of declarationCollections(body)) {
    for (const raw of collection) addToolDeclaration(raw, [], tools, identities, seen);
  }
  return { tools, identities };
}
