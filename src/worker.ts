import handler from "./index";
import { sendAlert } from "./alerts";
import {
  activityCutoff, cleanupExpiredActivity, cleanupExpiredOAuthSessions, cleanupExpiredRequestLogs,
  oauthSessionCutoff, requestLogCutoff,
} from "./log-retention";
import { refreshAllQuotas } from "./quota";
import type { Env, UsageQueueEvent } from "./types";

export { AccountPool, RateLimiter } from "./index";

interface RetentionTask {
  event: string;
  /** Retention boundary for a sweep; absent for tasks that are not time-bounded. */
  cutoff?: number;
  /** Rows removed, or items processed for tasks that are not deletions. */
  run: () => Promise<number>;
}

/**
 * Runs every retention sweep, reporting each outcome individually.
 *
 * The tasks are independent tables, so one failure must not stop the others: Cloudflare does
 * not retry a failed scheduled invocation, and letting the first error propagate would mean a
 * single bad table quietly freezes the rest until the next hour — or indefinitely, if the
 * failure is persistent. Each result is logged on its own, and the handler only rejects once
 * every task has had its turn, so the failure still surfaces in observability.
 */
async function runRetention(env: Env, scheduledTime: number): Promise<void> {
  const tasks: RetentionTask[] = [
    {
      event: "request_log_cleanup",
      cutoff: requestLogCutoff(scheduledTime),
      run: () => cleanupExpiredRequestLogs(env, scheduledTime),
    },
    {
      event: "activity_cleanup",
      cutoff: activityCutoff(scheduledTime),
      run: () => cleanupExpiredActivity(env, scheduledTime),
    },
    {
      event: "oauth_session_cleanup",
      cutoff: oauthSessionCutoff(scheduledTime),
      run: () => cleanupExpiredOAuthSessions(env, scheduledTime),
    },
    {
      // Quotas drive the account pool's availability decisions, so they must stay fresh even
      // when nobody opens the console. Batched inside refreshAllQuotas and ordered oldest
      // first, so a pool larger than one batch converges across successive hours.
      event: "quota_refresh",
      run: async () => (await refreshAllQuotas(env)).length,
    },
  ];

  const outcomes = await Promise.allSettled(tasks.map(async (task) => {
    try {
      const deleted = await task.run();
      console.log(JSON.stringify({ event: `${task.event}_completed`, cutoff: task.cutoff, deleted }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: `${task.event}_failed`,
        cutoff: task.cutoff,
        error: message,
      }));
      // Awaited rather than dispatched: this already runs inside the scheduled waitUntil, and
      // sendAlert never rejects, so awaiting only delays the sweep's own rejection. The dedupe
      // target is the task name, so an hourly cron failing on one table alerts once per window
      // instead of once per hour.
      await sendAlert(env, {
        type: "cron_cleanup_failed",
        severity: "warning",
        target: task.event,
        title: `定时清理任务 ${task.event} 失败`,
        detail: `保留清理未能完成，过期数据将持续累积。错误：${message}`,
        context: { task: task.event, cutoff: task.cutoff, scheduledTime },
      });
      throw error;
    }
  }));

  const failed = outcomes.filter((outcome) => outcome.status === "rejected").length;
  if (failed > 0) throw new Error(`${failed} of ${tasks.length} retention sweeps failed`);
}

export default {
  ...handler,
  scheduled(controller, env, ctx) {
    const scheduledTime = Number.isFinite(controller.scheduledTime)
      ? controller.scheduledTime
      : Date.now();
    ctx.waitUntil(runRetention(env, scheduledTime));
  },
} satisfies ExportedHandler<Env, UsageQueueEvent>;
