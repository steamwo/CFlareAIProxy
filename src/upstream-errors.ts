import { GatewayError } from "./errors";
import type { ProviderKind } from "./types";

export interface UpstreamErrorClassification {
  status: number;
  code: string;
  type: string;
  message: string;
  retryable: boolean;
  credentialFailure: boolean;
  providerFailure: boolean;
  retryAfterMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringAt(root: Record<string, unknown>, path: string): string | undefined {
  let current: unknown = root;
  for (const key of path.split(".")) current = record(current)[key];
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function numberAt(root: Record<string, unknown>, path: string): number | undefined {
  let current: unknown = root;
  for (const key of path.split(".")) current = record(current)[key];
  if (typeof current === "number" && Number.isFinite(current)) return current;
  if (typeof current === "string" && current.trim() && Number.isFinite(Number(current))) return Number(current);
  return undefined;
}

function parsePayload(body: string): Record<string, unknown> {
  try { return record(JSON.parse(body)); } catch { return {}; }
}

function retryAfterFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function retryAfterFromPayload(payload: Record<string, unknown>, now = Date.now()): number | undefined {
  for (const path of ["error.retry_after", "error.retry_after_seconds", "retry_after", "retry_after_seconds"]) {
    const seconds = numberAt(payload, path);
    if (seconds !== undefined && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  for (const path of ["error.reset_at", "error.resets_at", "reset_at", "resets_at"]) {
    const value = numberAt(payload, path);
    if (value === undefined) continue;
    const epochMs = value > 10_000_000_000 ? value : value * 1000;
    return Math.max(0, Math.ceil(epochMs - now));
  }
  return undefined;
}

export function classifyUpstreamResponse(
  status: number,
  body: string,
  headers: Headers,
  providerKind: ProviderKind,
): UpstreamErrorClassification {
  const payload = parsePayload(body);
  const upstreamCode = (stringAt(payload, "error.code") ?? stringAt(payload, "code") ?? "").toLowerCase();
  const upstreamType = (stringAt(payload, "error.type") ?? stringAt(payload, "type") ?? "").toLowerCase();
  const message = stringAt(payload, "error.message")
    ?? stringAt(payload, "message")
    ?? stringAt(payload, "error_description")
    ?? (body.trim() || `Upstream returned HTTP ${status}`);
  const lower = `${upstreamCode} ${upstreamType} ${message} ${body}`.toLowerCase();
  const retryAfterMs = retryAfterFromHeaders(headers) ?? retryAfterFromPayload(payload);

  if (status === 413 || upstreamCode === "context_length_exceeded" || upstreamCode === "context_too_large"
    || /context (?:window|length)|maximum context|too many tokens/.test(lower)) {
    return { status: 400, code: "CONTEXT_TOO_LARGE", type: "invalid_request_error", message, retryable: false, credentialFailure: false, providerFailure: false };
  }
  if (/invalid signature in thinking block|invalid_encrypted_content|thinking_signature/.test(lower)) {
    return { status: 400, code: "THINKING_SIGNATURE_INVALID", type: "invalid_request_error", message, retryable: false, credentialFailure: false, providerFailure: false };
  }
  if (upstreamCode === "previous_response_not_found" || /previous_response_id.*not found/.test(lower)) {
    return { status: 400, code: "PREVIOUS_RESPONSE_NOT_FOUND", type: "invalid_request_error", message, retryable: false, credentialFailure: false, providerFailure: false };
  }
  if (status === 401 || status === 403 || upstreamType === "authentication_error"
    || /invalid_api_key|invalid or expired token|refresh_token_reused|unauthorized|forbidden/.test(lower)) {
    return { status, code: "AUTH_UNAVAILABLE", type: status === 403 ? "permission_error" : "authentication_error", message, retryable: true, credentialFailure: true, providerFailure: false, retryAfterMs };
  }
  if (status === 429 || upstreamType === "rate_limit_error"
    || /rate.?limit|usage.?limit|quota|capacity|overloaded|too many requests/.test(lower)) {
    return { status: 429, code: "RATE_LIMIT_EXCEEDED", type: "rate_limit_error", message, retryable: true, credentialFailure: true, providerFailure: false, retryAfterMs };
  }
  if (status === 408 || status === 425 || status >= 500) {
    return { status: 502, code: "UPSTREAM_UNAVAILABLE", type: "upstream_error", message, retryable: true, credentialFailure: status !== 502 || providerKind === "codex", providerFailure: true, retryAfterMs };
  }
  return { status, code: "UPSTREAM_ERROR", type: "upstream_error", message, retryable: false, credentialFailure: false, providerFailure: false, retryAfterMs };
}

export function classifyTransportError(error: unknown, providerName: string, timeoutMs: number): GatewayError {
  if (error instanceof GatewayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
    || /timed?\s*out|timeout/i.test(message);
  return new GatewayError(
    timedOut ? 504 : 502,
    timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
    timedOut ? `${providerName} timed out after ${timeoutMs} ms` : `${providerName} request failed: ${message}`,
    "upstream_error",
  );
}

export function gatewayErrorFromClassification(value: UpstreamErrorClassification): GatewayError {
  return new GatewayError(value.status, value.code, value.message, value.type);
}
