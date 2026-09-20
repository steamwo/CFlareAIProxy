import type { ModelCapabilities } from "./model-capabilities";

export const OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT = "[image omitted: unsupported by upstream]";
const CLAUDE_TOOL_RESULT_IMAGE_RELAY_NOTICE = "Images returned by the preceding tool call(s):";
const CLAUDE_TOOL_RESULT_IMAGE_PLACEHOLDER = "[Tool returned image content; the images follow in the next user message.]";

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
  const messages: unknown[] = [];
  let replacedPlaceholderInCurrentTurn = false;

  for (const raw of body.messages) {
    const message = record(raw);
    const role = message.role;

    if (role === "tool") {
      let next = raw;
      if (Object.prototype.hasOwnProperty.call(message, "content")) {
        if (typeof message.content !== "string") {
          next = { ...message, content: flattenToolResultContent(message.content) };
          changed = true;
        } else if (message.content === CLAUDE_TOOL_RESULT_IMAGE_PLACEHOLDER) {
          next = { ...message, content: OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT };
          replacedPlaceholderInCurrentTurn = true;
          changed = true;
        }
      }
      messages.push(next);
      continue;
    }

    if (role === "user" && Array.isArray(message.content)) {
      let hasRelayNotice = false;
      let hasImages = false;
      const remaining = message.content.filter((part) => {
        const value = record(part);
        if (value.type === "text" && value.text === CLAUDE_TOOL_RESULT_IMAGE_RELAY_NOTICE) {
          hasRelayNotice = true;
          return false;
        }
        if (isImagePart(part)) {
          hasImages = true;
          return false;
        }
        return true;
      });

      if (hasRelayNotice && hasImages) {
        if (!replacedPlaceholderInCurrentTurn) {
          for (let index = messages.length - 1; index >= 0; index--) {
            const previous = record(messages[index]);
            if (previous.role !== "tool") break;
            const previousContent = typeof previous.content === "string" ? previous.content : "";
            if (!previousContent.includes(OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT)) {
              messages[index] = {
                ...previous,
                content: previousContent
                  ? `${previousContent}\n\n${OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT}`
                  : OPENAI_TOOL_RESULT_IMAGE_OMITTED_TEXT,
              };
            }
            break;
          }
        }
        replacedPlaceholderInCurrentTurn = false;
        changed = true;
        if (remaining.length) messages.push({ ...message, content: remaining });
        continue;
      }
    }

    replacedPlaceholderInCurrentTurn = false;
    messages.push(raw);
  }

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
