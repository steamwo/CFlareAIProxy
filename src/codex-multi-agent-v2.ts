import { listModels } from "./db";
import { enrichModelsWithCapabilities } from "./model-capabilities";
import { responseEncoder, responseHeaders, transformResponseSse } from "./response-utils";
import type { Env, GatewayEndpoint, ProviderKind } from "./types";

const SPAWN_AGENT_MARKER = "Spawns an agent";
const MODELS_HEADING = "Available model overrides (optional; inherited parent model is preferred):";
const COLLABORATION_NAMESPACE = "collaboration";
const OPTIMIZED_COLLABORATION_NAMESPACE = "collaboration-optimize";
const OPTIMIZED_COLLABORATION_PREFIX = `${OPTIMIZED_COLLABORATION_NAMESPACE}__`;

export interface CodexMultiAgentModelProfile {
  id: string;
  description?: string;
  reasoningLevels?: string[];
  serviceTiers?: string[];
}

export interface CodexMultiAgentOptimization {
  body: Record<string, unknown>;
  collaborationNamespaceOptimized: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))];
}

function cloneBody(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

export function isCodexMultiAgentClient(userAgent: string | null | undefined): boolean {
  const normalized = userAgent?.trim() ?? "";
  return normalized.startsWith("Codex Desktop/") || normalized.startsWith("codex-tui/");
}

export function codexMultiAgentModelProfiles(models: Array<Record<string, unknown>>): CodexMultiAgentModelProfile[] {
  const seen = new Set<string>();
  const output: CodexMultiAgentModelProfile[] = [];
  for (const model of models) {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || seen.has(id)) continue;
    const endpoints = strings(model.x_cflare_endpoints);
    if (endpoints.length > 0 && !endpoints.includes("responses")) continue;
    seen.add(id);
    const capabilities = record(model.x_cflare_capabilities);
    const displayName = typeof model.display_name === "string" ? model.display_name.trim() : "";
    output.push({
      id,
      ...(displayName && displayName !== id ? { description: displayName } : {}),
      reasoningLevels: strings(capabilities.reasoningLevels ?? capabilities.reasoning_levels),
      serviceTiers: strings(capabilities.serviceTiers ?? capabilities.service_tiers),
    });
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadCodexMultiAgentModelProfiles(env: Env, allowedModels: string[] = []): Promise<CodexMultiAgentModelProfile[]> {
  const models = await listModels(env, allowedModels);
  return codexMultiAgentModelProfiles(await enrichModelsWithCapabilities(env, models));
}

function markdownCode(value: string): string {
  return value.includes("`") ? `\`\` ${value} \`\`` : `\`${value}\``;
}

function sentence(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && !/[.!?]$/.test(normalized) ? `${normalized}.` : normalized;
}

export function formatCodexSpawnAgentModels(models: CodexMultiAgentModelProfile[]): string {
  return models.flatMap((model) => {
    const id = model.id.trim().replace(/\s+/g, " ");
    if (!id) return [];
    const details: string[] = [];
    if (model.description?.trim()) details.push(sentence(model.description));
    const reasoningLevels = strings(model.reasoningLevels);
    if (reasoningLevels.length > 0) details.push(`Reasoning efforts: ${reasoningLevels.join(", ")}.`);
    const serviceTiers = strings(model.serviceTiers);
    if (serviceTiers.length > 0) details.push(`Service tiers: ${serviceTiers.join(", ")}.`);
    return [`- ${markdownCode(id)}: ${details.join(" ")}`.trimEnd()];
  }).join("\n");
}

function removeModelSections(description: string): { cleaned: string; indent: string } {
  const lines = description.split(/(?<=\n)/);
  const output: string[] = [];
  let indent = "";
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (line.trim() !== MODELS_HEADING) {
      output.push(line);
      index += 1;
      continue;
    }
    if (!indent) indent = line.slice(0, Math.max(0, line.indexOf(MODELS_HEADING)));
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trimStart().startsWith("- ")) index += 1;
  }
  return { cleaned: output.join(""), indent };
}

export function replaceCodexSpawnAgentModels(description: string, modelList: string): string {
  if (!modelList) return description;
  const { cleaned, indent } = removeModelSections(description);
  const section = `${indent}${MODELS_HEADING}\n${modelList}\n`;
  const markerIndex = cleaned.indexOf(SPAWN_AGENT_MARKER);
  if (markerIndex >= 0) {
    const markerLineStart = cleaned.lastIndexOf("\n", markerIndex) + 1;
    return `${cleaned.slice(0, markerLineStart)}${section}${cleaned.slice(markerLineStart)}`;
  }
  const separator = cleaned && !cleaned.endsWith("\n") ? "\n\n" : "";
  return `${cleaned}${separator}${section.replace(/\n$/, "")}`;
}

