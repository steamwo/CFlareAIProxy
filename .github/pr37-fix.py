from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one exact match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str, flags: int = 0) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}: {pattern[:120]!r}")
    write(path, updated)


# 1) Keep backup restore atomic while packing rows into a bounded number of D1 statements.
replace_once(
    "src/admin.ts",
    '''const BACKUP_MAX_TABLE_ROWS = 20_000;
const BACKUP_MAX_TOTAL_ROWS = 50_000;
const BACKUP_MAX_IMPORT_BYTES = 32 * 1024 * 1024;''',
    '''const BACKUP_MAX_TABLE_ROWS = 20_000;
const BACKUP_MAX_TOTAL_ROWS = 50_000;
const BACKUP_MAX_IMPORT_BYTES = 32 * 1024 * 1024;
/** Keep each JSON binding below D1's 2 MB string/BLOB limit with safety margin. */
const BACKUP_JSON_CHUNK_BYTES = 1_500_000;
/** Workers Free permits 50 D1 queries per invocation; one batch must fit that floor. */
const BACKUP_MAX_BATCH_STATEMENTS = 50;''',
)
replace_once(
    "src/admin.ts",
    '''  usage_flush_dedupe: "用量写入去重标记，属于运行时状态",
};''',
    '''  usage_flush_dedupe: "用量写入去重标记，属于运行时状态",
  credential_refresh_attempts: "批量刷新公平调度游标，可由后续任务重新生成",
};''',
)
regex_once(
    "src/admin.ts",
    r'''function backupUpsertSql\(table: BackupTable\): string \{.*?\n\}\n\nasync function importBackup''',
    '''function backupUpsertSql(table: BackupTable): string {
  const columns = table.columns.map((column) => quoteIdentifier(column.name));
  const selectors = table.columns.map((column) => `json_extract(value, '$.${column.name}')`);
  const assignments = table.columns
    .filter((column) => !table.primaryKey.includes(column.name))
    .map((column) => `${quoteIdentifier(column.name)}=excluded.${quoteIdentifier(column.name)}`);
  const conflict = table.primaryKey.map(quoteIdentifier).join(",");
  // One bound JSON array can carry many rows, keeping the transaction below D1's query-count
  // limit. WHERE 1 disambiguates SQLite's ON CONFLICT from a SELECT join clause.
  return `INSERT INTO ${quoteIdentifier(table.name)}(${columns.join(",")}) `
    + `SELECT ${selectors.join(",")} FROM json_each(?) WHERE 1 `
    + `ON CONFLICT(${conflict}) DO UPDATE SET ${assignments.join(",")}`;
}

function backupJsonChunks(
  table: BackupTable,
  rows: Record<string, BackupValue>[],
  maxBytes = BACKUP_JSON_CHUNK_BYTES,
): string[] {
  if (!rows.length) return [];
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let encodedRows: string[] = [];
  let bytes = 2; // []
  for (let index = 0; index < rows.length; index += 1) {
    const encoded = JSON.stringify(rows[index]);
    const rowBytes = encoder.encode(encoded).byteLength;
    if (rowBytes + 2 > maxBytes) {
      throw invalidBackup(`${table.name}[${index}] 单行超过 D1 单个绑定值限制`);
    }
    const extra = rowBytes + (encodedRows.length ? 1 : 0);
    if (encodedRows.length && bytes + extra > maxBytes) {
      chunks.push(`[${encodedRows.join(",")}]`);
      encodedRows = [];
      bytes = 2;
    }
    encodedRows.push(encoded);
    bytes += rowBytes + (encodedRows.length > 1 ? 1 : 0);
  }
  if (encodedRows.length) chunks.push(`[${encodedRows.join(",")}]`);
  return chunks;
}

async function importBackup''',
    flags=re.S,
)
replace_once(
    "src/admin.ts",
    '''    const sql = backupUpsertSql(table);
    for (const row of rows) statements.push(env.DB.prepare(sql).bind(...table.columns.map((column) => row[column.name] ?? null)));
  }

  if (!statements.length) throw invalidBackup("备份文件不包含任何配置行");
  // One batch is one implicit transaction: a foreign-key violation or a constraint failure
  // anywhere rolls the entire restore back, so the gateway never runs on half a config.
  await env.DB.batch(statements);''',
    '''    const sql = backupUpsertSql(table);
    for (const chunk of backupJsonChunks(table, rows)) statements.push(env.DB.prepare(sql).bind(chunk));
  }

  if (!statements.length) throw invalidBackup("备份文件不包含任何配置行");
  if (statements.length > BACKUP_MAX_BATCH_STATEMENTS) {
    throw invalidBackup(`备份需要 ${statements.length} 条数据库语句，超过单次原子恢复上限 ${BACKUP_MAX_BATCH_STATEMENTS}`);
  }
  // One batch is one implicit transaction: a foreign-key violation or a constraint failure
  // anywhere rolls the entire restore back, so the gateway never runs on half a config.
  await env.DB.batch(statements);''',
)
replace_once(
    "test/backup-export.test.ts",
    '''    expect(credential?.args).toContain(CIPHERTEXT);
    expect(credential?.args).toContain(REFRESH_CIPHERTEXT);
    const key = (fake.batches[0] ?? []).find((entry) => entry.sql.includes("INTO \"gateway_keys\""));
    expect(key?.args).toContain(KEY_HASH);''',
    '''    expect(JSON.stringify(credential?.args)).toContain(CIPHERTEXT);
    expect(JSON.stringify(credential?.args)).toContain(REFRESH_CIPHERTEXT);
    const key = (fake.batches[0] ?? []).find((entry) => entry.sql.includes("INTO \"gateway_keys\""));
    expect(JSON.stringify(key?.args)).toContain(KEY_HASH);''',
)
replace_once(
    "test/backup-export.test.ts",
    '''  it("overwrites existing rows on primary key rather than skipping them", async () => {''',
    '''  it("packs a large restore into a bounded atomic batch", async () => {
    const fixture = fullFixture();
    const template = fixture.model_routes?.[0] ?? {};
    fixture.model_routes = Array.from({ length: 8_000 }, (_, index) => ({ ...template, id: `route-${index}` }));
    const document = await exportDocument(fixture);
    const fake = createFakeDb({});

    const { status } = await importDocument(document, fake);

    expect(status).toBe(200);
    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]?.length).toBeGreaterThan(BACKUP_TABLE_NAMES.length);
    expect(fake.batches[0]?.length).toBeLessThanOrEqual(50);
    expect(fake.batches[0]?.every((entry) => entry.args.length === 1 && entry.sql.includes("json_each(?)"))).toBe(true);
  });

  it("overwrites existing rows on primary key rather than skipping them", async () => {''',
)

