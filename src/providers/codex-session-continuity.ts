import { extractSessionAffinitySignals } from "../session-affinity";

const CLIENT_REQUEST_SOURCE = "client-request";

function explicitPromptCacheKey(body: Record<string, unknown>): string | undefined {
  const value = body.prompt_cache_key;
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

function uuidFromDigest(digest: ArrayBuffer): string {
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function resolveCodexHttpSessionId(
  body: Record<string, unknown>,
  request: Request,
  providerId: string,
): Promise<string | undefined> {
  const promptCacheKey = explicitPromptCacheKey(body);
  if (promptCacheKey) return promptCacheKey;

  const signal = extractSessionAffinitySignals(request, body)
    .find((entry) => entry.source !== CLIENT_REQUEST_SOURCE && entry.source !== "prompt-cache");
  if (!signal) return undefined;

  // The gateway credential is used only as a scoping input to the one-way digest. It is
  // never persisted or transmitted upstream, and it is not a fallback session identity.
  const gatewayScope = request.headers.get("authorization") ?? "";
  const seed = `${providerId}\0${gatewayScope}\0${signal.source}\0${signal.value}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return uuidFromDigest(digest);
}