function removeEncryptedMessageParameter(tool: Record<string, unknown>): void {
  const parameters = record(tool.parameters);
  const properties = record(parameters.properties);
  const message = record(properties.message);
  const messageProperties = record(message.properties);
  if (Object.prototype.hasOwnProperty.call(messageProperties, "encrypted")) {
    delete messageProperties.encrypted;
    message.properties = messageProperties;
    properties.message = message;
    parameters.properties = properties;
    tool.parameters = parameters;
  }
  if (Array.isArray(message.required)) {
    message.required = message.required.filter((entry) => entry !== "encrypted");
  }
}

export function rewriteSpawnAgentTool(tool: Record<string, unknown>, models: CodexMultiAgentModelProfile[]): Record<string, unknown> {
  const output = cloneBody(tool);
  const modelList = formatCodexSpawnAgentModels(models);
  if (typeof output.description === "string" && modelList) {
    output.description = replaceCodexSpawnAgentModels(output.description, modelList);
  }
  removeEncryptedMessageParameter(output);
  return output;
}

interface SpawnAgentReference {
  tools: unknown[];
  index: number;
  parentNamespace?: Record<string, unknown>;
}

function collectSpawnAgentReferences(toolsValue: unknown, output: SpawnAgentReference[], parentNamespace?: Record<string, unknown>): void {
  if (!Array.isArray(toolsValue)) return;
  for (let index = 0; index < toolsValue.length; index += 1) {
    const tool = record(toolsValue[index]);
    if (tool.type === "function" && tool.name === "spawn_agent") output.push({ tools: toolsValue, index, parentNamespace });
    if (tool.type === "namespace") collectSpawnAgentReferences(tool.tools, output, tool);
  }
}

function allToolCollections(body: Record<string, unknown>): unknown[] {
  const collections: unknown[] = [body.tools];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const entry = record(item);
      if (entry.type === "additional_tools") collections.push(entry.tools);
    }
  }
  return collections;
}

function toolsHaveOptimizedConflict(toolsValue: unknown): boolean {
  if (!Array.isArray(toolsValue)) return false;
  for (const raw of toolsValue) {
    const tool = record(raw);
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (name === OPTIMIZED_COLLABORATION_NAMESPACE || name.startsWith(OPTIMIZED_COLLABORATION_PREFIX)) return true;
    if (tool.type === "namespace" && toolsHaveOptimizedConflict(tool.tools)) return true;
  }
  return false;
}

export function hasCodexCollaborationConflict(body: Record<string, unknown>): boolean {
  return allToolCollections(body).some(toolsHaveOptimizedConflict);
}

function normalizeAgentMessageParts(body: Record<string, unknown>, convertToUserMessage: boolean): void {
  if (!Array.isArray(body.input)) return;
  for (const rawItem of body.input) {
    const item = record(rawItem);
    if (item.type !== "agent_message") continue;
    if (Array.isArray(item.content)) {
      for (const rawPart of item.content) {
        const part = record(rawPart);
        if (part.type !== "encrypted_content" || typeof part.encrypted_content !== "string") continue;
        part.type = "input_text";
        part.text = part.encrypted_content;
        delete part.encrypted_content;
      }
    }
    if (convertToUserMessage) {
      item.type = "message";
      item.role = "user";
    }
  }
}

export function normalizeAgentMessageInput(body: Record<string, unknown>, convertToUserMessage: boolean): Record<string, unknown> {
  const output = cloneBody(body);
  normalizeAgentMessageParts(output, convertToUserMessage);
  return output;
}

export function rewriteCollaborationNamespace(body: Record<string, unknown>): CodexMultiAgentOptimization {
  const output = cloneBody(body);
  if (hasCodexCollaborationConflict(output)) return { body: output, collaborationNamespaceOptimized: false };
  const references: SpawnAgentReference[] = [];
  for (const collection of allToolCollections(output)) collectSpawnAgentReferences(collection, references);
  let optimized = false;
  for (const reference of references) {
    if (reference.parentNamespace?.type === "namespace" && reference.parentNamespace.name === COLLABORATION_NAMESPACE) {
      reference.parentNamespace.name = OPTIMIZED_COLLABORATION_NAMESPACE;
      optimized = true;
    }
  }
  return { body: output, collaborationNamespaceOptimized: optimized };
}