# 2) Persist model-refresh attempts so repeatedly failing accounts move to the back of the batch.
replace_once(
    "src/models.ts",
    '''export const MODEL_REFRESH_BATCH_LIMIT = 40;

/**
 * Refreshes the least recently discovered catalogues first, so successive runs rotate
 * through a pool larger than one batch instead of repeatedly redoing the same head.
 */''',
    '''export const MODEL_REFRESH_BATCH_LIMIT = 40;

async function markModelRefreshAttempts(env: Env, credentialIds: string[]): Promise<void> {
  if (!credentialIds.length) return;
  const attemptedAt = Math.floor(Date.now() / 1000);
  await env.DB.batch(credentialIds.map((credentialId) => env.DB.prepare(
    `INSERT INTO credential_refresh_attempts(credential_id,model_attempted_at) VALUES(?,?)
     ON CONFLICT(credential_id) DO UPDATE SET model_attempted_at=excluded.model_attempted_at`,
  ).bind(credentialId, attemptedAt)));
}

/**
 * Refreshes the least recently attempted catalogues first, so even accounts whose upstream
 * keeps failing move behind the rest of the pool on the next invocation.
 */''',
)
replace_once(
    "src/models.ts",
    '''    `SELECT c.id FROM credentials c
     LEFT JOIN (SELECT credential_id, MAX(discovered_at) AS discovered_at FROM discovered_models GROUP BY credential_id) d
       ON d.credential_id = c.id
     WHERE c.enabled=1
     ORDER BY COALESCE(d.discovered_at, 0) ASC, c.provider_id, c.priority, c.created_at
     LIMIT ?`,''',
    '''    `SELECT c.id FROM credentials c
     LEFT JOIN credential_refresh_attempts a ON a.credential_id = c.id
     WHERE c.enabled=1
     ORDER BY COALESCE(a.model_attempted_at, 0) ASC, c.provider_id, c.priority, c.created_at
     LIMIT ?`,''',
)
replace_once(
    "src/models.ts",
    '''  const output: ModelRefreshResult[] = [];
  const openCode = await env.DB.prepare("SELECT enabled FROM providers WHERE id='opencode'").first<{ enabled: number }>();''',
    '''  await markModelRefreshAttempts(env, result.results.map((row) => row.id));
  const output: ModelRefreshResult[] = [];
  const openCode = await env.DB.prepare("SELECT enabled FROM providers WHERE id='opencode'").first<{ enabled: number }>();''',
)
replace_once(
    "test/refresh-batching.test.ts",
    '''  return {
    prepare: vi.fn((sql: string) => ({''',
    '''  return {
    batch: vi.fn(async (statements: D1PreparedStatement[]) => statements.map(() => ({ success: true, meta: {} }))),
    prepare: vi.fn((sql: string) => ({''',
)
replace_once(
    "test/refresh-batching.test.ts",
    '''  it("takes the least recently discovered catalogues first", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllModels(env);
    expect(capture.sql[0]).toMatch(/ORDER BY\\s+COALESCE\\(d\\.discovered_at, 0\\) ASC/);
  });''',
    '''  it("takes the least recently attempted catalogues first", async () => {
    const capture: Capture = { sql: [], binds: [] };
    const env = { DB: createDb(capture, []) } as never;
    await refreshAllModels(env);
    expect(capture.sql[0]).toContain("LEFT JOIN credential_refresh_attempts");
    expect(capture.sql[0]).toMatch(/ORDER BY\\s+COALESCE\\(a\\.model_attempted_at, 0\\) ASC/);
  });''',
)

