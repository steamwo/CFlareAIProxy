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

interface QuotaWindowRecord extends Record<string, unknown> {
  limit?: unknown;
  remaining?: unknown;
  usedPercent?: unknown;
  remainingPercent?: unknown;
}

function numericValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function normalizeQuotaWindow(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const window = value as QuotaWindowRecord;
  const limit = finiteNumber(window.limit);
  const remaining = finiteNumber(window.remaining);
  if (limit === undefined || limit <= 0 || remaining === undefined) return value;

  const remainingPercent = Math.max(0, Math.min(100, remaining / limit * 100));
  return {
    ...window,
    remainingPercent,
    usedPercent: 100 - remainingPercent,
  };
}

function normalizeQuotaDocument(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const document = value as Record<string, unknown>;
  if (!Array.isArray(document.windows)) return value;
  return { ...document, windows: document.windows.map(normalizeQuotaWindow) };
}

function normalizeQuotaRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...row };

  if (row.snapshot) normalized.snapshot = normalizeQuotaDocument(row.snapshot);
  if (typeof row.quota_json === "string" && row.quota_json.trim()) {
    try {
      normalized.quota_json = JSON.stringify(normalizeQuotaDocument(JSON.parse(row.quota_json)));
    } catch {
      // Keep malformed legacy snapshots untouched; the view already handles them gracefully.
    }
  }
  return normalized;
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

export function normalizeCredentialPageQuotas<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const source = payload as T & { quotas?: unknown };
  if (!Array.isArray(source.quotas)) return payload;
  return { ...source, quotas: source.quotas.map(normalizeQuotaRecord) };
}

export function normalizeCredentialPage<T>(payload: T): T {
  return normalizeCredentialPageQuotas(normalizeCredentialPageActivity(payload));
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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const resolvedPath = path === "/overview" ? "/overview-v2" : path;
  const response = await fetch(`${API_BASE}${resolvedPath}`, { ...init, headers, credentials: "same-origin" });
  const payload = await parseResponse<T>(response);
  return resolvedPath.startsWith("/credentials/paged") ? normalizeCredentialPage(payload) : payload;
}

export const jsonBody = (value: unknown) => JSON.stringify(value);
