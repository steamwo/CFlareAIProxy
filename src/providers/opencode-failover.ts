import type { Credential, Env, ProviderConfig } from "../types";
import { isOpenCodeAnonymousCredential } from "./opencode-anonymous";

export const DEFAULT_OPENCODE_MIRRORS = [
  "https://opencode.ai.cmliussss.net/zen/v1",
  "https://opencode.fastly.cmliussss.net/zen/v1",
  "https://opencode.gcore.cmliussss.net/zen/v1",
] as const;

const OPENCODE_USER_AGENT = "opencode/1.17.8 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13";

interface StoredFailure {
  status: number;
  statusText: string;
  headers: Headers;
  body: ArrayBuffer;
}

export interface OpenCodeFailoverResult {
  response: Response;
  usedMirror: boolean;
}

export interface OpenCodeFailoverInput {
  env: Env;
  provider: ProviderConfig;
  credential: Credential;
  target: string | URL;
  init: RequestInit;
  fetcher: (target: string, init: RequestInit) => Promise<Response>;
  random?: () => number;
}

function splitUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => splitUrls(entry));
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export function resolveOpenCodeMirrorUrls(env: Env, provider: ProviderConfig): string[] {
  const environment = env as Env & { OPENCODE_MIRRORS_URL?: string };
  const configured = [
    ...DEFAULT_OPENCODE_MIRRORS,
    ...splitUrls(provider.options.mirror_urls),
    ...splitUrls(environment.OPENCODE_MIRRORS_URL),
  ];
  const normalized = configured
    .map(normalizeHttpUrl)
    .filter((value): value is string => Boolean(value));
  return [...new Set(normalized)];
}

function orderedMirrors(urls: string[], random: () => number): string[] {
  if (urls.length === 0) return [];
  const sample = random();
  const bounded = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.999999999999) : 0;
  const start = Math.floor(bounded * urls.length);
  return [...urls.slice(start), ...urls.slice(0, start)];
}

function mirrorTarget(provider: ProviderConfig, target: string | URL, mirror: string): string {
  const source = target.toString();
  const base = provider.base_url.replace(/\/+$/, "");
  if (source === base) return mirror;
  if (source.startsWith(`${base}/`)) return `${mirror}${source.slice(base.length)}`;

  const sourceUrl = new URL(source);
  const baseUrl = new URL(`${base}/`);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const path = sourceUrl.pathname.startsWith(basePath)
    ? sourceUrl.pathname.slice(basePath.length)
    : sourceUrl.pathname;
  return `${mirror}${path.startsWith("/") ? "" : "/"}${path}${sourceUrl.search}`;
}

function createOpenCodeId(prefix: "msg" | "ses"): string {
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  return `${prefix}_${Date.now().toString(16)}${random}`;
}

function requestInit(init: RequestInit, apiKey: string, requestId: string, sessionId: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("user-agent", OPENCODE_USER_AGENT);
  headers.set("x-opencode-client", "cli");
  headers.set("x-opencode-project", "global");
  headers.set("x-opencode-request", headers.get("x-opencode-request") ?? requestId);
  headers.set("x-opencode-session", headers.get("x-opencode-session") ?? sessionId);
  return { ...init, headers };
}

async function storeFailure(response: Response): Promise<StoredFailure> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    body: await response.arrayBuffer(),
  };
}

function restoreFailure(failure: StoredFailure): Response {
  return new Response(failure.body, {
    status: failure.status,
    statusText: failure.statusText,
    headers: failure.headers,
  });
}

export async function fetchOpenCodeWithFailover(input: OpenCodeFailoverInput): Promise<OpenCodeFailoverResult> {
  const random = input.random ?? Math.random;
  const requestId = createOpenCodeId("msg");
  const sessionId = createOpenCodeId("ses");
  const anonymous = isOpenCodeAnonymousCredential(input.credential.id);
  let officialFailure: StoredFailure | undefined;
  let mirrorFailure: StoredFailure | undefined;
  let lastTransportError: unknown;

  if (!anonymous) {
    try {
      const response = await input.fetcher(
        input.target.toString(),
        requestInit(input.init, input.credential.secret, requestId, sessionId),
      );
      if (response.ok) return { response, usedMirror: false };
      officialFailure = await storeFailure(response);
    } catch (error) {
      lastTransportError = error;
    }
  }

  for (const mirror of orderedMirrors(resolveOpenCodeMirrorUrls(input.env, input.provider), random)) {
    try {
      const response = await input.fetcher(
        mirrorTarget(input.provider, input.target, mirror),
        requestInit(input.init, "public", requestId, sessionId),
      );
      if (response.ok) return { response, usedMirror: true };
      mirrorFailure = await storeFailure(response);
    } catch (error) {
      lastTransportError = error;
    }
  }

  if (officialFailure) return { response: restoreFailure(officialFailure), usedMirror: false };
  if (mirrorFailure) return { response: restoreFailure(mirrorFailure), usedMirror: true };
  if (lastTransportError instanceof Error) throw lastTransportError;
  throw new Error("OpenCode upstream request failed without a response");
}