# 3) Make OAuth polling a conditional D1 claim rather than a read-then-write race.
replace_once(
    "src/oauth.ts",
    '''  payload_json: string;
  expires_at: number;''',
    '''  payload_json: string;
  last_polled_at: number | null;
  expires_at: number;''',
)
regex_once(
    "src/oauth.ts",
    r'''/\*\*\n \* Records when a poll actually reached the provider\..*?\nasync function markPolled\(env: Env, row: OAuthSessionRow, payload: Record<string, unknown>, at: number\): Promise<void> \{.*?\n\}\n''',
    '''/**
 * Atomically claims the right to forward one poll upstream. The conditional UPDATE is the
 * synchronization point: concurrent requests may read the same session, but only one can
 * advance last_polled_at inside a window.
 */
async function claimPollSlot(env: Env, row: OAuthSessionRow, at: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE oauth_sessions SET last_polled_at=?
     WHERE id=? AND (last_polled_at IS NULL OR last_polled_at<=?)`,
  ).bind(at, row.id, at - POLL_MIN_INTERVAL_SECONDS).run();
  return Number(result.meta.changes ?? 0) > 0;
}
''',
    flags=re.S,
)
replace_once(
    "src/oauth.ts",
    '''  const now = nowSeconds();
  const lastPolledAt = numberValue(session.payload, "lastPolledAt");
  if (lastPolledAt !== undefined && now - lastPolledAt < POLL_MIN_INTERVAL_SECONDS) {
    // Deliberately shaped like any other pending result: a caller that is polling too fast
    // learns only that authorization has not completed, which is also what it would have
    // learned from the upstream. Surfacing "you are rate limited" would tell an abuser
    // exactly how to pace itself.
    return { status: "pending", retryAfterSeconds: POLL_MIN_INTERVAL_SECONDS };
  }
  await markPolled(env, session.row, session.payload, now);''',
    '''  const now = nowSeconds();
  if (!(await claimPollSlot(env, session.row, now))) {
    // Deliberately shaped like any other pending result: a caller that is polling too fast
    // learns only that authorization has not completed, which is also what it would have
    // learned from the upstream. Surfacing "you are rate limited" would tell an abuser
    // exactly how to pace itself.
    return { status: "pending", retryAfterSeconds: POLL_MIN_INTERVAL_SECONDS };
  }''',
)
replace_once(
    "test/oauth-throttle.test.ts",
    '''  const payload = lastPolledAt === undefined ? {} : { lastPolledAt };
  const writes: string[] = [];''',
    '''  const payload = {};
  let storedLastPolledAt: number | null = lastPolledAt ?? null;
  const writes: string[] = [];''',
)
replace_once(
    "test/oauth-throttle.test.ts",
    '''        secret_ciphertext: secret, payload_json: JSON.stringify(payload),
        expires_at: Math.floor(Date.now() / 1000) + 600, created_at: 0,''',
    '''        secret_ciphertext: secret, payload_json: JSON.stringify(payload), last_polled_at: storedLastPolledAt,
        expires_at: Math.floor(Date.now() / 1000) + 600, created_at: 0,''',
)
regex_once(
    "test/oauth-throttle.test.ts",
    r'''  const statement = \(sql: string\) => \(\{\n    bind: \(\) => statement\(sql\),\n    run: async \(\) => \{ writes\.push\(sql\); return \{ meta: \{ changes: 1 \} \}; \},\n    first: async \(\) => rowFor\(sql\),\n    all: async \(\) => \(\{ results: \[\] \}\),\n  \}\);''',
    '''  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => {
      if (sql.includes("UPDATE oauth_sessions SET last_polled_at")) {
        const [at, _id, cutoff] = args as [number, string, number];
        const claimed = storedLastPolledAt === null || storedLastPolledAt <= cutoff;
        if (claimed) {
          storedLastPolledAt = at;
          writes.push(sql);
        }
        return { meta: { changes: claimed ? 1 : 0 } };
      }
      writes.push(sql);
      return { meta: { changes: 1 } };
    },
    first: async () => rowFor(sql),
    all: async () => ({ results: [] }),
  });''',
)
replace_once(
    "test/oauth-throttle.test.ts",
    '''  it("keeps a throttled answer indistinguishable from an ordinary pending one", async () => {''',
    '''  it("allows only one concurrent poll to reach the provider", async () => {
    const harness = await createHarness();
    const results = await Promise.all([
      pollOAuth(harness.env, "kimi", "session-1"),
      pollOAuth(harness.env, "kimi", "session-1"),
    ]);
    expect(results.every((result) => result.status === "pending")).toBe(true);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a throttled answer indistinguishable from an ordinary pending one", async () => {''',
)

