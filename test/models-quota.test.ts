import { describe, expect, it } from "vitest";
import { parseModels } from "../src/models";
import { parseCodexQuota, parseGenericQuota, parseQoderQuota } from "../src/quota";
import type { ProviderConfig } from "../src/types";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "test",
    name: "Test Provider",
    kind: "openai-compatible",
    base_url: "https://api.example.com/v1",
    enabled: 1,
    pool_strategy: "round_robin",
    endpoints_json: "{}",
    auth_json: "{}",
    headers_json: "{}",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    endpoints: { chat: "/chat/completions", models: "/models" },
    auth: {},
    headers: {},
    options: {},
    ...overrides,
  };
}

describe("parseModels", () => {
  it("parses OpenAI-compatible arrays without inventing model IDs", () => {
    const models = parseModels({ data: [
      { id: "gpt-real-1", owned_by: "upstream" },
      { id: "gpt-real-2", display_name: "GPT Real 2" },
    ] });
    expect(models.map((model) => model.id)).toEqual(["gpt-real-1", "gpt-real-2"]);
    expect(models[1]?.displayName).toBe("GPT Real 2");
  });

  it("parses Qoder-style chat model maps", () => {
    const models = parseModels({ chat: {
      auto: { name: "Auto" },
      "qoder-code": { displayName: "Qoder Code" },
    } });
    expect(models.map((model) => model.id)).toEqual(["auto", "qoder-code"]);
  });
});

describe("quota parsers", () => {
  it("parses Codex primary, secondary and credit quota fields", () => {
    const snapshot = parseCodexQuota(provider({ id: "codex", kind: "codex" }), {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 25, reset_at: 2_000_000_000, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 60, reset_after_seconds: 3600 },
      },
      credits: { balance: "123.5", has_credits: true, unlimited: false },
    });
    expect(snapshot.plan).toBe("pro");
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]?.remainingPercent).toBe(75);
    expect(snapshot.credits?.balance).toBe("123.5");
  });

  it("parses the current Qoder personal and organization quota response", () => {
    const snapshot = parseQoderQuota(provider({ id: "qoder", kind: "qoder" }), {
      userQuota: { total: 1000, used: 375, remaining: 625, percentage: 37.5, unit: "credits" },
      orgResourcePackage: { total: 500, used: 100, remaining: 400, percentage: 20, unit: "credits" },
      totalUsagePercentage: 31.67,
      expiresAt: 2_000_000_000_000,
    });
    expect(snapshot.plan).toBe("Qoder");
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]).toMatchObject({ key: "user", limit: 1000, remaining: 625, usedPercent: 37.5, remainingPercent: 62.5 });
    expect(snapshot.windows[0]?.resetAt).toBe(2_000_000_000);
    expect(snapshot.windows[1]).toMatchObject({ key: "organization", limit: 500, remaining: 400, usedPercent: 20 });
  });

  it("supports configured generic quota paths", () => {
    const snapshot = parseGenericQuota(provider({
      options: {
        quota_windows: [{
          key: "monthly",
          label: "月度",
          limit_path: "data.month.limit",
          remaining_path: "data.month.left",
          reset_path: "data.month.reset_at",
        }],
      },
    }), {
      data: { month: { limit: 1000, left: 250, reset_at: 2_000_000_000 } },
    });
    expect(snapshot.windows[0]).toMatchObject({ key: "monthly", limit: 1000, remaining: 250, usedPercent: 75 });
  });
});
