import { getCredential, getProvider } from "./db";
import { providerAuthHeaders } from "./providers/headers";
import { isOpenCodeAnonymousCredential } from "./providers/opencode-anonymous";
import type { Credential, Env, ProviderConfig, QuotaSnapshot, QuotaSnapshotRow, QuotaWindow } from "./types";
import { normalizeBaseUrl, parseJson } from "./utils";
import { providerFetch } from "./upstream-fetch";

export interface QuotaRefreshResult {
  credentialId: string;
  providerId: string;
  status: QuotaSnapshot["status"];
  snapshot: QuotaSnapshot;
  error?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) { const parsed = Number(value); if (Number.isFinite(parsed)) return parsed; }
  return undefined;
}
function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function resetTimestamp(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric !== undefined) {
    if (numeric > 10_000_000_000) return Math.floor(numeric / 1000);
    if (numeric > 1_000_000_000) return Math.floor(numeric);
    return Math.floor(Date.now() / 1000 + numeric);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  const duration = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (duration) {
    const amount = Number(duration[1]);
    const factor = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[duration[2]!.toLowerCase() as "ms" | "s" | "m" | "h" | "d"];
    return Math.floor(Date.now() / 1000 + amount * factor);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}
function percent(value: unknown): number | undefined {
  const numeric = numberValue(value); return numeric === undefined ? undefined : Math.max(0, Math.min(100, numeric));
}
function configuredString(provider: ProviderConfig, key: string): string | undefined {
  return stringValue(provider.options[key] ?? provider.auth[key]);
}
function resolveUrl(provider: ProviderConfig, value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  const base = normalizeBaseUrl(provider.base_url);
  return `${base}${value.startsWith("/") ? "" : "/"}${value}`;
}
function getPath(root: unknown, path: unknown): unknown {
  if (typeof path !== "string" || !path.trim()) return undefined;
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!segment) continue;
    if (Array.isArray(current)) {
      const index = Number(segment); if (!Number.isInteger(index)) return undefined; current = current[index];
    } else current = object(current)[segment];
    if (current === undefined || current === null) break;
  }
  return current;
}

function parseCodexWindow(key: string, label: string, input: unknown): QuotaWindow | undefined {
  const window = object(input); if (!Object.keys(window).length) return undefined;
  const usedPercent = percent(window.used_percent ?? window.usedPercent ?? window.utilization);
  const remainingPercent = usedPercent === undefined ? percent(window.remaining_percent ?? window.remainingPercent) : Math.max(0, 100 - usedPercent);
  return {
    key, label, usedPercent, remainingPercent,
    resetAt: resetTimestamp(window.reset_at ?? window.resetAt ?? window.reset_after_seconds),
    windowSeconds: numberValue(window.limit_window_seconds ?? window.window_seconds ?? window.windowSeconds),
    limit: numberValue(window.limit), remaining: numberValue(window.remaining),
  };
}

export function parseCodexQuota(provider: ProviderConfig, payload: Record<string, unknown>): QuotaSnapshot {
  const rateLimit = object(payload.rate_limit ?? payload.rateLimit);
  const codeReview = object(payload.code_review_rate_limit ?? payload.codeReviewRateLimit);
  const windows = [
    parseCodexWindow("primary", "短周期", rateLimit.primary_window ?? rateLimit.primaryWindow),
    parseCodexWindow("secondary", "长周期", rateLimit.secondary_window ?? rateLimit.secondaryWindow),
    parseCodexWindow("code_review_primary", "代码审查短周期", codeReview.primary_window ?? codeReview.primaryWindow),
    parseCodexWindow("code_review_secondary", "代码审查长周期", codeReview.secondary_window ?? codeReview.secondaryWindow),
  ].filter((item): item is QuotaWindow => Boolean(item));
  const credits = object(payload.credits);
  return {
    provider: provider.id, plan: stringValue(payload.plan_type ?? payload.planType), status: "ok", windows,
    credits: Object.keys(credits).length ? {
      balance: credits.balance as string | number | undefined,
      unlimited: booleanValue(credits.unlimited),
      hasCredits: booleanValue(credits.has_credits ?? credits.hasCredits),
    } : undefined,
    source: "api", raw: payload,
  };
}

