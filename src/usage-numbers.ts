import type { Usage } from "./types";

export const MAX_SAFE_USAGE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface UsagePriceRates {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cacheMicrosPerMillion: number;
}

export function emptyCanonicalUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}

export function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function checkedSafeUsageAdd(left: number, right: number): number | undefined {
  if (safeNonNegativeInteger(left) === undefined || safeNonNegativeInteger(right) === undefined) return undefined;
  if (left > MAX_SAFE_USAGE_INTEGER - right) return undefined;
  return left + right;
}

export function canonicalUsage(
  promptValue: unknown,
  completionValue: unknown,
  cachedValue: unknown,
  totalValue?: unknown,
): Usage {
  const promptTokens = safeNonNegativeInteger(promptValue) ?? 0;
  const completionTokens = safeNonNegativeInteger(completionValue) ?? 0;
  const derivedTotal = checkedSafeUsageAdd(promptTokens, completionTokens);
  if (derivedTotal === undefined) return emptyCanonicalUsage();

  const rawCachedTokens = safeNonNegativeInteger(cachedValue);
  const cachedTokens = rawCachedTokens !== undefined && rawCachedTokens <= promptTokens ? rawCachedTokens : 0;
  const explicitTotal = safeNonNegativeInteger(totalValue);
  const totalTokens = explicitTotal !== undefined && explicitTotal >= derivedTotal ? explicitTotal : derivedTotal;
  return { promptTokens, completionTokens, cachedTokens, totalTokens };
}

export function mergeCanonicalUsage(left: Usage, right: Usage): Usage {
  const promptTokens = Math.max(
    safeNonNegativeInteger(left.promptTokens) ?? 0,
    safeNonNegativeInteger(right.promptTokens) ?? 0,
  );
  const completionTokens = Math.max(
    safeNonNegativeInteger(left.completionTokens) ?? 0,
    safeNonNegativeInteger(right.completionTokens) ?? 0,
  );
  const cachedTokens = Math.max(
    safeNonNegativeInteger(left.cachedTokens) ?? 0,
    safeNonNegativeInteger(right.cachedTokens) ?? 0,
  );
  const totalTokens = Math.max(
    safeNonNegativeInteger(left.totalTokens) ?? 0,
    safeNonNegativeInteger(right.totalTokens) ?? 0,
  );
  return canonicalUsage(promptTokens, completionTokens, cachedTokens, totalTokens);
}

export function calculateUsageCostMicros(usage: Usage, rates: UsagePriceRates): number {
  const normalized = canonicalUsage(
    usage.promptTokens,
    usage.completionTokens,
    usage.cachedTokens,
    usage.totalTokens,
  );
  const inputRate = safeNonNegativeInteger(rates.inputMicrosPerMillion);
  const outputRate = safeNonNegativeInteger(rates.outputMicrosPerMillion);
  const cacheRate = safeNonNegativeInteger(rates.cacheMicrosPerMillion);
  if (inputRate === undefined || outputRate === undefined || cacheRate === undefined) return 0;

  const uncachedInputTokens = normalized.promptTokens - normalized.cachedTokens;
  const numerator =
    BigInt(uncachedInputTokens) * BigInt(inputRate)
    + BigInt(normalized.cachedTokens) * BigInt(cacheRate)
    + BigInt(normalized.completionTokens) * BigInt(outputRate);
  const cost = (numerator + 999_999n) / 1_000_000n;
  return cost <= BigInt(MAX_SAFE_USAGE_INTEGER) ? Number(cost) : 0;
}
