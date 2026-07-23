import { DurableObject } from "cloudflare:workers";
import type { Env, RateLease } from "./types";

interface AcquirePayload {
  rpm: number;
  maxConcurrency: number;
  monthlyTokenLimit: number;
  estimatedTokens: number;
}

export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/acquire") {
      const payload = await request.json() as AcquirePayload;
      return Response.json(this.acquire(payload));
    }
    if (request.method === "POST" && url.pathname === "/release") {
      const payload = await request.json() as { leaseId: string; actualTokens?: number };
      this.release(payload.leaseId, payload.actualTokens);
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  private cleanup(now: number): void {
    const expired = this.ctx.storage.sql
      .exec<{ count: number; reserved: number }>(
        "SELECT COUNT(*) AS count, COALESCE(SUM(reserved_tokens), 0) AS reserved FROM leases WHERE expires_at <= ?",
        now,
      )
      .one();
    if ((expired?.count ?? 0) > 0) {
      this.ctx.storage.sql.exec(
        "UPDATE state SET inflight = MAX(0, inflight - ?), month_tokens = MAX(0, month_tokens - ?) WHERE singleton = 1",
        expired!.count,
        expired!.reserved,
      );
      this.ctx.storage.sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
    }
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
      now + 15 * 60_000,
    );
    return { leaseId, allowed: true };
  }

  private release(leaseId: string, actualTokens?: number): void {
    const lease = this.ctx.storage.sql
      .exec<{ reserved_tokens: number }>("SELECT reserved_tokens FROM leases WHERE lease_id = ?", leaseId)
      .toArray()[0];
    if (!lease) return;
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE lease_id = ?", leaseId);
    const chargedTokens = typeof actualTokens === "number" ? Math.max(0, actualTokens) : lease.reserved_tokens;
    const delta = chargedTokens - lease.reserved_tokens;
    this.ctx.storage.sql.exec(
      "UPDATE state SET inflight = MAX(0, inflight - 1), month_tokens = MAX(0, month_tokens + ?) WHERE singleton = 1",
      delta,
    );
  }
}
