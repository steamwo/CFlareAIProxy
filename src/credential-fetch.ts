import { connect } from "cloudflare:sockets";
import { GatewayError } from "./errors";
import type { Credential, Env, ProviderConfig, ProxyProtocol } from "./types";
import { providerFetch, validateProxyUrl, type ProviderFetchOptions } from "./upstream-fetch";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_END = encoder.encode("\r\n\r\n");
const CRLF = encoder.encode("\r\n");
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

function concat(chunks: ReadonlyArray<Uint8Array<ArrayBufferLike>>): Uint8Array<ArrayBuffer> {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= haystack.byteLength - needle.byteLength; index += 1) {
    for (let cursor = 0; cursor < needle.byteLength; cursor += 1) if (haystack[index + cursor] !== needle[cursor]) continue outer;
    return index;
  }
  return -1;
}

class Reader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = new Uint8Array();

  constructor(stream: ReadableStream<Uint8Array>) { this.reader = stream.getReader(); }
  release(): void { this.reader.releaseLock(); }
  prepend(value: Uint8Array): void { if (value.byteLength) this.buffer = concat([value, this.buffer]); }

  async some(): Promise<Uint8Array | null> {
    if (this.buffer.byteLength) { const value = this.buffer; this.buffer = new Uint8Array(); return value; }
    const result = await this.reader.read();
    return result.done ? null : result.value;
  }

  async atMost(length: number): Promise<Uint8Array | null> {
    const value = await this.some();
    if (!value || value.byteLength <= length) return value;
    this.prepend(value.slice(length));
    return value.slice(0, length);
  }

  async exact(length: number, maxBytes = 64 * 1024): Promise<Uint8Array> {
    if (length < 0 || length > maxBytes) throw new GatewayError(502, "CREDENTIAL_PROXY_PROTOCOL_ERROR", "Credential proxy returned an invalid response length", "upstream_error");
    while (this.buffer.byteLength < length) {
      const result = await this.reader.read();
      if (result.done) throw new GatewayError(502, "CREDENTIAL_PROXY_CLOSED", "Credential proxy closed during handshake", "upstream_error");
      this.buffer = concat([this.buffer, result.value]);
      if (this.buffer.byteLength > maxBytes) throw new GatewayError(502, "CREDENTIAL_PROXY_PROTOCOL_ERROR", "Credential proxy handshake response was too large", "upstream_error");
    }
    const output = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return output;
  }

  async until(marker: Uint8Array, maxBytes = 128 * 1024): Promise<Uint8Array> {
    while (true) {
      const offset = indexOf(this.buffer, marker);
      if (offset >= 0) {
        const end = offset + marker.byteLength;
        const output = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        return output;
      }
      if (this.buffer.byteLength >= maxBytes) throw new GatewayError(502, "UPSTREAM_HEADERS_TOO_LARGE", "Upstream response headers were too large", "upstream_error");
      const result = await this.reader.read();
      if (result.done) throw new GatewayError(502, "UPSTREAM_CONNECTION_CLOSED", "Upstream closed before returning complete headers", "upstream_error");
      this.buffer = concat([this.buffer, result.value]);
    }
  }
}

export function credentialProxyUrl(credential: Credential): string | undefined {
  const value = credential.metadata.proxy_url ?? credential.metadata.proxyUrl;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function proxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  return `Basic ${btoa(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`)}`;
}

async function requestBody(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof URLSearchParams) return encoder.encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ReadableStream) throw new GatewayError(500, "CREDENTIAL_PROXY_BODY_UNSUPPORTED", "Credential proxy does not support streaming request bodies", "upstream_error");
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function openProxySocket(proxy: URL, target: URL, timeoutMs: number): Promise<Socket> {
  const socket = connect(
    { hostname: proxy.hostname, port: Number.parseInt(proxy.port, 10) },
    { secureTransport: target.protocol === "https:" ? "starttls" : "off", allowHalfOpen: true },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      socket.opened,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new GatewayError(504, "CREDENTIAL_PROXY_CONNECT_TIMEOUT", `Connecting to credential proxy ${proxy.host} timed out`, "upstream_error")), timeoutMs); }),
    ]);
    socket.closed.catch(() => undefined);
    return socket;
  } catch (error) {
    await socket.close().catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function write(socket: Socket, value: Uint8Array): Promise<void> {
  const writer = socket.writable.getWriter();
  try { await writer.write(value); } finally { writer.releaseLock(); }
}

async function httpConnect(socket: Socket, reader: Reader, target: URL, proxy: URL): Promise<void> {
  const authority = `${target.hostname}:${target.port || "443"}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Proxy-Connection: keep-alive"];
  const authorization = proxyAuthorization(proxy);
  if (authorization) lines.push(`Proxy-Authorization: ${authorization}`);
  await write(socket, encoder.encode(`${lines.join("\r\n")}\r\n\r\n`));
  const response = decoder.decode(await reader.until(HEADER_END));
  const first = response.split("\r\n", 1)[0] ?? "";
  const status = Number.parseInt(first.split(/\s+/)[1] ?? "0", 10);
  if (status < 200 || status >= 300) throw new GatewayError(502, "CREDENTIAL_PROXY_CONNECT_REJECTED", `Credential HTTP proxy rejected CONNECT: ${first || "missing status"}`, "upstream_error");
}

