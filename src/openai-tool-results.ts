import type { ModelCapabilities } from "./model-capabilities";

export const OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT = "[image omitted: unsupported by upstream]";

const textOnlyOpenAiCapabilities = new WeakSet<ModelCapabilities>();
const originalMessagesByBody = new WeakMap<Record<string, unknown>, { hadMessages: boolean; value: unknown }>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isImagePart(value: unknown): boolean {
  const part = record(value);
  if (!Object.keys(part).length) return false;
  const type = typeof part.type === "string" ? part.type.trim().toLowerCase() : "";
  return type === "image" || type === "image_url" || type === "input_image"
    || Object.prototype.hasOwnProperty.call(part, "image_url")
    || Object.prototype.hasOwnProperty.call(part, "input_image");
}

function jsonText(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) return encoded;
  } catch {
    // Fall back to a stable scalar representation below.
  }
  return String(value ?? "");
}

function toolResultPartText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isImagePart(value)) return OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT;
  const part = record(value);
  if (typeof part.text === "string") return part.text;
  return jsonText(value);
}

function flattenToolResultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toolResultPartText).join("\n\n");
  return toolResultPartText(value);
}

export function isExplicitTextOnlyInput(capabilities: ModelCapabilities): boolean {
  const modalities = capabilities.inputModalities;
  return Array.isArray(modalities) && modalities.includes("text") && !modalities.includes("image");
}

export function markOpenAiTextOnlyToolResultNormalization(capabilities: ModelCapabilities): void {
  if (isExplicitTextOnlyInput(capabilities)) textOnlyOpenAiCapabilities.add(capabilities);
}

export function normalizeOpenAiToolResultsTextOnly(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((raw) => {
    const message = record(raw);
    if (message.role !== "tool" || !Object.prototype.hasOwnProperty.call(message, "content") || typeof message.content === "string") return raw;
    changed = true;
    return { ...message, content: flattenToolResultContent(message.content) };
  });
  return changed ? { ...body, messages } : body;
}

export function prepareOpenAiToolResultsForValidation(body: Record<string, unknown>, capabilities: ModelCapabilities): void {
  const original = originalMessagesByBody.get(body);
  if (original) {
    if (original.hadMessages) body.messages = original.value;
    else delete body.messages;
    originalMessagesByBody.delete(body);
  }

  if (!textOnlyOpenAiCapabilities.has(capabilities)) return;
  const normalized = normalizeOpenAiToolResultsTextOnly(body);
  if (normalized === body) return;

  originalMessagesByBody.set(body, {
    hadMessages: Object.prototype.hasOwnProperty.call(body, "messages"),
    value: body.messages,
  });
  body.messages = normalized.messages;
}
