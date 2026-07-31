import { connect } from "cloudflare:sockets";
import { GatewayError } from "./errors";
import type { ProxyProtocol } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CRLF = encoder.encode("\r\n");
const HEADER_END = encoder.encode("\r\n\r\n");
const NATIVE_PROXY_PROTOCOLS = new Set<ProxyProtocol>(["http", "socks", "socks4", "socks4a", "socks5", "socks5h"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

const HANDSHAKE_MAX_BYTES = 64 * 1024;
const RESPONSE_HEADER_MAX_BYTES = 128 * 1024;
const CHUNK_HEADER_MAX_BYTES = 16 * 1024;
const CHUNK_TRAILER_MAX_BYTES = 64 * 1024;

/**
 * The native proxy path must not use a total-duration deadline: a healthy
 * streaming completion legitimately keeps one socket open for many minutes,
 * and a total deadline would kill long conversations that are working fine.
 * We bound the gap between two consecutive socket operations instead, so a
 * stalled tunnel is torn down within one idle window rather than pinning an
 * AccountPool / RateLimiter lease until its 15 minute TTL expires.
 *
 * The window defaults to the caller's request timeout (120 s for inference,
 * 20-30 s for models/quota/oauth) clamped into [30 s, 300 s]: every supported
 * upstream emits deltas or heartbeats far more often than every 30 s, while
 * the upper bound keeps a hung tunnel from outliving the lease TTL.
 */
export const MIN_IDLE_TIMEOUT_MS = 30_000;
export const MAX_IDLE_TIMEOUT_MS = 300_000;

export function idleTimeoutFor(timeoutMs: number): number {
  return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, timeoutMs));
}

/**
 * Per-caller error vocabulary. The two proxy entry points share this transport
 * but keep their own error codes and message language.
 */
export interface ProxyDialect {
  connectTimeout(proxy: URL, timeoutMs: number): GatewayError;
  idleTimeout(idleMs: number): GatewayError;
  handshakeLengthInvalid(): GatewayError;
  handshakeClosed(): GatewayError;
  handshakeTooLarge(): GatewayError;
  headersTooLarge(): GatewayError;
  headersClosed(): GatewayError;
  connectRejected(statusLine: string): GatewayError;
  authRejected(): GatewayError;
  authMethodUnsupported(method: number | undefined): GatewayError;
  authFailed(): GatewayError;
  proxyCredentialTooLong(): GatewayError;
  hostTooLong(): GatewayError;
  socksConnectFailed(code: number | undefined): GatewayError;
  socksUnknownAddress(): GatewayError;
  tlsNegotiationTimeout(target: URL, timeoutMs: number): GatewayError;
  tlsHandshakeFailed(target: URL, detail: string): GatewayError;
  streamingBodyUnsupported(): GatewayError;
  invalidStatusLine(statusLine: string): GatewayError;
  bodyEndedEarly(): Error;
  chunkedEndedEarly(): Error;
  invalidChunkLength(line: string): Error;
  missingChunkCrlf(): Error;
}

export function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  if (first === undefined) return Math.min(Math.max(from, 0), haystack.byteLength);
  const limit = haystack.byteLength - needle.byteLength;
  outer: for (let index = Math.max(from, 0); index <= limit; index += 1) {
    if (haystack[index] !== first) continue;
    for (let cursor = 1; cursor < needle.byteLength; cursor += 1) {
      if (haystack[index + cursor] !== needle[cursor]) continue outer;
    }
    return index;
  }
  return -1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bounds a single socket operation. On timeout the pending operation keeps a
 * no-op rejection handler so tearing the socket down does not surface as an
 * unhandled rejection.
 */
