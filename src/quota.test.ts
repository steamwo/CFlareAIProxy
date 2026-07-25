import { describe, expect, it } from "vitest";
import { parseCodexQuota, parseQoderQuota } from "./quota";
import type { ProviderConfig, ProviderKind } from "./types";

function provider(id: string, kind: ProviderKind): ProviderConfig {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    name: id,
    kind,
    base_url: "https://example.com",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: now,
    updated_at: now,
    endpoints: {},
    auth: {},
    headers: {},
    options: {},
  };
}

describe("Qoder quota parsing", () => {
  it("treats an explicit 0/0 pool as exhausted", () => {
    const snapshot = parseQoderQuota(provider("qoder", "qoder"), {
      data: {
        userQuota: {
          total: 0,
          remaining: 0,
          percentage: 0,
        },
        totalUsagePercentage: 0,
      },
    });

    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]).toMatchObject({
      key: "user",
      limit: 0,
      remaining: 0,
      usedPercent: 100,
      remainingPercent: 0,
    });
    expect(snapshot.credits).toMatchObject({ balance: 0, hasCredits: false });
  });
});

describe("Codex quota parsing", () => {
  it("parses primary, secondary and additional rate limits", () => {
    const snapshot = parseCodexQuota(provider("codex", "codex"), {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 25,
          reset_after_seconds: 60,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          remaining_percent: 40,
          reset_after_seconds: 120,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "Code Review",
          metered_feature: "codex_code_review",
          rate_limit: {
            primary_window: {
              used_percent: 80,
              reset_after_seconds: 30,
            },
          },
        },
      ],
    });

    expect(snapshot.plan).toBe("plus");
    expect(snapshot.windows.map((window) => window.key)).toEqual([
      "primary",
      "secondary",
      "additional_codex_code_review_primary",
    ]);
    expect(snapshot.windows[0]).toMatchObject({ usedPercent: 25, remainingPercent: 75, windowSeconds: 18_000 });
    expect(snapshot.windows[1]).toMatchObject({ usedPercent: 60, remainingPercent: 40 });
    expect(snapshot.windows[2]).toMatchObject({ usedPercent: 80, remainingPercent: 20 });
  });
});
