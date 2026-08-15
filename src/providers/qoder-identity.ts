import { extractSessionAffinitySignal } from "../session-affinity";
import { sha256Hex } from "../utils";

async function stableHash(...parts: unknown[]): Promise<string> {
  return sha256Hex(JSON.stringify(parts));
}

function meaningfulTaskUserContent(content: unknown): boolean {
  if (content == null) return false;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return true;
}

/**
 * Keep one request-set identity across assistant/tool round-trips for the same
 * user task. A later meaningful user message starts a new request set.
 */
export function qoderRequestSetMessagePrefix(
  messages: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  let lastUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "user" && meaningfulTaskUserContent(message.content)) lastUser = index;
  }
  return lastUser < 0 ? messages : messages.slice(0, lastUser + 1);
}

/**
 * Bind Qoder to an explicit downstream conversation when one exists. Without a
 * trustworthy client/session signal, isolate the request instead of deriving
 * linkable identity from prompt content.
 */
export async function qoderSessionId(
  request: Request,
  body: Record<string, unknown>,
  upstreamModel: string,
): Promise<string> {
  const signal = extractSessionAffinitySignal(request, body);
  if (!signal) return crypto.randomUUID();
  return stableHash("qoder-client-session", upstreamModel, signal.source, signal.value);
}

export function qoderRequestSetId(
  sessionId: string,
  upstreamModel: string,
  messages: readonly Record<string, unknown>[],
): Promise<string> {
  return stableHash("qoder-request-set", sessionId, upstreamModel, qoderRequestSetMessagePrefix(messages));
}

export function qoderChatRecordId(
  sessionId: string,
  upstreamModel: string,
  messages: readonly Record<string, unknown>[],
  tools: readonly unknown[],
  maxTokens: number,
): Promise<string> {
  return stableHash("qoder-chat-record", sessionId, upstreamModel, messages, tools, maxTokens);
}
