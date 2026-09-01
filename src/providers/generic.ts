import type { ProxyRequestContext, UpstreamBuildResult } from "../types";
import { normalizeBaseUrl, resolveConfiguredHeaderValue, sanitizeHeaders } from "../utils";
import { applyOpenAiPromptCacheKey } from "./openai-prompt-cache";

function resolveEndpoint(context: ProxyRequestContext): string {
  const configured = context.provider.endpoints[context.endpoint];
  if (configured) return configured;
  if (context.endpoint === "responses") return "/responses";
  if (context.endpoint === "completions") return "/completions";
  return "/chat/completions";
}

function objectOption(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function buildGenericRequest(context: ProxyRequestContext): Promise<UpstreamBuildResult> {
  const baseUrl = normalizeBaseUrl(context.provider.base_url);
  const endpoint = resolveEndpoint(context);
  const url = endpoint.startsWith("http") ? normalizeBaseUrl(endpoint) : `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const body: Record<string, unknown> = { ...context.body };
  const defaults = objectOption(context.provider.options.request_defaults);
  const overrides = objectOption(context.provider.options.request_overrides);
  for (const [key, value] of Object.entries(defaults)) if (body[key] === undefined) body[key] = value;
  Object.assign(body, overrides);
  body.model = context.upstreamModel;
  if (context.provider.kind === "openai-compatible") await applyOpenAiPromptCacheKey(body, context);
  const headers = sanitizeHeaders(context.originalRequest.headers, context.provider.headers);

  const authHeader = typeof context.provider.auth.header === "string" ? context.provider.auth.header : "authorization";
  const authPrefix = typeof context.provider.auth.prefix === "string" ? context.provider.auth.prefix : "Bearer ";
  if (context.credential.secret) headers.set(authHeader, `${authPrefix}${context.credential.secret}`);

  const metadataHeaders = context.credential.metadata.headers;
  if (metadataHeaders && typeof metadataHeaders === "object" && !Array.isArray(metadataHeaders)) {
    for (const [key, configured] of Object.entries(metadataHeaders as Record<string, unknown>)) {
      if (typeof configured !== "string") continue;
      const value = resolveConfiguredHeaderValue(configured, context.originalRequest.headers);
      if (value !== undefined) headers.set(key, value);
      else headers.delete(key);
    }
  }

  return {
    url,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
    },
    responseMode: "passthrough",
  };
}
