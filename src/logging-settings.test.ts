import { describe, expect, it } from "vitest";
import { shouldPersistError } from "./logging-settings";
import type { LoggingSettings, UsageEvent } from "./types";

function event(statusCode: number, errorCode?: string): UsageEvent {
  return {
    requestId: "request-1",
    statusCode,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 },
    latencyMs: 10,
    ...(errorCode ? { errorCode } : {}),
    createdAt: 1,
  };
}

function settings(level: LoggingSettings["level"], requestLoggingEnabled = true): LoggingSettings {
  return { level, requestLoggingEnabled };
}

describe("request log retention", () => {
  it("never stores successful request details", () => {
    expect(shouldPersistError(settings("debug"), event(200))).toBe(false);
  });

  it("stores only server or internal errors at error level", () => {
    expect(shouldPersistError(settings("error"), event(429))).toBe(false);
    expect(shouldPersistError(settings("error"), event(502))).toBe(true);
    expect(shouldPersistError(settings("error"), event(400, "INVALID_REQUEST"))).toBe(true);
  });

  it("stores all failed request details at warn and higher levels", () => {
    expect(shouldPersistError(settings("warn"), event(400))).toBe(true);
    expect(shouldPersistError(settings("info"), event(429))).toBe(true);
    expect(shouldPersistError(settings("debug"), event(503))).toBe(true);
  });

  it("stores no request details when logging is disabled", () => {
    expect(shouldPersistError(settings("debug", false), event(503, "UPSTREAM_ERROR"))).toBe(false);
  });
});
