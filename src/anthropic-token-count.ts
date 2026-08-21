import { anthropicJsonError } from "./anthropic-downstream";
import type { Env } from "./types";
import { asInt, readJsonBody } from "./utils";

type BaseWorker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedAuthHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const authorization = headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authorization)) {
    const apiKey = headers.get("x-api-key")?.trim();
    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  }
  headers.delete("x-api-key");
  headers.delete("content-length");
  return headers;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!isObject(part)) return "";
    if (part.type === "text" && typeof part.text === "string") return part.text;
    if (part.type === "thinking" && typeof part.thinking === "string") return part.thinking;
    if (part.type === "tool_result") return textFromContent(part.content);
    if (part.type === "tool_use") {
      try { return JSON.stringify(part.input ?? {}); } catch { return ""; }
    }
    return "";
  }).filter(Boolean).join("\n");
}

function estimateInputTokens(body: Record<string, unknown>): number {
  const parts: string[] = [textFromContent(body.system)];
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isObject(message)) parts.push(textFromContent(message.content));
    }
  }
  if (Array.isArray(body.tools)) {
    try { parts.push(JSON.stringify(body.tools)); } catch { /* ignore */ }
  }
  return Math.max(1, Math.ceil(parts.join("\n").length / 4));
}

async function convertedAuthError(response: Response): Promise<Response> {
  let message = `Request failed with status ${response.status}`;
  let type: string | undefined;
  try {
    const payload = await response.json() as unknown;
    if (isObject(payload) && isObject(payload.error)) {
      if (typeof payload.error.message === "string") message = payload.error.message;
      if (typeof payload.error.type === "string") type = payload.error.type;
    }
  } catch {
    // Keep the status-derived fallback.
  }
  return anthropicJsonError(response.status, message, type, response.headers.get("x-request-id") ?? undefined);
}

export async function handleAnthropicTokenCount(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  worker: BaseWorker,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/messages/count_tokens" && path !== "/v1/messages/count_tokens/") return undefined;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, x-request-id",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "POST") return anthropicJsonError(405, "Method not allowed", "invalid_request_error");

  try {
    const body = await readJsonBody(request, asInt(env.MAX_BODY_BYTES, 8 * 1024 * 1024));
    const authUrl = new URL(request.url);
    authUrl.pathname = "/v1/models";
    authUrl.search = "";
    const authResponse = await worker.fetch(new Request(authUrl, {
      method: "GET",
      headers: normalizedAuthHeaders(request.headers),
      signal: request.signal,
    }), env, ctx);
    if (!authResponse.ok) return convertedAuthError(authResponse);
    return Response.json({ input_tokens: estimateInputTokens(body) }, {
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    const status = isObject(error) && typeof error.status === "number" ? error.status : 400;
    const message = error instanceof Error ? error.message : "Invalid request";
    const type = isObject(error) && typeof error.type === "string" ? error.type : "invalid_request_error";
    return anthropicJsonError(status, message, type);
  }
}