function parseGenericWindow(key: string, label: string, input: Record<string, unknown>): QuotaWindow | undefined {
  const limit = numberValue(input.limit ?? input.total ?? input.quota ?? input.max);
  const remaining = numberValue(input.remaining ?? input.left ?? input.available);
  let usedPercent = percent(input.used_percent ?? input.usedPercent ?? input.percent_used);
  if (usedPercent === undefined && limit !== undefined && remaining !== undefined && limit > 0) usedPercent = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
  const remainingPercent = usedPercent === undefined ? percent(input.remaining_percent ?? input.remainingPercent) : 100 - usedPercent;
  if (limit === undefined && remaining === undefined && usedPercent === undefined && remainingPercent === undefined) return undefined;
  return {
    key, label, limit, remaining, usedPercent, remainingPercent,
    resetAt: resetTimestamp(input.reset_at ?? input.resetAt ?? input.reset ?? input.reset_after ?? input.reset_after_seconds),
    windowSeconds: numberValue(input.window_seconds ?? input.windowSeconds),
  };
}

function configuredQuotaWindow(payload: Record<string, unknown>, index: number, config: Record<string, unknown>): QuotaWindow | undefined {
  const key = stringValue(config.key ?? config.name) ?? `window_${index + 1}`;
  const label = stringValue(config.label ?? config.name) ?? key;
  const source = typeof config.path === "string" ? object(getPath(payload, config.path)) : {};
  const read = (field: string, aliases: string[]): unknown => {
    const explicit = config[`${field}_path`];
    if (typeof explicit === "string") return getPath(payload, explicit);
    for (const alias of aliases) if (source[alias] !== undefined) return source[alias];
    return undefined;
  };
  return parseGenericWindow(key, label, {
    limit: read("limit", ["limit", "total", "quota", "max"]),
    remaining: read("remaining", ["remaining", "left", "available"]),
    used_percent: read("used_percent", ["used_percent", "usedPercent", "percent_used"]),
    remaining_percent: read("remaining_percent", ["remaining_percent", "remainingPercent"]),
    reset_at: read("reset", ["reset_at", "resetAt", "reset", "reset_after", "reset_after_seconds"]),
    window_seconds: read("window_seconds", ["window_seconds", "windowSeconds"]),
  });
}

export function parseGenericQuota(provider: ProviderConfig, payload: Record<string, unknown>): QuotaSnapshot {
  const root = object(payload.data ?? payload.result ?? payload.quota ?? payload.usage ?? payload);
  const windows: QuotaWindow[] = [];
  const configured = provider.options.quota_windows;
  if (Array.isArray(configured)) {
    for (const [index, value] of configured.entries()) { const parsed = configuredQuotaWindow(payload, index, object(value)); if (parsed) windows.push(parsed); }
  } else if (configured && typeof configured === "object") {
    for (const [key, pathValue] of Object.entries(configured as Record<string, unknown>)) {
      if (typeof pathValue !== "string") continue;
      const parsed = parseGenericWindow(key, key, object(getPath(payload, pathValue))); if (parsed) windows.push(parsed);
    }
  }
  if (!windows.length) {
    for (const value of [root.windows, root.rate_limits, root.rateLimits, payload.windows]) {
      if (!Array.isArray(value)) continue;
      for (const [index, item] of value.entries()) {
        const row = object(item); const key = stringValue(row.key ?? row.name ?? row.type) ?? `window_${index + 1}`;
        const parsed = parseGenericWindow(key, stringValue(row.label ?? row.name ?? row.type) ?? key, row); if (parsed) windows.push(parsed);
      }
    }
  }
  if (!windows.length) { const parsed = parseGenericWindow("default", "配额", root); if (parsed) windows.push(parsed); }
  const credits = object(root.credits ?? payload.credits);
  return {
    provider: provider.id, plan: stringValue(root.plan ?? root.plan_type ?? payload.plan_type), status: "ok", windows,
    credits: Object.keys(credits).length ? {
      balance: credits.balance as string | number | undefined,
      unlimited: booleanValue(credits.unlimited),
      hasCredits: booleanValue(credits.has_credits ?? credits.hasCredits),
    } : undefined,
    source: "configured", raw: payload,
  };
}

