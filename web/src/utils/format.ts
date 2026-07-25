function compactValue(value: number, divisor: number, suffix: string): string {
  const scaled = value / divisor;
  const maximumFractionDigits = Math.abs(scaled) < 10 ? 2 : Math.abs(scaled) < 100 ? 1 : 0;
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
    useGrouping: false,
  }).format(scaled);
  return `${formatted}${suffix}`;
}

export function formatTokens(value: number | null | undefined): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "0";
  const absolute = Math.abs(numeric);
  if (absolute >= 1_000_000_000) return compactValue(numeric, 1_000_000_000, "B");
  if (absolute >= 1_000_000) return compactValue(numeric, 1_000_000, "M");
  if (absolute >= 1_000) return compactValue(numeric, 1_000, "K");
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(numeric);
}
