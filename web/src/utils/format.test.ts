import { describe, expect, it } from "vitest";
import { formatTokens } from "./format";

describe("formatTokens", () => {
  it("keeps values below one thousand unscaled", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(856)).toBe("856");
  });

  it("uses K, M and B units at decimal thresholds", () => {
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(12_800)).toBe("12.8K");
    expect(formatTokens(1_280_000)).toBe("1.28M");
    expect(formatTokens(85_000_000)).toBe("85M");
    expect(formatTokens(2_400_000_000)).toBe("2.4B");
  });

  it("handles missing, negative and non-finite inputs", () => {
    expect(formatTokens(undefined)).toBe("0");
    expect(formatTokens(-1_500)).toBe("-1.5K");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});
