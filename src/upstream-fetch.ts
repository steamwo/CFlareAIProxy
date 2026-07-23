import { connect } from "cloudflare:sockets";
import { getProviderProxyConfig } from "./db";
import { GatewayError } from "./errors";
import type { Env, ProviderConfig, ProviderProxyConfig, ProxyProtocol } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CRLF = encoder.encode("\r\n");
const HEADER_END = encoder.encode("\r\n\r\n");
const NATIVE_PROXY_PROTOCOLS = new Set<ProxyProtocol>(["http", "socks", "socks5", "socks5h"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

export interface ProviderFetchOptions {
  timeoutMs?: number;
  purpose?: "inference" | "models" | "quota" | "oauth" | "test";
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.byteLength - needle.byteLength; index += 1) {
    for (let cursor = 0; cursor < needle.byteLength; cursor += 1) {
      if (haystack[index + cursor] !== needle[cursor]) continue outer;
    }
    return index;
  }
  return -1;
}

class SocketReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffered: Uint8Array = new Uint8Array();

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  release(): void {
    this.reader.releaseLock();
  }

  async readSome(): Promise<Uint8Array | null> {
    if (this.buffered.byteLength) {
      const value = this.buffered;
      this.buffered = new Uint8Array();
      return value;
    }
    const result = await this.reader.read();
    return result.done ? null : result.value;
  }

  prepend(value: Uint8Array): void {
    if (value.byteLength) this.buffered = concatBytes([value, this.buffered]);
  }

  async readAtMost(length: number): Promise<Uint8Array | null> {
    if (length <= 0) return new Uint8Array();
    const value = await this.readSome();
    if (!value || value.byteLength <= length) return value;
    this.prepend(value.slice(length));
    return value.slice(0, length);
  }

  async readExact(length: number, maxBytes = 64 * 1024): Promise<Uint8Array> {
    if (length < 0 || length > maxBytes) throw new GatewayError(502, "PROXY_PROTOCOL_ERROR", "代理返回的数据长度异常", "upstream_error");
    while (this.buffered.byteLength < length) {
      const result = await this.reader.read();
      if (result.done) throw new GatewayError(502, "PROXY_CONNECTION_CLOSED", "代理连接在握手完成前关闭", "upstream_error");
      this.buffered = concatBytes([this.buffered, result.value]);
      if (this.buffered.byteLength > maxBytes) throw new GatewayError(502, "PROXY_PROTOCOL_ERROR", "代理握手响应过大", "upstream_error");
    }
    const output = this.buffered.slice(0, length);
    this.buffered = this.buffered.slice(length);
    return output;
  }

  async readUntil(marker: Uint8Array, maxBytes = 64 * 1024): Promise<Uint8Array> {
    while (true) {
      const index = indexOfBytes(this.buffered, marker);
      if (index >= 0) {
        const end = index + marker.byteLength;
        const output = this.buffered.slice(0, end);
        this.buffered = this.buffered.slice(end);
        return output;
      }
      if (this.buffered.byteLength >= maxBytes) throw new GatewayError(502, "UPSTREAM_HEADERS_TOO_LARGE", "上游响应头过大", "upstream_error");
      const result = await this.reader.read();
      if (result.done) throw new GatewayError(502, "UPSTREAM_CONNECTION_CLOSED", "上游在返回完整响应头前关闭连接", "upstream_error");
      this.buffered = concatBytes([this.buffered, result.value]);
    }
  }
}

export function validateProxyUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new GatewayError(400, "PROXY_URL_INVALID", "代理 URL 格式无效"); }
  const protocol = url.protocol.replace(/:$/, "") as ProxyProtocol;
  if (!NATIVE_PROXY_PROTOCOLS.has(protocol)) {
    if (protocol === "https") {
      throw new GatewayError(400, "PROXY_PROTOCOL_UNSUPPORTED", "HTTPS 目标仍应填写 http:// 代理地址；当前原生代理支持 http://、socks5:// 和 socks5h://");
    }
    throw new GatewayError(400, "PROXY_PROTOCOL_UNSUPPORTED", "代理协议仅支持 http://、socks5:// 和 socks5h://");
  }
  if (!url.hostname) throw new GatewayError(400, "PROXY_URL_INVALID", "代理 URL 必须包含主机");
  if (!url.port) url.port = protocol === "http" ? "8080" : "1080";
  return url;
}

