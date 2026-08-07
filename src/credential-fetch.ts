import { GatewayError } from "./errors";
import { idleTimeoutFor, proxyRequest, validateProxyUrl, type ProxyDialect } from "./proxy-transport";
import type { Credential, Env, ProviderConfig } from "./types";
import { providerFetch, type ProviderFetchOptions } from "./upstream-fetch";

const CREDENTIAL_CONNECT_TIMEOUT_MS = 20_000;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CREDENTIAL_PROXY_DIALECT: ProxyDialect = {
  connectTimeout: (proxy) => new GatewayError(504, "CREDENTIAL_PROXY_CONNECT_TIMEOUT", `Connecting to credential proxy ${proxy.host} timed out`, "upstream_error"),
  idleTimeout: (idleMs) => new GatewayError(504, "CREDENTIAL_PROXY_IDLE_TIMEOUT", `Credential proxy connection was idle for ${idleMs} ms and timed out`, "upstream_error"),
  handshakeLengthInvalid: () => new GatewayError(502, "CREDENTIAL_PROXY_PROTOCOL_ERROR", "Credential proxy returned an invalid response length", "upstream_error"),
  handshakeClosed: () => new GatewayError(502, "CREDENTIAL_PROXY_CLOSED", "Credential proxy closed during handshake", "upstream_error"),
  handshakeTooLarge: () => new GatewayError(502, "CREDENTIAL_PROXY_PROTOCOL_ERROR", "Credential proxy handshake response was too large", "upstream_error"),
  headersTooLarge: () => new GatewayError(502, "UPSTREAM_HEADERS_TOO_LARGE", "Upstream response headers were too large", "upstream_error"),
  headersClosed: () => new GatewayError(502, "UPSTREAM_CONNECTION_CLOSED", "Upstream closed before returning complete headers", "upstream_error"),
  connectRejected: (statusLine) => new GatewayError(502, "CREDENTIAL_PROXY_CONNECT_REJECTED", `Credential HTTP proxy rejected CONNECT: ${statusLine || "missing status"}`, "upstream_error"),
  authRejected: () => new GatewayError(502, "CREDENTIAL_PROXY_AUTH_UNSUPPORTED", "Credential SOCKS5 proxy rejected all authentication methods", "upstream_error"),
  authMethodUnsupported: (method) => new GatewayError(502, "CREDENTIAL_PROXY_AUTH_UNSUPPORTED", `Credential SOCKS5 proxy returned authentication method ${method}`, "upstream_error"),
  authFailed: () => new GatewayError(502, "CREDENTIAL_PROXY_AUTH_FAILED", "Credential SOCKS5 authentication failed", "upstream_error"),
  proxyCredentialTooLong: () => new GatewayError(400, "CREDENTIAL_PROXY_CREDENTIAL_TOO_LONG", "Credential SOCKS username, password, or USERID is too long or invalid"),
  hostTooLong: () => new GatewayError(400, "UPSTREAM_HOST_INVALID", "Upstream hostname is too long"),
  socksConnectFailed: (code) => new GatewayError(502, "CREDENTIAL_PROXY_CONNECT_FAILED", `Credential SOCKS proxy failed to connect, code ${code}`, "upstream_error"),
  socksUnknownAddress: () => new GatewayError(502, "CREDENTIAL_PROXY_PROTOCOL_ERROR", "Credential SOCKS5 proxy returned an unknown address type", "upstream_error"),
  tlsNegotiationTimeout: (target, timeoutMs) => new GatewayError(504, "CREDENTIAL_PROXY_TLS_TIMEOUT", `TLS negotiation with ${target.hostname}:${target.port || "443"} timed out after ${timeoutMs} ms`, "upstream_error"),
  tlsHandshakeFailed: (target, message) => new GatewayError(502, "CREDENTIAL_PROXY_TLS_HANDSHAKE_FAILED", `Credential proxy tunnel was established, but TLS handshake with ${target.hostname}:${target.port || "443"} failed: ${message}`, "upstream_error"),
  streamingBodyUnsupported: () => new GatewayError(500, "CREDENTIAL_PROXY_BODY_UNSUPPORTED", "Credential proxy does not support streaming request bodies", "upstream_error"),
  invalidStatusLine: (statusLine) => new GatewayError(502, "UPSTREAM_PROTOCOL_ERROR", `Upstream returned an invalid status line: ${statusLine.slice(0, 200)}`, "upstream_error"),
  bodyEndedEarly: () => new Error("Upstream response ended early"),
  chunkedEndedEarly: () => new Error("Chunked response ended early"),
  invalidChunkLength: (line) => new Error(`Invalid chunk length: ${line}`),
  missingChunkCrlf: () => new Error("Chunk data was not followed by CRLF"),
};

export function credentialProxyUrl(credential: Credential): string | undefined {
  const value = credential.metadata.proxy_url ?? credential.metadata.proxyUrl;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function credentialProxyFetch(proxyValue: string, target: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await proxyRequest({
      proxy: validateProxyUrl(proxyValue),
      target,
      init,
      connectTimeoutMs: Math.min(timeoutMs, CREDENTIAL_CONNECT_TIMEOUT_MS),
      idleTimeoutMs: idleTimeoutFor(timeoutMs),
      dialect: CREDENTIAL_PROXY_DIALECT,
    });
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(502, "CREDENTIAL_PROXY_REQUEST_FAILED", `Request through credential proxy failed: ${detail(error)}`, "upstream_error");
  }
}

export async function providerFetchForCredential(
  env: Env,
  provider: ProviderConfig,
  credential: Credential,
  target: string | URL,
  init: RequestInit = {},
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const override = credentialProxyUrl(credential);
  if (!override) return providerFetch(env, provider, target, init, options);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 120_000);
  const url = new URL(target.toString());
  if (override.toLowerCase() === "direct" || override.toLowerCase() === "none") {
    return fetch(url.toString(), { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  }
  return credentialProxyFetch(override, url, init, timeoutMs);
}
