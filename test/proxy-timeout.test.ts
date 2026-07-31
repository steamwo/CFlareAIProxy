import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFetchForCredential } from "../src/credential-fetch";
import { GatewayError } from "../src/errors";
import {
  MIN_IDLE_TIMEOUT_MS,
  MAX_IDLE_TIMEOUT_MS,
  SocketReader,
  idleTimeoutFor,
  indexOfBytes,
  validateProxyUrl,
  type ProxyDialect,
} from "../src/proxy-transport";
import type { Credential, Env, ProviderConfig } from "../src/types";
import { classifyTransportError } from "../src/upstream-errors";
import { enqueueSocket, recordedSockets, resetSockets, type SocketScriptStep } from "./mocks/cloudflare-sockets";

const encoder = new TextEncoder();

function credential(proxyUrl: string): Credential {
  return { metadata: { proxy_url: proxyUrl } } as unknown as Credential;
}

const provider = {
  id: "provider-1",
  name: "Provider",
  kind: "openai-compatible",
  base_url: "http://upstream.test/v1",
  endpoints: {},
  auth: {},
  headers: {},
  options: {},
} as unknown as ProviderConfig;

const env = {} as Env;

/** Minimal dialect used for the SocketReader unit tests. */
function testDialect(): ProxyDialect {
  const fail = (code: string, message: string): GatewayError => new GatewayError(502, code, message, "upstream_error");
  return {
    connectTimeout: () => fail("CONNECT_TIMEOUT", "connect timed out"),
    idleTimeout: (idleMs) => new GatewayError(504, "IDLE_TIMEOUT", `idle for ${idleMs} ms, timed out`, "upstream_error"),
    handshakeLengthInvalid: () => fail("HANDSHAKE_LENGTH", "bad length"),
    handshakeClosed: () => fail("HANDSHAKE_CLOSED", "closed"),
    handshakeTooLarge: () => fail("HANDSHAKE_TOO_LARGE", "too large"),
    headersTooLarge: () => fail("HEADERS_TOO_LARGE", "headers too large"),
    headersClosed: () => fail("HEADERS_CLOSED", "headers closed"),
    connectRejected: () => fail("CONNECT_REJECTED", "rejected"),
    authRejected: () => fail("AUTH_REJECTED", "rejected"),
    authMethodUnsupported: () => fail("AUTH_METHOD", "unsupported"),
    authFailed: () => fail("AUTH_FAILED", "failed"),
    proxyCredentialTooLong: () => fail("CREDENTIAL_TOO_LONG", "too long"),
    hostTooLong: () => fail("HOST_TOO_LONG", "too long"),
    socksConnectFailed: () => fail("SOCKS_CONNECT_FAILED", "failed"),
    socksUnknownAddress: () => fail("SOCKS_ADDRESS", "unknown"),
    tlsNegotiationTimeout: () => fail("TLS_TIMEOUT", "tls timed out"),
    tlsHandshakeFailed: () => fail("TLS_FAILED", "tls failed"),
    streamingBodyUnsupported: () => fail("BODY_UNSUPPORTED", "unsupported"),
    invalidStatusLine: () => fail("STATUS_LINE", "invalid"),
    bodyEndedEarly: () => new Error("body ended early"),
    chunkedEndedEarly: () => new Error("chunked ended early"),
    invalidChunkLength: () => new Error("invalid chunk length"),
    missingChunkCrlf: () => new Error("missing crlf"),
  };
}

function streamOf(chunks: Array<Uint8Array | string>): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) { controller.close(); return; }
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
  });
}

function readerOver(chunks: Array<Uint8Array | string>, idleTimeoutMs = 30_000): SocketReader {
  return new SocketReader(streamOf(chunks), { idleTimeoutMs, dialect: testDialect() });
}

/**
 * Drives fake timers until `promise` settles, so no wall-clock time elapses.
 * Steps are small relative to the deadlines under test so timer ordering
 * (data arrival vs. idle expiry) stays faithful.
 */