export function validateBridgeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new GatewayError(400, "PROXY_BRIDGE_URL_INVALID", "代理桥接地址格式无效"); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new GatewayError(400, "PROXY_BRIDGE_URL_INVALID", "旧版 Bridge 的远程地址必须使用 HTTPS");
  }
  return url;
}

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

function basicAuthorization(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined;
  return `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`;
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof URLSearchParams) return encoder.encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ReadableStream) {
    throw new GatewayError(500, "PROXY_BODY_UNSUPPORTED", "原生代理暂不支持流式请求体，请使用 JSON、表单或二进制请求体");
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function openSocket(hostname: string, port: number, secureTransport: "off" | "on" | "starttls", timeoutMs: number): Promise<Socket> {
  const socket = connect({ hostname, port }, { secureTransport, allowHalfOpen: true });
  const timer = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new GatewayError(504, "PROXY_CONNECT_TIMEOUT", `连接代理 ${hostname}:${port} 超时`, "upstream_error")), timeoutMs);
    socket.opened.finally(() => clearTimeout(id)).catch(() => undefined);
  });
  try {
    await Promise.race([socket.opened, timer]);
    socket.closed.catch(() => undefined);
    return socket;
  } catch (error) {
    await socket.close().catch(() => undefined);
    throw error;
  }
}

async function writeBytes(socket: Socket, bytes: Uint8Array): Promise<void> {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

async function httpConnect(socket: Socket, reader: SocketReader, target: URL, proxy: URL): Promise<void> {
  const authority = `${target.hostname}:${target.port || (target.protocol === "https:" ? "443" : "80")}`;
  const headers = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    "Proxy-Connection: keep-alive",
  ];
  const auth = basicAuthorization(proxy);
  if (auth) headers.push(`Proxy-Authorization: ${auth}`);
  await writeBytes(socket, encoder.encode(`${headers.join("\r\n")}\r\n\r\n`));
  const raw = decoder.decode(await reader.readUntil(HEADER_END));
  const first = raw.split("\r\n", 1)[0] ?? "";
  const status = Number.parseInt(first.split(/\s+/)[1] ?? "0", 10);
  if (status < 200 || status >= 300) {
    throw new GatewayError(502, "PROXY_CONNECT_REJECTED", `HTTP 代理拒绝 CONNECT：${first || "无状态行"}`, "upstream_error");
  }
}

async function socks5Connect(socket: Socket, reader: SocketReader, target: URL, proxy: URL): Promise<void> {
  const username = decodeURIComponent(proxy.username || "");
  const password = decodeURIComponent(proxy.password || "");
  const methods = username || password ? [0x00, 0x02] : [0x00];
  await writeBytes(socket, new Uint8Array([0x05, methods.length, ...methods]));
  const hello = await reader.readExact(2);
  if (hello[0] !== 0x05 || hello[1] === 0xff) throw new GatewayError(502, "SOCKS_AUTH_UNSUPPORTED", "SOCKS5 代理没有接受可用的认证方式", "upstream_error");
  if (hello[1] === 0x02) {
    const user = encoder.encode(username);
    const pass = encoder.encode(password);
    if (user.byteLength > 255 || pass.byteLength > 255) throw new GatewayError(400, "PROXY_CREDENTIAL_TOO_LONG", "SOCKS5 用户名或密码过长");
    await writeBytes(socket, new Uint8Array([0x01, user.byteLength, ...user, pass.byteLength, ...pass]));
    const auth = await reader.readExact(2);
    if (auth[1] !== 0x00) throw new GatewayError(502, "SOCKS_AUTH_FAILED", "SOCKS5 用户名或密码验证失败", "upstream_error");
  } else if (hello[1] !== 0x00) {
    throw new GatewayError(502, "SOCKS_AUTH_UNSUPPORTED", `SOCKS5 返回未知认证方式 ${hello[1]}`, "upstream_error");
  }

  const host = encoder.encode(target.hostname);
  if (host.byteLength > 255) throw new GatewayError(400, "UPSTREAM_HOST_INVALID", "上游主机名过长");
  const port = Number.parseInt(target.port || (target.protocol === "https:" ? "443" : "80"), 10);
  await writeBytes(socket, new Uint8Array([0x05, 0x01, 0x00, 0x03, host.byteLength, ...host, (port >> 8) & 0xff, port & 0xff]));
  const head = await reader.readExact(4);
  if (head[0] !== 0x05 || head[1] !== 0x00) throw new GatewayError(502, "SOCKS_CONNECT_FAILED", `SOCKS5 连接上游失败，代码 ${head[1]}`, "upstream_error");
  const addressLength = head[3] === 0x01 ? 4 : head[3] === 0x04 ? 16 : head[3] === 0x03 ? (await reader.readExact(1))[0]! : -1;
  if (addressLength < 0) throw new GatewayError(502, "SOCKS_PROTOCOL_ERROR", "SOCKS5 返回了未知地址类型", "upstream_error");
  await reader.readExact(addressLength + 2);
}

