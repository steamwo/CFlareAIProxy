import { describe, expect, it } from "vitest";
import { accountState, exhaustedWindow, parseQuota, quotaExhausted, quotaPercentage, quotaProgressStyle } from "./account-quota";
import type { Credential, QuotaSnapshot, QuotaWindow } from "../types";

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return { key: "primary", label: "主窗口", ...overrides };
}

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    credential_id: "cred-1",
    provider_id: "codex",
    status: "ok",
    quota_json: "{}",
    error_message: null,
    fetched_at: 1_700_000_000,
    expires_at: null,
    ...overrides,
  };
}

function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred-1",
    provider_id: "codex",
    label: "工作账号",
    auth_type: "oauth",
    expires_at: null,
    enabled: 1,
    priority: 100,
    weight: 1,
    max_concurrency: 4,
    metadata_json: "{}",
    last_error: null,
    last_used_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("parseQuota", () => {
  it("prefers the structured snapshot", () => {
    const parsed = parseQuota(snapshot({
      snapshot: { plan: "pro", windows: [window()], credits: { balance: 10 } },
      quota_json: JSON.stringify({ plan: "ignored" }),
    }));

    expect(parsed.plan).toBe("pro");
    expect(parsed.windows).toHaveLength(1);
  });

  it("falls back to the raw JSON column", () => {
    const parsed = parseQuota(snapshot({ quota_json: JSON.stringify({ plan: "team", windows: [window()] }) }));
    expect(parsed.plan).toBe("team");
    expect(parsed.windows).toHaveLength(1);
  });

  it("degrades safely on malformed, missing or non-array payloads", () => {
    expect(parseQuota(snapshot({ quota_json: "{oops" }))).toEqual({ windows: [] });
    expect(parseQuota(undefined).windows).toEqual([]);
    expect(parseQuota(snapshot({ quota_json: JSON.stringify({ windows: "nope" }) })).windows).toEqual([]);
  });
});

describe("quotaPercentage", () => {
  it("computes remaining share from limit and remaining", () => {
    expect(quotaPercentage(window({ limit: 200, remaining: 50 }))).toBe(25);
  });

  it("treats a zero limit with zero remaining as empty rather than NaN", () => {
    expect(quotaPercentage(window({ limit: 0, remaining: 0 }))).toBe(0);
  });

  it("falls back to remainingPercent then usedPercent", () => {
    expect(quotaPercentage(window({ remainingPercent: 42 }))).toBe(42);
    expect(quotaPercentage(window({ usedPercent: 75 }))).toBe(25);
    expect(quotaPercentage(window())).toBe(0);
  });

  it("clamps out-of-range inputs into 0-100", () => {
    expect(quotaPercentage(window({ remainingPercent: 180 }))).toBe(100);
    expect(quotaPercentage(window({ remainingPercent: -20 }))).toBe(0);
    expect(quotaPercentage(window({ limit: 100, remaining: 250 }))).toBe(100);
  });
});

describe("quotaProgressStyle", () => {
  it("shifts hue from red at empty to green at full", () => {
    const empty = quotaProgressStyle(window({ limit: 100, remaining: 0 }));
    const full = quotaProgressStyle(window({ limit: 100, remaining: 100 }));

    expect(empty["--quota-color"]).toBe("hsl(4 78% 46%)");
    expect(full["--quota-color"]).toBe("hsl(142 78% 46%)");
    expect(full["--quota-gradient"]).toContain("linear-gradient");
  });
});

describe("exhaustedWindow", () => {
  it("recognises every exhaustion encoding", () => {
    expect(exhaustedWindow(window({ limit: 0, remaining: 0 }))).toBe(true);
    expect(exhaustedWindow(window({ remaining: 0 }))).toBe(true);
    expect(exhaustedWindow(window({ remainingPercent: 0 }))).toBe(true);
    expect(exhaustedWindow(window({ usedPercent: 100 }))).toBe(true);
    expect(exhaustedWindow(window({ remaining: 5 }))).toBe(false);
    expect(exhaustedWindow(window())).toBe(false);
  });
});

describe("quotaExhausted", () => {
  it("never reports exhaustion for unlimited credits", () => {
    expect(quotaExhausted("codex", { windows: [window({ remaining: 0 })], credits: { unlimited: true } })).toBe(false);
  });

  it("judges qoder on its user and organization pools only", () => {
    const windows = [window({ key: "user", remaining: 0 }), window({ key: "organization", remaining: 0 }), window({ key: "other", remaining: 99 })];
    expect(quotaExhausted("qoder", { windows })).toBe(true);

    const partial = [window({ key: "user", remaining: 0 }), window({ key: "organization", remaining: 5 })];
    expect(quotaExhausted("qoder", { windows: partial })).toBe(false);
  });

  it("judges codex on primary/secondary, falling back to all measurable windows", () => {
    expect(quotaExhausted("codex", { windows: [window({ key: "primary", remaining: 0 }), window({ key: "secondary", remaining: 0 })] })).toBe(true);
    expect(quotaExhausted("codex", { windows: [window({ key: "primary", remaining: 0 }), window({ key: "secondary", remaining: 4 })] })).toBe(false);
    expect(quotaExhausted("codex", { windows: [window({ key: "weekly", remaining: 0 })] })).toBe(true);
  });

  it("uses the credit balance when no measurable window exists", () => {
    expect(quotaExhausted("kimi", { windows: [], credits: { balance: 0 } })).toBe(true);
    expect(quotaExhausted("kimi", { windows: [], credits: { balance: "12.5" } })).toBe(false);
    expect(quotaExhausted("kimi", { windows: [], credits: { hasCredits: false, balance: 5 } })).toBe(true);
    expect(quotaExhausted("kimi", { windows: [] })).toBe(false);
  });
});

describe("accountState", () => {
  it("reports disabled accounts before anything else", () => {
    expect(accountState(credential({ enabled: 0, last_error: "boom" }), snapshot({ status: "error" })))
      .toEqual({ text: "已停用", type: "default" });
  });

  it("flags exhausted quota on an otherwise healthy snapshot", () => {
    const state = accountState(
      credential(),
      snapshot({ status: "ok", snapshot: { windows: [window({ key: "primary", remaining: 0 })] } }),
    );
    expect(state).toEqual({ text: "额度耗尽", type: "error" });
  });

  it("flags accounts with a last error or a failing snapshot", () => {
    expect(accountState(credential({ last_error: "401" }), undefined).type).toBe("warning");
    expect(accountState(credential(), snapshot({ status: "error" })).type).toBe("warning");
  });

  it("marks unsupported quota as unknown and healthy accounts as running", () => {
    expect(accountState(credential(), snapshot({ status: "unsupported" }))).toEqual({ text: "额度未知", type: "warning" });
    expect(accountState(credential(), snapshot({ status: "ok" }))).toEqual({ text: "运行正常", type: "success" });
    expect(accountState(credential(), undefined)).toEqual({ text: "运行正常", type: "success" });
  });
});
