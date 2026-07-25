import handler from "./index";
import { cleanupExpiredRequestLogs, requestLogCutoff } from "./log-retention";
import type { Env, UsageQueueEvent } from "./types";

export default {
  ...handler,
  scheduled(controller, env, ctx) {
    const scheduledTime = Number.isFinite(controller.scheduledTime)
      ? controller.scheduledTime
      : Date.now();
    const cutoff = requestLogCutoff(scheduledTime);
    ctx.waitUntil(
      cleanupExpiredRequestLogs(env, scheduledTime)
        .then((deleted) => {
          console.log(JSON.stringify({ event: "request_log_cleanup_completed", cutoff, deleted }));
        })
        .catch((error) => {
          console.error(JSON.stringify({
            event: "request_log_cleanup_failed",
            cutoff,
            error: error instanceof Error ? error.message : String(error),
          }));
          throw error;
        }),
    );
  },
} satisfies ExportedHandler<Env, UsageQueueEvent>;
