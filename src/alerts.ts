import { decryptSecret, encryptSecret } from "./crypto";
import { GatewayError } from "./errors";
import type { Env } from "./types";
import { parseJson, truncate } from "./utils";

export const ALERT_TYPES = [
  "provider_circuit_open",
  "credentials_exhausted",
  "usage_queue_dlq",
  "cron_cleanup_failed",
  "alert_test",
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];
export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertInput {
  type: AlertType;
  severity: AlertSeverity;
  /**
   * Deduplication scope. Alerts sharing the same (type, target) collapse into a single
   * notification per window, so this must identify the failing resource (a provider id,
   * a retention task name) and never carry a per-occurrence value such as a timestamp.
   */
  target: string;
  title: string;
  detail: string;
  context?: Record<string, unknown>;
}

/**
 * Vendor-neutral envelope. Discord/Slack/DingTalk each want a different body shape, so the
 * gateway posts one stable JSON document and leaves the rendering to a relay the operator
 * controls. Field names stay English; operator-facing prose is Chinese like the console.
 */
export interface AlertPayload {
  schema: "cflare.alert.v1";
  type: AlertType;
  severity: AlertSeverity;
  target: string;
  title: string;
  detail: string;
  service: string;
  /** ISO-8601 UTC, for humans. */
  timestamp: string;
  /** Epoch milliseconds, for machines that want to order or window events. */
  timestampMs: number;
  context: Record<string, unknown>;
}

export interface AlertSettingsSummary {
  enabled: boolean;
  hasWebhook: boolean;
  /** Masked view of the configured endpoint; the full URL is never returned. */
  webhookHost: string;
  dedupeWindowMinutes: number;
  updatedAt: number;
}

export interface AlertSettingsInput {
  webhookUrl?: string;
  enabled?: boolean;
  dedupeWindowMinutes?: number;
}

export type AlertSkipReason = "disabled" | "not_configured" | "deduplicated";

export interface AlertDeliveryResult {
  delivered: boolean;
  skipped?: AlertSkipReason;
  status?: number;
  error?: string;
}

const SETTINGS_KEY = "alert_webhook";
const SETTINGS_CACHE_TTL_MS = 30_000;

/**
 * Default deduplication window.
 *
 * Chosen to match the circuit breaker's ceiling: backoffMsForFailures() caps at 15 minutes
 * (MAX_BACKOFF_MS) and the rolling failure window is 10 minutes, so a provider that stays
 * broken re-opens its breaker at most once per 15 minutes in steady state. A shorter window
 * would emit several notifications per backoff cycle for a single ongoing incident — exactly
 * the flooding that makes operators mute the channel — while a longer one would swallow the
 * "still down" reminder that tells an operator the incident has not self-healed. It also
 * keeps the KV dedupe key far below the ~1 write/second per-key limit.
 */
export const DEFAULT_DEDUPE_WINDOW_MINUTES = 15;
const MIN_DEDUPE_WINDOW_MINUTES = 1;
const MAX_DEDUPE_WINDOW_MINUTES = 24 * 60;
/** KV rejects an expirationTtl below 60 seconds, so a 1-minute window is the floor. */
const MIN_KV_TTL_SECONDS = 60;
const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_DETAIL_CHARS = 1000;
const MAX_TARGET_CHARS = 120;
const DEDUPE_MEMO_CAPACITY = 128;

interface ResolvedAlertSettings extends AlertSettingsSummary {
  webhookUrl: string;
}

let settingsCache: { value: ResolvedAlertSettings; expiresAt: number } | undefined;

/**
 * Suppression timestamps observed by this isolate. KV is eventually consistent, so a burst of
 * failures inside one isolate could each read a stale "not sent yet" and all fire. Recording
 * the send synchronously here collapses that burst; KV still covers the cross-isolate case.
 */
const dedupeMemo = new Map<string, number>();

/** Test seam: drops the settings cache and the isolate-local dedupe memo. */
export function resetAlertsState(): void {
  settingsCache = undefined;
  dedupeMemo.clear();
}

function clampWindowMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DEDUPE_WINDOW_MINUTES;
  return Math.min(MAX_DEDUPE_WINDOW_MINUTES, Math.max(MIN_DEDUPE_WINDOW_MINUTES, Math.trunc(value)));
}

function maskWebhook(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.hostname + (parsed.port ? `:${parsed.port}` : "");
  } catch {
    return "";
  }
}

/**
 * Admin-supplied, so this is a shape check rather than an SSRF boundary: an administrator who
 * can set the webhook can already read every credential through the console. HTTPS is required
 * off-loopback because the payload names failing providers and accounts.
 */
