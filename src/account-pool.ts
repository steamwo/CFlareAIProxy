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

interface SmoothWeightRow {
  [key: string]: SqlStorageValue;
  credential_id: string;
  current_weight: number;
  configured_weight: number;
}

type AccountPoolStrategy = PoolStrategy | "smooth_weighted";

interface AcquirePayload {
  providerId: string;
  strategy: AccountPoolStrategy;
  candidates: PoolCandidate[];
  model?: string;
  sessionKey?: string | string[];
  leaseTtlMs?: number;
}

const MAX_CREDENTIAL_WEIGHT = 1_000_000;

function sessionKeys(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))].slice(0, 8);
}

function validSmoothWeight(candidate: PoolCandidate): boolean {
  return Number.isInteger(candidate.weight)
    && candidate.weight >= 1
    && candidate.weight <= MAX_CREDENTIAL_WEIGHT;
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
        CREATE TABLE IF NOT EXISTS smooth_weights (
          provider_id TEXT NOT NULL,
          credential_id TEXT NOT NULL,
          current_weight INTEGER NOT NULL DEFAULT 0,
          configured_weight INTEGER NOT NULL,
          PRIMARY KEY (provider_id, credential_id)
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
          cooldownEligible?: boolean;
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
        this.ctx.storage.sql.exec("DELETE FROM pool_stats; DELETE FROM leases; DELETE FROM affinities; DELETE FROM smooth_weights; DELETE FROM refresh_locks;");
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

    const affinityKeys = sessionKeys(payload.sessionKey);
    for (const sessionKey of affinityKeys) {
      const affinity = this.ctx.storage.sql
        .exec<{ credential_id: string }>(
          "SELECT credential_id FROM affinities WHERE session_key = ? AND expires_at > ?",
          sessionKey,
          now,
        )
        .toArray()[0];
      if (!affinity) continue;
      const candidate = candidates.find((entry) => entry.id === affinity.credential_id);
      const stat = candidate ? stats.get(candidate.id) : undefined;
      if (candidate && stat && stat.cooldown_until <= now && stat.inflight < candidate.maxConcurrency) {
        // Sticky sessions intentionally bypass scheduler advancement. Affinity is a routing
        // constraint, not another weighted selection event.
        return this.createLease(candidate.id, affinityKeys, payload.leaseTtlMs ?? 600_000, now);
      }
    }

    const available = candidates.filter((candidate) => {
      const stat = stats.get(candidate.id);
      return stat && stat.cooldown_until <= now && stat.inflight < candidate.maxConcurrency;
    });
    if (available.length === 0) {
      const model = typeof payload.model === "string" ? payload.model.trim() : "";
      throw new Error(model
        ? `All credentials are busy or cooling down for model ${JSON.stringify(model)}`
        : "All credentials are busy or cooling down");
    }

    const lowestPriority = Math.min(...available.map((candidate) => candidate.priority));
    const tier = available.filter((candidate) => candidate.priority === lowestPriority);
    let chosen: PoolCandidate;

    if (payload.strategy === "smooth_weighted") {
      chosen = this.nextSmoothWeighted(payload.providerId, tier);
    } else {
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
          // Preserve the deployed weighted cursor behavior. The new deterministic smooth
          // algorithm is opt-in through `smooth_weighted`.
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
    }

    return this.createLease(chosen.id, affinityKeys, payload.leaseTtlMs ?? 600_000, now);
  }

  private nextSmoothWeighted(providerId: string, candidates: PoolCandidate[]): PoolCandidate {
    const sorted = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
    if (sorted.some((candidate) => !validSmoothWeight(candidate))) {
      throw new Error(`Credential weight must be an integer between 1 and ${MAX_CREDENTIAL_WEIGHT}`);
    }

    const existing = this.ctx.storage.sql
      .exec<SmoothWeightRow>(
        "SELECT credential_id,current_weight,configured_weight FROM smooth_weights WHERE provider_id=? ORDER BY credential_id",
        providerId,
      )
      .toArray();
    const existingById = new Map(existing.map((row) => [row.credential_id, row] as const));
    const changed = existing.length !== sorted.length
      || sorted.some((candidate) => existingById.get(candidate.id)?.configured_weight !== candidate.weight);

    if (changed) {
      // Reset the whole active tier when availability, membership, or weights change. An
      // unavailable account therefore cannot accumulate credit and burst when it recovers.
      this.ctx.storage.sql.exec("DELETE FROM smooth_weights WHERE provider_id=?", providerId);
      for (const candidate of sorted) {
        this.ctx.storage.sql.exec(
          "INSERT INTO smooth_weights(provider_id,credential_id,current_weight,configured_weight) VALUES(?,?,0,?)",
          providerId,
          candidate.id,
          candidate.weight,
        );
      }
    }

    const currentById = changed
      ? new Map(sorted.map((candidate) => [candidate.id, 0] as const))
      : new Map(existing.map((row) => [row.credential_id, row.current_weight] as const));
    const totalWeight = sorted.reduce((sum, candidate) => sum + candidate.weight, 0);
    if (!Number.isSafeInteger(totalWeight)) throw new Error("Combined credential weight exceeds the safe scheduler range");

    let chosen = sorted[0]!;
    let chosenWeight = Number.NEGATIVE_INFINITY;
    const updated = new Map<string, number>();
    for (const candidate of sorted) {
      const current = (currentById.get(candidate.id) ?? 0) + candidate.weight;
      updated.set(candidate.id, current);
      if (current > chosenWeight) {
        chosen = candidate;
        chosenWeight = current;
      }
    }
    updated.set(chosen.id, (updated.get(chosen.id) ?? 0) - totalWeight);

    for (const candidate of sorted) {
      this.ctx.storage.sql.exec(
        "UPDATE smooth_weights SET current_weight=? WHERE provider_id=? AND credential_id=?",
        updated.get(candidate.id) ?? 0,
        providerId,
        candidate.id,
      );
    }
    return chosen;
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

  private createLease(credentialId: string, affinityKeys: string[], ttlMs: number, now: number): PoolLease {
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
    for (const sessionKey of affinityKeys) {
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

  private release(payload: { leaseId: string; success: boolean; statusCode?: number; cooldownMs?: number; cooldownEligible?: boolean }): void {
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
    const shouldCooldown = payload.cooldownEligible !== false
      && (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500);
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