export function parseQoderQuota(provider: ProviderConfig, payload: Record<string, unknown>): QuotaSnapshot {
  const root = object(payload.data ?? payload.result ?? payload.payload ?? payload);
  const resetAt = root.expiresAt ?? root.expires_at ?? payload.expiresAt ?? payload.expires_at;
  const windows: QuotaWindow[] = [];
  const user = object(root.userQuota ?? root.user_quota);
  const organization = object(root.orgResourcePackage ?? root.org_resource_package ?? root.organizationQuota);
  const userWindow = parseGenericWindow("user", "个人额度", {
    limit: user.total ?? user.limit,
    remaining: user.remaining ?? user.left,
    used_percent: user.percentage ?? user.usedPercent ?? root.totalUsagePercentage,
    reset_at: user.resetAt ?? user.reset_at ?? resetAt,
  });
  const organizationWindow = parseGenericWindow("organization", "组织资源包", {
    limit: organization.total ?? organization.limit,
    remaining: organization.remaining ?? organization.left,
    used_percent: organization.percentage ?? organization.usedPercent,
    reset_at: organization.resetAt ?? organization.reset_at ?? resetAt,
  });
  if (userWindow) windows.push(userWindow);
  if (organizationWindow && (organizationWindow.limit ?? 0) > 0) windows.push(organizationWindow);
  return {
    provider: provider.id,
    plan: stringValue(root.plan ?? root.planType ?? root.subscriptionTitle) ?? (windows.length ? "Qoder" : undefined),
    status: "ok",
    windows,
    credits: userWindow ? { balance: userWindow.remaining, hasCredits: (userWindow.remaining ?? 0) > 0 } : undefined,
    source: "api",
    raw: payload,
  };
}

function quotaUrl(provider: ProviderConfig, credential: Credential): string | undefined {
  const configured = configuredString(provider, "quota_url"); if (configured) return resolveUrl(provider, configured);
  if (provider.kind === "codex") return "https://chatgpt.com/backend-api/wham/usage";
  if (provider.kind === "qoder") return "https://openapi.qoder.sh/api/v2/quota/usage";
  return undefined;
}

async function saveSnapshot(env: Env, credentialId: string, providerId: string, snapshot: QuotaSnapshot, error?: string): Promise<QuotaSnapshot> {
  const previousRow = await env.DB.prepare("SELECT quota_json,status FROM quota_snapshots WHERE credential_id=?")
    .bind(credentialId).first<{ quota_json: string; status: QuotaSnapshot["status"] }>();
  const previous = previousRow
    ? parseJson<QuotaSnapshot>(previousRow.quota_json, { provider: providerId, status: previousRow.status, windows: [], source: "configured" })
    : undefined;
  let stored = snapshot;
  if (previous && snapshot.source === "headers") {
    const windows = new Map(previous.windows.map((window) => [window.key, window]));
    for (const window of snapshot.windows) windows.set(window.key, window);
    stored = {
      ...previous,
      ...snapshot,
      plan: snapshot.plan ?? previous.plan,
      credits: snapshot.credits ?? previous.credits,
      windows: [...windows.values()],
      raw: previous.raw,
    };
  } else if (previous && snapshot.status !== "ok" && (previous.windows.length || previous.credits || previous.plan)) {
    stored = { ...previous, status: snapshot.status, source: snapshot.source };
  }
  const now = Math.floor(Date.now() / 1000); const ttl = snapshot.status === "ok" ? 300 : 60;
  await env.DB.prepare(
    `INSERT INTO quota_snapshots(credential_id,provider_id,status,quota_json,error_message,fetched_at,expires_at)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(credential_id) DO UPDATE SET
       provider_id=excluded.provider_id,status=excluded.status,quota_json=excluded.quota_json,
       error_message=excluded.error_message,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at`,
  ).bind(credentialId, providerId, snapshot.status, JSON.stringify(stored), error?.slice(0, 1000) ?? null, now, now + ttl).run();
  return stored;
}

