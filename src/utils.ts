import { GatewayError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function asInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(data);
}

export function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function base64Encode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function timingSafeEqualText(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split(".")[1];
  if (!segment) return {};
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(segment))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function pickString(object: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    let value: unknown = object;
    for (const part of path.split(".")) {
      if (!value || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > maxBytes) {
    throw new GatewayError(413, "REQUEST_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, "invalid_request_error");
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("body too large");
      throw new GatewayError(413, "REQUEST_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, "invalid_request_error");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new GatewayError(400, "INVALID_JSON", "Request body must be a JSON object", "invalid_request_error");
  }
}

export function sanitizeHeaders(input: Headers, extra: Record<string, string> = {}): Headers {
  const output = new Headers();
  const allow = ["accept", "content-type", "user-agent", "x-request-id", "openai-organization", "openai-project"];
  for (const key of allow) {
    const value = input.get(key);
    if (value) output.set(key, value);
  }
  output.set("content-type", "application/json");
  for (const [key, value] of Object.entries(extra)) output.set(key, value);
  return output;
}

export function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new GatewayError(400, "INVALID_PROVIDER_URL", "Provider URL must use HTTPS");
  }
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/$/, "");
}

export function endpointFromPath(path: string): "responses" | "chat" | "completions" {
  if (path.endsWith("/responses")) return "responses";
  if (path.endsWith("/completions") && !path.endsWith("/chat/completions")) return "completions";
  return "chat";
}

export function truncate(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