async function socksConnect(socket: Socket, reader: Reader, target: URL, proxy: URL): Promise<void> {
  const username = decodeURIComponent(proxy.username || "");
  const password = decodeURIComponent(proxy.password || "");
  const methods = username || password ? [0, 2] : [0];
  await write(socket, new Uint8Array([5, methods.length, ...methods]));
  const hello = await reader.exact(2);
  if (hello[0] !== 5 || hello[1] === 255) throw new GatewayError(502, "CREDENTIAL_PROXY_AUTH_UNSUPPORTED", "Credential SOCKS5 proxy rejected all authentication methods", "upstream_error");
  if (hello[1] === 2) {
    const user = encoder.encode(username);
    const pass = encoder.encode(password);
    if (user.byteLength > 255 || pass.byteLength > 255) throw new GatewayError(400, "CREDENTIAL_PROXY_CREDENTIAL_TOO_LONG", "Credential proxy username or password is too long");
    await write(socket, new Uint8Array([1, user.byteLength, ...user, pass.byteLength, ...pass]));
    const auth = await reader.exact(2);
    if (auth[1] !== 0) throw new GatewayError(502, "CREDENTIAL_PROXY_AUTH_FAILED", "Credential SOCKS5 authentication failed", "upstream_error");
  } else if (hello[1] !== 0) {
    throw new GatewayError(502, "CREDENTIAL_PROXY_AUTH_UNSUPPORTED", `Credential SOCKS5 proxy returned authentication method ${hello[1]}`, "upstream_error");
  }
  const host = encoder.encode(target.hostname);
  if (host.byteLength > 255) throw new GatewayError(400, "UPSTREAM_HOST_INVALID", "Upstream hostname is too long");
  const port = Number.parseInt(target.port || (target.protocol === "https:" ? "443" : "80"), 10);
  await write(socket, new Uint8Array([5, 1, 0, 3, host.byteLength, ...host, (port >> 8) & 255, port & 255]));
  const head = await reader.exact(4);
  if (head[0] !== 5 || head[1] !== 0) throw new GatewayError(502, "CREDENTIAL_PROXY_CONNECT_FAILED", `Credential SOCKS5 proxy failed to connect, code ${head[1]}`, "upstream_error");
  const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await reader.exact(1))[0]! : -1;
  if (addressLength < 0) throw new GatewayError(502, "CREDENTIAL_PROXY_PROTOCOL_ERROR", "Credential SOCKS5 proxy returned an unknown address type", "upstream_error");
  await reader.exact(addressLength + 2);
}

function encodedRequest(target: URL, init: RequestInit, body: Uint8Array, absolute: boolean, proxy: URL): Uint8Array {
  const method = (init.method ?? "GET").toUpperCase();
  const path = absolute ? target.toString() : `${target.pathname || "/"}${target.search}`;
  const headers = new Headers(init.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.set("host", target.host);
  headers.set("connection", "close");
  if (body.byteLength) headers.set("content-length", String(body.byteLength));
  else if (["POST", "PUT", "PATCH"].includes(method)) headers.set("content-length", "0");
  if (absolute) {
    const authorization = proxyAuthorization(proxy);
    if (authorization) headers.set("proxy-authorization", authorization);
  }
  const lines = [`${method} ${path} HTTP/1.1`];
  headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  return concat([encoder.encode(`${lines.join("\r\n")}\r\n\r\n`), body]);
}

function parsedHeaders(raw: Uint8Array): { status: number; statusText: string; headers: Headers } {
  const lines = decoder.decode(raw).slice(0, -4).split("\r\n");
  const statusLine = lines.shift() ?? "";
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i);
  if (!match) throw new GatewayError(502, "UPSTREAM_PROTOCOL_ERROR", `Upstream returned an invalid status line: ${statusLine.slice(0, 200)}`, "upstream_error");
  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator > 0) headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { status: Number.parseInt(match[1]!, 10), statusText: match[2] ?? "", headers };
}