async function settleWithTimers<T>(promise: Promise<T>, budgetMs = 900_000): Promise<{ value?: T; error?: unknown }> {
  const outcome = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  let settled = false;
  void outcome.then(() => { settled = true; });
  for (let elapsed = 0; elapsed < budgetMs && !settled; elapsed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return outcome;
}

beforeEach(() => {
  resetSockets();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetSockets();
});

describe("idle timeout window", () => {
  it("clamps the caller timeout into the supported idle range", () => {
    // Short administrative timeouts must not shorten the streaming idle window.
    expect(idleTimeoutFor(1_000)).toBe(MIN_IDLE_TIMEOUT_MS);
    expect(idleTimeoutFor(20_000)).toBe(MIN_IDLE_TIMEOUT_MS);
    expect(idleTimeoutFor(120_000)).toBe(120_000);
    // And a very long timeout must still expire well inside the 15 minute lease TTL.
    expect(idleTimeoutFor(3_600_000)).toBe(MAX_IDLE_TIMEOUT_MS);
    expect(MAX_IDLE_TIMEOUT_MS).toBeLessThan(15 * 60_000);
  });
});

describe("native proxy request deadlines", () => {
  it("aborts and closes the socket when the tunnel stops sending data", async () => {
    enqueueSocket({ steps: [{ type: "stall" }] });
    const outcome = await settleWithTimers(providerFetchForCredential(
      env,
      provider,
      credential("http://127.0.0.1:8080"),
      "http://upstream.test/v1/models",
      { method: "GET" },
      { timeoutMs: 120_000 },
    ));
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(GatewayError);
    expect(outcome.error).toMatchObject({ code: "CREDENTIAL_PROXY_IDLE_TIMEOUT", status: 504 });
    // The upper layer must see a retryable timeout, not an opaque failure.
    const classified = classifyTransportError(outcome.error, "Provider", 120_000);
    expect(classified.status).toBe(504);
    const socket = recordedSockets()[0];
    expect(socket?.isClosed).toBe(true);
  });

  it("aborts when the response body stalls mid-stream", async () => {
    enqueueSocket({
      steps: [
        { type: "awaitWrite", count: 1 },
        { type: "data", bytes: "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n" },
        { type: "data", bytes: "6\r\ndata: \r\n" },
        { type: "stall" },
      ],
    });
    const response = await settleWithTimers(providerFetchForCredential(
      env,
      provider,
      credential("http://127.0.0.1:8080"),
      "http://upstream.test/v1/chat/completions",
      { method: "POST", body: "{}" },
      { timeoutMs: 120_000 },
    ));
    expect(response.value?.status).toBe(200);
    const body = response.value?.body;
    expect(body).toBeTruthy();
    const outcome = await settleWithTimers(new Response(body).text());
    expect(outcome.error).toMatchObject({ code: "CREDENTIAL_PROXY_IDLE_TIMEOUT" });
  });

  it("does not kill a slow stream that keeps emitting inside the idle window", async () => {
    // A 20 s caller timeout clamps the idle window to MIN_IDLE_TIMEOUT_MS, so a
    // 25 s inter-chunk gap sits just under the deadline every single time.
    const gap = MIN_IDLE_TIMEOUT_MS - 5_000;
    const ticks = 8;
    const steps: SocketScriptStep[] = [
      { type: "awaitWrite", count: 1 },
      { type: "data", bytes: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n" },
    ];
    for (let index = 0; index < ticks; index += 1) {
      steps.push({ type: "delay", ms: gap });
      steps.push({ type: "data", bytes: "5\r\ntick \r\n" });
    }
    steps.push({ type: "data", bytes: "0\r\n\r\n" });
    enqueueSocket({ steps });

    const response = await settleWithTimers(providerFetchForCredential(
      env,
      provider,
      credential("http://127.0.0.1:8080"),
      "http://upstream.test/v1/chat/completions",
      { method: "POST", body: "{}" },
      { timeoutMs: 20_000 },
    ));
    expect(response.value?.status).toBe(200);
    const outcome = await settleWithTimers(new Response(response.value?.body).text());
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe("tick ".repeat(ticks));
    // Total stream duration dwarfs the idle window, proving the deadline is
    // per-gap rather than a total-duration budget.
    expect(gap * ticks).toBeGreaterThan(MIN_IDLE_TIMEOUT_MS);
  });

  it("times out the connect phase with the connect budget, not the idle budget", async () => {
    enqueueSocket({ steps: [], openStalls: true });
    const outcome = await settleWithTimers(providerFetchForCredential(
      env,
      provider,
      credential("socks5://127.0.0.1:1080"),
      "http://upstream.test/v1/models",
      { method: "GET" },
      { timeoutMs: 120_000 },
    ));
    expect(outcome.error).toMatchObject({ code: "CREDENTIAL_PROXY_CONNECT_TIMEOUT", status: 504 });
    expect(recordedSockets()[0]?.isClosed).toBe(true);
  });
});

describe("proxy handshake framing", () => {
  it("writes a SOCKS5 greeting, auth and connect request for the target host", async () => {
    const host = "upstream.test";
    enqueueSocket({
      steps: [
        { type: "awaitWrite", count: 1 },
        { type: "data", bytes: new Uint8Array([0x05, 0x02]) },
        { type: "awaitWrite", count: 2 },
        { type: "data", bytes: new Uint8Array([0x01, 0x00]) },
        { type: "awaitWrite", count: 3 },
        { type: "data", bytes: new Uint8Array([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]) },
        { type: "awaitWrite", count: 4 },
        { type: "data", bytes: "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi" },
      ],
    });
    const outcome = await settleWithTimers(providerFetchForCredential(
      env,
      provider,
      credential("socks5://user:secret@127.0.0.1:1080"),
      `http://${host}/v1/models`,
      { method: "GET" },
      { timeoutMs: 120_000 },
    ));
    expect(outcome.error).toBeUndefined();
    expect(await new Response(outcome.value?.body).text()).toBe("hi");

    const socket = recordedSockets()[0];
    expect(socket).toBeTruthy();
    const greeting = socket?.writes[0];
    expect(greeting && Array.from(greeting)).toEqual([0x05, 0x02, 0x00, 0x02]);
    const auth = socket?.writes[1];
    expect(auth && Array.from(auth)).toEqual([0x01, 4, ...encoder.encode("user"), 6, ...encoder.encode("secret")]);
    const request = socket?.writes[2];
    expect(request && Array.from(request)).toEqual([
      0x05, 0x01, 0x00, 0x03, host.length, ...encoder.encode(host), 0x00, 0x50,
    ]);
  });

  it("writes an HTTP CONNECT with proxy authorization for HTTPS targets", async () => {
    enqueueSocket({
      steps: [
        { type: "awaitWrite", count: 1 },
        { type: "data", bytes: "HTTP/1.1 200 Connection Established\r\n\r\n" },
      ],
      afterStartTls: {
        steps: [
          { type: "awaitWrite", count: 1 },
          { type: "data", bytes: "HTTP/1.1 204 No Content\r\n\r\n" },
        ],
      },
    });
    const outcome = await settleWithTimers(providerFetchForCredential(
      env,
      provider,
      credential("http://alice:pw@127.0.0.1:8080"),
      "https://upstream.test/v1/models",
      { method: "GET" },
      { timeoutMs: 120_000 },
    ));
    expect(outcome.error).toBeUndefined();
    expect(outcome.value?.status).toBe(204);

    const tunnel = recordedSockets()[0];
    const connectText = tunnel?.writtenText() ?? "";
    expect(connectText.startsWith("CONNECT upstream.test:443 HTTP/1.1\r\n")).toBe(true);
    expect(connectText).toContain("Host: upstream.test:443");
    expect(connectText).toContain(`Proxy-Authorization: Basic ${btoa("alice:pw")}`);
    expect(tunnel?.startTlsCalls[0]).toEqual({ expectedServerHostname: "upstream.test" });
    // The request itself must go out on the upgraded socket, in origin form.
    expect(recordedSockets()[1]?.writtenText()).toContain("GET /v1/models HTTP/1.1\r\n");
  });
});

describe("incremental header scanning", () => {
  it("finds a marker split across chunk boundaries without rescanning", async () => {
    const reader = readerOver(["HTTP/1.1 200 OK\r\nx-a: 1\r", "\n\r", "\nbody-start"]);
    const headers = await reader.readUntil(encoder.encode("\r\n\r\n"));
    expect(new TextDecoder().decode(headers)).toBe("HTTP/1.1 200 OK\r\nx-a: 1\r\n\r\n");
    const rest = await reader.readSome();
    expect(rest && new TextDecoder().decode(rest)).toBe("body-start");
  });

  it("does not miss a marker that starts in the previously scanned region", async () => {
    // "\r\n\r" arrives first; the completing "\n" is in the next chunk, so a
    // naive "resume from buffer end" scan would skip the match.
    const reader = readerOver(["a\r\n\r", "\ntail"]);
    const found = await reader.readUntil(encoder.encode("\r\n\r\n"));
    expect(new TextDecoder().decode(found)).toBe("a\r\n\r\n");
    expect(new TextDecoder().decode((await reader.readSome()) ?? new Uint8Array())).toBe("tail");
  });

  it("handles many small chunks before the marker", async () => {
    const chunks = Array.from({ length: 500 }, (_, index) => `h${index}: v\r\n`);
    const reader = readerOver([...chunks, "\r\n", "payload"]);
    const headers = await reader.readUntil(encoder.encode("\r\n\r\n"));
    expect(new TextDecoder().decode(headers).endsWith("h499: v\r\n\r\n")).toBe(true);
    expect(new TextDecoder().decode((await reader.readSome()) ?? new Uint8Array())).toBe("payload");
  });

  it("enforces the header size cap and the closed-stream error", async () => {
    const big = readerOver(["x".repeat(300)]);
    await expect(big.readUntil(encoder.encode("\r\n\r\n"), 128)).rejects.toMatchObject({ code: "HEADERS_TOO_LARGE" });
    const short = readerOver(["no marker here"]);
    await expect(short.readUntil(encoder.encode("\r\n\r\n"))).rejects.toMatchObject({ code: "HEADERS_CLOSED" });
  });

  it("reads exact lengths across chunk boundaries and keeps the remainder", async () => {
    const reader = readerOver([new Uint8Array([5, 2]), new Uint8Array([1, 0, 9])]);
    expect(Array.from(await reader.readExact(2))).toEqual([5, 2]);
    expect(Array.from(await reader.readExact(3))).toEqual([1, 0, 9]);
  });

  it("indexOfBytes honours the start offset and finds trailing matches", () => {
    const haystack = encoder.encode("abcabcabd");
    expect(indexOfBytes(haystack, encoder.encode("abc"))).toBe(0);
    expect(indexOfBytes(haystack, encoder.encode("abc"), 1)).toBe(3);
    expect(indexOfBytes(haystack, encoder.encode("abd"), 0)).toBe(6);
    expect(indexOfBytes(haystack, encoder.encode("abd"), 7)).toBe(-1);
    expect(indexOfBytes(haystack, encoder.encode("zz"))).toBe(-1);
  });
});

describe("proxy url validation still guards the transport", () => {
  it("rejects protocols the native stack cannot speak", () => {
    expect(() => validateProxyUrl("https://proxy.test:443")).toThrow(GatewayError);
    expect(validateProxyUrl("socks5h://proxy.test").port).toBe("1080");
  });
});