async function withIdleDeadline<T>(operation: Promise<T>, timeoutMs: number, expire: () => GatewayError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expire()), timeoutMs); }),
    ]);
  } catch (error) {
    operation.catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Append-oriented byte buffer with amortized O(1) appends and O(1) consumption. */
class ByteBuffer {
  private data = new Uint8Array(0);
  private start = 0;
  private end = 0;

  get length(): number {
    return this.end - this.start;
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.reserve(chunk.byteLength);
    this.data.set(chunk, this.end);
    this.end += chunk.byteLength;
  }

  prepend(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength <= this.start) {
      this.start -= chunk.byteLength;
      this.data.set(chunk, this.start);
      return;
    }
    const merged = new Uint8Array(chunk.byteLength + this.length);
    merged.set(chunk, 0);
    merged.set(this.data.subarray(this.start, this.end), chunk.byteLength);
    this.data = merged;
    this.start = 0;
    this.end = merged.byteLength;
  }

  take(length: number): Uint8Array {
    const size = Math.min(Math.max(length, 0), this.length);
    const output = this.data.slice(this.start, this.start + size);
    this.start += size;
    if (this.start === this.end) {
      this.start = 0;
      this.end = 0;
    }
    return output;
  }

  takeAll(): Uint8Array {
    return this.take(this.length);
  }

  /** Incremental search: `from` is a buffer-relative offset already scanned. */
  indexOf(needle: Uint8Array, from: number): number {
    const index = indexOfBytes(this.data.subarray(this.start, this.end), needle, from);
    return index;
  }

  private reserve(extra: number): void {
    if (this.end + extra <= this.data.byteLength) return;
    const used = this.length;
    if (this.start > 0 && used + extra <= this.data.byteLength) {
      this.data.copyWithin(0, this.start, this.end);
      this.start = 0;
      this.end = used;
      return;
    }
    let capacity = Math.max(4096, this.data.byteLength * 2);
    while (capacity < used + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.data.subarray(this.start, this.end), 0);
    this.data = next;
    this.start = 0;
    this.end = used;
  }
}

export interface SocketReaderOptions {
  idleTimeoutMs: number;
  dialect: ProxyDialect;
}

export class SocketReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly buffer = new ByteBuffer();
  private readonly idleTimeoutMs: number;
  private readonly dialect: ProxyDialect;

  constructor(readable: ReadableStream<Uint8Array>, options: SocketReaderOptions) {
    this.reader = readable.getReader();
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.dialect = options.dialect;
  }

  release(): void {
    this.reader.releaseLock();
  }

  prepend(value: Uint8Array): void {
    this.buffer.prepend(value);
  }

  private async pull(): Promise<Uint8Array | null> {
    const result = await withIdleDeadline(
      this.reader.read(),
      this.idleTimeoutMs,
      () => this.dialect.idleTimeout(this.idleTimeoutMs),
    );
    return result.done ? null : result.value;
  }

  async readSome(): Promise<Uint8Array | null> {
    if (this.buffer.length) return this.buffer.takeAll();
    return this.pull();
  }

  async readAtMost(length: number): Promise<Uint8Array | null> {
    if (length <= 0) return new Uint8Array();
    const value = await this.readSome();
    if (!value || value.byteLength <= length) return value;
    this.prepend(value.subarray(length));
    return value.slice(0, length);
  }

  async readExact(length: number, maxBytes = HANDSHAKE_MAX_BYTES): Promise<Uint8Array> {
    if (length < 0 || length > maxBytes) throw this.dialect.handshakeLengthInvalid();
    while (this.buffer.length < length) {
      const chunk = await this.pull();
      if (!chunk) throw this.dialect.handshakeClosed();
      this.buffer.append(chunk);
      if (this.buffer.length > maxBytes) throw this.dialect.handshakeTooLarge();
    }
    return this.buffer.take(length);
  }

  async readUntil(marker: Uint8Array, maxBytes = RESPONSE_HEADER_MAX_BYTES): Promise<Uint8Array> {
    let scanned = 0;
    while (true) {
      const index = this.buffer.indexOf(marker, scanned);
      if (index >= 0) {
        const end = index + marker.byteLength;
        if (end > maxBytes) throw this.dialect.headersTooLarge();
        return this.buffer.take(end);
      }
      // Only the trailing marker.length-1 bytes can still start a match that
      // completes once the next chunk arrives, so never rescan before that.
      scanned = Math.max(0, this.buffer.length - marker.byteLength + 1);
      if (this.buffer.length >= maxBytes) throw this.dialect.headersTooLarge();
      const chunk = await this.pull();
      if (!chunk) throw this.dialect.headersClosed();
      this.buffer.append(chunk);
    }
  }
}

export function validateProxyUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new GatewayError(400, "PROXY_URL_INVALID", "代理 URL 格式无效"); }
  const protocol = url.protocol.replace(/:$/, "") as ProxyProtocol;
  if (!NATIVE_PROXY_PROTOCOLS.has(protocol)) {
    if (protocol === "https") {
      throw new GatewayError(400, "PROXY_PROTOCOL_UNSUPPORTED", "HTTPS 目标仍应填写 http:// 代理地址；当前原生代理支持 http://、socks4://、socks4a://、socks5:// 和 socks5h://");
    }
    throw new GatewayError(400, "PROXY_PROTOCOL_UNSUPPORTED", "代理协议仅支持 http://、socks4://、socks4a://、socks5:// 和 socks5h://");
  }
  if (!url.hostname) throw new GatewayError(400, "PROXY_URL_INVALID", "代理 URL 必须包含主机");
  if ((protocol === "socks4" || protocol === "socks4a") && url.password) {
    throw new GatewayError(400, "PROXY_URL_INVALID", "SOCKS4/4a 不支持密码认证；URL 用户名仅作为 USERID");
  }
  if (!url.port) url.port = protocol === "http" ? "8080" : "1080";
  return url;
}

