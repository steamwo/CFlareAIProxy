type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function appendSystemParts(target: unknown[], value: unknown): void {
  if (typeof value === "string") {
    if (value) target.push({ type: "text", text: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      if (typeof part === "string") {
        if (part) target.push({ type: "text", text: part });
      } else if (isObject(part)) {
        target.push(part);
      }
    }
    return;
  }
  if (isObject(value)) target.push(value);
}

/**
 * Claude Code compatibility normalization on an already parsed request body.
 *
 * Anthropic's Messages API represents system instructions in the top-level
 * `system` field, but compatibility clients can occasionally send a
 * `messages[]` item with `role: "system"`. Canonicalize those messages without
 * re-reading or cloning the HTTP request body so long Claude Code contexts only
 * pay the JSON parse cost once.
 */
export function normalizeClaudeCodeMessagesBody(body: JsonObject): JsonObject {
  if (!Array.isArray(body.messages)) return body;

  const systemParts: unknown[] = [];
  appendSystemParts(systemParts, body.system);
  const messages: unknown[] = [];
  let changed = false;

  for (const rawMessage of body.messages) {
    if (!isObject(rawMessage) || rawMessage.role !== "system") {
      messages.push(rawMessage);
      continue;
    }
    changed = true;
    appendSystemParts(systemParts, rawMessage.content);
  }

  if (!changed) return body;

  const normalized: JsonObject = { ...body, messages };
  if (systemParts.length > 0) normalized.system = systemParts;
  else delete normalized.system;
  return normalized;
}