export function validateWebhookUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GatewayError(400, "ALERT_WEBHOOK_INVALID", "告警 Webhook 必须是合法的 URL", "invalid_request_error");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new GatewayError(400, "ALERT_WEBHOOK_INVALID", "告警 Webhook 必须使用 HTTPS", "invalid_request_error");
  }
  return parsed.toString();
}

interface AlertSettingsRow {
  value_ciphertext: string | null;
  value_json: string;
  updated_at: number;
}

async function readSettingsRow(env: Env): Promise<AlertSettingsRow | null> {
  return env.DB.prepare("SELECT value_ciphertext,value_json,updated_at FROM system_settings WHERE key=?")
    .bind(SETTINGS_KEY)
    .first<AlertSettingsRow>();
}

async function loadAlertSettings(env: Env): Promise<ResolvedAlertSettings> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) return settingsCache.value;
  // A fresh deployment may not have migration 0011 applied yet, and a missing D1 binding
  // makes prepare() throw synchronously; both mean "no webhook configured" rather than a
  // reason to fail whatever the caller was doing.
  const row = await readSettingsRow(env).catch(() => null);
  const options = parseJson<Record<string, unknown>>(row?.value_json, {});
  const webhookUrl = row?.value_ciphertext
    ? await decryptSecret(row.value_ciphertext, env.MASTER_KEY, env.MASTER_KEY_PREVIOUS).catch(() => "")
    : "";
  const value: ResolvedAlertSettings = {
    enabled: options.enabled === true,
    hasWebhook: Boolean(webhookUrl),
    webhookHost: maskWebhook(webhookUrl),
    dedupeWindowMinutes: clampWindowMinutes(options.dedupeWindowMinutes),
    updatedAt: Number(row?.updated_at ?? 0),
    webhookUrl,
  };
  settingsCache = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return value;
}

function summarize(settings: ResolvedAlertSettings): AlertSettingsSummary {
  const { webhookUrl: _webhookUrl, ...summary } = settings;
  return summary;
}

export async function getAlertSettings(env: Env): Promise<AlertSettingsSummary> {
  return summarize(await loadAlertSettings(env));
}

