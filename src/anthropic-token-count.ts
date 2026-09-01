import { anthropicJsonError } from "./anthropic-downstream";
import { authenticateGatewayKey, gatewayKeyAllowsModel } from "./db";
import { GatewayError } from "./errors";
import type { Env } from "./types";
import { asInt, parseJson, readJsonBody } from "./utils";

type JsonObject = Record<string, unknown>;

export type TokenCountAuthorizer = (request: Request, env: Env, body: JsonObject) => Promise<void>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function gatewayToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const apiKey = request.headers.get("x-api-key")?.trim();
  const token = bearer || apiKey;
  if (!token) throw new GatewayError(401, "AUTHENTICATION_ERROR", "Missing API key", "authentication_error");
  return token;
}

async function authorizeTokenCount(request: Request, env: Env, body: JsonObject): Promise<void> {
  const model = stringValue(body.model)?.trim();
  if (!model) throw new GatewayError(400, "INVALID_REQUEST", "The model field is required", "invalid_request_error");
  const gatewayKey = await authenticateGatewayKey(env, gatewayToken(request));
  const allowedModels = parseJson<string[]>(gatewayKey.allowed_models_json, []);
  if (!await gatewayKeyAllowsModel(env, model, allowedModels)) {
    throw new GatewayError(403, "MODEL_NOT_ALLOWED", `API key is not allowed to use model ${model}`, "permission_error");
  }
}

function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

function jsonTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function contentTokens(value: unknown): number {
  if (typeof value === "string") return estimateTextTokens(value);
  if (!Array.isArray(value)) return isObject(value) ? jsonTokens(value) : 0;
  let total = 0;
  for (const rawPart of value) {
    if (typeof rawPart === "string") {
      total += estimateTextTokens(rawPart);
      continue;
    }
    if (!isObject(rawPart)) continue;
    if ((rawPart.type === "text" || rawPart.type === "thinking") && typeof rawPart.text === "string") {
      total += estimateTextTokens(rawPart.text);
      continue;
    }
    if (rawPart.type === "thinking" && typeof rawPart.thinking === "string") {
      total += estimateTextTokens(rawPart.thinking);
      continue;
    }
    if (rawPart.type === "tool_result") {
      total += contentTokens(rawPart.content);
      continue;
    }
    if (rawPart.type === "tool_use") {
      total += estimateTextTokens(stringValue(rawPart.name) ?? "") + jsonTokens(rawPart.input ?? {});
      continue;
    }
    if (rawPart.type === "image") {
      // Exact vision token counts depend on image dimensions, which are not
      // available from the base64/url block alone. Use a conservative fixed
      // contribution instead of counting the base64 bytes as prompt text.
      total += 1600;
      continue;
    }
    if (rawPart.type === "document") {
      // Documents may contain text, PDF/image data, or references. Counting the
      // serialized block is still only an estimate, but unlike the old text-only
      // path it does not silently treat a document as zero tokens.
      total += Math.max(256, jsonTokens(rawPart));
      continue;
    }
    total += jsonTokens(rawPart);
  }
  return total;
}

function estimateInputTokens(body: JsonObject): number {
  let total = contentTokens(body.system);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isObject(message)) continue;
      total += 4; // small per-message framing allowance
      total += contentTokens(message.content);
    }
  }
  if (Array.isArray(body.tools)) total += jsonTokens(body.tools);
  return Math.max(1, Math.ceil(total));
}

export async function handleAnthropicTokenCount(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  authorize: TokenCountAuthorizer = authorizeTokenCount,
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
    await authorize(request, env, body);
    return Response.json({ input_tokens: estimateInputTokens(body) }, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-cfap-token-count": "estimated",
      },
    });
  } catch (error) {
    const status = error instanceof GatewayError
      ? error.status
      : isObject(error) && typeof error.status === "number" ? error.status : 400;
    const message = error instanceof Error ? error.message : "Invalid request";
    const type = error instanceof GatewayError
      ? error.type
      : isObject(error) && typeof error.type === "string" ? error.type : "invalid_request_error";
    return anthropicJsonError(status, message, type);
  }
}