function requestHeaders(target: URL, init: RequestInit, body: Uint8Array, absoluteForm: boolean, proxy?: URL): Uint8Array {
  const method = (init.method ?? "GET").toUpperCase();
  const path = absoluteForm ? target.toString() : `${target.pathname || "/"}${target.search}`;
  const headers = new Headers(init.headers);
  for (const key of HOP_BY_HOP_HEADERS) headers.delete(key);
  headers.set("host", target.host);
  headers.set("connection", "close");
  if (body.byteLength) headers.set("content-length", String(body.byteLength));
  else if (method === "POST" || method === "PUT" || method === "PATCH") headers.set("content-length", "0");
  if (absoluteForm && proxy) {
    const auth = basicAuthorization(proxy);
    if (auth) headers.set("proxy-authorization", auth);
  }
  const lines = [`${method} ${path} HTTP/1.1`];
  headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  return concatBytes([encoder.encode(`${lines.join("\r\n")}\r\n\r\n`), body]);
}

function parseResponseHeaders(raw: Uint8Array): { status: number; statusText: string; headers: Headers } {
  const text = decoder.decode(raw);
  const lines = text.slice(0, -4).split("\r\n");
  const statusLine = lines.shift() ?? "";
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i);
  if (!match) throw new GatewayError(502, "UPSTREAM_PROTOCOL_ERROR", `上游返回了无效状态行：${statusLine.slice(0, 200)}`, "upstream_error");
  const headers = new Headers();
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return { status: Number.parseInt(match[1]!, 10), statusText: match[2] ?? "", headers };
}

function closeSocket(socket: Socket): void {
  void socket.close().catch(() => undefined);
}

function fixedLengthBody(reader: SocketReader, socket: Socket, length: number): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) { controller.close(); closeSocket(socket); return; }
      const chunk = await reader.readSome();
      if (!chunk) { controller.error(new Error("上游响应体提前结束")); closeSocket(socket); return; }
      if (chunk.byteLength <= remaining) {
        controller.enqueue(chunk);
        remaining -= chunk.byteLength;
      } else {
        controller.enqueue(chunk.slice(0, remaining));
        remaining = 0;
      }
      if (remaining === 0) { controller.close(); closeSocket(socket); }
    },
    cancel() { closeSocket(socket); },
  });
}

function untilCloseBody(reader: SocketReader, socket: Socket): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.readSome();
      if (chunk) controller.enqueue(chunk);
      else { controller.close(); closeSocket(socket); }
    },
    cancel() { closeSocket(socket); },
  });
}

function chunkedBody(reader: SocketReader, socket: Socket): ReadableStream<Uint8Array> {
  let remaining = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (finished) return;
        if (remaining === 0) {
          const line = decoder.decode(await reader.readUntil(CRLF, 16 * 1024)).slice(0, -2).trim();
          const size = Number.parseInt(line.split(";", 1)[0] ?? "", 16);
          if (!Number.isFinite(size) || size < 0) throw new Error(`无效 chunk 长度：${line}`);
          if (size === 0) {
            while (true) {
              const trailer = await reader.readUntil(CRLF, 64 * 1024);
              if (trailer.byteLength === 2) break;
            }
            finished = true;
            controller.close();
            closeSocket(socket);
            return;
          }
          remaining = size;
        }
        const chunk = await reader.readAtMost(remaining);
        if (!chunk) throw new Error("chunked 响应提前结束");
        controller.enqueue(chunk);
        remaining -= chunk.byteLength;
        if (remaining === 0) {
          const suffix = await reader.readExact(2);
          if (suffix[0] !== 13 || suffix[1] !== 10) throw new Error("chunk 数据后缺少 CRLF");
        }
      } catch (error) {
        controller.error(error);
        closeSocket(socket);
      }
    },
    cancel() { closeSocket(socket); },
  });
}

