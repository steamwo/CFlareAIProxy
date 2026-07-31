import type { Env } from "./types";

/**
 * Per-request detail rows. Short by design: they exist for debugging a failure that just
 * happened, and `logging-settings` already restricts which requests are persisted at all.
 */
export const REQUEST_LOG_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * Five-minute usage aggregates. These back the dashboard's 7-day availability chart and the
 * account-pool activity strips, so they must outlive the request logs by a wide margin. 90
 * days keeps quarter-over-quarter comparisons available while still bounding a table that
 * would otherwise grow forever: it is the only table with no expiry at all today.
 */
export const ACTIVITY_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * Abandoned OAuth sessions. `readSession` already refuses anything past `expires_at`, so
 * rows beyond that point are unreachable state — and they hold encrypted PKCE verifiers and
 * device codes, which is not something to keep indefinitely. The extra hour is slack for
 * clock skew between the Worker and the row's own deadline.
 */
export const OAUTH_SESSION_GRACE_SECONDS = 60 * 60;

/**
 * Rows removed per statement. D1 bounds how much a single statement may write, and the cron
 * handler gets one shot — Cloudflare does not retry a failed scheduled invocation — so a
 * backlog (cron outage, traffic spike) has to drain in bounded chunks instead of one
 * oversized DELETE that fails and leaves the backlog in place.
 */
const DELETE_BATCH_SIZE = 5_000;

/** Caps the work per invocation so a large backlog cannot exhaust the cron's CPU budget. */
const MAX_BATCHES_PER_TABLE = 20;

export function requestLogCutoff(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) - REQUEST_LOG_RETENTION_SECONDS;
}

export function activityCutoff(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) - ACTIVITY_RETENTION_SECONDS;
}

export function oauthSessionCutoff(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) - OAUTH_SESSION_GRACE_SECONDS;
}

/**
 * Deletes in bounded batches until the table is clean or the batch budget runs out.
 * Returning early on a short batch avoids issuing a final no-op statement.
 */
async function deleteInBatches(env: Env, sql: string, cutoff: number): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
    const result = await env.DB.prepare(sql).bind(cutoff, DELETE_BATCH_SIZE).run();
    const changes = Number(result.meta.changes ?? 0);
    removed += changes;
    if (changes < DELETE_BATCH_SIZE) break;
  }
  return removed;
}

export async function cleanupExpiredRequestLogs(env: Env, nowMs = Date.now()): Promise<number> {
  return deleteInBatches(
    env,
    "DELETE FROM request_logs WHERE rowid IN (SELECT rowid FROM request_logs WHERE created_at < ? LIMIT ?)",
    requestLogCutoff(nowMs),
  );
}

export async function cleanupExpiredActivity(env: Env, nowMs = Date.now()): Promise<number> {
  return deleteInBatches(
    env,
    "DELETE FROM request_activity_5m WHERE rowid IN (SELECT rowid FROM request_activity_5m WHERE bucket < ? LIMIT ?)",
    activityCutoff(nowMs),
  );
}

export async function cleanupExpiredOAuthSessions(env: Env, nowMs = Date.now()): Promise<number> {
  return deleteInBatches(
    env,
    "DELETE FROM oauth_sessions WHERE rowid IN (SELECT rowid FROM oauth_sessions WHERE expires_at < ? LIMIT ?)",
    oauthSessionCutoff(nowMs),
  );
}