# 4) Move cross-isolate alert deduplication into a strongly consistent Durable Object.
replace_once(
    "src/rate-limiter.ts",
    '''export interface LoginThrottleCheck {
  allowed: boolean;
  /** Scopes that currently hold a failure counter, so the caller can skip a no-op reset. */
  trackedScopes: string[];
}
''',
    '''export interface LoginThrottleCheck {
  allowed: boolean;
  /** Scopes that currently hold a failure counter, so the caller can skip a no-op reset. */
  trackedScopes: string[];
}

export interface AlertClaimResult {
  claimed: boolean;
  claimedAt: number;
}
''',
)
replace_once(
    "src/rate-limiter.ts",
    '''const LOGIN_WINDOW_MS = 15 * 60_000;''',
    '''const LOGIN_WINDOW_MS = 15 * 60_000;
const ALERT_CLAIM_RETENTION_MS = 24 * 60 * 60_000;''',
)
replace_once(
    "src/rate-limiter.ts",
    '''        CREATE TABLE IF NOT EXISTS pending_flush (
          flush_id TEXT PRIMARY KEY,''',
    '''        CREATE TABLE IF NOT EXISTS alert_claims (
          scope TEXT PRIMARY KEY,
          claimed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_flush (
          flush_id TEXT PRIMARY KEY,''',
)
replace_once(
    "src/rate-limiter.ts",
    '''    if (request.method === "POST" && url.pathname === "/login/reset") {
      const payload = await request.json() as { scopes?: unknown };
      this.resetLogin(loginScopeList(payload.scopes));
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });''',
    '''    if (request.method === "POST" && url.pathname === "/login/reset") {
      const payload = await request.json() as { scopes?: unknown };
      this.resetLogin(loginScopeList(payload.scopes));
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/alerts/claim") {
      const payload = await request.json() as { scope?: unknown; windowMs?: unknown; now?: unknown };
      const scope = typeof payload.scope === "string" ? payload.scope : "";
      const windowMs = typeof payload.windowMs === "number" && Number.isFinite(payload.windowMs)
        ? Math.max(0, payload.windowMs) : 0;
      const now = typeof payload.now === "number" && Number.isFinite(payload.now) ? payload.now : Date.now();
      return Response.json(this.claimAlert(scope, windowMs, now));
    }
    return new Response("Not found", { status: 404 });''',
)
replace_once(
    "src/rate-limiter.ts",
    '''  private resetLogin(scopes: string[]): void {
    if (!scopes.length) return;
    const placeholders = scopes.map(() => "?").join(",");
    this.ctx.storage.sql.exec(`DELETE FROM login_attempts WHERE scope IN (${placeholders})`, ...scopes);
  }

  private async recordActivity''',
    '''  private resetLogin(scopes: string[]): void {
    if (!scopes.length) return;
    const placeholders = scopes.map(() => "?").join(",");
    this.ctx.storage.sql.exec(`DELETE FROM login_attempts WHERE scope IN (${placeholders})`, ...scopes);
  }

  private claimAlert(scope: string, windowMs: number, now: number): AlertClaimResult {
    if (!scope) return { claimed: false, claimedAt: now };
    const previous = this.ctx.storage.sql
      .exec<{ claimed_at: number }>("SELECT claimed_at FROM alert_claims WHERE scope=?", scope)
      .toArray()[0];
    if (previous && now - previous.claimed_at < windowMs) {
      return { claimed: false, claimedAt: previous.claimed_at };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO alert_claims(scope,claimed_at) VALUES(?,?)
       ON CONFLICT(scope) DO UPDATE SET claimed_at=excluded.claimed_at`,
      scope,
      now,
    );
    this.ctx.storage.sql.exec("DELETE FROM alert_claims WHERE claimed_at<=?", now - ALERT_CLAIM_RETENTION_MS);
    return { claimed: true, claimedAt: now };
  }

  private async recordActivity''',
)
replace_once(
    "src/alerts.ts",
    ''' * "still down" reminder that tells an operator the incident has not self-healed. It also
 * keeps the KV dedupe key far below the ~1 write/second per-key limit.
 */''',
    ''' * "still down" reminder that tells an operator the incident has not self-healed.
 */''',
)
replace_once(
    "src/alerts.ts",
    '''/** KV rejects an expirationTtl below 60 seconds, so a 1-minute window is the floor. */
const MIN_KV_TTL_SECONDS = 60;
const WEBHOOK_TIMEOUT_MS = 10_000;''',
    '''const WEBHOOK_TIMEOUT_MS = 10_000;''',
)
replace_once(
    "src/alerts.ts",
    '''/**
 * Suppression timestamps observed by this isolate. KV is eventually consistent, so a burst of
 * failures inside one isolate could each read a stale "not sent yet" and all fire. Recording
 * the send synchronously here collapses that burst; KV still covers the cross-isolate case.
 */''',
    '''/** Isolate-local fast path; the Durable Object below is the cross-isolate authority. */''',
)
regex_once(
    "src/alerts.ts",
    r'''async function claimDedupeSlot\(env: Env, type: AlertType, target: string, windowMs: number, now: number\): Promise<boolean> \{.*?\n\}\n\nexport function buildAlertPayload''',
    '''const ALERT_DEDUPE_DO_NAME = "alert-dedupe";

export async function claimAlertDedupeSlot(
  env: Env,
  type: AlertType,
  target: string,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const key = dedupeKey(type, target);
  const memoized = dedupeMemo.get(key);
  if (memoized !== undefined && now - memoized < windowMs) return false;

  try {
    const namespace = env.RATE_LIMITER;
    const stub = namespace.get(namespace.idFromName(ALERT_DEDUPE_DO_NAME));
    const response = await stub.fetch("https://do.internal/alerts/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: key, windowMs, now }),
    });
    if (!response.ok) throw new Error(`alert dedupe returned ${response.status}`);
    const result = await response.json() as { claimed?: unknown; claimedAt?: unknown };
    const claimedAt = typeof result.claimedAt === "number" ? result.claimedAt : now;
    memoSet(key, claimedAt);
    return result.claimed === true;
  } catch (error) {
    // Alerting must not fail the operation that produced it. A DO outage degrades to a local
    // claim (duplicates across isolates are possible) and is made visible in runtime logs.
    console.error(JSON.stringify({
      event: "alert_dedupe_claim_failed",
      type,
      target,
      error: error instanceof Error ? error.message : String(error),
    }));
    memoSet(key, now);
    return true;
  }
}

export function buildAlertPayload''',
    flags=re.S,
)
replace_once(
    "src/alerts.ts",
    '''      const claimed = await claimDedupeSlot(env, input.type, input.target, settings.dedupeWindowMinutes * 60_000, now);''',
    '''      const claimed = await claimAlertDedupeSlot(env, input.type, input.target, settings.dedupeWindowMinutes * 60_000, now);''',
)

