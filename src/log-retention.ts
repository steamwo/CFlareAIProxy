import type { Env } from "./types";

export const REQUEST_LOG_RETENTION_SECONDS = 24 * 60 * 60;

export function requestLogCutoff(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) - REQUEST_LOG_RETENTION_SECONDS;
}

export async function cleanupExpiredRequestLogs(env: Env, nowMs = Date.now()): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM request_logs WHERE created_at < ?")
    .bind(requestLogCutoff(nowMs))
    .run();
  return Number(result.meta.changes ?? 0);
}
