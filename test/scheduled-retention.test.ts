import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { Env } from "../src/types";

/**
 * The cron handler sweeps three independent tables. Cloudflare does not retry a failed
 * scheduled invocation, so one broken table must not prevent the others from being cleaned —
 * otherwise a single persistent failure silently freezes retention everywhere.
 */
function createEnv(failOn: string | null) {
  const swept: string[] = [];
  // The cron runs deletions alongside the quota refresh, which only reads. Answering both
  // shapes keeps this test about task isolation rather than about SQL plumbing.
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    run: async () => {
      const table = sql.match(/DELETE FROM (\w+)/)?.[1] ?? "?";
      swept.push(table);
      if (failOn && table === failOn) throw new Error(`${table} is unavailable`);
      return { meta: { changes: 0 } };
    },
    all: async () => ({ results: [] }),
    first: async () => null,
  });
  const prepare = vi.fn(statement);
  return { swept, env: { DB: { prepare } } as unknown as Env };
}

function runScheduled(env: Env): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: () => {} };
  worker.scheduled?.(
    { scheduledTime: 1_800_000_000_000, cron: "0 * * * *", noRetry: () => {} } as ScheduledController,
    env,
    ctx as ExecutionContext,
  );
  return Promise.all(pending).then(() => undefined);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("scheduled retention", () => {
  it("sweeps request logs, activity aggregates and oauth sessions", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { swept, env } = createEnv(null);
    await runScheduled(env);
    expect(new Set(swept)).toEqual(new Set(["request_logs", "request_activity_5m", "oauth_sessions"]));
  });

  it("still sweeps the other tables when one of them fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { swept, env } = createEnv("request_logs");

    // The invocation still reports failure so the error remains visible in observability.
    await expect(runScheduled(env)).rejects.toThrow(/retention sweeps failed/);
    expect(swept).toContain("request_activity_5m");
    expect(swept).toContain("oauth_sessions");
  });
});
