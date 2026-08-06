import { getProviderProxyConfig } from "./db";
import { GatewayError } from "./errors";
import { idleTimeoutFor, proxyRequest, validateProxyUrl, type ProxyDialect } from "./proxy-transport";
import type { Env, ProviderConfig, ProviderProxyConfig } from "./types";
import { classifyTransportError } from "./upstream-errors";

export { validateProxyUrl };

export interface ProviderFetchOptions {
  timeoutMs?: number;
  purpose?: "inference" | "models" | "quota" | "oauth" | "test";
  /** Preloaded by bounded batch jobs so repeated attempts do not re-read D1 proxy settings. */
  proxyConfig?: ProviderProxyConfig | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROVIDER_PROXY_DIALECT: ProxyDialect = {
  connectTimeout: (proxy, timeoutMs) => new GatewayError(504, "PROXY_CONNECT_TIMEOUT", `连接代理 ${proxy.hostname}:${proxy.port} 超时（${timeoutMs} ms）`, "upstream_error"),
  idleTimeout: (idleMs) => new GatewayError(504, "PROXY_IDLE_TIMEOUT", `代理连接在 ${idleMs} ms 内没有任何数据往来，已中断`, "upstream_error"),
  handshakeLengthInvalid: () => new GatewayError(502, "PROXY_PROTOCOL_ERROR", "代理返回的数据长度异常", "upstream_error"),
  handshakeClosed: () => new GatewayError(502, "PROXY_CONNECTION_CLOSED", "代理连接在握手完成前关闭", "upstream_error"),
  handshakeTooLarge: () => new GatewayError(502, "PROXY_PROTOCOL_ERROR", "代理握手响应过大", "upstream_error"),
  headersTooLarge: () => new GatewayError(502, "UPSTREAM_HEADERS_TOO_LARGE", "上游响应头过大", "upstream_error"),
  headersClosed: () => new GatewayError(502, "UPSTREAM_CONNECTION_CLOSED", "上游在返回完整响应头前关闭连接", "upstream_error"),
  connectRejected: (statusLine) => new GatewayError(502, "PROXY_CONNECT_REJECTED", `HTTP 代理拒绝 CONNECT：${statusLine || "无状态行"}`, "upstream_error"),
  authRejected: () => new GatewayError(502, "SOCKS_AUTH_UNSUPPORTED", "SOCKS5 代理没有接受可用的认证方式", "upstream_error"),
  authMethodUnsupported: (method) => new GatewayError(502, "SOCKS_AUTH_UNSUPPORTED", `SOCKS5 返回未知认证方式 ${method}`, "upstream_error"),
  authFailed: () => new GatewayError(502, "SOCKS_AUTH_FAILED", "SOCKS5 用户名或密码验证失败", "upstream_error"),
  proxyCredentialTooLong: () => new GatewayError(400, "PROXY_CREDENTIAL_TOO_LONG", "SOCKS5 用户名或密码过长"),
  hostTooLong: () => new GatewayError(400, "UPSTREAM_HOST_INVALID", "上游主机名过长"),
  socksConnectFailed: (code) => new GatewayError(502, "SOCKS_CONNECT_FAILED", `SOCKS5 连接上游失败，代码 ${code}`, "upstream_error"),
  socksUnknownAddress: () => new GatewayError(502, "SOCKS_PROTOCOL_ERROR", "SOCKS5 返回了未知地址类型", "upstream_error"),
  tlsNegotiationTimeout: (target, timeoutMs) => new GatewayError(504, "PROXY_TLS_TIMEOUT", `与 ${target.hostname}:${target.port || "443"} 的 TLS 协商超时（${timeoutMs} ms）`, "upstream_error"),
  tlsHandshakeFailed: (target, detail) => new GatewayError(
    502,
    "PROXY_TLS_HANDSHAKE_FAILED",
    `代理隧道已建立，但与 ${target.hostname}:${target.port || "443"} 的 TLS 握手失败：${detail}。请确认代理支持标准 CONNECT/SOCKS 隧道、不会进行 HTTPS 解密或替换证书，并允许访问该目标。`,
    "upstream_error",
  ),
  streamingBodyUnsupported: () => new GatewayError(500, "PROXY_BODY_UNSUPPORTED", "原生代理暂不支持流式请求体，请使用 JSON、表单或二进制请求体"),
  invalidStatusLine: (statusLine) => new GatewayError(502, "UPSTREAM_PROTOCOL_ERROR", `上游返回了无效状态行：${statusLine.slice(0, 200)}`, "upstream_error"),
  bodyEndedEarly: () => new Error("上游响应体提前结束"),
  chunkedEndedEarly: () => new Error("chunked 响应提前结束"),
  invalidChunkLength: (line) => new Error(`无效 chunk 长度：${line}`),
  missingChunkCrlf: () => new Error("chunk 数据后缺少 CRLF"),
};

export function hostnameMatchesProxyBypassRule(hostname: string, rule: string): boolean {
  let normalized = rule.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "*") return true;
  try {
    if (normalized.includes("://")) normalized = new URL(normalized).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (normalized.startsWith("[")) {
    const closing = normalized.indexOf("]");
    if (closing > 0) normalized = normalized.slice(1, closing);
  } else {
    const colonCount = (normalized.match(/:/g) ?? []).length;
    if (colonCount === 1 && /:\d+$/.test(normalized)) normalized = normalized.replace(/:\d+$/, "");
  }
  const candidate = normalized.replace(/^\*?\./, "");
  return hostname.toLowerCase() === candidate || hostname.toLowerCase().endsWith(`.${candidate}`);
}

function shouldBypass(config: ProviderProxyConfig, target: URL): boolean {
  return config.noProxy.some((rule) => hostnameMatchesProxyBypassRule(target.hostname.toLowerCase(), rule));
}

function isOAuthRefreshRequest(init: RequestInit, options: ProviderFetchOptions): boolean {
  if (options.purpose !== "oauth") return false;
  if (init.body instanceof URLSearchParams) return init.body.get("grant_type") === "refresh_token";
  if (typeof init.body !== "string") return false;
  try {
    return new URLSearchParams(init.body).get("grant_type") === "refresh_token";
  } catch {
    return false;
  }
}

function oauthRefreshTransportError(error: unknown, provider: ProviderConfig, timeoutMs: number): GatewayError {
  const classified = classifyTransportError(error, `${provider.name} OAuth refresh`, timeoutMs);
  return new GatewayError(classified.status, "OAUTH_REFRESH_FAILED", classified.message, "upstream_error");
}

export function isTlsHandshakeFailure(error: unknown): boolean {
  const code = error instanceof GatewayError ? error.code : "";
  return code === "PROXY_TLS_HANDSHAKE_FAILED"
    || /(?:tls|ssl).*(?:handshake|certificate)|(?:handshake|certificate).*(?:tls|ssl)/i.test(errorMessage(error));
}

async function nativeProxyFetch(config: ProviderProxyConfig, target: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return proxyRequest({
    proxy: validateProxyUrl(config.proxyUrl),
    target,
    init,
    connectTimeoutMs: Math.min(timeoutMs, config.connectTimeoutMs),
    idleTimeoutMs: idleTimeoutFor(timeoutMs),
    dialect: PROVIDER_PROXY_DIALECT,
  });
}

export async function providerFetch(
  env: Env,
  provider: ProviderConfig,
  target: string | URL,
  init: RequestInit = {},
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const url = new URL(target.toString());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayError(400, "UPSTREAM_URL_INVALID", "上游 URL 必须使用 HTTP 或 HTTPS");
  }
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 120_000);
  const config = options.proxyConfig === undefined ? await getProviderProxyConfig(env, provider.id) : options.proxyConfig;
  if (!config?.enabled || shouldBypass(config, url)) {
    try {
      return await fetch(url.toString(), { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (isOAuthRefreshRequest(init, options)) throw oauthRefreshTransportError(error, provider, timeoutMs);
      throw error;
    }
  }
  if (!config.proxyUrl) throw new GatewayError(500, "PROXY_URL_MISSING", `供应商 ${provider.name} 已启用代理，但代理 URL 为空`);
  try {
    return await nativeProxyFetch(config, url, init, timeoutMs);
  } catch (error) {
    if (isOAuthRefreshRequest(init, options)) throw oauthRefreshTransportError(error, provider, timeoutMs);
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(502, "PROXY_REQUEST_FAILED", `${provider.name} 通过代理请求失败：${errorMessage(error)}`, "upstream_error");
  }
}

function readIpPayload(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["ip", "origin", "address"]) if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  return undefined;
}

