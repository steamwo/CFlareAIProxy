import type { ProxyRequestContext, UpstreamBuildResult } from "../types";
import { normalizeBaseUrl, sanitizeHeaders } from "../utils";

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

export function buildGenericRequest(context: ProxyRequestContext): UpstreamBuildResult {
  const baseUrl = normalizeBaseUrl(context.provider.base_url);
  const endpoint = resolveEndpoint(context);
  const url = endpoint.startsWith("http") ? normalizeBaseUrl(endpoint) : `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const body: Record<string, unknown> = { ...context.body };
  const defaults = objectOption(context.provider.options.request_defaults);
  const overrides = objectOption(context.provider.options.request_overrides);
  for (const [key, value] of Object.entries(defaults)) if (body[key] === undefined) body[key] = value;
  Object.assign(body, overrides);
  body.model = context.upstreamModel;
  const headers = sanitizeHeaders(context.originalRequest.headers, context.provider.headers);

  const authHeader = typeof context.provider.auth.header === "string" ? context.provider.auth.header : "authorization";
  const authPrefix = typeof context.provider.auth.prefix === "string" ? context.provider.auth.prefix : "Bearer ";
  if (context.credential.secret) headers.set(authHeader, `${authPrefix}${context.credential.secret}`);

  const metadataHeaders = context.credential.metadata.headers;
  if (metadataHeaders && typeof metadataHeaders === "object") {
    for (const [key, value] of Object.entries(metadataHeaders as Record<string, unknown>)) {
      if (typeof value === "string") headers.set(key, value);
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
