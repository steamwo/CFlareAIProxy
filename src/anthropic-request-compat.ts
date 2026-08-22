type JsonObject = Record<string, unknown>;

const SYSTEM_REMINDER_START = "<system-reminder>";
const SYSTEM_REMINDER_END = "</system-reminder>";

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

function systemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      if (raw) parts.push(raw);
      continue;
    }
    if (isObject(raw) && raw.type === "text" && typeof raw.text === "string" && raw.text) parts.push(raw.text);
  }
  return parts.join("\n");
}

function systemReminderMessage(content: unknown): JsonObject | undefined {
  const text = systemText(content).trim();
  if (!text) return undefined;
  return {
    role: "user",
    content: [{ type: "text", text: `${SYSTEM_REMINDER_START}\n${text}\n${SYSTEM_REMINDER_END}` }],
  };
}

/**
 * Normalize compatibility-client system messages without changing their scope.
 *
 * Instructions that apply from the start belong in Anthropic's top-level
 * `system` field. Some Claude Code compatible clients still place a leading
 * `role: "system"` entry in `messages`; promote only those leading entries.
 * A system entry after the conversation has started must stay at that position.
 * For non-Claude upstream formats we mirror CLIProxyAPI's compatibility behavior
 * and represent it as a `<system-reminder>` user turn instead of incorrectly
 * hoisting it to the beginning of the prompt.
 */
export function normalizeClaudeCodeMessagesBody(body: JsonObject): JsonObject {
  if (!Array.isArray(body.messages)) return body;

  const systemParts: unknown[] = [];
  appendSystemParts(systemParts, body.system);
  const messages: unknown[] = [];
  let conversationStarted = false;
  let changed = false;

  for (const rawMessage of body.messages) {
    if (!isObject(rawMessage) || rawMessage.role !== "system") {
      messages.push(rawMessage);
      if (isObject(rawMessage)) conversationStarted = true;
      continue;
    }

    changed = true;
    if (!conversationStarted) {
      appendSystemParts(systemParts, rawMessage.content);
      continue;
    }

    const reminder = systemReminderMessage(rawMessage.content);
    if (reminder) messages.push(reminder);
  }

  if (!changed) return body;

  const normalized: JsonObject = { ...body, messages };
  if (systemParts.length > 0) normalized.system = systemParts;
  else delete normalized.system;
  return normalized;
}
