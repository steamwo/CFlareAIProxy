import type { PublicModel } from "../types";

export type PlaygroundEndpoint = "responses" | "chat" | "completions";
export type PlaygroundConversationRole = "user" | "assistant";
export interface PlaygroundConversationMessage {
  role: PlaygroundConversationRole;
  content: string;
}

const ENDPOINT_ORDER: PlaygroundEndpoint[] = ["responses", "chat", "completions"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function gatewayKeyAllowedModelIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

export function playgroundEndpoints(model: PublicModel | undefined): PlaygroundEndpoint[] {
  if (!model) return [];
  const declared = Array.isArray(model.x_cflare_endpoints)
    ? model.x_cflare_endpoints
    : Array.isArray(model.endpoints) ? model.endpoints : [];
  const supported = ENDPOINT_ORDER.filter((endpoint) => declared.includes(endpoint));
  return supported.length ? supported : [...ENDPOINT_ORDER];
}

export function parsePlaygroundAdvancedJson(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("高级参数必须是 JSON 对象");
  return parsed;
}

function completionTranscript(messages: readonly PlaygroundConversationMessage[], systemPrompt?: string): string {
  const sections: string[] = [];
  if (systemPrompt?.trim()) sections.push(`System: ${systemPrompt.trim()}`);
  for (const message of messages) {
    sections.push(`${message.role === "user" ? "User" : "Assistant"}: ${message.content}`);
  }
  sections.push("Assistant:");
  return sections.join("\n\n");
}

export function buildPlaygroundRequest(input: {
  endpoint: PlaygroundEndpoint;
  model: string;
  messages: readonly PlaygroundConversationMessage[];
  systemPrompt?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  advanced?: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...(input.advanced ?? {}),
    model: input.model,
    stream: false,
  };

  if (typeof input.temperature === "number") payload.temperature = input.temperature;
  if (typeof input.maxTokens === "number") {
    payload[input.endpoint === "responses" ? "max_output_tokens" : "max_tokens"] = Math.max(1, Math.floor(input.maxTokens));
  }

  if (input.endpoint === "responses") {
    payload.input = input.messages.map((message) => ({ role: message.role, content: message.content }));
    if (input.systemPrompt?.trim()) payload.instructions = input.systemPrompt.trim();
    return payload;
  }

  if (input.endpoint === "chat") {
    const messages: Array<{ role: "system" | PlaygroundConversationRole; content: string }> = [];
    if (input.systemPrompt?.trim()) messages.push({ role: "system", content: input.systemPrompt.trim() });
    messages.push(...input.messages.map((message) => ({ role: message.role, content: message.content })));
    payload.messages = messages;
    return payload;
  }

  payload.prompt = completionTranscript(input.messages, input.systemPrompt);
  return payload;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!isRecord(item)) return "";
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
    return "";
  }).filter(Boolean).join("\n");
}

export function extractPlaygroundText(payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (typeof payload.output_text === "string" && payload.output_text) return payload.output_text;

  if (Array.isArray(payload.choices)) {
    const choices = payload.choices.map((choice) => {
      if (!isRecord(choice)) return "";
      if (typeof choice.text === "string") return choice.text;
      if (isRecord(choice.message)) return contentText(choice.message.content);
      return "";
    }).filter(Boolean);
    if (choices.length) return choices.join("\n\n");
  }

  if (Array.isArray(payload.output)) {
    const output = payload.output.map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      return contentText(item.content);
    }).filter(Boolean);
    if (output.length) return output.join("\n\n");
  }

  return "";
}