export function optimizeCodexMultiAgentV2Body(
  body: Record<string, unknown>,
  options: {
    enabled: boolean;
    endpoint: GatewayEndpoint;
    providerKind: ProviderKind;
    userAgent?: string | null;
    models: CodexMultiAgentModelProfile[];
  },
): CodexMultiAgentOptimization {
  if (!options.enabled || options.endpoint !== "responses" || !isCodexMultiAgentClient(options.userAgent)) {
    return { body, collaborationNamespaceOptimized: false };
  }
  const output = normalizeAgentMessageInput(body, options.providerKind !== "codex");
  if (hasCodexCollaborationConflict(output)) return { body: output, collaborationNamespaceOptimized: false };
  const references: SpawnAgentReference[] = [];
  for (const collection of allToolCollections(output)) collectSpawnAgentReferences(collection, references);
  for (const reference of references) {
    reference.tools[reference.index] = rewriteSpawnAgentTool(record(reference.tools[reference.index]), options.models);
  }
  let optimized = false;
  for (const reference of references) {
    if (reference.parentNamespace?.type === "namespace" && reference.parentNamespace.name === COLLABORATION_NAMESPACE) {
      reference.parentNamespace.name = OPTIMIZED_COLLABORATION_NAMESPACE;
      optimized = true;
    }
  }
  return { body: output, collaborationNamespaceOptimized: optimized };
}

export async function optimizeCodexMultiAgentV2Request(
  env: Env,
  body: Record<string, unknown>,
  options: {
    enabled: boolean;
    endpoint: GatewayEndpoint;
    providerKind: ProviderKind;
    userAgent?: string | null;
    allowedModels?: string[];
  },
): Promise<CodexMultiAgentOptimization> {
  if (!options.enabled || options.endpoint !== "responses" || !isCodexMultiAgentClient(options.userAgent)) {
    return { body, collaborationNamespaceOptimized: false };
  }
  const models = await loadCodexMultiAgentModelProfiles(env, options.allowedModels).catch(() => []);
  return optimizeCodexMultiAgentV2Body(body, { ...options, models });
}

export function restoreCollaborationNamespaceValue(value: unknown, depth = 0): unknown {
  if (depth > 24 || value == null) return value;
  if (Array.isArray(value)) return value.map((entry) => restoreCollaborationNamespaceValue(entry, depth + 1));
  if (typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = { ...source };
  const itemType = typeof output.type === "string" ? output.type.trim() : "";
  const isToolCall = itemType === "function_call" || itemType === "custom_tool_call";
  if (isToolCall && output.namespace === OPTIMIZED_COLLABORATION_NAMESPACE) output.namespace = COLLABORATION_NAMESPACE;
  if (output.name === OPTIMIZED_COLLABORATION_NAMESPACE && itemType === "namespace") output.name = COLLABORATION_NAMESPACE;
  if (isToolCall && typeof output.name === "string" && output.name.startsWith(OPTIMIZED_COLLABORATION_PREFIX)) {
    output.name = `${COLLABORATION_NAMESPACE}__${output.name.slice(OPTIMIZED_COLLABORATION_PREFIX.length)}`;
  }
  for (const [key, child] of Object.entries(output)) {
    if (key === "arguments" || key === "input" || (key === "output" && (itemType === "function_call_output" || itemType === "custom_tool_call_output"))) continue;
    output[key] = restoreCollaborationNamespaceValue(child, depth + 1);
  }
  return output;
}

export async function restoreCodexMultiAgentV2Response(response: Response, optimized: boolean): Promise<Response> {
  if (!optimized || !response.body) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const body = transformResponseSse(response.body, (data, controller) => {
      if (data === "[DONE]") {
        controller.enqueue(responseEncoder.encode("data: [DONE]\n\n"));
        return;
      }
      try {
        controller.enqueue(responseEncoder.encode(`data: ${JSON.stringify(restoreCollaborationNamespaceValue(JSON.parse(data)))}\n\n`));
      } catch {
        controller.enqueue(responseEncoder.encode(`data: ${data}\n\n`));
      }
    }, () => undefined);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers, contentType) });
  }
  const text = await response.text();
  if (!contentType.includes("json")) {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers, contentType || undefined) });
  }
  try {
    return Response.json(restoreCollaborationNamespaceValue(JSON.parse(text)), {
      status: response.status,
      headers: responseHeaders(response.headers, "application/json; charset=utf-8"),
    });
  } catch {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers, contentType) });
  }
}
