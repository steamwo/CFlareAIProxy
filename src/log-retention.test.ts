import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredRequestLogs, requestLogCutoff, REQUEST_LOG_RETENTION_SECONDS } from "./log-retention";
import type { Env } from "./types";

describe("request log retention cleanup", () => {
  it("computes a cutoff exactly 24 hours before the trigger time", () => {
    const nowMs = 1_800_000_000_000;
    expect(requestLogCutoff(nowMs)).toBe(Math.floor(nowMs / 1000) - REQUEST_LOG_RETENTION_SECONDS);
  });

  it("deletes only request logs older than the cutoff", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 3 } });
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { DB: { prepare } } as unknown as Env;
    const nowMs = 1_800_000_000_000;

    await expect(cleanupExpiredRequestLogs(env, nowMs)).resolves.toBe(3);
    expect(prepare).toHaveBeenCalledWith("DELETE FROM request_logs WHERE created_at < ?");
    expect(bind).toHaveBeenCalledWith(requestLogCutoff(nowMs));
    expect(run).toHaveBeenCalledOnce();
  });
});