function basicAuthorization(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined;
  return `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`;
}

async function bodyBytes(body: BodyInit | null | undefined, dialect: ProxyDialect): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof URLSearchParams) return encoder.encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ReadableStream) throw dialect.streamingBodyUnsupported();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function openSocket(
  proxy: URL,
  secureTransport: "off" | "on" | "starttls",
  timeoutMs: number,
  dialect: ProxyDialect,
): Promise<Socket> {
  const socket = connect(
    { hostname: proxy.hostname, port: Number.parseInt(proxy.port, 10) },
    { secureTransport, allowHalfOpen: true },
  );
  try {
    await withIdleDeadline(socket.opened, timeoutMs, () => dialect.connectTimeout(proxy, timeoutMs));
    socket.closed.catch(() => undefined);
    return socket;
  } catch (error) {
    await socket.close().catch(() => undefined);
    throw error;
  }
}

async function writeBytes(socket: Socket, bytes: Uint8Array, idleTimeoutMs: number, dialect: ProxyDialect): Promise<void> {
  const writer = socket.writable.getWriter();
  try {
    await withIdleDeadline(writer.write(bytes), idleTimeoutMs, () => dialect.idleTimeout(idleTimeoutMs));
  } finally {
    writer.releaseLock();
  }
}

function targetPort(target: URL): string {
  return target.port || (target.protocol === "https:" ? "443" : "80");
}

async function httpConnect(context: TunnelContext): Promise<void> {
  const { socket, reader, target, proxy, dialect } = context;
  const authority = `${target.hostname}:${targetPort(target)}`;
  const headers = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    "Proxy-Connection: keep-alive",
  ];
  const auth = basicAuthorization(proxy);
  if (auth) headers.push(`Proxy-Authorization: ${auth}`);
  await writeBytes(socket, encoder.encode(`${headers.join("\r\n")}\r\n\r\n`), context.idleTimeoutMs, dialect);
  const raw = decoder.decode(await reader.readUntil(HEADER_END, HANDSHAKE_MAX_BYTES));
  const first = raw.split("\r\n", 1)[0] ?? "";
  const status = Number.parseInt(first.split(/\s+/)[1] ?? "0", 10);
  if (status < 200 || status >= 300) throw dialect.connectRejected(first);
}

function parseIpv4(hostname: string): Uint8Array | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    octets.push(value);
  }
  return new Uint8Array(octets);
}

async function socks4Connect(context: TunnelContext, remoteDns: boolean): Promise<void> {
  const { socket, reader, target, proxy, dialect, idleTimeoutMs } = context;
  const userId = encoder.encode(decodeURIComponent(proxy.username || ""));
  if (userId.byteLength > 255 || userId.includes(0)) throw dialect.proxyCredentialTooLong();

  const port = Number.parseInt(targetPort(target), 10);
  const host = encoder.encode(target.hostname);
  if (host.byteLength === 0 || host.byteLength > 255 || host.includes(0)) throw dialect.hostTooLong();

  let address: Uint8Array;
  let domainSuffix = new Uint8Array();
  if (remoteDns) {
    address = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
    domainSuffix = concatBytes([host, new Uint8Array([0x00])]);
  } else {
    const ipv4 = parseIpv4(target.hostname);
    if (!ipv4) {
      throw new GatewayError(400, "SOCKS4_IPV4_REQUIRED", "socks4:// 仅支持 IPv4 目标；域名目标请使用 socks4a://");
    }
    address = ipv4;
  }

  const request = concatBytes([
    new Uint8Array([0x04, 0x01, (port >> 8) & 0xff, port & 0xff]),
    address,
    userId,
    new Uint8Array([0x00]),
    domainSuffix,
  ]);
  await writeBytes(socket, request, idleTimeoutMs, dialect);

  const reply = await reader.readExact(8);
  if ((reply[0] !== 0x00 && reply[0] !== 0x04) || reply[1] !== 0x5a) {
    throw dialect.socksConnectFailed(reply[1]);
  }
}

