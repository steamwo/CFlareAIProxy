const MAX_EXPLICIT_ID_LENGTH = 256;
const CONTROL_CHARACTER = /\p{Cc}/u;

interface SessionSignal {
  source: string;
  value: string;
  legacy?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeExplicitId(value: unknown): string | undefined {
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_EXPLICIT_ID_LENGTH) return undefined;
  return normalized;
}

function headerSignal(headers: Headers, name: string, source: string, legacy = false): SessionSignal | undefined {
  const value = normalizeExplicitId(headers.get(name));
  return value ? { source, value, ...(legacy ? { legacy: true } : {}) } : undefined;
}

function claudeMetadataSessionId(body: Record<string, unknown>): string | undefined {
  const userId = normalizeExplicitId(record(body.metadata).user_id);
  if (!userId) return undefined;
  if (userId.startsWith("{")) {
    try {
      return normalizeExplicitId(record(JSON.parse(userId)).session_id);
    } catch {
      return undefined;
    }
  }
  return normalizeExplicitId(userId.match(/_session_([a-f0-9-]+)$/i)?.[1]);
}

function conversationId(body: Record<string, unknown>): string | undefined {
  const conversation = body.conversation;
  if (typeof conversation === "string") return normalizeExplicitId(conversation);
  return normalizeExplicitId(record(conversation).id);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    const item = record(part);
    if (typeof item.text === "string") return item.text;
    if (item.content !== undefined) return contentText(item.content);
    return "";
  }).filter(Boolean).join("\n");
}

function messageHashSeed(body: Record<string, unknown>): string | undefined {
  const instructions: string[] = [];
  const topLevelInstructions = contentText(body.instructions);
  if (topLevelInstructions) instructions.push(topLevelInstructions.slice(0, 400));

  let firstUser = "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const rawMessage of messages) {
    const message = record(rawMessage);
    const role = typeof message.role === "string" ? message.role : "";
    const text = contentText(message.content).trim();
    if (!text) continue;
    if ((role === "system" || role === "developer") && instructions.length < 4) {
      instructions.push(text.slice(0, 400));
    } else if (role === "user" && !firstUser) {
      firstUser = text.slice(0, 800);
      break;
    }
  }

  if (!firstUser) {
    const input = body.input;
    if (typeof input === "string") {
      firstUser = input.trim().slice(0, 800);
    } else if (Array.isArray(input)) {
      for (const rawItem of input) {
        const item = record(rawItem);
        const role = typeof item.role === "string" ? item.role : "";
        const text = contentText(item.content).trim();
        if (!text) continue;
        if ((role === "system" || role === "developer") && instructions.length < 4) {
          instructions.push(text.slice(0, 400));
        } else if (role === "user") {
          firstUser = text.slice(0, 800);
          break;
        }
      }
    }
  }

  if (!firstUser) return undefined;
  return JSON.stringify({ instructions, firstUser });
}

export function extractSessionAffinitySignal(request: Request, body: Record<string, unknown>): SessionSignal | undefined {
  const headers = request.headers;
  const explicit = [
    headerSignal(headers, "x-claude-code-session-id", "claude"),
    (() => {
      const value = claudeMetadataSessionId(body);
      return value ? { source: "claude", value } : undefined;
    })(),
    headerSignal(headers, "session-id", "codex"),
    headerSignal(headers, "session_id", "codex"),
    headerSignal(headers, "x-session-id", "session-header", true),
    headerSignal(headers, "x-conversation-id", "conversation-header", true),
    headerSignal(headers, "x-session-affinity", "opencode"),
    headerSignal(headers, "x-client-request-id", "client-request"),
  ].find((entry): entry is SessionSignal => entry !== undefined);
  if (explicit) return explicit;

  for (const [field, source] of [["session_id", "session"], ["sessionId", "session"]] as const) {
    const value = normalizeExplicitId(body[field]);
    if (value) return { source, value };
  }

  const promptCacheKey = normalizeExplicitId(body.prompt_cache_key);
  if (promptCacheKey) return { source: "prompt-cache", value: promptCacheKey };

  const responsesConversation = conversationId(body);
  if (responsesConversation) return { source: "conversation", value: responsesConversation };

  const metadataUser = normalizeExplicitId(record(body.metadata).user_id);
  if (metadataUser) return { source: "metadata-user", value: metadataUser };

  const legacyConversation = normalizeExplicitId(body.conversation_id);
  if (legacyConversation) return { source: "conversation", value: legacyConversation };

  const previousResponse = normalizeExplicitId(body.previous_response_id);
  if (previousResponse) return { source: "previous-response", value: previousResponse, legacy: true };

  const user = normalizeExplicitId(body.user);
  if (user) return { source: "user", value: user, legacy: true };

  const seed = messageHashSeed(body);
  return seed ? { source: "message-root", value: seed } : undefined;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildSessionAffinityKey(
  request: Request,
  body: Record<string, unknown>,
  gatewayKeyId: string,
  providerId: string,
): Promise<string | undefined> {
  const signal = extractSessionAffinitySignal(request, body);
  if (!signal) return undefined;
  if (signal.legacy) return `${providerId}:${gatewayKeyId}:${signal.value}`;
  const opaque = await sha256(`${signal.source}\0${signal.value}`);
  return `v2:${providerId}:${gatewayKeyId}:${opaque}`;
}
