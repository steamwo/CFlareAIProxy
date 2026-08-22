import { prepareAnthropicChatBody, normalizeChatUsageForAnthropic } from "./anthropic-chat-compat";
import { anthropicJsonError, anthropicMessagesToChat, chatResponseToAnthropic } from "./anthropic-downstream";
import { normalizeClaudeCodeMessagesBody } from "./anthropic-request-compat";
import { listRoutesForModel } from "./db";
import { GatewayError } from "./errors";
import type { Env } from "./types";
import { asInt, cacheInternalJsonBody, readJsonBody, releaseInternalJsonBody } from "./utils";

type JsonObject = Record<string, unknown>;

type BaseWorker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

export type NativeMessagesRouteResolver = (env: Env, model: string) => Promise<boolean>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isMessagesPath(pathname: string): boolean {
  return pathname === "/v1/messages" || pathname === "/v1/messages/";
}

async function defaultNativeMessagesRouteResolver(env: Env, model: string): Promise<boolean> {
  return (await listRoutesForModel(env, model, "messages")).length > 0;
}

function anthropicCors(request: Request): Response {
  const origin = request.headers.get("origin") || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin === "null" ? "*" : origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-request-id, x-session-id, x-conversation-id, x-claude-code-session-id, x-claude-code-agent-id",
      "access-control-expose-headers": "x-request-id, request-id, retry-after",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}

function withGatewayAuthorization(headers: Headers): Headers {
  const result = new Headers(headers);
  const authorization = result.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authorization)) {
    const apiKey = result.get("x-api-key")?.trim();
    if (apiKey) result.set("authorization", `Bearer ${apiKey}`);
  }
  result.delete("x-api-key");
  result.delete("content-length");
  result.set("content-type", "application/json");
  return result;
}

function cachedRequest(request: Request, path: string, body: JsonObject): { request: Request; cacheId: string } {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const headers = withGatewayAuthorization(request.headers);
  const cacheId = cacheInternalJsonBody(headers, body);
  return {
    request: new Request(url, { method: "POST", headers, signal: request.signal }),
    cacheId,
  };
}

async function fetchCached(
  worker: BaseWorker,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
  body: JsonObject,
): Promise<Response> {
  const internal = cachedRequest(request, path, body);
  try {
    return await worker.fetch(internal.request, env, ctx);
  } finally {
    // The normal readJsonBody path consumes the entry. This also cleans up if
    // routing/authentication fails before body parsing.
    releaseInternalJsonBody(internal.cacheId);
  }
}

async function nativeErrorToAnthropic(response: Response): Promise<Response> {
  let sourceType: string | undefined;
  let message = `Request failed with status ${response.status}`;
  try {
    const payload = await response.json() as unknown;
    if (isObject(payload) && isObject(payload.error)) {
      sourceType = stringValue(payload.error.type);
      message = stringValue(payload.error.message) || message;
    }
  } catch {
    // Keep the status-based message.
  }
  const converted = anthropicJsonError(
    response.status,
    message,
    sourceType,
    response.headers.get("x-request-id") ?? undefined,
  );
  const headers = new Headers(converted.headers);
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(converted.body, { status: converted.status, headers });
}

/**
 * Anthropic Messages downstream entrypoint for the dev branch.
 *
 * Dev already has provider-specific native `messages` routes (notably Qoder).
 * Resolve route existence before invoking proxyGeneration so a Chat fallback does
 * not first consume an RPM/rate-limit lease on a guaranteed messages-route 404.
 * The chosen endpoint then goes through proxyGeneration exactly once.
 */
export async function handleAnthropicMessages(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  nativeMessagesWorker: BaseWorker,
  chatWorker: BaseWorker,
  resolveNativeMessagesRoute: NativeMessagesRouteResolver = defaultNativeMessagesRouteResolver,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!isMessagesPath(url.pathname)) return undefined;
  if (request.method === "OPTIONS") return anthropicCors(request);
  if (request.method !== "POST") return anthropicJsonError(405, "Method not allowed", "invalid_request_error");

  try {
    const parsed = await readJsonBody(request, asInt(env.MAX_BODY_BYTES, 8 * 1024 * 1024));
    const body = normalizeClaudeCodeMessagesBody(parsed);
    const model = stringValue(body.model)?.trim();
    if (!model) throw new GatewayError(400, "INVALID_REQUEST", "The model field is required", "invalid_request_error");

    if (await resolveNativeMessagesRoute(env, model)) {
      const native = await fetchCached(nativeMessagesWorker, request, env, ctx, "/v1/messages", body);
      return native.ok ? native : nativeErrorToAnthropic(native);
    }

    const chatBody = prepareAnthropicChatBody(body, anthropicMessagesToChat(body));
    const chat = await fetchCached(chatWorker, request, env, ctx, "/v1/chat/completions", chatBody);
    const normalizedChat = await normalizeChatUsageForAnthropic(chat);
    return chatResponseToAnthropic(normalizedChat, body.stream === true, model);
  } catch (error) {
    if (error instanceof GatewayError) return anthropicJsonError(error.status, error.message, error.type);
    const message = error instanceof Error ? error.message : "Internal gateway error";
    return anthropicJsonError(500, message, "api_error");
  }
}