export async function refreshCredentialQuota(env: Env, credentialId: string): Promise<QuotaRefreshResult> {
  const credential = await getCredential(env, credentialId); const provider = await getProvider(env, credential.provider_id); const url = quotaUrl(provider, credential);
  if (!url) {
    const snapshot: QuotaSnapshot = { provider: provider.id, status: "unsupported", windows: [], source: "configured" };
    const error = "该供应商没有公开或已配置的配额接口";
    const stored = await saveSnapshot(env, credential.id, provider.id, snapshot, error);
    return { credentialId, providerId: provider.id, status: snapshot.status, snapshot: stored, error };
  }
  try {
    const headers = providerAuthHeaders(provider, credential);
    if (provider.kind === "qoder") {
      headers.set("accept", "application/json");
      headers.set("user-agent", headers.get("user-agent") ?? "CFlareAPI/0.5.3");
    }
    const extra = provider.options.quota_headers;
    if (extra && typeof extra === "object" && !Array.isArray(extra)) for (const [key, value] of Object.entries(extra as Record<string, unknown>)) if (typeof value === "string") headers.set(key, value);
    const timeoutMs = typeof provider.options.quota_timeout_ms === "number" ? Math.max(1000, provider.options.quota_timeout_ms) : 20_000;
    const response = await providerFetch(env, provider, url, {
      method: configuredString(provider, "quota_method") ?? "GET", headers, redirect: "manual",
    }, { purpose: "quota", timeoutMs });
    const text = await response.text(); if (!response.ok) throw new Error(`${provider.name} quota returned ${response.status}: ${text.slice(0, 500)}`);
    const parsed: unknown = text ? JSON.parse(text) : {}; const payload = object(parsed);
    const snapshot = provider.kind === "codex"
      ? parseCodexQuota(provider, payload)
      : provider.kind === "qoder"
        ? parseQoderQuota(provider, payload)
        : parseGenericQuota(provider, payload);
    if (!snapshot.windows.length && !snapshot.credits && !snapshot.plan) throw new Error(`${provider.name} quota payload did not contain recognizable quota fields`);
    const stored = await saveSnapshot(env, credential.id, provider.id, snapshot);
    return { credentialId, providerId: provider.id, status: snapshot.status, snapshot: stored };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const snapshot: QuotaSnapshot = { provider: provider.id, status: "error", windows: [], source: "api" };
    const stored = await saveSnapshot(env, credential.id, provider.id, snapshot, message);
    return { credentialId, providerId: provider.id, status: snapshot.status, snapshot: stored, error: message };
  }
}

export async function refreshAllQuotas(env: Env): Promise<QuotaRefreshResult[]> {
  const result = await env.DB.prepare("SELECT id FROM credentials WHERE enabled=1 ORDER BY provider_id,priority,created_at").all<{ id: string }>();
  const output: QuotaRefreshResult[] = [];
  for (let index = 0; index < result.results.length; index += 4) output.push(...await Promise.all(result.results.slice(index, index + 4).map((row) => refreshCredentialQuota(env, row.id))));
  return output;
}

export async function listQuotaSnapshots(env: Env): Promise<Array<QuotaSnapshotRow & { snapshot: QuotaSnapshot; credential_label: string; provider_name: string }>> {
  const result = await env.DB.prepare(
    `SELECT q.*, c.label AS credential_label, p.name AS provider_name
     FROM quota_snapshots q JOIN credentials c ON c.id=q.credential_id JOIN providers p ON p.id=q.provider_id
     ORDER BY p.name,c.priority,c.created_at`,
  ).all<QuotaSnapshotRow & { credential_label: string; provider_name: string }>();
  return result.results.map((row) => ({ ...row, snapshot: parseJson<QuotaSnapshot>(row.quota_json, { provider: row.provider_id, status: row.status, windows: [], source: "configured" }) }));
}

function headerNumber(headers: Headers, names: string[]): number | undefined {
  for (const name of names) { const parsed = numberValue(headers.get(name)); if (parsed !== undefined) return parsed; }
  return undefined;
}

export async function captureQuotaHeaders(env: Env, credentialId: string, providerId: string, headers: Headers): Promise<void> {
  if (isOpenCodeAnonymousCredential(credentialId)) return;
  const limitRequests = headerNumber(headers, ["x-ratelimit-limit-requests", "ratelimit-limit"]);
  const remainingRequests = headerNumber(headers, ["x-ratelimit-remaining-requests", "ratelimit-remaining"]);
  const limitTokens = headerNumber(headers, ["x-ratelimit-limit-tokens"]);
  const remainingTokens = headerNumber(headers, ["x-ratelimit-remaining-tokens"]);
  if (limitRequests === undefined && remainingRequests === undefined && limitTokens === undefined && remainingTokens === undefined) return;
  const windows: QuotaWindow[] = [];
  const requestWindow = parseGenericWindow("requests", "请求", { limit: limitRequests, remaining: remainingRequests, reset: headers.get("x-ratelimit-reset-requests") ?? headers.get("ratelimit-reset") });
  const tokenWindow = parseGenericWindow("tokens", "Token", { limit: limitTokens, remaining: remainingTokens, reset: headers.get("x-ratelimit-reset-tokens") });
  if (requestWindow) windows.push(requestWindow); if (tokenWindow) windows.push(tokenWindow);
  await saveSnapshot(env, credentialId, providerId, { provider: providerId, status: "ok", windows, source: "headers" });
}
