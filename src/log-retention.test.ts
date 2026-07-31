import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_RETENTION_SECONDS, activityCutoff, cleanupExpiredActivity, cleanupExpiredOAuthSessions,
  cleanupExpiredRequestLogs, oauthSessionCutoff, OAUTH_SESSION_GRACE_SECONDS, requestLogCutoff,
  REQUEST_LOG_RETENTION_SECONDS,
} from "./log-retention";
import type { Env } from "./types";

const NOW_MS = 1_800_000_000_000;

/**
 * Minimal D1 stand-in that answers each statement with a scripted row count, and records
 * the SQL and bindings it saw. Deliberately does not assert on exact SQL text: the point is
 * which table gets swept, with which cutoff, and how the batching behaves.
 */
function createDb(changesPerCall: number[]) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  let index = 0;
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        calls.push({ sql, args });
        const changes = changesPerCall[Math.min(index, changesPerCall.length - 1)] ?? 0;
        index += 1;
        return { meta: { changes } };
      },
    }),
  }));
  return { calls, env: { DB: { prepare } } as unknown as Env };
}

describe("retention cutoffs", () => {
  it("keeps request detail for a day and aggregates for a quarter", () => {
    expect(requestLogCutoff(NOW_MS)).toBe(Math.floor(NOW_MS / 1000) - REQUEST_LOG_RETENTION_SECONDS);
    expect(activityCutoff(NOW_MS)).toBe(Math.floor(NOW_MS / 1000) - ACTIVITY_RETENTION_SECONDS);
    expect(oauthSessionCutoff(NOW_MS)).toBe(Math.floor(NOW_MS / 1000) - OAUTH_SESSION_GRACE_SECONDS);
    // Aggregates back the 7-day availability chart, so they must outlive the detail rows.
    expect(activityCutoff(NOW_MS)).toBeLessThan(requestLogCutoff(NOW_MS));
  });
});

describe("batched deletes", () => {
  it("sweeps each table with its own cutoff", async () => {
    for (const [sweep, cutoff, table] of [
      [cleanupExpiredRequestLogs, requestLogCutoff(NOW_MS), "request_logs"],
      [cleanupExpiredActivity, activityCutoff(NOW_MS), "request_activity_5m"],
      [cleanupExpiredOAuthSessions, oauthSessionCutoff(NOW_MS), "oauth_sessions"],
    ] as const) {
      const { calls, env } = createDb([2]);
      await expect(sweep(env, NOW_MS)).resolves.toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.sql).toContain(table);
      expect(calls[0]?.args[0]).toBe(cutoff);
      // Every statement must carry a row limit, so a backlog cannot produce one huge delete.
      expect(typeof calls[0]?.args[1]).toBe("number");
    }
  });

  it("keeps deleting while batches come back full", async () => {
    // Two saturated batches then a short one: the sweep should stop after the short batch.
    const { calls, env } = createDb([5_000, 5_000, 17]);
    await expect(cleanupExpiredRequestLogs(env, NOW_MS)).resolves.toBe(10_017);
    expect(calls).toHaveLength(3);
  });

  it("stops after one statement when the first batch is already short", async () => {
    const { calls, env } = createDb([0]);
    await expect(cleanupExpiredActivity(env, NOW_MS)).resolves.toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("bounds the work per invocation even if the backlog never drains", async () => {
    // Always-full batches simulate a backlog larger than one cron run can clear.
    const { calls, env } = createDb([5_000]);
    const deleted = await cleanupExpiredRequestLogs(env, NOW_MS);
    expect(calls.length).toBeLessThanOrEqual(20);
    expect(deleted).toBe(calls.length * 5_000);
  });
});
