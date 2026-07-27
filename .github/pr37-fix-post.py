from pathlib import Path
import re

path = Path('src/alerts.ts')
text = path.read_text(encoding='utf-8')
pattern = r'''export async function claimAlertDedupeSlot\(.*?\n\}\n\nexport function buildAlertPayload'''
replacement = '''export async function claimAlertDedupeSlot(
  env: Env,
  type: AlertType,
  target: string,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const key = dedupeKey(type, target);
  const memoized = dedupeMemo.get(key);
  if (memoized !== undefined && now - memoized < windowMs) return false;

  const namespace = env.RATE_LIMITER;
  if (namespace) {
    try {
      const stub = namespace.get(namespace.idFromName(ALERT_DEDUPE_DO_NAME));
      const response = await stub.fetch("https://do.internal/alerts/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: key, windowMs, now }),
      });
      if (!response.ok) throw new Error(`alert dedupe returned ${response.status}`);
      const result = await response.json() as { claimed?: unknown; claimedAt?: unknown };
      const claimedAt = typeof result.claimedAt === "number" ? result.claimedAt : now;
      memoSet(key, claimedAt);
      return result.claimed === true;
    } catch (error) {
      // A missing or temporarily unavailable DO must not make alert delivery fail. Fall back
      // to the previous KV mechanism: it is only best-effort across isolates, but still
      // suppresses most duplicates while the strongly consistent authority is unavailable.
      console.error(JSON.stringify({
        event: "alert_dedupe_claim_failed",
        type,
        target,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const cache = env.CONFIG_CACHE;
  const raw = cache ? await cache.get(key, "text").catch(() => null) : null;
  const stored = parseJson<{ sentAt?: unknown }>(raw, {});
  if (typeof stored.sentAt === "number" && now - stored.sentAt < windowMs) {
    memoSet(key, stored.sentAt);
    return false;
  }

  memoSet(key, now);
  if (cache) {
    const ttlSeconds = Math.max(60, Math.ceil(windowMs / 1000));
    await cache.put(key, JSON.stringify({ sentAt: now }), { expirationTtl: ttlSeconds })
      .catch(() => undefined);
  }
  return true;
}

export function buildAlertPayload'''
updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
if count != 1:
    raise RuntimeError(f'expected one alert claim function, found {count}')
path.write_text(updated, encoding='utf-8')
