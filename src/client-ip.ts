const CONTROL_OR_SEPARATOR = /[\\u0000-\\u0020\\u007f,]/;

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\\d{1,3}$/.test(part)) return false;
    const number = Number(part);
    return number >= 0 && number <= 255 && String(number) === part.replace(/^0+(?=\\d)/, "");
  });
}

function validIpv6(value: string): boolean {
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    // URL parsing gives us a runtime-native IPv6 parser without adding a Node-only dependency.
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

/**
 * Returns the platform-authenticated client address for a Cloudflare Worker request.
 *
 * We deliberately require a Workers request.cf context before trusting
 * CF-Connecting-IP. In local/non-Cloudflare environments an arbitrary client can
 * supply that header, so the safe answer is "unknown". Forwarded/XFF headers are never
 * consulted.
 */
export function workerClientIp(request: Request): string | undefined {
  const cf = (request as Request & { cf?: unknown }).cf;
  if (!cf || typeof cf !== "object") return undefined;
  const raw = request.headers.get("cf-connecting-ip");
  if (!raw || CONTROL_OR_SEPARATOR.test(raw)) return undefined;
  const value = raw.trim();
  if (!value || value !== raw) return undefined;
  return validIpv4(value) || validIpv6(value) ? value : undefined;
}