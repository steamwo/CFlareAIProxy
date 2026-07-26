import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEDUPE_WINDOW_MINUTES,
  buildAlertPayload,
  getAlertSettings,
  resetAlertsState,
  sendAlert,
  updateAlertSettings,
  validateWebhookUrl,
  type AlertInput,
} from "../src/alerts";
import { GatewayError } from "../src/errors";
import type { Env } from "../src/types";

/** 32 zero bytes, base64 — the shape encryptSecret/decryptSecret require. */
const MASTER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const WEBHOOK = "https://hooks.example.com/services/T000/B000/abc";

interface SettingsRow {
  value_ciphertext: string | null;
  value_json: string;
  updated_at: number;
}

interface Harness {
  env: Env;
  kv: Map<string, string>;
  kvWrites: number;
  row: SettingsRow | null;
}

/** Minimal D1 + KV stand-ins covering only the statements alerts.ts issues. */
function createHarness(initial: SettingsRow | null = null): Harness {
  const kv = new Map<string, string>();
  const harness: Harness = { kv, kvWrites: 0, row: initial, env: {} as Env };

  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first(): Promise<SettingsRow | null> {
              return harness.row;
            },
            async run(): Promise<void> {
              if (sql.startsWith("DELETE")) {
                harness.row = null;
                return;
              }
              const [, ciphertext, valueJson, updatedAt] = args;
              harness.row = {
                value_ciphertext: typeof ciphertext === "string" ? ciphertext : null,
                value_json: String(valueJson),
                updated_at: Number(updatedAt),
              };
            },
          };
        },
      };
    },
  };

  const CONFIG_CACHE = {
    async get(key: string): Promise<string | null> {
      return kv.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      harness.kvWrites += 1;
      kv.set(key, value);
    },
    async delete(key: string): Promise<void> {
      kv.delete(key);
    },
  };

  harness.env = {
    DB, CONFIG_CACHE, MASTER_KEY, APP_NAME: "TestGateway",
  } as unknown as Env;
  return harness;
}

const ALERT: AlertInput = {
  type: "provider_circuit_open",
  severity: "critical",
  target: "codex",
  title: "渠道 codex 已被熔断",
  detail: "连续 3 次失败",
  context: { failures: 3 },
};

/** Configures an enabled webhook through the real settings writer (so it is really encrypted). */
async function configure(harness: Harness, dedupeWindowMinutes = DEFAULT_DEDUPE_WINDOW_MINUTES): Promise<void> {
  await updateAlertSettings(harness.env, { webhookUrl: WEBHOOK, enabled: true, dedupeWindowMinutes });
}

function okFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  resetAlertsState();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAlertsState();
});

describe("alert settings", () => {
  it("reports unconfigured state and never leaks the webhook URL", async () => {
    const harness = createHarness();
    expect(await getAlertSettings(harness.env)).toMatchObject({ enabled: false, hasWebhook: false, webhookHost: "" });

    await configure(harness);
    resetAlertsState();
    const summary = await getAlertSettings(harness.env);
    expect(summary).toMatchObject({ enabled: true, hasWebhook: true, webhookHost: "hooks.example.com" });
    expect(JSON.stringify(summary)).not.toContain("/services/T000");
    // The URL is stored encrypted, not in the plaintext options column.
    expect(harness.row?.value_json).not.toContain("hooks.example.com");
    expect(harness.row?.value_ciphertext).toMatch(/^v1\./);
  });

  it("refuses to enable alerting without a destination", async () => {
    const harness = createHarness();
    expect(await updateAlertSettings(harness.env, { enabled: true })).toMatchObject({ enabled: false });
  });

  it("rejects non-HTTPS webhooks", () => {
    expect(() => validateWebhookUrl("http://evil.example.com/hook")).toThrow(GatewayError);
    expect(() => validateWebhookUrl("not a url")).toThrow(GatewayError);
    expect(validateWebhookUrl("http://localhost:9000/hook")).toContain("localhost");
  });

  it("clamps the dedupe window to a sane range", async () => {
    const harness = createHarness();
    await updateAlertSettings(harness.env, { webhookUrl: WEBHOOK, enabled: true, dedupeWindowMinutes: 0 });
    expect((await getAlertSettings(harness.env)).dedupeWindowMinutes).toBe(1);
    await updateAlertSettings(harness.env, { dedupeWindowMinutes: 10_000 });
    expect((await getAlertSettings(harness.env)).dedupeWindowMinutes).toBe(24 * 60);
  });
});

