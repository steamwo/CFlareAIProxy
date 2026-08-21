const MAX_EXPLICIT_ID_LENGTH = 256;
const MAX_CODEX_TURN_METADATA_LENGTH = 8 << 10;
const CONTROL_CHARACTER = /\p{Cc}/u;

export interface SessionSignal {
  source: string;
  value: string;
  legacy?: boolean;
}

export interface CodexTurnMetadata {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
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

function requestPath(request: Request): string {
  try { return new URL(request.url).pathname; } catch { return ""; }
}

function isOpenAiGenerationPath(request: Request): boolean {
  const path = requestPath(request);
  return path === "/v1/responses" || path === "/v1/chat/completions";
}

function claudeMetadataSessionId(body: Record<string, unknown>): string | undefined {
  const rawUserId = record(body.metadata).user_id;
  if (typeof rawUserId !== "string") return undefined;
  const userId = rawUserId.trim();
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

export function parseCodexTurnMetadata(raw: string | null | undefined): CodexTurnMetadata {
  const value = raw?.trim() ?? "";
  if (!value || value.length > MAX_CODEX_TURN_METADATA_LENGTH) return {};
  try {
    const metadata = record(JSON.parse(value));
    return {
      sessionId: normalizeExplicitId(metadata.session_id),
      threadId: normalizeExplicitId(metadata.thread_id),
      turnId: normalizeExplicitId(metadata.turn_id),
    };
  } catch {
    return {};
  }
}

function codexSessionSignal(request: Request): SessionSignal | undefined {
  if (!isOpenAiGenerationPath(request)) return undefined;
  const headers = request.headers;
  const metadata = parseCodexTurnMetadata(headers.get("x-codex-turn-metadata"));
  return [
    headerSignal(headers, "thread-id", "codex-thread"),
    headerSignal(headers, "thread_id", "codex-thread"),
    metadata.threadId ? { source: "codex-thread", value: metadata.threadId } : undefined,
    headerSignal(headers, "x-codex-window-id", "codex-window"),
    // Keep existing CFlare signal namespaces for pre-existing headers so the
    // account-pool affinity key remains stable while Qoder gains richer Codex
    // thread/turn inputs.
    headerSignal(headers, "session-id", "codex"),
    headerSignal(headers, "session_id", "codex"),
    headerSignal(headers, "x-session-id", "session-header", true),
    metadata.sessionId ? { source: "codex-session", value: metadata.sessionId } : undefined,
  ].find((entry): entry is SessionSignal => entry !== undefined);
}

export function extractClientTurnKey(request: Request): string | undefined {
  if (!isOpenAiGenerationPath(request)) return undefined;
  const turnId = parseCodexTurnMetadata(request.headers.get("x-codex-turn-metadata")).turnId;
  return turnId ? `codex/turn/${turnId}` : undefined;
}

export function extractSessionAffinitySignals(request: Request, body: Record<string, unknown>): SessionSignal[] {
  const headers = request.headers;
  const claude = [
    headerSignal(headers, "x-claude-code-session-id", "claude"),
    (() => {
      const value = claudeMetadataSessionId(body);
      return value ? { source: "claude", value } : undefined;
    })(),
  ].find((entry): entry is SessionSignal => entry !== undefined);
  if (claude) return [claude];

  const codex = codexSessionSignal(request);
  if (codex) return [codex];

  const explicit = [
    headerSignal(headers, "session-id", "codex"),
    headerSignal(headers, "session_id", "codex"),
    headerSignal(headers, "x-session-id", "session-header", true),
    headerSignal(headers, "x-conversation-id", "conversation-header", true),
    headerSignal(headers, "x-session-affinity", "opencode"),
    headerSignal(headers, "x-client-request-id", "client-request"),
  ].find((entry): entry is SessionSignal => entry !== undefined);
  if (explicit) return [explicit];

  for (const [field, source] of [["session_id", "session"], ["sessionId", "session"]] as const) {
    const value = normalizeExplicitId(body[field]);
    if (value) return [{ source, value }];
  }

  const promptCacheKey = normalizeExplicitId(body.prompt_cache_key);
  if (promptCacheKey) {
    const signals: SessionSignal[] = [{ source: "prompt-cache", value: promptCacheKey }];
    const responsesConversation = conversationId(body);
    if (responsesConversation) signals.push({ source: "conversation", value: responsesConversation });
    return signals;
  }

  const responsesConversation = conversationId(body);
  if (responsesConversation) return [{ source: "conversation", value: responsesConversation }];

  const metadataUser = normalizeExplicitId(record(body.metadata).user_id);
  if (metadataUser) return [{ source: "metadata-user", value: metadataUser }];

  const legacyConversation = normalizeExplicitId(body.conversation_id);
  if (legacyConversation) return [{ source: "conversation", value: legacyConversation }];

  const previousResponse = normalizeExplicitId(body.previous_response_id);
  if (previousResponse) return [{ source: "previous-response", value: previousResponse, legacy: true }];

  const user = normalizeExplicitId(body.user);
  if (user) return [{ source: "user", value: user, legacy: true }];

  // No prompt/message-derived fallback. Affinity must come from an explicit client or
  // protocol session signal so unrelated requests cannot become linkable by content.
  return [];
}

export function extractSessionAffinitySignal(request: Request, body: Record<string, unknown>): SessionSignal | undefined {
  return extractSessionAffinitySignals(request, body)[0];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sessionSignalKey(signal: SessionSignal, gatewayKeyId: string, providerId: string): Promise<string> {
  if (signal.legacy) return `${providerId}:${gatewayKeyId}:${signal.value}`;
  const opaque = await sha256(`${signal.source}\0${signal.value}`);
  return `v2:${providerId}:${gatewayKeyId}:${opaque}`;
}

export async function buildSessionAffinityKey(
  request: Request,
  body: Record<string, unknown>,
  gatewayKeyId: string,
  providerId: string,
): Promise<string | string[] | undefined> {
  const signals = extractSessionAffinitySignals(request, body);
  if (signals.length === 0) return undefined;
  const keys = [...new Set(await Promise.all(signals.map((signal) => sessionSignalKey(signal, gatewayKeyId, providerId))))];
  return keys.length === 1 ? keys[0] : keys;
}
