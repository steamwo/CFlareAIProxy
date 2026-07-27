import type { Credential, QuotaSnapshot, QuotaWindow } from "../types";

export interface QuotaCredits {
  balance?: string | number;
  unlimited?: boolean;
  hasCredits?: boolean;
}

export interface ParsedQuota {
  plan?: string;
  windows: QuotaWindow[];
  credits?: QuotaCredits;
}

export type AccountTagType = "success" | "error" | "warning" | "info" | "default";

export interface AccountState {
  text: string;
  type: AccountTagType;
}

/** Reads a quota snapshot, preferring the structured payload and falling back to raw JSON. */
export function parseQuota(row?: QuotaSnapshot): ParsedQuota {
  if (row?.snapshot) return { plan: row.snapshot.plan, windows: row.snapshot.windows ?? [], credits: row.snapshot.credits };
  try {
    const parsed = JSON.parse(row?.quota_json || "{}") as Partial<ParsedQuota>;
    return { plan: parsed.plan, windows: Array.isArray(parsed.windows) ? parsed.windows : [], credits: parsed.credits };
  } catch {
    return { windows: [] };
  }
}

/** Percentage of the window still available, clamped to 0-100. */
export function quotaPercentage(window: QuotaWindow): number {
  if (window.limit === 0 && window.remaining === 0) return 0;
  if (typeof window.limit === "number" && window.limit > 0 && typeof window.remaining === "number") {
    return Math.max(0, Math.min(100, window.remaining / window.limit * 100));
  }
  if (typeof window.remainingPercent === "number") return Math.max(0, Math.min(100, window.remainingPercent));
  if (typeof window.usedPercent === "number") return Math.max(0, Math.min(100, 100 - window.usedPercent));
  return 0;
}

/** CSS custom properties driving the quota bar's red-to-green gradient. */
export function quotaProgressStyle(window: QuotaWindow): Record<string, string> {
  const percentage = quotaPercentage(window);
  const hue = percentage <= 50 ? 4 + percentage / 50 * 38 : 42 + (percentage - 50) / 50 * 100;
  return {
    "--quota-color": `hsl(${hue} 78% 46%)`,
    "--quota-gradient": `linear-gradient(90deg,hsl(${Math.max(0, hue - 7)} 82% 43%),hsl(${Math.min(145, hue + 8)} 76% 53%))`,
  };
}

export function exhaustedWindow(window: QuotaWindow): boolean {
  return (window.limit === 0 && window.remaining === 0)
    || (typeof window.remaining === "number" && window.remaining <= 0)
    || (typeof window.remainingPercent === "number" && window.remainingPercent <= 0)
    || (typeof window.usedPercent === "number" && window.usedPercent >= 100);
}

/**
 * Whether the account has no usable quota left. Providers expose different window sets, so
 * Qoder and Codex are judged on their own pool keys before falling back to "every measurable
 * window is empty", then to the credit balance.
 */
export function quotaExhausted(providerId: string, quota: ParsedQuota): boolean {
  if (quota.credits?.unlimited) return false;
  const measurable = quota.windows.filter((window) => window.remaining !== undefined || window.remainingPercent !== undefined || window.usedPercent !== undefined);
  if (providerId === "qoder") {
    const pools = measurable.filter((window) => window.key === "user" || window.key === "organization");
    return pools.length > 0 && pools.every(exhaustedWindow);
  }
  if (providerId === "codex") {
    const core = measurable.filter((window) => window.key === "primary" || window.key === "secondary");
    return core.length > 0 ? core.every(exhaustedWindow) : measurable.length > 0 && measurable.every(exhaustedWindow);
  }
  if (measurable.length) return measurable.every(exhaustedWindow);
  const balance = Number(quota.credits?.balance);
  return quota.credits?.hasCredits === false || (Number.isFinite(balance) && balance <= 0);
}

/** Badge shown on the account card, in worst-first order. */
export function accountState(row: Credential, snapshot: QuotaSnapshot | undefined): AccountState {
  if (row.enabled !== 1) return { text: "已停用", type: "default" };
  if (snapshot?.status === "ok" && quotaExhausted(row.provider_id, parseQuota(snapshot))) return { text: "额度耗尽", type: "error" };
  if (row.last_error || snapshot?.status === "error") return { text: "需要关注", type: "warning" };
  if (snapshot?.status === "unsupported") return { text: "额度未知", type: "warning" };
  return { text: "运行正常", type: "success" };
}
