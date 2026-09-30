import { describe, expect, it } from "vitest";
import { responseUsage } from "../src/response-utils";
import { extractUsage } from "../src/stream";
import {
  calculateUsageCostMicros,
  canonicalUsage,
  checkedSafeUsageAdd,
  MAX_SAFE_USAGE_INTEGER,
  mergeCanonicalUsage,
  safeNonNegativeInteger,
} from "../src/usage-numbers";

describe("safe usage integer normalization", () => {
  it("keeps normal integer usage unchanged", () => {
    const expected = { promptTokens: 100, completionTokens: 20, cachedTokens: 40, totalTokens: 120 };
    expect(canonicalUsage(100, 20, 40, 120)).toEqual(expected);
    expect(responseUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    })).toEqual(expected);
    expect(extractUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 40 },
      },
    })).toEqual(expected);
  });

  it("accepts only non-negative safe integers", () => {
    expect(safeNonNegativeInteger(0)).toBe(0);
    expect(safeNonNegativeInteger(MAX_SAFE_USAGE_INTEGER)).toBe(MAX_SAFE_USAGE_INTEGER);
    for (const value of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, MAX_SAFE_USAGE_INTEGER + 1, "1"]) {
      expect(safeNonNegativeInteger(value)).toBeUndefined();
    }

    expect(responseUsage({
      usage: {
        prompt_tokens: 1.5,
        completion_tokens: -2,
        total_tokens: Number.POSITIVE_INFINITY,
        prompt_tokens_details: { cached_tokens: "3" },
      },
    })).toEqual({ promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 });
  });

  it("uses checked sums at the MAX_SAFE_INTEGER boundary", () => {
    expect(checkedSafeUsageAdd(MAX_SAFE_USAGE_INTEGER - 1, 1)).toBe(MAX_SAFE_USAGE_INTEGER);
    expect(checkedSafeUsageAdd(MAX_SAFE_USAGE_INTEGER, 1)).toBeUndefined();

    expect(canonicalUsage(MAX_SAFE_USAGE_INTEGER - 1, 1, 0)).toEqual({
      promptTokens: MAX_SAFE_USAGE_INTEGER - 1,
      completionTokens: 1,
      cachedTokens: 0,
      totalTokens: MAX_SAFE_USAGE_INTEGER,
    });
    expect(canonicalUsage(MAX_SAFE_USAGE_INTEGER, 1, 0)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    });
  });

  it("drops inconsistent cache breakdowns instead of clamping them into a false complete breakdown", () => {
    expect(canonicalUsage(10, 5, 11, 15)).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
    });
  });

  it("ignores unsafe or too-small explicit totals and derives a safe total", () => {
    expect(canonicalUsage(10, 5, 0, MAX_SAFE_USAGE_INTEGER + 1).totalTokens).toBe(15);
    expect(canonicalUsage(10, 5, 0, 4).totalTokens).toBe(15);
  });

  it("does not let merged snapshots synthesize an unsafe total", () => {
    expect(mergeCanonicalUsage(
      { promptTokens: MAX_SAFE_USAGE_INTEGER, completionTokens: 0, cachedTokens: 0, totalTokens: MAX_SAFE_USAGE_INTEGER },
      { promptTokens: 0, completionTokens: 1, cachedTokens: 0, totalTokens: 1 },
    )).toEqual({ promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 });
  });

  it("calculates cost exactly and rejects unsafe cost results", () => {
    expect(calculateUsageCostMicros(
      { promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 250_000, totalTokens: 1_500_000 },
      {
        inputMicrosPerMillion: 2_000_000,
        outputMicrosPerMillion: 4_000_000,
        cacheMicrosPerMillion: 1_000_000,
      },
    )).toBe(3_750_000);

    expect(calculateUsageCostMicros(
      {
        promptTokens: MAX_SAFE_USAGE_INTEGER,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: MAX_SAFE_USAGE_INTEGER,
      },
      {
        inputMicrosPerMillion: MAX_SAFE_USAGE_INTEGER,
        outputMicrosPerMillion: 0,
        cacheMicrosPerMillion: 0,
      },
    )).toBe(0);
  });
});