export async function updateAlertSettings(env: Env, input: AlertSettingsInput): Promise<AlertSettingsSummary> {
  const current = await loadAlertSettings(env);
  const webhookUrl = input.webhookUrl === undefined
    ? current.webhookUrl
    : input.webhookUrl.trim()
      ? validateWebhookUrl(input.webhookUrl.trim())
      : "";
  const dedupeWindowMinutes = input.dedupeWindowMinutes === undefined
    ? current.dedupeWindowMinutes
    : clampWindowMinutes(input.dedupeWindowMinutes);
  // Enabling without a destination would silently drop every alert, so the switch is pinned
  // to the presence of a webhook rather than trusted from the request.
  const enabled = (input.enabled === undefined ? current.enabled : input.enabled) && Boolean(webhookUrl);
  const ciphertext = webhookUrl ? await encryptSecret(webhookUrl, env.MASTER_KEY) : null;
  const updatedAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO system_settings(key,value_ciphertext,value_json,updated_at)
     VALUES(?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       value_ciphertext=excluded.value_ciphertext,
       value_json=excluded.value_json,
       updated_at=excluded.updated_at`,
  ).bind(SETTINGS_KEY, ciphertext, JSON.stringify({ enabled, dedupeWindowMinutes }), updatedAt).run();
  const value: ResolvedAlertSettings = {
    enabled,
    hasWebhook: Boolean(webhookUrl),
    webhookHost: maskWebhook(webhookUrl),
    dedupeWindowMinutes,
    updatedAt,
    webhookUrl,
  };
  settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
  // Window changes must not stay masked by suppressions taken under the old window.
  dedupeMemo.clear();
  return summarize(value);
}

export async function deleteAlertSettings(env: Env): Promise<AlertSettingsSummary> {
  await env.DB.prepare("DELETE FROM system_settings WHERE key=?").bind(SETTINGS_KEY).run();
  settingsCache = undefined;
  dedupeMemo.clear();
  return getAlertSettings(env);
}

function dedupeKey(type: AlertType, target: string): string {
  const safe = target.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, MAX_TARGET_CHARS) || "_";
  return `alert-dedupe:v1:${type}:${safe}`;
}

function memoSet(key: string, sentAt: number): void {
  if (dedupeMemo.size >= DEDUPE_MEMO_CAPACITY && !dedupeMemo.has(key)) dedupeMemo.clear();
  dedupeMemo.set(key, sentAt);
}

/**
 * Claims the (type, target) slot for the current window. Returns false when a notification
 * for the same slot was already sent inside the window.
 *
 * The claim is recorded on attempt, not on successful delivery: the point of the window is to
 * bound outbound traffic, and a webhook that is itself failing must not be retried once per
 * upstream failure. Delivery problems surface in the runtime log instead.
 */
async function claimDedupeSlot(env: Env, type: AlertType, target: string, windowMs: number, now: number): Promise<boolean> {
  const key = dedupeKey(type, target);
  const memoized = dedupeMemo.get(key);
  if (memoized !== undefined && now - memoized < windowMs) return false;

  const raw = await env.CONFIG_CACHE.get(key, "text").catch(() => null);
  const stored = parseJson<{ sentAt?: unknown }>(raw, {});
  // Compare against the current window rather than trusting the KV TTL, so shrinking the
  // window in the console takes effect immediately instead of after the old TTL expires.
  if (typeof stored.sentAt === "number" && now - stored.sentAt < windowMs) {
    memoSet(key, stored.sentAt);
    return false;
  }

  memoSet(key, now);
  // Persist the claim so other isolates suppress the same alert. Without this the memo is
  // the only record, and a fleet of N isolates would each deliver the first occurrence.
  // The TTL is a floor (KV enforces a 60s minimum) and is only a garbage-collection hint —
  // suppression is decided by comparing sentAt against the current window above, so
  // shortening the window in the console takes effect immediately.
  const ttlSeconds = Math.max(60, Math.ceil(windowMs / 1000));
  await env.CONFIG_CACHE.put(key, JSON.stringify({ sentAt: now }), { expirationTtl: ttlSeconds })
    .catch(() => undefined);
  return true;
}

export function buildAlertPayload(env: Env, input: AlertInput, now: number): AlertPayload {
  return {
    schema: "cflare.alert.v1",
    type: input.type,
    severity: input.severity,
    target: truncate(input.target, MAX_TARGET_CHARS),
    title: truncate(input.title, 200),
    detail: truncate(input.detail, MAX_DETAIL_CHARS),
    service: env.APP_NAME ?? "CFlareAIProxy",
    timestamp: new Date(now).toISOString(),
    timestampMs: now,
    context: input.context ?? {},
  };
}

async function postWebhook(url: string, payload: AlertPayload): Promise<AlertDeliveryResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "CFlareAIProxy-Alerts/1" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (response.ok) return { delivered: true, status: response.status };
  const body = await response.text().catch(() => "");
  return { delivered: false, status: response.status, error: truncate(body, 200) };
}

/**
 * Delivers one alert. Never throws: alerting is observability, and a misconfigured or
 * unreachable webhook must not be able to fail a request, a cron sweep or a queue batch.
 */
export async function sendAlert(
  env: Env,
  input: AlertInput,
  /**
   * Both flags exist only for the admin "send test alert" button: a test must reach the
   * endpoint before the operator flips the switch on, and must not be swallowed by a
   * suppression window that a real ongoing incident is holding.
   */
  options: { bypassDedupe?: boolean; bypassEnabled?: boolean } = {},
): Promise<AlertDeliveryResult> {
  try {
    const settings = await loadAlertSettings(env);
    if (!settings.webhookUrl) return { delivered: false, skipped: "not_configured" };
    if (!settings.enabled && !options.bypassEnabled) return { delivered: false, skipped: "disabled" };

    const now = Date.now();
    if (!options.bypassDedupe) {
      const claimed = await claimDedupeSlot(env, input.type, input.target, settings.dedupeWindowMinutes * 60_000, now);
      if (!claimed) return { delivered: false, skipped: "deduplicated" };
    }

    const result = await postWebhook(settings.webhookUrl, buildAlertPayload(env, input, now));
    if (!result.delivered) {
      console.error(JSON.stringify({
        event: "alert_webhook_failed", alert_type: input.type, target: input.target,
        status: result.status, error: result.error,
      }));
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "alert_webhook_error", alert_type: input.type, target: input.target, error: message }));
    return { delivered: false, error: truncate(message, 200) };
  }
}

/** Keeps context-less dispatches referenced so they are not collected before settling. */
const inFlight = new Set<Promise<void>>();

/**
 * Fire-and-forget wrapper for callers on a latency-sensitive path.
 *
 * `waitUntil` should be supplied wherever an ExecutionContext is reachable so the runtime keeps
 * the isolate alive until the POST settles. Callers that have no context (routing-health runs
 * deep inside the failure path) fall back to a retained promise, which survives for as long as
 * the surrounding invocation does.
 */
export function dispatchAlert(
  env: Env,
  input: AlertInput,
  waitUntil?: (promise: Promise<unknown>) => void,
): void {
  const pending = sendAlert(env, input).then(() => undefined);
  if (waitUntil) {
    waitUntil(pending);
    return;
  }
  inFlight.add(pending);
  void pending.finally(() => inFlight.delete(pending));
}
