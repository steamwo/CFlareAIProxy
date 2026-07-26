const API_BASE = "/admin/api";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message); this.name = "ApiError"; this.status = status; this.code = code;
  }
}

interface ActivityBucket {
  bucket: number;
  requests: number;
  successes: number;
  failures: number;
  tokens: number;
}

interface ActivityRecord {
  buckets: ActivityBucket[];
  totals: {
    requests: number;
    successes: number;
    failures: number;
  };
}

function numericValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeActivityRecord(value: unknown): ActivityRecord {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { buckets?: unknown }).buckets)
      ? (value as { buckets: unknown[] }).buckets
      : [];
  const grouped = new Map<number, ActivityBucket>();

  for (const item of source) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const bucket = numericValue(row.bucket);
    const current = grouped.get(bucket) ?? { bucket, requests: 0, successes: 0, failures: 0, tokens: 0 };
    current.requests += numericValue(row.requests);
    current.successes += numericValue(row.successes);
    current.failures += numericValue(row.failures);
    current.tokens += numericValue(row.tokens ?? row.total_tokens);
    grouped.set(bucket, current);
  }

  const buckets = [...grouped.values()].sort((left, right) => left.bucket - right.bucket);
  const totals = buckets.reduce(
    (result, row) => ({
      requests: result.requests + row.requests,
      successes: result.successes + row.successes,
      failures: result.failures + row.failures,
    }),
    { requests: 0, successes: 0, failures: 0 },
  );
  return { buckets, totals };
}

export function normalizeCredentialPageActivity<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const source = payload as T & { activity?: unknown };
  if (!source.activity || typeof source.activity !== "object" || Array.isArray(source.activity)) return payload;
  const activity = Object.fromEntries(
    Object.entries(source.activity as Record<string, unknown>)
      .map(([credentialId, value]) => [credentialId, normalizeActivityRecord(value)]),
  );
  return { ...source, activity };
}

async function parseResponse<T>(response: Response): Promise<T> {
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("application/json") ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok) {
    const value = payload as { error?: { message?: string; code?: string }; message?: string };
    throw new ApiError(value?.error?.message || value?.message || `请求失败 (${response.status})`, response.status, value?.error?.code);
  }
  return payload as T;
}

/**
 * Paths that legitimately answer 401 as data rather than as "the admin session died".
 * `/session` probes auth on purpose and `/login` reports bad credentials; neither should
 * trigger the global sign-out handler.
 */
const SELF_HANDLED_AUTH_PATHS = new Set(["/session", "/login", "/logout"]);

type UnauthorizedHandler = (path: string) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Registers the single global reaction to an expired admin session. The session store owns
 * this so that any 401 from any view converges on one sign-out + redirect, instead of each
 * view showing an isolated toast while the user stays on a dead page.
 */
export function onUnauthorized(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const resolvedPath = path === "/overview" ? "/overview-v2" : path;
  const response = await fetch(`${API_BASE}${resolvedPath}`, { ...init, headers, credentials: "same-origin" });
  if (response.status === 401 && !SELF_HANDLED_AUTH_PATHS.has(resolvedPath)) unauthorizedHandler?.(resolvedPath);
  const payload = await parseResponse<T>(response);
  return resolvedPath.startsWith("/credentials/paged") ? normalizeCredentialPageActivity(payload) : payload;
}

export const jsonBody = (value: unknown) => JSON.stringify(value);