async function readIpResponse(response: Response): Promise<string | undefined> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return readIpPayload(JSON.parse(text));
  } catch {
    return readIpPayload(text);
  }
}

export async function testProviderProxy(env: Env, provider: ProviderConfig): Promise<Record<string, unknown>> {
  const config = await getProviderProxyConfig(env, provider.id);
  if (!config?.enabled) throw new GatewayError(400, "PROXY_DISABLED", "该供应商尚未启用代理");
  const startedAt = Date.now();
  const httpsIpUrl = "https://api.ipify.org?format=json";
  const httpIpUrl = "http://api.ipify.org?format=json";
  const directPromise = fetch(httpsIpUrl, { signal: AbortSignal.timeout(15_000) })
    .then(readIpResponse)
    .catch(() => undefined);

  let proxied: Response;
  let httpsReady = true;
  let tlsError: string | undefined;
  try {
    proxied = await providerFetch(env, provider, httpsIpUrl, { method: "GET", headers: { accept: "application/json" } }, {
      purpose: "test",
      timeoutMs: Math.min(config.requestTimeoutMs, 30_000),
    });
  } catch (error) {
    if (!isTlsHandshakeFailure(error)) throw error;
    httpsReady = false;
    tlsError = errorMessage(error);
    try {
      proxied = await providerFetch(env, provider, httpIpUrl, { method: "GET", headers: { accept: "application/json" } }, {
        purpose: "test",
        timeoutMs: Math.min(config.requestTimeoutMs, 30_000),
      });
    } catch (fallbackError) {
      throw new GatewayError(
        502,
        "PROXY_TEST_FAILED",
        `${tlsError}；HTTP 出口诊断也失败：${errorMessage(fallbackError)}`,
        "upstream_error",
      );
    }
  }

  if (!proxied.ok) throw new GatewayError(502, "PROXY_TEST_FAILED", `代理出口检测返回 HTTP ${proxied.status}`, "upstream_error");
  const [directIp, exitIp] = await Promise.all([directPromise, readIpResponse(proxied)]);
  if (!exitIp) throw new GatewayError(502, "PROXY_TEST_INVALID", "代理出口检测没有返回 IP 地址", "upstream_error");

  const sameExit = directIp ? directIp === exitIp : false;
  const warning = !httpsReady
    ? "已通过 HTTP 确认代理出口，但 HTTPS 隧道的 TLS 握手失败。该代理目前不能用于模型、OAuth、额度等 HTTPS 上游；请改用不拦截 TLS 的标准 CONNECT/SOCKS5 代理。"
    : sameExit
      ? "代理出口 IP 与 Worker 直连出口相同，请检查代理是否真的改变了出口。"
      : undefined;

  return {
    ok: httpsReady,
    providerId: provider.id,
    latencyMs: Date.now() - startedAt,
    proxyApplied: true,
    directIp,
    exitIp,
    ipChanged: directIp ? !sameExit : undefined,
    httpsReady,
    testTransport: httpsReady ? "https" : "http",
    tlsError,
    warning,
    proxyProtocol: validateProxyUrl(config.proxyUrl).protocol.replace(/:$/, ""),
  };
}

export async function testSystemProxy(env: Env): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  const provider: ProviderConfig = {
    id: "__system_proxy_test__",
    name: "系统代理",
    kind: "openai-compatible",
    base_url: "https://api.ipify.org",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: now,
    updated_at: now,
    endpoints: {},
    auth: {},
    headers: {},
    options: {},
  };
  return testProviderProxy(env, provider);
}
