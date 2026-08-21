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

function firstHeaderValue(headers: Headers, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = normalizeExplicitId(headers.get(name));
    if (value) return value;
  }
  return undefined;
}

function requestPath(request: Request): string {
  try { return new URL(request.url).pathname; } catch { return ""; }
}

function isOpenAiGenerationPath(request: Request): boolean {
  const path = requestPath(request);
  return path === "/v1/responses" || path === "/v1/chat/completions";
}

function isAnthropicMessagesPath(request: Request): boolean {
  return requestPath(request) === "/v1/messages";
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

function claudeCodeAgentId(request: Request): string | undefined {
  return isAnthropicMessagesPath(request)
    ? normalizeExplicitId(request.headers.get("x-claude-code-agent-id"))
    : undefined;
}

function claudeSessionSignal(request: Request, body: Record<string, unknown>): SessionSignal | undefined {
  const headers = request.headers;
  const native = [
    headerSignal(headers, "x-claude-code-session-id", "claude"),
    (() => {
      const value = claudeMetadataSessionId(body);
      return value ? { source: "claude", value } : undefined;
    })(),
  ].find((entry): entry is SessionSignal => entry !== undefined);
  if (native) return native;
  if (!isAnthropicMessagesPath(request)) return undefined;
  return [
    headerSignal(headers, "session-id", "codex"),
    headerSignal(headers, "session_id", "codex"),
    headerSignal(headers, "x-session-id", "session-header", true),
  ].find((entry): entry is SessionSignal => entry !== undefined);
}

function claudeSignalAliases(request: Request, signal: SessionSignal | undefined): SessionSignal[] {
  const agentId = claudeCodeAgentId(request);
  if (!signal) return agentId ? [{ source: "claude-agent", value: agentId }] : [];
  if (!agentId) return [signal];
  return [
    signal,
    { source: "claude-agent", value: JSON.stringify([signal.value, agentId]) },
  ];
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

function codexSignalAliases(signal: SessionSignal): SessionSignal[] {
  if (signal.source === "codex") return [signal, { source: "codex-session", value: signal.value }];
  if (signal.source === "codex-session") return [signal, { source: "codex", value: signal.value }];
  return [signal];
}

export function extractClientTurnKey(request: Request): string | undefined {
  if (!isOpenAiGenerationPath(request)) return undefined;
  const turnId = parseCodexTurnMetadata(request.headers.get("x-codex-turn-metadata")).turnId;
  return turnId ? `codex/turn/${turnId}` : undefined;
}

/**
 * Produce the canonical downstream conversation key used only for Qoder's
 * upstream session identity. This mirrors qoder-proxy's protocol-specific
 * namespaces while leaving CFlare's existing account-pool affinity precedence
 * and aliases backwards-compatible.
 */
export function qoderClientSessionKey(request: Request, body: Record<string, unknown>): string | undefined {
  const headers = request.headers;
  const path = requestPath(request);

  if (path === "/v1/messages") {
    const sessionId = firstHeaderValue(headers,
      "x-claude-code-session-id",
      "session-id",
      "session_id",
      "x-session-id",
    ) ?? claudeMetadataSessionId(body);
    const agentId = claudeCodeAgentId(request);
    if (agentId) {
      return sessionId
        ? `claude-code/session/${sessionId}/agent/${agentId}`
        : `claude-code/agent/${agentId}`;
    }
    if (sessionId) return `claude-code/session/${sessionId}`;
  }

  if (path === "/v1/responses" || path === "/v1/chat/completions") {
    const metadata = parseCodexTurnMetadata(headers.get("x-codex-turn-metadata"));
    const threadId = firstHeaderValue(headers, "thread-id", "thread_id") ?? metadata.threadId;
    if (threadId) return `codex/thread/${threadId}`;
    const windowId = normalizeExplicitId(headers.get("x-codex-window-id"));
    if (windowId) return `codex/window/${windowId}`;
    const sessionId = firstHeaderValue(headers, "session-id", "session_id");
    if (sessionId) return `codex/session/${sessionId}`;
    const openAiSessionId = normalizeExplicitId(headers.get("x-session-id"));
    if (openAiSessionId) return `openai/session/${openAiSessionId}`;
    if (metadata.sessionId) return `codex/session/${metadata.sessionId}`;
    if (path === "/v1/responses") {
      const promptCacheKey = normalizeExplicitId(body.prompt_cache_key);
      if (promptCacheKey) return `openai-responses/prompt-cache/${promptCacheKey}`;
    }
  }

  const signal = extractSessionAffinitySignal(request, body);
  return signal ? `cflare/${signal.source}/${signal.value}` : undefined;
}

export function extractSessionAffinitySignals(request: Request, body: Record<string, unknown>): SessionSignal[] {
  const headers = request.headers;
  const claude = claudeSessionSignal(request, body);
  const claudeAliases = claudeSignalAliases(request, claude);
  // Preserve the deployed CFlare precedence: a native Claude session signal
  // wins account-pool affinity even on OpenAI-shaped compatibility requests.
  // Qoder provider session identity is canonicalized separately above.
  if (claudeAliases.length) return claudeAliases;

  const codex = codexSessionSignal(request);
  if (codex) return codexSignalAliases(codex);

  const explicit = [
    headerSignal(headers, "session-id", "codex"),
    headerSignal(headers, "session_id", "codex"),
    headerSignal(headers, "x-session-id", "session-header", true),
    headerSignal(headers, "x-conversation-id", "conversation-header", true),
    headerSignal(headers, "x-session-affinity", "opencode"),
  ].find((entry): entry is SessionSignal => entry !== undefined);
  if (explicit) return [explicit];

  for (const [field, source] of [["session_id", "session"], ["sessionId", "session"]] as const) {
    const value = normalizeExplicitId(body[field]);
    if (value) return [{ source, value }];
  }

  const promptCacheKey = normalizeExplicitId(body.prompt_cache_key);
  const responsesConversation = conversationId(body);
  const clientRequest = headerSignal(headers, "x-client-request-id", "client-request");
  if (clientRequest) {
    // Preserve x-client-request-id as the primary legacy affinity key, but add
    // stable Responses aliases when available so changing request IDs can still
    // find the same selected credential after a restart/turn boundary.
    const aliases: SessionSignal[] = [clientRequest];
    if (promptCacheKey) aliases.push({ source: "prompt-cache", value: promptCacheKey });
    if (responsesConversation) aliases.push({ source: "conversation", value: responsesConversation });
    return aliases;
  }

  if (promptCacheKey) {
    const signals: SessionSignal[] = [{ source: "prompt-cache", value: promptCacheKey }];
    if (responsesConversation) signals.push({ source: "conversation", value: responsesConversation });
    return signals;
  }

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