function close(socket: Socket): void { void socket.close().catch(() => undefined); }

function fixedBody(reader: Reader, socket: Socket, length: number): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream({
    async pull(controller) {
      if (remaining <= 0) { controller.close(); close(socket); return; }
      const chunk = await reader.some();
      if (!chunk) { controller.error(new Error("Upstream response ended early")); close(socket); return; }
      const value = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      controller.enqueue(value);
      remaining -= value.byteLength;
      if (remaining === 0) { controller.close(); close(socket); }
    },
    cancel() { close(socket); },
  });
}

function closeBody(reader: Reader, socket: Socket): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) { const chunk = await reader.some(); if (chunk) controller.enqueue(chunk); else { controller.close(); close(socket); } },
    cancel() { close(socket); },
  });
}

function chunkedBody(reader: Reader, socket: Socket): ReadableStream<Uint8Array> {
  let remaining = 0;
  let finished = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        if (finished) return;
        if (remaining === 0) {
          const line = decoder.decode(await reader.until(CRLF, 16 * 1024)).slice(0, -2).trim();
          const size = Number.parseInt(line.split(";", 1)[0] ?? "", 16);
          if (!Number.isFinite(size) || size < 0) throw new Error(`Invalid chunk length: ${line}`);
          if (size === 0) {
            while ((await reader.until(CRLF, 64 * 1024)).byteLength !== 2) { /* consume trailers */ }
            finished = true; controller.close(); close(socket); return;
          }
          remaining = size;
        }
        const chunk = await reader.atMost(remaining);
        if (!chunk) throw new Error("Chunked response ended early");
        controller.enqueue(chunk);
        remaining -= chunk.byteLength;
        if (remaining === 0) {
          const suffix = await reader.exact(2);
          if (suffix[0] !== 13 || suffix[1] !== 10) throw new Error("Chunk data was not followed by CRLF");
        }
      } catch (error) { controller.error(error); close(socket); }
    },
    cancel() { close(socket); },
  });
}

async function credentialProxyFetch(proxyValue: string, target: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const proxy = validateProxyUrl(proxyValue);
  const protocol = proxy.protocol.replace(/:$/, "") as ProxyProtocol;
  let socket = await openProxySocket(proxy, target, Math.min(timeoutMs, 20_000));
  let reader = new Reader(socket.readable);
  const tunneled = protocol !== "http" || target.protocol === "https:";
  try {
    if (protocol === "http" && target.protocol === "https:") await httpConnect(socket, reader, target, proxy);
    else if (protocol !== "http") await socksConnect(socket, reader, target, proxy);
    if (target.protocol === "https:") {
      reader.release();
      try {
        socket = socket.startTls({ expectedServerHostname: target.hostname });
        await socket.opened;
        socket.closed.catch(() => undefined);
        reader = new Reader(socket.readable);
      } catch (error) {
        throw new GatewayError(502, "CREDENTIAL_PROXY_TLS_HANDSHAKE_FAILED", `Credential proxy tunnel was established, but TLS handshake with ${target.hostname}:${target.port || "443"} failed: ${error instanceof Error ? error.message : String(error)}`, "upstream_error");
      }
    }
    const body = await requestBody(init.body);
    await write(socket, encodedRequest(target, init, body, protocol === "http" && !tunneled, proxy));
    const parsed = parsedHeaders(await reader.until(HEADER_END));
    const headers = new Headers(parsed.headers);
    const method = (init.method ?? "GET").toUpperCase();
    const noBody = method === "HEAD" || parsed.status === 204 || parsed.status === 304 || (parsed.status >= 100 && parsed.status < 200);
    let responseBody: ReadableStream<Uint8Array> | null = null;
    if (!noBody) {
      const transfer = headers.get("transfer-encoding")?.toLowerCase() ?? "";
      const length = Number.parseInt(headers.get("content-length") ?? "", 10);
      if (transfer.includes("chunked")) { headers.delete("transfer-encoding"); headers.delete("content-length"); responseBody = chunkedBody(reader, socket); }
      else if (Number.isFinite(length) && length >= 0) responseBody = fixedBody(reader, socket, length);
      else responseBody = closeBody(reader, socket);
    } else close(socket);
    headers.delete("connection");
    headers.delete("proxy-connection");
    return new Response(responseBody, { status: parsed.status, statusText: parsed.statusText, headers });
  } catch (error) {
    close(socket);
    throw error instanceof GatewayError ? error : new GatewayError(502, "CREDENTIAL_PROXY_REQUEST_FAILED", `Request through credential proxy failed: ${error instanceof Error ? error.message : String(error)}`, "upstream_error");
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
