import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { ProxyAgent } from "proxy-agent";

const port = parseInteger(process.env.PORT, 9090, 1, 65535);
const maxBodyBytes = parseInteger(process.env.CFLARE_PROXY_MAX_BODY_BYTES, 16 * 1024 * 1024, 1024, 128 * 1024 * 1024);
const maxClockSkewSeconds = parseInteger(process.env.CFLARE_PROXY_MAX_CLOCK_SKEW_SECONDS, 300, 30, 3600);
const tokens = (process.env.CFLARE_PROXY_TOKENS || process.env.CFLARE_PROXY_TOKEN || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const allowedHosts = (process.env.CFLARE_PROXY_ALLOWED_HOSTS || "")
  .split(",").map((value) => value.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
const proxyProtocols = new Set(["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);
const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function parseInteger(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifySignature(timestamp, signature, body) {
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > maxClockSkewSeconds) return false;
  const digest = base64Url(crypto.createHash("sha256").update(body).digest());
  return tokens.some((token) => {
    const expected = base64Url(crypto.createHmac("sha256", token).update(`${timestamp}.${digest}`).digest());
    return safeEqual(signature, expected);
  });
}

function hostAllowed(hostname) {
  if (!allowedHosts.length) return true;
  const host = hostname.toLowerCase();
  return allowedHosts.some((rule) => rule === "*" || host === rule || host.endsWith(`.${rule}`));
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) throw Object.assign(new Error("Bridge request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  const errorHeader = payload && payload.error && payload.error.message ? { "x-cflare-proxy-bridge-error": String(payload.error.message).slice(0, 500) } : {};
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...errorHeader, ...extraHeaders });
  response.end(body);
}

function redactProxyError(value, proxyUrl) {
  let message = value instanceof Error ? value.message : String(value);
  if (proxyUrl) {
    const full = proxyUrl.toString();
    message = message.split(full).join(`${proxyUrl.protocol}//***@${proxyUrl.host}`);
    if (proxyUrl.username) message = message.split(decodeURIComponent(proxyUrl.username)).join("***");
    if (proxyUrl.password) message = message.split(decodeURIComponent(proxyUrl.password)).join("***");
  }
  return message.slice(0, 1000);
}

function normalizedHeaders(entries) {
  const headers = {};
  if (!Array.isArray(entries)) return headers;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const key = String(entry[0]).toLowerCase();
    if (hopByHop.has(key) || key === "host" || key === "content-length") continue;
    headers[key] = String(entry[1]);
  }
  return headers;
}

function forward(payload, response) {
  const target = new URL(String(payload.targetUrl || ""));
  if (target.protocol !== "http:" && target.protocol !== "https:") throw Object.assign(new Error("Only HTTP(S) targets are allowed"), { statusCode: 400 });
  if (!hostAllowed(target.hostname)) throw Object.assign(new Error(`Target host ${target.hostname} is not in CFLARE_PROXY_ALLOWED_HOSTS`), { statusCode: 403 });
  const proxyUrl = new URL(String(payload.proxyUrl || ""));
  if (!proxyProtocols.has(proxyUrl.protocol) || !proxyUrl.hostname || !proxyUrl.port) {
    throw Object.assign(new Error("Unsupported or incomplete proxy URL"), { statusCode: 400 });
  }

  const connectTimeoutMs = parseInteger(payload.connectTimeoutMs, 20_000, 1000, 300_000);
  const requestTimeoutMs = parseInteger(payload.requestTimeoutMs, 120_000, 1000, 900_000);
  const headers = normalizedHeaders(payload.headers);
  const body = payload.bodyBase64 ? Buffer.from(String(payload.bodyBase64), "base64") : undefined;
  if (body) headers["content-length"] = String(body.length);
  const agent = new ProxyAgent({ getProxyForUrl: () => proxyUrl.toString() });
  const client = target.protocol === "https:" ? https : http;
  const request = client.request(target, {
    method: String(payload.method || "GET").toUpperCase(),
    headers,
    agent,
  }, (upstream) => {
    connected = true;
    clearTimeout(connectTimer);
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value === undefined || hopByHop.has(key.toLowerCase())) continue;
      responseHeaders[key] = value;
    }
    responseHeaders["x-cflare-proxy-bridge"] = "0.5.0";
    response.writeHead(upstream.statusCode || 502, upstream.statusMessage, responseHeaders);
    upstream.on("error", (error) => response.destroy(error));
    upstream.pipe(response);
  });

  let connected = false;
  const connectTimer = setTimeout(() => {
    if (!connected) request.destroy(new Error(`Proxy connection timed out after ${connectTimeoutMs} ms`));
  }, connectTimeoutMs);
  request.on("socket", (socket) => {
    const markConnected = () => { connected = true; clearTimeout(connectTimer); };
    socket.once("connect", markConnected);
    socket.once("secureConnect", markConnected);
    if (!socket.connecting) markConnected();
  });
  request.setTimeout(requestTimeoutMs, () => request.destroy(new Error(`Proxy request timed out after ${requestTimeoutMs} ms`)));
  response.on("close", () => {
    if (!response.writableEnded && !request.destroyed) request.destroy(new Error("Bridge client disconnected"));
  });
  request.on("error", (error) => {
    clearTimeout(connectTimer);
    const message = redactProxyError(error, proxyUrl);
    if (!response.headersSent) sendJson(response, 502, { error: { code: "PROXY_FORWARD_FAILED", message } }, { "x-cflare-proxy-bridge-error": message });
    else response.destroy(error);
  });
  if (body) request.end(body); else request.end();
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { status: "ok", version: "0.5.0", proxyProtocols: [...proxyProtocols].map((item) => item.slice(0, -1)), allowlistEnabled: allowedHosts.length > 0 });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/forward") return sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    if (!tokens.length) return sendJson(response, 503, { error: { code: "BRIDGE_TOKEN_MISSING", message: "CFLARE_PROXY_TOKEN is not configured" } });
    const body = await readBody(request);
    const timestamp = String(request.headers["x-cflare-proxy-timestamp"] || "");
    const signature = String(request.headers["x-cflare-proxy-signature"] || "");
    if (!verifySignature(timestamp, signature, body)) return sendJson(response, 401, { error: { code: "BRIDGE_AUTH_FAILED", message: "Invalid or expired bridge signature" } });
    let payload;
    try { payload = JSON.parse(body.toString("utf8")); } catch { return sendJson(response, 400, { error: { code: "BRIDGE_PAYLOAD_INVALID", message: "Invalid JSON payload" } }); }
    return forward(payload, response);
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    return sendJson(response, status, { error: { code: status === 500 ? "BRIDGE_INTERNAL_ERROR" : "BRIDGE_REQUEST_INVALID", message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "proxy_bridge_ready", port, version: "0.5.0", allowedHosts: allowedHosts.length || "all" }));
});