describe("payload", () => {
  it("is a vendor-neutral envelope with type/severity/title/detail/timestamp", () => {
    const now = Date.UTC(2026, 6, 26, 1, 2, 3);
    const payload = buildAlertPayload({ APP_NAME: "TestGateway" } as unknown as Env, ALERT, now);
    expect(payload).toEqual({
      schema: "cflare.alert.v1",
      type: "provider_circuit_open",
      severity: "critical",
      target: "codex",
      title: "渠道 codex 已被熔断",
      detail: "连续 3 次失败",
      service: "TestGateway",
      timestamp: "2026-07-26T01:02:03.000Z",
      timestampMs: now,
      context: { failures: 3 },
    });
    // No Discord/Slack/DingTalk-specific keys leaked into the contract.
    expect(Object.keys(payload)).not.toContain("embeds");
    expect(Object.keys(payload)).not.toContain("msgtype");
  });

  it("is what actually gets POSTed as JSON", async () => {
    const harness = createHarness();
    await configure(harness);
    const fetchMock = okFetch();

    expect(await sendAlert(harness.env, ALERT)).toMatchObject({ delivered: true, status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.schema).toBe("cflare.alert.v1");
    expect(body.type).toBe("provider_circuit_open");
  });
});

describe("silent skip when unconfigured", () => {
  it("does not call fetch when no webhook is stored", async () => {
    const harness = createHarness();
    const fetchMock = okFetch();
    expect(await sendAlert(harness.env, ALERT)).toEqual({ delivered: false, skipped: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.kvWrites).toBe(0);
  });

  it("does not call fetch when a webhook exists but alerting is off", async () => {
    const harness = createHarness();
    await updateAlertSettings(harness.env, { webhookUrl: WEBHOOK, enabled: false });
    const fetchMock = okFetch();
    expect(await sendAlert(harness.env, ALERT)).toEqual({ delivered: false, skipped: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still delivers a bypassEnabled test send so the console can verify wiring", async () => {
    const harness = createHarness();
    await updateAlertSettings(harness.env, { webhookUrl: WEBHOOK, enabled: false });
    const fetchMock = okFetch();
    expect(await sendAlert(harness.env, ALERT, { bypassDedupe: true, bypassEnabled: true })).toMatchObject({ delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("deduplication window", () => {
  it("collapses repeats of the same (type, target) inside the window", async () => {
    const harness = createHarness();
    await configure(harness, 15);
    const fetchMock = okFetch();

    expect(await sendAlert(harness.env, ALERT)).toMatchObject({ delivered: true });
    for (let index = 0; index < 5; index += 1) {
      vi.advanceTimersByTime(60_000);
      expect(await sendAlert(harness.env, ALERT)).toEqual({ delivered: false, skipped: "deduplicated" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends again once the window has elapsed", async () => {
    const harness = createHarness();
    await configure(harness, 15);
    const fetchMock = okFetch();

    await sendAlert(harness.env, ALERT);
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(await sendAlert(harness.env, ALERT)).toMatchObject({ skipped: "deduplicated" });
    vi.advanceTimersByTime(2);
    expect(await sendAlert(harness.env, ALERT)).toMatchObject({ delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("scopes suppression per target and per type", async () => {
    const harness = createHarness();
    await configure(harness);
    const fetchMock = okFetch();

    await sendAlert(harness.env, ALERT);
    await sendAlert(harness.env, { ...ALERT, target: "kimi" });
    await sendAlert(harness.env, { ...ALERT, type: "credentials_exhausted" });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Repeats of each of the three slots are all suppressed.
    await sendAlert(harness.env, ALERT);
    await sendAlert(harness.env, { ...ALERT, target: "kimi" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("suppresses across isolates via KV, not just the in-memory memo", async () => {
    const harness = createHarness();
    await configure(harness);
    const fetchMock = okFetch();

    await sendAlert(harness.env, ALERT);
    // A different isolate shares KV but starts with an empty memo.
    resetAlertsState();
    expect(await sendAlert(harness.env, ALERT)).toEqual({ delivered: false, skipped: "deduplicated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("claims the slot even when delivery fails, so a broken webhook is not retried per failure", async () => {
    const harness = createHarness();
    await configure(harness);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendAlert(harness.env, ALERT)).toMatchObject({ delivered: false, status: 500 });
    expect(await sendAlert(harness.env, ALERT)).toEqual({ delivered: false, skipped: "deduplicated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("writes at most one KV dedupe entry per window", async () => {
    const harness = createHarness();
    await configure(harness);
    okFetch();
    const before = harness.kvWrites;
    await sendAlert(harness.env, ALERT);
    await sendAlert(harness.env, ALERT);
    await sendAlert(harness.env, ALERT);
    expect(harness.kvWrites - before).toBe(1);
  });
});

describe("trigger points", () => {
  it("alerts once when a provider circuit breaker opens, not once per failure", async () => {
    const harness = createHarness();
    await configure(harness);
    const fetchMock = okFetch();
    const { recordProviderFailure, resetRoutingHealthMemo, FAILURE_THRESHOLD } = await import("../src/routing-health");
    resetRoutingHealthMemo();

    const env = {
      ...harness.env,
      // No /health/* route: routing-health falls back to its local failure window.
      ACCOUNT_POOL: { idFromName: () => "id", get: () => ({ fetch: async () => new Response("", { status: 404 }) }) },
    } as unknown as Env;

    for (let index = 0; index < FAILURE_THRESHOLD + 4; index += 1) {
      await recordProviderFailure(env, "codex", 502, "upstream unreachable");
    }
    // Every failure past the threshold re-arms the breaker; the dedupe window, not the call
    // site, is what keeps that from becoming one notification per failed request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.type).toBe("provider_circuit_open");
    expect(body.target).toBe("codex");
    expect(body.severity).toBe("critical");
    resetRoutingHealthMemo();
  });

  it("alerts when a cron retention sweep fails without swallowing the failure", async () => {
    const harness = createHarness();
    await configure(harness);
    const fetchMock = okFetch();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const worker = (await import("../src/worker")).default;

    const env = {
      ...harness.env,
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            run: async () => {
              if (sql.includes("system_settings")) return { meta: { changes: 0 } };
              if (sql.includes("DELETE FROM request_logs")) throw new Error("request_logs is unavailable");
              return { meta: { changes: 0 } };
            },
            first: async () => (sql.includes("system_settings") ? harness.row : null),
          }),
        }),
      },
    } as unknown as Env;

    const pending: Promise<unknown>[] = [];
    worker.scheduled?.(
      { scheduledTime: 1_800_000_000_000, cron: "0 * * * *", noRetry: () => {} } as ScheduledController,
      env,
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: () => {} } as ExecutionContext,
    );
    await expect(Promise.all(pending)).rejects.toThrow(/retention sweeps failed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.type).toBe("cron_cleanup_failed");
    expect(body.target).toBe("request_log_cleanup");
  });
});

describe("failure isolation", () => {
  it("never throws when the webhook rejects", async () => {
    const harness = createHarness();
    await configure(harness);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));

    await expect(sendAlert(harness.env, ALERT)).resolves.toMatchObject({
      delivered: false,
      error: expect.stringContaining("ECONNREFUSED") as unknown as string,
    });
  });

  it("never throws when the webhook returns a non-2xx status", async () => {
    const harness = createHarness();
    await configure(harness);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    await expect(sendAlert(harness.env, ALERT)).resolves.toMatchObject({ delivered: false, status: 429 });
  });

  it("never throws when the settings read itself fails", async () => {
    const env = {
      DB: { prepare: () => { throw new Error("no such table: system_settings"); } },
      CONFIG_CACHE: { get: async () => null, put: async () => undefined },
      MASTER_KEY,
    } as unknown as Env;
    const fetchMock = okFetch();
    await expect(sendAlert(env, ALERT)).resolves.toEqual({ delivered: false, skipped: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when KV is unavailable", async () => {
    const harness = createHarness();
    await configure(harness);
    const failingKv = {
      get: async () => { throw new Error("kv down"); },
      put: async () => { throw new Error("kv down"); },
      delete: async () => undefined,
    };
    const env = { ...harness.env, CONFIG_CACHE: failingKv } as unknown as Env;
    const fetchMock = okFetch();
    // KV failure must degrade to "send anyway" rather than losing the alert.
    await expect(sendAlert(env, ALERT)).resolves.toMatchObject({ delivered: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
