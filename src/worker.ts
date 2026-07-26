import handler from "./index";
import {
  activityCutoff, cleanupExpiredActivity, cleanupExpiredOAuthSessions, cleanupExpiredRequestLogs,
  oauthSessionCutoff, requestLogCutoff,
} from "./log-retention";
import type { Env, UsageQueueEvent } from "./types";

export { AccountPool, RateLimiter } from "./index";

interface RetentionTask {
  event: string;
  cutoff: number;
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
  ];

  const outcomes = await Promise.allSettled(tasks.map(async (task) => {
    try {
      const deleted = await task.run();
      console.log(JSON.stringify({ event: `${task.event}_completed`, cutoff: task.cutoff, deleted }));
    } catch (error) {
      console.error(JSON.stringify({
        event: `${task.event}_failed`,
        cutoff: task.cutoff,
        error: error instanceof Error ? error.message : String(error),
      }));
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
