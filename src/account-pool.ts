import { DurableObject } from "cloudflare:workers";
import type { Env, PoolCandidate, PoolLease, PoolStrategy } from "./types";

interface PoolStat {
  [key: string]: SqlStorageValue;
  credential_id: string;
  inflight: number;
  cooldown_until: number;
  failures: number;
  last_used: number;
}

interface AcquirePayload {
  providerId: string;
  strategy: PoolStrategy;
  candidates: PoolCandidate[];
  sessionKey?: string;
  leaseTtlMs?: number;
}

export class AccountPool extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS pool_stats (
          credential_id TEXT PRIMARY KEY,
          inflight INTEGER NOT NULL DEFAULT 0,
          cooldown_until INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0,
          last_used INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS leases (
          lease_id TEXT PRIMARY KEY,
          credential_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS affinities (
          session_key TEXT PRIMARY KEY,
          credential_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS counters (
          provider_id TEXT PRIMARY KEY,
          cursor INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS refresh_locks (
          credential_id TEXT PRIMARY KEY,
          lock_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/acquire") {
        return Response.json(this.acquire(await request.json() as AcquirePayload));
      }
      if (request.method === "POST" && url.pathname === "/release") {
        const payload = await request.json() as {
          leaseId: string;
          success: boolean;
          statusCode?: number;
          cooldownMs?: number;
        };
        this.release(payload);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/lock") {
        const payload = await request.json() as { credentialId: string; ttlMs?: number };
        return Response.json(this.acquireRefreshLock(payload.credentialId, payload.ttlMs ?? 60_000));
      }
      if (request.method === "POST" && url.pathname === "/unlock") {
        const payload = await request.json() as { credentialId: string; lockId: string };
        this.releaseRefreshLock(payload.credentialId, payload.lockId);
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/reset") {
        this.ctx.storage.sql.exec("DELETE FROM pool_stats; DELETE FROM leases; DELETE FROM affinities; DELETE FROM refresh_locks;");
        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  private cleanup(now: number): void {
    const expired = this.ctx.storage.sql
      .exec<{ credential_id: string; count: number }>(
        "SELECT credential_id, COUNT(*) AS count FROM leases WHERE expires_at <= ? GROUP BY credential_id",
        now,
      )
      .toArray();
    for (const row of expired) {
      this.ctx.storage.sql.exec(
        "UPDATE pool_stats SET inflight = MAX(0, inflight - ?) WHERE credential_id = ?",
        row.count,
        row.credential_id,
      );
    }
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM affinities WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM refresh_locks WHERE expires_at <= ?", now);
  }

  private acquire(payload: AcquirePayload): PoolLease {
    const now = Date.now();
    this.cleanup(now);
    const candidates = payload.candidates.filter((candidate) => candidate.enabled);
    if (candidates.length === 0) throw new Error("No enabled credential candidates");

    for (const candidate of candidates) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO pool_stats (credential_id, inflight, cooldown_until, failures, last_used) VALUES (?, 0, 0, 0, 0)",
        candidate.id,
      );
    }

    const stats = new Map(
      this.ctx.storage.sql
        .exec<PoolStat>(
          `SELECT credential_id, inflight, cooldown_until, failures, last_used
           FROM pool_stats WHERE credential_id IN (${candidates.map(() => "?").join(",")})`,
          ...candidates.map((candidate) => candidate.id),
        )
        .toArray()
        .map((row) => [row.credential_id, row] as const),
    );

    if (payload.sessionKey) {
      const affinity = this.ctx.storage.sql
        .exec<{ credential_id: string }>(
          "SELECT credential_id FROM affinities WHERE session_key = ? AND expires_at > ?",
          payload.sessionKey,
          now,
        )
        .toArray()[0];
      if (affinity) {
        const candidate = candidates.find((entry) => entry.id === affinity.credential_id);
        const stat = candidate ? stats.get(candidate.id) : undefined;
        if (candidate && stat && stat.cooldown_until <= now && stat.inflight < candidate.maxConcurrency) {
          return this.createLease(candidate.id, payload.sessionKey, payload.leaseTtlMs ?? 600_000, now);
        }
      }
    }

    const available = candidates.filter((candidate) => {
      const stat = stats.get(candidate.id);
      return stat && stat.cooldown_until <= now && stat.inflight < candidate.maxConcurrency;
    });
    if (available.length === 0) throw new Error("All credentials are busy or cooling down");

    const lowestPriority = Math.min(...available.map((candidate) => candidate.priority));
    const tier = available.filter((candidate) => candidate.priority === lowestPriority);
    let chosen: PoolCandidate;

    switch (payload.strategy) {
      case "fill_first":
        chosen = tier.sort((a, b) => a.id.localeCompare(b.id))[0]!;
        break;
      case "least_inflight":
        chosen = tier.sort((a, b) => {
          const left = stats.get(a.id)!;
          const right = stats.get(b.id)!;
          const ratio = left.inflight / a.maxConcurrency - right.inflight / b.maxConcurrency;
          return ratio || left.last_used - right.last_used;
        })[0]!;
        break;
      case "weighted": {
        const expanded = tier.flatMap((candidate) => Array.from({ length: Math.min(100, Math.max(1, candidate.weight)) }, () => candidate));
        const cursor = this.nextCursor(payload.providerId, expanded.length);
        chosen = expanded[cursor]!;
        break;
      }
      case "round_robin":
      default: {
        const sorted = [...tier].sort((a, b) => a.id.localeCompare(b.id));
        const cursor = this.nextCursor(payload.providerId, sorted.length);
        chosen = sorted[cursor]!;
      }
    }

    return this.createLease(chosen.id, payload.sessionKey, payload.leaseTtlMs ?? 600_000, now);
  }

  private nextCursor(providerId: string, modulo: number): number {
    const existing = this.ctx.storage.sql
      .exec<{ cursor: number }>("SELECT cursor FROM counters WHERE provider_id = ?", providerId)
      .toArray()[0];
    const cursor = existing?.cursor ?? 0;
    this.ctx.storage.sql.exec(
      `INSERT INTO counters(provider_id, cursor) VALUES (?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET cursor = excluded.cursor`,
      providerId,
      (cursor + 1) % Math.max(1, modulo),
    );
    return cursor % Math.max(1, modulo);
  }

  private createLease(credentialId: string, sessionKey: string | undefined, ttlMs: number, now: number): PoolLease {
    const leaseId = crypto.randomUUID();
    const expiresAt = now + ttlMs;
    this.ctx.storage.sql.exec(
      "UPDATE pool_stats SET inflight = inflight + 1, last_used = ? WHERE credential_id = ?",
      now,
      credentialId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO leases(lease_id, credential_id, expires_at) VALUES (?, ?, ?)",
      leaseId,
      credentialId,
      expiresAt,
    );
    if (sessionKey) {
      this.ctx.storage.sql.exec(
        `INSERT INTO affinities(session_key, credential_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET credential_id = excluded.credential_id, expires_at = excluded.expires_at`,
        sessionKey,
        credentialId,
        now + 15 * 60_000,
      );
    }
    return { leaseId, credentialId, expiresAt };
  }

  private release(payload: { leaseId: string; success: boolean; statusCode?: number; cooldownMs?: number }): void {
    const lease = this.ctx.storage.sql
      .exec<{ credential_id: string }>("SELECT credential_id FROM leases WHERE lease_id = ?", payload.leaseId)
      .toArray()[0];
    if (!lease) return;
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE lease_id = ?", payload.leaseId);
    this.ctx.storage.sql.exec(
      "UPDATE pool_stats SET inflight = MAX(0, inflight - 1) WHERE credential_id = ?",
      lease.credential_id,
    );

    if (payload.success) {
      this.ctx.storage.sql.exec(
        "UPDATE pool_stats SET failures = 0, cooldown_until = 0 WHERE credential_id = ?",
        lease.credential_id,
      );
      return;
    }

    const status = payload.statusCode ?? 500;
    const shouldCooldown = status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
    if (shouldCooldown) {
      const stat = this.ctx.storage.sql
        .exec<{ failures: number }>("SELECT failures FROM pool_stats WHERE credential_id = ?", lease.credential_id)
        .toArray()[0];
      const failures = (stat?.failures ?? 0) + 1;
      const base = payload.cooldownMs ?? 60_000;
      const cooldown = Math.min(15 * 60_000, base * 2 ** Math.min(4, failures - 1));
      this.ctx.storage.sql.exec(
        "UPDATE pool_stats SET failures = ?, cooldown_until = ? WHERE credential_id = ?",
        failures,
        Date.now() + cooldown,
        lease.credential_id,
      );
    }
  }

  private acquireRefreshLock(credentialId: string, ttlMs: number): { acquired: boolean; lockId?: string } {
    const now = Date.now();
    this.cleanup(now);
    const existing = this.ctx.storage.sql
      .exec<{ lock_id: string; expires_at: number }>(
        "SELECT lock_id, expires_at FROM refresh_locks WHERE credential_id = ?",
        credentialId,
      )
      .toArray()[0];
    if (existing && existing.expires_at > now) return { acquired: false };
    const lockId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO refresh_locks(credential_id, lock_id, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(credential_id) DO UPDATE SET lock_id = excluded.lock_id, expires_at = excluded.expires_at`,
      credentialId,
      lockId,
      now + ttlMs,
    );
    return { acquired: true, lockId };
  }

  private releaseRefreshLock(credentialId: string, lockId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM refresh_locks WHERE credential_id = ? AND lock_id = ?",
      credentialId,
      lockId,
    );
  }
}
