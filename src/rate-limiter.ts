import { DurableObject } from "cloudflare:workers";
import type { Env, RateLease, UsageAggregateEvent, UsageEvent } from "./types";

interface AcquirePayload {
  rpm: number;
  maxConcurrency: number;
  monthlyTokenLimit: number;
  estimatedTokens: number;
}

interface ActivityRow {
  [key: string]: SqlStorageValue;
  bucket: number;
  gateway_key_id: string;
  provider_id: string;
  credential_id: string;
  public_model: string;
  upstream_model: string;
  endpoint: string;
  requests: number;
  successes: number;
  failures: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  latency_sum_ms: number;
  first_token_sum_ms: number;
  first_token_samples: number;
  updated_at: number;
}

interface PendingFlushRow extends ActivityRow {
  flush_id: string;
}

const ACTIVITY_BUCKET_SECONDS = 5 * 60;
const QUEUE_BATCH_SIZE = 100;
const LEASE_TTL_MS = 15 * 60_000;
/** How long an expired-lease tombstone is kept so a late release() can still be billed. */
const LEASE_TOMBSTONE_TTL_MS = 60 * 60_000;

export class RateLimiter extends DurableObject<Env> {
  private alarmAt: number | null = null;
  private readonly environment: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.environment = env;
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS state (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          minute_window INTEGER NOT NULL,
          minute_count INTEGER NOT NULL,
          month_window TEXT NOT NULL,
          month_tokens INTEGER NOT NULL,
          inflight INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS leases (
          lease_id TEXT PRIMARY KEY,
          reserved_tokens INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lease_tombstones (
          lease_id TEXT PRIMARY KEY,
          refunded_tokens INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activity_buckets (
          bucket INTEGER NOT NULL,
          gateway_key_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          credential_id TEXT NOT NULL,
          public_model TEXT NOT NULL,
          upstream_model TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          requests INTEGER NOT NULL DEFAULT 0,
          successes INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          latency_sum_ms INTEGER NOT NULL DEFAULT 0,
          first_token_sum_ms INTEGER NOT NULL DEFAULT 0,
          first_token_samples INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(bucket,provider_id,credential_id,public_model,upstream_model,endpoint)
        );
        CREATE TABLE IF NOT EXISTS pending_flush (
          flush_id TEXT PRIMARY KEY,
          bucket INTEGER NOT NULL,
          gateway_key_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          credential_id TEXT NOT NULL,
          public_model TEXT NOT NULL,
          upstream_model TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          requests INTEGER NOT NULL,
          successes INTEGER NOT NULL,
          failures INTEGER NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL,
          cached_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          latency_sum_ms INTEGER NOT NULL,
          first_token_sum_ms INTEGER NOT NULL,
          first_token_samples INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      this.alarmAt = await this.ctx.storage.getAlarm();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/acquire") {
      const payload = await request.json() as AcquirePayload;
      return Response.json(this.acquire(payload));
    }
    if (request.method === "POST" && url.pathname === "/release") {
      const payload = await request.json() as { leaseId: string; actualTokens?: number; activity?: UsageEvent };
      await this.release(payload.leaseId, payload.actualTokens, payload.activity);
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  override async alarm(): Promise<void> {
    this.stagePendingFlush();
    const pending = this.ctx.storage.sql.exec<PendingFlushRow>(
      `SELECT flush_id,bucket,gateway_key_id,provider_id,credential_id,public_model,upstream_model,endpoint,
              requests,successes,failures,prompt_tokens,completion_tokens,cached_tokens,total_tokens,
              latency_sum_ms,first_token_sum_ms,first_token_samples,updated_at
       FROM pending_flush ORDER BY bucket`,
    ).toArray();
    if (!pending.length) {
      this.alarmAt = null;
      return;
    }

    try {
      for (let index = 0; index < pending.length; index += QUEUE_BATCH_SIZE) {
        const slice = pending.slice(index, index + QUEUE_BATCH_SIZE);
        await this.environment.USAGE_QUEUE.sendBatch(slice.map((row) => ({
          body: {
            kind: "aggregate",
            flushId: row.flush_id,
            bucket: row.bucket,
            sourceId: row.gateway_key_id,
            gatewayKeyId: row.gateway_key_id,
            providerId: row.provider_id,
            credentialId: row.credential_id,
            publicModel: row.public_model,
            upstreamModel: row.upstream_model,
            endpoint: row.endpoint,
            requests: row.requests,
            successes: row.successes,
            failures: row.failures,
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
            cachedTokens: row.cached_tokens,
            totalTokens: row.total_tokens,
            latencySumMs: row.latency_sum_ms,
            firstTokenSumMs: row.first_token_sum_ms,
            firstTokenSamples: row.first_token_samples,
            updatedAt: row.updated_at,
          } satisfies UsageAggregateEvent,
        })));
        for (const row of slice) {
          this.ctx.storage.sql.exec("DELETE FROM pending_flush WHERE flush_id = ?", row.flush_id);
        }
      }
      await this.rescheduleFlush();
    } catch (error) {
      this.alarmAt = Date.now() + 60_000;
      await this.ctx.storage.setAlarm(this.alarmAt);
      throw error;
    }
  }

  /**
   * Move the live counters into immutable pending_flush snapshots, each with its own
   * flush id. Snapshots never change afterwards, so a retried alarm resends byte-identical
   * events and the D1 consumer can drop them by flush id instead of double counting.
   * There is no await between the read and the delete, so counters cannot advance in between.
   */
  private stagePendingFlush(): void {
    const rows = this.ctx.storage.sql.exec<ActivityRow>(
      `SELECT bucket,gateway_key_id,provider_id,credential_id,public_model,upstream_model,endpoint,
              requests,successes,failures,prompt_tokens,completion_tokens,cached_tokens,total_tokens,
              latency_sum_ms,first_token_sum_ms,first_token_samples,updated_at
       FROM activity_buckets ORDER BY bucket`,
    ).toArray();
    for (const row of rows) {
      this.ctx.storage.sql.exec(
        `INSERT INTO pending_flush
          (flush_id,bucket,gateway_key_id,provider_id,credential_id,public_model,upstream_model,endpoint,
           requests,successes,failures,prompt_tokens,completion_tokens,cached_tokens,total_tokens,
           latency_sum_ms,first_token_sum_ms,first_token_samples,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        crypto.randomUUID(),
        row.bucket,
        row.gateway_key_id,
        row.provider_id,
        row.credential_id,
        row.public_model,
        row.upstream_model,
        row.endpoint,
        row.requests,
        row.successes,
        row.failures,
        row.prompt_tokens,
        row.completion_tokens,
        row.cached_tokens,
        row.total_tokens,
        row.latency_sum_ms,
        row.first_token_sum_ms,
        row.first_token_samples,
        row.updated_at,
      );
      this.ctx.storage.sql.exec(
        `DELETE FROM activity_buckets
         WHERE bucket=? AND provider_id=? AND credential_id=? AND public_model=?
           AND upstream_model=? AND endpoint=?`,
        row.bucket,
        row.provider_id,
        row.credential_id,
        row.public_model,
        row.upstream_model,
        row.endpoint,
      );
    }
  }

  private async rescheduleFlush(): Promise<void> {
    const remaining = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT (SELECT COUNT(*) FROM activity_buckets) + (SELECT COUNT(*) FROM pending_flush) AS count",
      )
      .one();
    if ((remaining?.count ?? 0) > 0) {
      this.alarmAt = Date.now() + 60_000;
      await this.ctx.storage.setAlarm(this.alarmAt);
    } else {
      this.alarmAt = null;
    }
  }

  private cleanup(now: number): void {
    const expired = this.ctx.storage.sql
      .exec<{ lease_id: string; reserved_tokens: number }>(
        "SELECT lease_id, reserved_tokens FROM leases WHERE expires_at <= ?",
        now,
      )
      .toArray();
    if (expired.length > 0) {
      const reserved = expired.reduce((sum, row) => sum + row.reserved_tokens, 0);
      this.ctx.storage.sql.exec(
        "UPDATE state SET inflight = MAX(0, inflight - ?), month_tokens = MAX(0, month_tokens - ?) WHERE singleton = 1",
        expired.length,
        reserved,
      );
      // Keep a tombstone: a stream can outlive the lease TTL, and its release() must still
      // bill the tokens it actually consumed and record the request in the activity buckets.
      for (const row of expired) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO lease_tombstones(lease_id, refunded_tokens, created_at) VALUES (?, ?, ?)",
          row.lease_id,
          row.reserved_tokens,
          now,
        );
      }
      this.ctx.storage.sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
    }
    this.ctx.storage.sql.exec("DELETE FROM lease_tombstones WHERE created_at <= ?", now - LEASE_TOMBSTONE_TTL_MS);
  }

  private acquire(payload: AcquirePayload): RateLease {
    const now = Date.now();
    this.cleanup(now);
    const minuteWindow = Math.floor(now / 60_000);
    const monthWindow = new Date(now).toISOString().slice(0, 7);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO state(singleton, minute_window, minute_count, month_window, month_tokens, inflight) VALUES (1, ?, 0, ?, 0, 0)",
      minuteWindow,
      monthWindow,
    );
    const state = this.ctx.storage.sql
      .exec<{
        minute_window: number;
        minute_count: number;
        month_window: string;
        month_tokens: number;
        inflight: number;
      }>("SELECT minute_window, minute_count, month_window, month_tokens, inflight FROM state WHERE singleton = 1")
      .one()!;

    let minuteCount = state.minute_count;
    let monthTokens = state.month_tokens;
    if (state.minute_window !== minuteWindow) minuteCount = 0;
    if (state.month_window !== monthWindow) monthTokens = 0;

    if (payload.rpm > 0 && minuteCount >= payload.rpm) {
      return { leaseId: "", allowed: false, reason: "RATE_LIMIT_EXCEEDED", retryAfterMs: 60_000 - (now % 60_000) };
    }
    if (payload.maxConcurrency > 0 && state.inflight >= payload.maxConcurrency) {
      return { leaseId: "", allowed: false, reason: "CONCURRENCY_LIMIT_EXCEEDED", retryAfterMs: 1000 };
    }
    const reservation = Math.max(0, payload.estimatedTokens);
    if (payload.monthlyTokenLimit > 0 && monthTokens + reservation > payload.monthlyTokenLimit) {
      return { leaseId: "", allowed: false, reason: "TOKEN_QUOTA_EXCEEDED" };
    }

    const leaseId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `UPDATE state SET minute_window = ?, minute_count = ?, month_window = ?,
       month_tokens = ?, inflight = inflight + 1 WHERE singleton = 1`,
      minuteWindow,
      minuteCount + 1,
      monthWindow,
      monthTokens + reservation,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO leases(lease_id, reserved_tokens, expires_at) VALUES (?, ?, ?)",
      leaseId,
      reservation,
      now + LEASE_TTL_MS,
    );
    return { leaseId, allowed: true };
  }

  private async release(leaseId: string, actualTokens?: number, activity?: UsageEvent): Promise<void> {
    const lease = this.ctx.storage.sql
      .exec<{ reserved_tokens: number }>("SELECT reserved_tokens FROM leases WHERE lease_id = ?", leaseId)
      .toArray()[0];
    if (lease) {
      this.ctx.storage.sql.exec("DELETE FROM leases WHERE lease_id = ?", leaseId);
      const chargedTokens = typeof actualTokens === "number" ? Math.max(0, actualTokens) : lease.reserved_tokens;
      this.ctx.storage.sql.exec(
        "UPDATE state SET inflight = MAX(0, inflight - 1), month_tokens = MAX(0, month_tokens + ?) WHERE singleton = 1",
        chargedTokens - lease.reserved_tokens,
      );
      if (activity) await this.recordActivity(activity);
      return;
    }

    const tombstone = this.ctx.storage.sql
      .exec<{ refunded_tokens: number }>("SELECT refunded_tokens FROM lease_tombstones WHERE lease_id = ?", leaseId)
      .toArray()[0];
    if (tombstone) {
      // cleanup() already released the inflight slot and refunded the reservation, so only
      // the tokens actually consumed are re-billed here.
      this.ctx.storage.sql.exec("DELETE FROM lease_tombstones WHERE lease_id = ?", leaseId);
      const chargedTokens = typeof actualTokens === "number" ? Math.max(0, actualTokens) : tombstone.refunded_tokens;
      if (chargedTokens > 0) {
        this.ctx.storage.sql.exec(
          "UPDATE state SET month_tokens = MAX(0, month_tokens + ?) WHERE singleton = 1",
          chargedTokens,
        );
      }
    }
    // Unknown lease id (tombstone already purged, or a duplicate release): accounting is
    // no longer possible, but the request must still show up in the activity buckets.
    if (activity) await this.recordActivity(activity);
  }

  private async recordActivity(event: UsageEvent): Promise<void> {
    const bucket = Math.floor(event.createdAt / ACTIVITY_BUCKET_SECONDS) * ACTIVITY_BUCKET_SECONDS;
    const success = event.statusCode >= 200 && event.statusCode < 400 && !event.errorCode;
    const gatewayKeyId = event.gatewayKeyId ?? "";
    const providerId = event.providerId ?? "";
    const credentialId = event.credentialId ?? "";
    const publicModel = event.publicModel ?? "";
    const upstreamModel = event.upstreamModel ?? "";
    const endpoint = event.endpoint ?? "";
    const firstTokenMs = typeof event.firstTokenMs === "number" ? Math.max(0, event.firstTokenMs) : 0;
    const firstTokenSamples = typeof event.firstTokenMs === "number" ? 1 : 0;
    this.ctx.storage.sql.exec(
      `INSERT INTO activity_buckets
        (bucket,gateway_key_id,provider_id,credential_id,public_model,upstream_model,endpoint,
         requests,successes,failures,prompt_tokens,completion_tokens,cached_tokens,total_tokens,
         latency_sum_ms,first_token_sum_ms,first_token_samples,updated_at)
       VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(bucket,provider_id,credential_id,public_model,upstream_model,endpoint) DO UPDATE SET
         requests=requests+1,
         successes=successes+excluded.successes,
         failures=failures+excluded.failures,
         prompt_tokens=prompt_tokens+excluded.prompt_tokens,
         completion_tokens=completion_tokens+excluded.completion_tokens,
         cached_tokens=cached_tokens+excluded.cached_tokens,
         total_tokens=total_tokens+excluded.total_tokens,
         latency_sum_ms=latency_sum_ms+excluded.latency_sum_ms,
         first_token_sum_ms=first_token_sum_ms+excluded.first_token_sum_ms,
         first_token_samples=first_token_samples+excluded.first_token_samples,
         updated_at=excluded.updated_at`,
      bucket,
      gatewayKeyId,
      providerId,
      credentialId,
      publicModel,
      upstreamModel,
      endpoint,
      success ? 1 : 0,
      success ? 0 : 1,
      Math.max(0, event.usage.promptTokens),
      Math.max(0, event.usage.completionTokens),
      Math.max(0, event.usage.cachedTokens),
      Math.max(0, event.usage.totalTokens),
      Math.max(0, event.latencyMs),
      firstTokenMs,
      firstTokenSamples,
      Math.floor(Date.now() / 1000),
    );
    if (this.alarmAt === null) {
      this.alarmAt = (bucket + ACTIVITY_BUCKET_SECONDS) * 1000 + 5_000;
      await this.ctx.storage.setAlarm(this.alarmAt);
    }
  }
}