write(
    "test/alert-dedupe-do.test.ts",
    '''import { beforeEach, describe, expect, it } from "vitest";
import { claimAlertDedupeSlot, resetAlertsState } from "../src/alerts";
import type { Env } from "../src/types";

function createEnv(): Env {
  let claimedAt: number | undefined;
  const stub = {
    async fetch(_url: string, init?: RequestInit) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { windowMs: number; now: number };
      const claimed = claimedAt === undefined || body.now - claimedAt >= body.windowMs;
      if (claimed) claimedAt = body.now;
      return Response.json({ claimed, claimedAt: claimedAt ?? body.now });
    },
  };
  return {
    RATE_LIMITER: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub,
    } as unknown as DurableObjectNamespace,
  } as Env;
}

beforeEach(() => resetAlertsState());

describe("alert dedupe Durable Object", () => {
  it("grants exactly one concurrent claim for the same alert window", async () => {
    const env = createEnv();
    const results = await Promise.all([
      claimAlertDedupeSlot(env, "provider_circuit_open", "codex", 60_000, 1_000),
      claimAlertDedupeSlot(env, "provider_circuit_open", "codex", 60_000, 1_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("re-arms after the requested window", async () => {
    const env = createEnv();
    expect(await claimAlertDedupeSlot(env, "provider_circuit_open", "codex", 60_000, 1_000)).toBe(true);
    resetAlertsState();
    expect(await claimAlertDedupeSlot(env, "provider_circuit_open", "codex", 60_000, 61_000)).toBe(true);
  });
});
''',
)

