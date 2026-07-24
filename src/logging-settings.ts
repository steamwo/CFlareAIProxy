import type { Env, LogLevel, LoggingSettings, UsageEvent } from "./types";
import { parseJson } from "./utils";

const SETTINGS_KEY = "request_logging";
const CACHE_TTL_MS = 30_000;
const DEFAULT_SETTINGS: LoggingSettings = {
  requestLoggingEnabled: true,
  level: "error",
};

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let cached: { value: LoggingSettings; expiresAt: number } | undefined;

function normalizeLevel(value: unknown): LogLevel {
  return value === "warn" || value === "info" || value === "debug" ? value : "error";
}

function normalizeSettings(value: unknown): LoggingSettings {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    requestLoggingEnabled: record.requestLoggingEnabled !== false,
    level: normalizeLevel(record.level),
  };
}

export async function getLoggingSettings(env: Env): Promise<LoggingSettings> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const row = await env.DB.prepare("SELECT value_json FROM system_settings WHERE key=?")
    .bind(SETTINGS_KEY)
    .first<{ value_json: string }>()
    .catch(() => null);
  const value = row?.value_json
    ? normalizeSettings(parseJson<Record<string, unknown>>(row.value_json, DEFAULT_SETTINGS))
    : DEFAULT_SETTINGS;
  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function updateLoggingSettings(env: Env, input: Partial<LoggingSettings>): Promise<LoggingSettings> {
  const current = await getLoggingSettings(env);
  const value = normalizeSettings({
    requestLoggingEnabled: typeof input.requestLoggingEnabled === "boolean"
      ? input.requestLoggingEnabled
      : current.requestLoggingEnabled,
    level: input.level ?? current.level,
  });
  await env.DB.prepare(
    `INSERT INTO system_settings(key,value_ciphertext,value_json,updated_at)
     VALUES(?,NULL,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
  ).bind(SETTINGS_KEY, JSON.stringify(value), Math.floor(Date.now() / 1000)).run();
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export function shouldPersistError(settings: LoggingSettings, event: UsageEvent): boolean {
  if (!settings.requestLoggingEnabled) return false;
  const failed = event.statusCode < 200 || event.statusCode >= 400 || Boolean(event.errorCode);
  if (!failed) return false;
  if (settings.level === "error") return event.statusCode >= 500 || Boolean(event.errorCode);
  return true;
}

export function runtimeLog(
  settings: LoggingSettings,
  level: LogLevel,
  payload: Record<string, unknown>,
): void {
  if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[settings.level]) return;
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "info") console.info(line);
  else console.debug(line);
}