async function socks5Connect(context: TunnelContext): Promise<void> {
  const { socket, reader, target, proxy, dialect, idleTimeoutMs } = context;
  const username = decodeURIComponent(proxy.username || "");
  const password = decodeURIComponent(proxy.password || "");
  const methods = username || password ? [0x00, 0x02] : [0x00];
  await writeBytes(socket, new Uint8Array([0x05, methods.length, ...methods]), idleTimeoutMs, dialect);
  const hello = await reader.readExact(2);
  if (hello[0] !== 0x05 || hello[1] === 0xff) throw dialect.authRejected();
  if (hello[1] === 0x02) {
    const user = encoder.encode(username);
    const pass = encoder.encode(password);
    if (user.byteLength > 255 || pass.byteLength > 255) throw dialect.proxyCredentialTooLong();
    await writeBytes(socket, new Uint8Array([0x01, user.byteLength, ...user, pass.byteLength, ...pass]), idleTimeoutMs, dialect);
    const auth = await reader.readExact(2);
    if (auth[1] !== 0x00) throw dialect.authFailed();
  } else if (hello[1] !== 0x00) {
    throw dialect.authMethodUnsupported(hello[1]);
  }

  const host = encoder.encode(target.hostname);
  if (host.byteLength > 255) throw dialect.hostTooLong();
  const port = Number.parseInt(targetPort(target), 10);
  await writeBytes(
    socket,
    new Uint8Array([0x05, 0x01, 0x00, 0x03, host.byteLength, ...host, (port >> 8) & 0xff, port & 0xff]),
    idleTimeoutMs,
    dialect,
  );
  const head = await reader.readExact(4);
  if (head[0] !== 0x05 || head[1] !== 0x00) throw dialect.socksConnectFailed(head[1]);
  const addressLength = head[3] === 0x01 ? 4 : head[3] === 0x04 ? 16 : head[3] === 0x03 ? (await reader.readExact(1))[0] ?? -1 : -1;
  if (addressLength < 0) throw dialect.socksUnknownAddress();
  await reader.readExact(addressLength + 2);
}

interface TunnelContext {
  socket: Socket;
  reader: SocketReader;
  target: URL;
  proxy: URL;
  dialect: ProxyDialect;
  idleTimeoutMs: number;
}

function requestHeaders(target: URL, init: RequestInit, body: Uint8Array, absoluteForm: boolean, proxy: URL): Uint8Array {
  const method = (init.method ?? "GET").toUpperCase();
  const path = absoluteForm ? target.toString() : `${target.pathname || "/"}${target.search}`;
  const headers = new Headers(init.headers);
  for (const key of HOP_BY_HOP_HEADERS) headers.delete(key);
  headers.set("host", target.host);
  headers.set("connection", "close");
  if (body.byteLength) headers.set("content-length", String(body.byteLength));
  else if (method === "POST" || method === "PUT" || method === "PATCH") headers.set("content-length", "0");
  if (absoluteForm) {
    const auth = basicAuthorization(proxy);
    if (auth) headers.set("proxy-authorization", auth);
  }
  const lines = [`${method} ${path} HTTP/1.1`];
  headers.forEach((value, key) => lines.push(`${key}: ${value}`));
  return concatBytes([encoder.encode(`${lines.join("\r\n")}\r\n\r\n`), body]);
}

function parseResponseHeaders(raw: Uint8Array, dialect: ProxyDialect): { status: number; statusText: string; headers: Headers } {
  const lines = decoder.decode(raw).slice(0, -4).split("\r\n");
  const statusLine = lines.shift() ?? "";
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i);
  if (!match) throw dialect.invalidStatusLine(statusLine);
  const headers = new Headers();
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return { status: Number.parseInt(match[1] ?? "0", 10), statusText: match[2] ?? "", headers };
}

function closeSocket(socket: Socket): void {
  void socket.close().catch(() => undefined);
}

function fixedLengthBody(reader: SocketReader, socket: Socket, length: number, dialect: ProxyDialect): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (remaining <= 0) { controller.close(); closeSocket(socket); return; }
        const chunk = await reader.readSome();
        if (!chunk) throw dialect.bodyEndedEarly();
        const value = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
        controller.enqueue(value);
        remaining -= value.byteLength;
        if (remaining === 0) { controller.close(); closeSocket(socket); }
      } catch (error) {
        controller.error(error);
        closeSocket(socket);
      }
    },
    cancel() { closeSocket(socket); },
  });
}