# 5) Enforce header/chunk limits even when the terminator arrives inside one oversized read.
replace_once(
    "src/proxy-transport.ts",
    '''      const index = this.buffer.indexOf(marker, scanned);
      if (index >= 0) return this.buffer.take(index + marker.byteLength);''',
    '''      const index = this.buffer.indexOf(marker, scanned);
      if (index >= 0) {
        const end = index + marker.byteLength;
        if (end > maxBytes) throw this.dialect.headersTooLarge();
        return this.buffer.take(end);
      }''',
)
write(
    "test/proxy-size-limit.test.ts",
    '''import { describe, expect, it } from "vitest";
import { SocketReader } from "../src/proxy-transport";

function dialect() {
  return {
    headersTooLarge: () => new Error("headers too large"),
    headersClosed: () => new Error("headers closed"),
    idleTimeout: () => new Error("idle timeout"),
  } as never;
}

describe("proxy response size limits", () => {
  it("rejects a terminator that appears beyond the configured limit in one socket read", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${"x".repeat(64)}\r\n\r\n`));
        controller.close();
      },
    });
    const reader = new SocketReader(body, { idleTimeoutMs: 1_000, dialect: dialect() });
    await expect(reader.readUntil(new TextEncoder().encode("\r\n\r\n"), 32)).rejects.toThrow("headers too large");
  });
});
''',
)

# Schema state used by the two fairness/concurrency fixes.
write(
    "migrations/0012_review_followups.sql",
    '''-- Persist the last model-refresh attempt independently from successful discovery so
-- repeatedly failing accounts cannot monopolize the head of every bounded refresh batch.
CREATE TABLE IF NOT EXISTS credential_refresh_attempts (
  credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  model_attempted_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_credential_refresh_attempts_model
  ON credential_refresh_attempts(model_attempted_at);

-- Device OAuth polling uses a conditional UPDATE on this column as its atomic claim.
ALTER TABLE oauth_sessions ADD COLUMN last_polled_at INTEGER;
''',
)

print("Applied PR #37 review follow-up fixes")
