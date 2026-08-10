interface ParsedKimiModel {
  base: string;
  suffix?: string;
}

function parseTrailingThinkingSuffix(model: string): ParsedKimiModel {
  const trimmed = model.trim();
  const match = trimmed.match(/^(.*)\(([^()]*)\)$/);
  if (!match) return { base: trimmed };
  return { base: match[1]!.trim(), suffix: match[2] ?? "" };
}

/**
 * Canonicalizes the K2.7 Code aliases that Kimi now exposes under the official
 * Kimi-For-Coding IDs. Existing non-K2.7 route model spelling is preserved to avoid
 * widening this upstream alignment into a global model-name rewrite.
 */
export function normalizeKimiUpstreamModel(model: string): string {
  const parsed = parseTrailingThinkingSuffix(model);
  let base = parsed.base;
  if (base.toLowerCase().endsWith("[1m]")) base = base.slice(0, -"[1m]".length).trim();

  const key = base.toLowerCase();
  let normalized: string;
  switch (key) {
    case "kimi-k2.7-code":
    case "k2.7-code":
    case "kimi-for-coding":
    case "for-coding":
      normalized = "kimi-for-coding";
      break;
    case "kimi-k2.7-code-highspeed":
    case "k2.7-code-highspeed":
    case "kimi-for-coding-highspeed":
    case "for-coding-highspeed":
      normalized = "kimi-for-coding-highspeed";
      break;
    default:
      normalized = base;
      break;
  }

  return parsed.suffix !== undefined ? `${normalized}(${parsed.suffix})` : normalized;
}