function untilCloseBody(reader: SocketReader, socket: Socket): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.readSome();
        if (chunk) controller.enqueue(chunk);
        else { controller.close(); closeSocket(socket); }
      } catch (error) {
        controller.error(error);
        closeSocket(socket);
      }
    },
    cancel() { closeSocket(socket); },
  });
}

function chunkedBody(reader: SocketReader, socket: Socket, dialect: ProxyDialect): ReadableStream<Uint8Array> {
  let remaining = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (finished) return;
        if (remaining === 0) {
          const line = decoder.decode(await reader.readUntil(CRLF, CHUNK_HEADER_MAX_BYTES)).slice(0, -2).trim();
          const size = Number.parseInt(line.split(";", 1)[0] ?? "", 16);
          if (!Number.isFinite(size) || size < 0) throw dialect.invalidChunkLength(line);
          if (size === 0) {
            while ((await reader.readUntil(CRLF, CHUNK_TRAILER_MAX_BYTES)).byteLength !== 2) { /* consume trailers */ }
            finished = true;
            controller.close();
            closeSocket(socket);
            return;
          }
          remaining = size;
        }
        const chunk = await reader.readAtMost(remaining);
        if (!chunk) throw dialect.chunkedEndedEarly();
        controller.enqueue(chunk);
        remaining -= chunk.byteLength;
        if (remaining === 0) {
          const suffix = await reader.readExact(2);
          if (suffix[0] !== 13 || suffix[1] !== 10) throw dialect.missingChunkCrlf();
        }
      } catch (error) {
        controller.error(error);
        closeSocket(socket);
      }
    },
    cancel() { closeSocket(socket); },
  });
}

export interface ProxyRequestOptions {
  proxy: URL;
  target: URL;
  init: RequestInit;
  /** Bounds the TCP connect and the TLS negotiation only. */
  connectTimeoutMs: number;
  /** Bounds the gap between two consecutive socket operations. */
  idleTimeoutMs: number;
  dialect: ProxyDialect;
}

/**
 * Runs one HTTP request through an HTTP CONNECT, SOCKS4/4a, or SOCKS5 proxy. Every socket
 * operation past the connect phase is bounded by `idleTimeoutMs`, including the
 * reads performed lazily by the returned response body.
 */
export async function proxyRequest(options: ProxyRequestOptions): Promise<Response> {
  const { proxy, target, init, idleTimeoutMs, dialect } = options;
  const protocol = proxy.protocol.replace(/:$/, "") as ProxyProtocol;
  let socket = await openSocket(
    proxy,
    target.protocol === "https:" ? "starttls" : "off",
    options.connectTimeoutMs,
    dialect,
  );
  let reader = new SocketReader(socket.readable, { idleTimeoutMs, dialect });
  const tunneled = protocol !== "http" || target.protocol === "https:";

  try {
    const context: TunnelContext = { socket, reader, target, proxy, dialect, idleTimeoutMs };
    if (protocol === "http" && target.protocol === "https:") await httpConnect(context);
    else if (protocol === "socks4" || protocol === "socks4a") await socks4Connect(context, protocol === "socks4a");
    else if (protocol !== "http") await socks5Connect(context);

    if (target.protocol === "https:") {
      reader.release();
      try {
        socket = socket.startTls({ expectedServerHostname: target.hostname });
        await withIdleDeadline(
          socket.opened,
          options.connectTimeoutMs,
          () => dialect.tlsNegotiationTimeout(target, options.connectTimeoutMs),
        );
        socket.closed.catch(() => undefined);
        reader = new SocketReader(socket.readable, { idleTimeoutMs, dialect });
      } catch (error) {
        // Only our own deadline surfaces as a GatewayError here; anything else
        // is a genuine TLS failure and keeps the diagnostic wording.
        if (error instanceof GatewayError) throw error;
        throw dialect.tlsHandshakeFailed(target, errorMessage(error));
      }
    }

    const body = await bodyBytes(init.body, dialect);
    await writeBytes(socket, requestHeaders(target, init, body, protocol === "http" && !tunneled, proxy), idleTimeoutMs, dialect);
    const parsed = parseResponseHeaders(await reader.readUntil(HEADER_END, RESPONSE_HEADER_MAX_BYTES), dialect);
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
        responseBody = chunkedBody(reader, socket, dialect);
      } else if (Number.isFinite(contentLength) && contentLength >= 0) {
        responseBody = fixedLengthBody(reader, socket, contentLength, dialect);
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