async function nativeProxyFetch(config: ProviderProxyConfig, target: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const proxy = validateProxyUrl(config.proxyUrl);
  const protocol = proxy.protocol.replace(/:$/, "") as ProxyProtocol;
  let socket = await openSocket(
    proxy.hostname,
    Number.parseInt(proxy.port, 10),
    target.protocol === "https:" ? "starttls" : "off",
    Math.min(timeoutMs, config.connectTimeoutMs),
  );
  let reader = new SocketReader(socket.readable);
  const tunneled = protocol !== "http" || target.protocol === "https:";

  try {
    if (protocol === "http" && target.protocol === "https:") await httpConnect(socket, reader, target, proxy);
    else if (protocol !== "http") await socks5Connect(socket, reader, target, proxy);

    if (target.protocol === "https:") {
      reader.release();
      socket = socket.startTls({ expectedServerHostname: target.hostname });
      await socket.opened;
      socket.closed.catch(() => undefined);
      reader = new SocketReader(socket.readable);
    }

    const body = await bodyBytes(init.body);
    await writeBytes(socket, requestHeaders(target, init, body, protocol === "http" && !tunneled, proxy));
    const rawHeaders = await reader.readUntil(HEADER_END, 128 * 1024);
    const parsed = parseResponseHeaders(rawHeaders);
    const headers = new Headers(parsed.headers);
    const method = (init.method ?? "GET").toUpperCase();
    const noBody = method === "HEAD" || parsed.status === 204 || parsed.status === 304 || (parsed.status >= 100 && parsed.status < 200);
    let responseBody: ReadableStream<Uint8Array> | null = null;
    if (!noBody) {
      const transferEncoding = headers.get("transfer-encoding")?.toLowerCase() ?? "";
      const contentLength = Number.parseInt(headers.get("content-length") ?? "", 10);
      if (transferEncoding.includes("chunked")) {
        headers.delete("transfer-encoding");
        headers.delete("content-length");
        responseBody = chunkedBody(reader, socket);
      } else if (Number.isFinite(contentLength) && contentLength >= 0) {
        responseBody = fixedLengthBody(reader, socket, contentLength);
      } else {
        responseBody = untilCloseBody(reader, socket);
      }
    } else {
      closeSocket(socket);
    }
    headers.delete("connection");
    headers.delete("proxy-connection");
    return new Response(responseBody, { status: parsed.status, statusText: parsed.statusText, headers });
  } catch (error) {
    closeSocket(socket);
    throw error;
  }
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
  const config = await getProviderProxyConfig(env, provider.id);
  if (!config?.enabled || shouldBypass(config, url)) {
    return fetch(url.toString(), { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  }
  if (!config.proxyUrl) throw new GatewayError(500, "PROXY_URL_MISSING", `供应商 ${provider.name} 已启用代理，但代理 URL 为空`);
  try {
    return await nativeProxyFetch(config, url, init, timeoutMs);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(502, "PROXY_REQUEST_FAILED", `${provider.name} 通过代理请求失败：${error instanceof Error ? error.message : String(error)}`, "upstream_error");
  }
}

function readIpPayload(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["ip", "origin", "address"]) if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  return undefined;
}

export async function testProviderProxy(env: Env, provider: ProviderConfig): Promise<Record<string, unknown>> {
  const config = await getProviderProxyConfig(env, provider.id);
  if (!config?.enabled) throw new GatewayError(400, "PROXY_DISABLED", "该供应商尚未启用代理");
  const startedAt = Date.now();
  const ipUrl = "https://api.ipify.org?format=json";
  const [directResult, proxied] = await Promise.all([
    fetch(ipUrl, { signal: AbortSignal.timeout(15_000) }).then((response) => response.json()).catch(() => null),
    providerFetch(env, provider, ipUrl, { method: "GET", headers: { accept: "application/json" } }, {
      purpose: "test",
      timeoutMs: Math.min(config.requestTimeoutMs, 30_000),
    }),
  ]);
  const payload = await proxied.json().catch(() => null);
  if (!proxied.ok) throw new GatewayError(502, "PROXY_TEST_FAILED", `代理出口检测返回 HTTP ${proxied.status}`, "upstream_error");
  const directIp = readIpPayload(directResult);
  const exitIp = readIpPayload(payload);
  if (!exitIp) throw new GatewayError(502, "PROXY_TEST_INVALID", "代理出口检测没有返回 IP 地址", "upstream_error");
  return {
    ok: true,
    providerId: provider.id,
    latencyMs: Date.now() - startedAt,
    proxyApplied: true,
    directIp,
    exitIp,
    ipChanged: directIp ? directIp !== exitIp : undefined,
    warning: directIp && directIp === exitIp ? "代理出口 IP 与 Worker 直连出口相同，请检查代理是否真的改变了出口。" : undefined,
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
